import { IdSchema } from "@promptlab/contracts";
import { and, eq, inArray, max } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import {
  ExperimentDecisionSchema,
  parseStoredControlledEvaluationMetadata,
  parseStoredExperimentPilotMetadata,
} from "@/lib/experiment-pilot";
import { hasExperimentAcceptanceEvidence } from "./acceptance-eligibility.ts";
import {
  controlledEvaluationPromptVersionIds,
  hasControlledEvaluationAcceptanceEvidence,
} from "./controlled-evaluation-eligibility.ts";
import {
  createControlledEvaluationVerifiedMemory,
  createPilotVerifiedMemory,
  isVerifiedMemorySourceManifestCurrent,
  sourceManifestForExperiment,
  type StoredExperimentEvent,
  type VerifiedMemoryRecord,
} from "@/lib/verified-memory";

export const runtime = "nodejs";

const DecisionRequestSchema = z.strictObject({
  experimentId: IdSchema,
  ...ExperimentDecisionSchema.shape,
});

export async function POST(
  request: Request,
  context: {
    params: Promise<{ projectId: string; experimentId: string }>;
  },
) {
  const { projectId: rawProjectId, experimentId: rawExperimentId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const experimentId = parseRouteId(rawExperimentId);
  if (!projectId || !experimentId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = DecisionRequestSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    experimentId,
  });
  if (!parsed.success)
    return Response.json(
      { error: "INVALID_EXPERIMENT_DECISION" },
      { status: 400 },
    );

  try {
    const [run] = await database.db
      .select({
        id: schema.runs.id,
        projectId: schema.runs.projectId,
        status: schema.runs.status,
        promptVersionId: schema.runs.promptVersionId,
        provider: schema.runs.provider,
        purpose: schema.runs.purpose,
        requestedModel: schema.runs.requestedModel,
        configSnapshot: schema.runs.configSnapshot,
      })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, projectId),
          eq(schema.runs.id, experimentId),
        ),
      )
      .limit(1);
    if (!run)
      return Response.json({ error: "EXPERIMENT_NOT_FOUND" }, { status: 404 });

    const [marker] = await database.db
      .select({ payload: schema.runEvents.payload })
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.projectId, projectId),
          eq(schema.runEvents.runId, experimentId),
          eq(schema.runEvents.eventType, "experiment.created"),
        ),
      )
      .limit(1);
    if (!marker)
      return Response.json({ error: "EXPERIMENT_NOT_FOUND" }, { status: 404 });

    if (["queued", "running", "cancel_requested"].includes(run.status))
      return Response.json(
        { error: "EXPERIMENT_STILL_RUNNING" },
        { status: 409 },
      );

    let acceptanceEvidence = false;
    let acceptedEvents: StoredExperimentEvent[] = [];
    let acceptedMetadata:
      | {
          mode: "controlled_evaluation";
          metadata: NonNullable<
            ReturnType<typeof parseStoredControlledEvaluationMetadata>
          >;
        }
      | {
          mode: "pilot";
          metadata: NonNullable<
            ReturnType<typeof parseStoredExperimentPilotMetadata>
          >["metadata"];
        }
      | null = null;
    let acceptedSourceManifest: ReturnType<typeof sourceManifestForExperiment> =
      null;
    let acceptedSourcesCurrent = false;

    if (parsed.data.decision === "accepted") {
      const events: StoredExperimentEvent[] = await database.db
        .select({
          projectId: schema.runEvents.projectId,
          runId: schema.runEvents.runId,
          attemptId: schema.runEvents.attemptId,
          sequence: schema.runEvents.sequence,
          eventType: schema.runEvents.eventType,
          payload: schema.runEvents.payload,
        })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            eq(schema.runEvents.runId, experimentId),
          ),
        );
      acceptedEvents = events;
      const markerPayload =
        typeof marker.payload === "object" &&
        marker.payload !== null &&
        !Array.isArray(marker.payload)
          ? (marker.payload as Record<string, unknown>)
          : null;
      const controlledMetadata = parseStoredControlledEvaluationMetadata(
        markerPayload?.metadata,
      );
      if (controlledMetadata) {
        const promptIds =
          controlledEvaluationPromptVersionIds(controlledMetadata);
        const promptVersions = await database.db
          .select({
            id: schema.promptVersions.id,
            text: schema.promptVersions.text,
          })
          .from(schema.promptVersions)
          .where(
            and(
              eq(schema.promptVersions.projectId, projectId),
              inArray(schema.promptVersions.id, promptIds),
            ),
          );
        const promptById = new Map(
          promptVersions.map((promptVersion) => [
            promptVersion.id,
            promptVersion.text,
          ]),
        );
        acceptanceEvidence = hasControlledEvaluationAcceptanceEvidence({
          experimentId,
          run,
          markerMetadata: controlledMetadata,
          events,
          baselinePrompt:
            promptById.get(controlledMetadata.baselinePromptVersionId) ?? "",
          candidatePrompt:
            promptById.get(controlledMetadata.candidatePromptVersionId) ?? "",
        });
        if (acceptanceEvidence) {
          acceptedMetadata = {
            mode: "controlled_evaluation",
            metadata: controlledMetadata,
          };
        }
      } else {
        const pilotMetadata = parseStoredExperimentPilotMetadata(
          markerPayload?.metadata,
        );
        if (pilotMetadata && !pilotMetadata.legacy) {
          acceptanceEvidence = hasExperimentAcceptanceEvidence({
            projectId,
            experimentId,
            run,
            metadata: pilotMetadata.metadata,
            events,
          });
          if (acceptanceEvidence) {
            acceptedMetadata = {
              mode: "pilot",
              metadata: pilotMetadata.metadata,
            };
          }
        }
      }
      if (!acceptanceEvidence) {
        return Response.json(
          {
            error: "EXPERIMENT_ACCEPTANCE_EVIDENCE_INCOMPLETE",
            message:
              "Eksperimen belum dapat diterima karena perbandingan baseline dan kandidat yang lengkap dan valid tidak tersedia. Pastikan kedua hasil memakai kasus, model, effort, dan konteks uji yang sama serta tidak ada fixture gagal atau tidak valid.",
          },
          { status: 409 },
        );
      }
      if (acceptedMetadata) {
        acceptedSourceManifest = sourceManifestForExperiment(
          acceptedMetadata.metadata,
        );
        if (acceptedSourceManifest) {
          acceptedSourcesCurrent = await isVerifiedMemorySourceManifestCurrent(
            database.db,
            projectId,
            acceptedSourceManifest,
          );
        }
      }
    }

    const decidedAt = new Date();
    const sequence = await database.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ sequence: max(schema.runEvents.sequence) })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            eq(schema.runEvents.runId, experimentId),
          ),
        );
      const nextSequence = (latest?.sequence ?? 0) + 1;
      let verifiedMemory: VerifiedMemoryRecord | null = null;
      if (acceptedMetadata && acceptedSourceManifest) {
        const gate = {
          decision: parsed.data.decision,
          evaluationEligible: acceptanceEvidence,
          sourceVersionsCurrent: acceptedSourcesCurrent,
          acceptedDecisionSequence: nextSequence,
          acceptedAt: decidedAt.toISOString(),
          sourceVersionManifest: acceptedSourceManifest,
        };
        const memoryInput = {
          gate,
          run,
          metadata: acceptedMetadata.metadata,
          events: acceptedEvents,
        };
        verifiedMemory =
          acceptedMetadata.mode === "controlled_evaluation"
            ? createControlledEvaluationVerifiedMemory(memoryInput)
            : createPilotVerifiedMemory(memoryInput);
      }
      await tx.insert(schema.runEvents).values({
        projectId,
        runId: experimentId,
        sequence: nextSequence,
        eventType: "experiment.decision",
        payload: {
          experimentId,
          decision: parsed.data.decision,
          note: parsed.data.note,
          decidedAt: decidedAt.toISOString(),
          ...(verifiedMemory ? { verifiedMemory } : {}),
        },
      });
      return nextSequence;
    });
    return Response.json({
      experimentId,
      decision: parsed.data.decision,
      note: parsed.data.note,
      decidedAt: decidedAt.toISOString(),
      sequence,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return safeApiFailure(409);
    return safeApiFailure();
  }
}
