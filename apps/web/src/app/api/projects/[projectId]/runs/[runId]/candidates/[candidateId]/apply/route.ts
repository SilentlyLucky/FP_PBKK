import { IdSchema } from "@promptlab/contracts";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

import {
  candidateApplyBlockMessage,
  validateOptimizationCandidateApply,
} from "./eligibility";

export const runtime = "nodejs";

const ApplyRequestSchema = z.strictObject({
  promptId: IdSchema,
  draftVersionId: IdSchema,
});

export async function POST(
  request: Request,
  context: {
    params: Promise<{
      projectId: string;
      runId: string;
      candidateId: string;
    }>;
  },
) {
  const {
    projectId: rawProjectId,
    runId: rawRunId,
    candidateId: rawCandidateId,
  } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const runId = parseRouteId(rawRunId);
  const candidateId = parseRouteId(rawCandidateId);
  if (!projectId || !runId || !candidateId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = ApplyRequestSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "INVALID_CANDIDATE_APPLY_REQUEST" },
      { status: 400 },
    );

  try {
    const result = await database.db.transaction(async (tx) => {
      const [run] = await tx
        .select({
          id: schema.runs.id,
          projectId: schema.runs.projectId,
          status: schema.runs.status,
          purpose: schema.runs.purpose,
          promptVersionId: schema.runs.promptVersionId,
          configSnapshot: schema.runs.configSnapshot,
        })
        .from(schema.runs)
        .where(
          and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)),
        )
        .for("update");
      if (!run) return { error: "RUN_NOT_FOUND" as const };

      const [prompt] = await tx
        .select({
          id: schema.prompts.id,
          projectId: schema.prompts.projectId,
          name: schema.prompts.name,
          currentVersionId: schema.prompts.currentVersionId,
          deletedAt: schema.prompts.deletedAt,
        })
        .from(schema.prompts)
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, parsed.data.promptId),
          ),
        )
        .for("update");
      if (!prompt) return { error: "PROMPT_NOT_FOUND" as const };

      const [baselineVersion] = run.promptVersionId
        ? await tx
            .select({
              id: schema.promptVersions.id,
              projectId: schema.promptVersions.projectId,
              promptId: schema.promptVersions.promptId,
              text: schema.promptVersions.text,
              invariants: schema.promptVersions.invariantDefinition,
            })
            .from(schema.promptVersions)
            .where(
              and(
                eq(schema.promptVersions.projectId, projectId),
                eq(schema.promptVersions.id, run.promptVersionId),
              ),
            )
            .limit(1)
        : [];
      const [draftVersion] = await tx
        .select({
          id: schema.promptVersions.id,
          projectId: schema.promptVersions.projectId,
          promptId: schema.promptVersions.promptId,
          version: schema.promptVersions.version,
          parentVersionId: schema.promptVersions.parentVersionId,
          text: schema.promptVersions.text,
          invariants: schema.promptVersions.invariantDefinition,
          createdBy: schema.promptVersions.createdBy,
        })
        .from(schema.promptVersions)
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            eq(schema.promptVersions.promptId, parsed.data.promptId),
            eq(schema.promptVersions.id, parsed.data.draftVersionId),
          ),
        )
        .limit(1);
      const [completion] = await tx
        .select({
          attemptId: schema.runEvents.attemptId,
          payload: schema.runEvents.payload,
        })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            eq(schema.runEvents.runId, runId),
            eq(schema.runEvents.eventType, "run.completed"),
          ),
        )
        .orderBy(desc(schema.runEvents.sequence))
        .limit(1);

      const eligibility = validateOptimizationCandidateApply({
        requested: {
          projectId,
          runId,
          promptId: parsed.data.promptId,
          candidateId,
          draftVersionId: parsed.data.draftVersionId,
        },
        run,
        prompt,
        baselineVersion: baselineVersion ?? null,
        draftVersion: draftVersion ?? null,
        completionAttemptId: completion?.attemptId ?? null,
        completionPayload: completion?.payload ?? null,
      });
      if (!eligibility.eligible)
        return { conflict: eligibility.reason } as const;

      if (!eligibility.alreadyApplied) {
        const [updated] = await tx
          .update(schema.prompts)
          .set({
            currentVersionId: parsed.data.draftVersionId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.prompts.projectId, projectId),
              eq(schema.prompts.id, parsed.data.promptId),
              eq(schema.prompts.currentVersionId, run.promptVersionId!),
            ),
          )
          .returning({ currentVersionId: schema.prompts.currentVersionId });
        if (!updated) return { conflict: "stale_baseline" as const };
      }

      if (!draftVersion) return { conflict: "draft_scope_mismatch" as const };
      return {
        applied: !eligibility.alreadyApplied,
        alreadyApplied: eligibility.alreadyApplied,
        prompt: {
          id: prompt.id,
          name: prompt.name,
          currentVersionId: draftVersion.id,
          version: draftVersion.version,
          text: draftVersion.text,
          invariants: draftVersion.invariants,
        },
      };
    });

    if ("error" in result) {
      const message =
        result.error === "RUN_NOT_FOUND"
          ? "Run optimasi tidak ditemukan di proyek ini."
          : "Prompt tidak ditemukan di proyek ini.";
      return Response.json({ error: result.error, message }, { status: 404 });
    }
    if ("conflict" in result) {
      return Response.json(
        {
          error: result.conflict.toUpperCase(),
          message: candidateApplyBlockMessage(result.conflict),
        },
        { status: 409 },
      );
    }
    return Response.json(result);
  } catch {
    return safeApiFailure();
  }
}
