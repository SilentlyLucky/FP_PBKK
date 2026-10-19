import { isDeepStrictEqual } from "node:util";
import {
  ControlledEvaluationRequestSchema,
  IdSchema,
  RunRetrievalSelectionSchema,
} from "@promptlab/contracts";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import { isControlledEvaluationConfigurationValid } from "@promptlab/agent";
import { hasExperimentAcceptanceEvidence } from "./[experimentId]/decision/acceptance-eligibility";
import {
  controlledEvaluationPromptVersionIds,
  hasControlledEvaluationAcceptanceEvidence,
} from "./[experimentId]/decision/controlled-evaluation-eligibility";
import {
  ExperimentPilotMetadataSchema,
  isExperimentPilotConfigurationValid,
  parseStoredControlledEvaluationMetadata,
  parseStoredExperimentPilotMetadata,
  type ExperimentRecord,
} from "@/lib/experiment-pilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateExperimentSchema = z.strictObject({
  runId: IdSchema,
  metadata: z.union([
    ExperimentPilotMetadataSchema,
    ControlledEvaluationRequestSchema,
  ]),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function runMatchesMetadata(
  run: {
    promptVersionId: string | null;
    provider: string;
    purpose: string;
    requestedModel: string;
    configSnapshot: Record<string, unknown>;
  },
  metadata:
    | z.infer<typeof ExperimentPilotMetadataSchema>
    | z.infer<typeof ControlledEvaluationRequestSchema>,
): boolean {
  if (run.provider !== "codex_app_server" || run.purpose !== "target") {
    return false;
  }
  if ("mode" in metadata) {
    const configuredReasoningEffort = run.configSnapshot.reasoningEffort;
    if (
      configuredReasoningEffort !== undefined &&
      configuredReasoningEffort !== null &&
      typeof configuredReasoningEffort !== "string"
    ) {
      return false;
    }
    const reasoningEffort =
      typeof configuredReasoningEffort === "string"
        ? configuredReasoningEffort
        : null;
    return (
      run.promptVersionId === metadata.baselinePromptVersionId &&
      metadata.arms.every(
        (arm) =>
          arm.requestedModel === run.requestedModel &&
          arm.reasoningEffort === reasoningEffort,
      ) &&
      sameJson(run.configSnapshot.controlledEvaluation, metadata)
    );
  }
  if (
    run.promptVersionId !== metadata.promptVersionId ||
    run.requestedModel !== metadata.requestedModel
  ) {
    return false;
  }
  const configuredReasoningEffort = run.configSnapshot.reasoningEffort;
  if (
    configuredReasoningEffort !== undefined &&
    configuredReasoningEffort !== null &&
    typeof configuredReasoningEffort !== "string"
  ) {
    return false;
  }
  const effort =
    typeof configuredReasoningEffort === "string"
      ? configuredReasoningEffort
      : null;
  if (effort !== metadata.reasoningEffort) return false;

  const retrieval = RunRetrievalSelectionSchema.safeParse(
    run.configSnapshot.retrieval ?? {
      strategy: "lexical",
      sourceIds: [],
    },
  );
  if (!retrieval.success || !sameJson(retrieval.data, metadata.retrieval)) {
    return false;
  }

  const optimization = asRecord(run.configSnapshot.optimization);
  const testCases = optimization?.testCases;
  if (!Array.isArray(testCases) || testCases.length !== 1) return false;
  const [testCase] = testCases;
  const caseRecord = asRecord(testCase);
  return (
    caseRecord?.id === metadata.caseId && caseRecord.input === metadata.input
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const markers = await database.db
      .select({
        runId: schema.runEvents.runId,
        payload: schema.runEvents.payload,
        createdAt: schema.runEvents.createdAt,
      })
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.projectId, projectId),
          eq(schema.runEvents.eventType, "experiment.created"),
        ),
      )
      .orderBy(desc(schema.runEvents.createdAt));
    if (!markers.length) return Response.json({ experiments: [] });

    const runIds = [...new Set(markers.map((event) => event.runId))];
    const [runs, decisions, runEvents] = await Promise.all([
      database.db
        .select({
          id: schema.runs.id,
          projectId: schema.runs.projectId,
          status: schema.runs.status,
          errorSummary: schema.runs.errorSummary,
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
            inArray(schema.runs.id, runIds),
          ),
        ),
      database.db
        .select({
          runId: schema.runEvents.runId,
          payload: schema.runEvents.payload,
          createdAt: schema.runEvents.createdAt,
          sequence: schema.runEvents.sequence,
        })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            inArray(schema.runEvents.runId, runIds),
            eq(schema.runEvents.eventType, "experiment.decision"),
          ),
        )
        .orderBy(desc(schema.runEvents.sequence)),
      database.db
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
            inArray(schema.runEvents.runId, runIds),
          ),
        ),
    ]);
    const runById = new Map(runs.map((run) => [run.id, run]));
    const latestDecisionByRun = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      if (!latestDecisionByRun.has(decision.runId))
        latestDecisionByRun.set(decision.runId, decision);
    }

    const controlledPromptIds = [
      ...new Set(
        markers.flatMap((event) =>
          controlledEvaluationPromptVersionIds(
            asRecord(event.payload)?.metadata,
          ),
        ),
      ),
    ];
    const controlledPromptVersions = controlledPromptIds.length
      ? await database.db
          .select({
            id: schema.promptVersions.id,
            text: schema.promptVersions.text,
          })
          .from(schema.promptVersions)
          .where(
            and(
              eq(schema.promptVersions.projectId, projectId),
              inArray(schema.promptVersions.id, controlledPromptIds),
            ),
          )
      : [];
    const promptById = new Map(
      controlledPromptVersions.map((prompt) => [prompt.id, prompt.text]),
    );

    const experiments: ExperimentRecord[] = markers.flatMap((event) => {
      const payload = asRecord(event.payload);
      const run = runById.get(event.runId);
      if (!run) return [];
      const controlledMetadata = parseStoredControlledEvaluationMetadata(
        payload?.metadata,
      );
      const pilotMetadata = controlledMetadata
        ? null
        : parseStoredExperimentPilotMetadata(payload?.metadata);
      if (!controlledMetadata && !pilotMetadata) return [];
      const decisionEvent = latestDecisionByRun.get(event.runId);
      const decisionPayload = asRecord(decisionEvent?.payload);
      const decisionValue = decisionPayload?.decision;
      const decision: ExperimentRecord["decision"] =
        decisionValue === "accepted" ||
        decisionValue === "rejected" ||
        decisionValue === "inconclusive"
          ? decisionValue
          : null;
      const evidenceEligible = controlledMetadata
        ? hasControlledEvaluationAcceptanceEvidence({
            experimentId: event.runId,
            run,
            markerMetadata: controlledMetadata,
            events: runEvents,
            baselinePrompt:
              promptById.get(controlledMetadata.baselinePromptVersionId) ?? "",
            candidatePrompt:
              promptById.get(controlledMetadata.candidatePromptVersionId) ?? "",
          })
        : !pilotMetadata!.legacy &&
          hasExperimentAcceptanceEvidence({
            projectId,
            experimentId: event.runId,
            run,
            metadata: pilotMetadata!.metadata,
            events: runEvents,
          });
      const base = {
        experimentId: event.runId,
        runId: event.runId,
        status: run.status,
        errorSummary: run.errorSummary,
        evidenceEligible,
        decisionVerified: decision !== "accepted" || evidenceEligible,
        createdAt: event.createdAt.toISOString(),
        decision,
        decisionNote:
          typeof decisionPayload?.note === "string"
            ? decisionPayload.note
            : null,
        decidedAt: decisionEvent?.createdAt.toISOString() ?? null,
      };
      return [
        controlledMetadata
          ? {
              ...base,
              mode: "controlled_evaluation" as const,
              metadata: controlledMetadata,
            }
          : {
              ...base,
              mode: "pilot" as const,
              metadata: pilotMetadata!.metadata,
            },
      ];
    });
    return Response.json({ experiments });
  } catch {
    return safeApiFailure();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = CreateExperimentSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "INVALID_EXPERIMENT" }, { status: 400 });
  if ("mode" in parsed.data.metadata) {
    if (!isControlledEvaluationConfigurationValid(parsed.data.metadata)) {
      return Response.json(
        { error: "INVALID_EXPERIMENT_CONFIGURATION" },
        { status: 400 },
      );
    }
  } else if (!isExperimentPilotConfigurationValid(parsed.data.metadata)) {
    return Response.json(
      { error: "INVALID_EXPERIMENT_CONFIGURATION" },
      { status: 400 },
    );
  }

  try {
    const [run] = await database.db
      .select({
        id: schema.runs.id,
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
          eq(schema.runs.id, parsed.data.runId),
        ),
      )
      .limit(1);
    if (!run) return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
    if (!runMatchesMetadata(run, parsed.data.metadata))
      return Response.json(
        { error: "EXPERIMENT_RUN_MISMATCH" },
        { status: 409 },
      );

    const result = await database.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ payload: schema.runEvents.payload })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            eq(schema.runEvents.runId, run.id),
            eq(schema.runEvents.eventType, "experiment.created"),
          ),
        )
        .limit(1);
      if (existing) {
        const existingMetadata = asRecord(existing.payload)?.metadata;
        return sameJson(existingMetadata, parsed.data.metadata)
          ? { conflict: false as const, created: false }
          : { conflict: true as const };
      }

      const [latest] = await tx
        .select({ sequence: max(schema.runEvents.sequence) })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, run.id));
      const sequence = (latest?.sequence ?? 0) + 1;
      await tx.insert(schema.runEvents).values({
        projectId,
        runId: run.id,
        sequence,
        eventType: "experiment.created",
        payload: {
          experimentId: run.id,
          metadata: parsed.data.metadata,
        },
      });
      return { conflict: false as const, created: true };
    });
    if (result.conflict)
      return Response.json(
        { error: "EXPERIMENT_ALREADY_RECORDED" },
        { status: 409 },
      );
    return Response.json(
      {
        experiment: {
          experimentId: run.id,
          runId: run.id,
          mode:
            "mode" in parsed.data.metadata ? "controlled_evaluation" : "pilot",
          metadata: parsed.data.metadata,
        },
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return safeApiFailure(409);
    return safeApiFailure();
  }
}
