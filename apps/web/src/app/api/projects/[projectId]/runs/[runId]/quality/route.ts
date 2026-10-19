import { PromptQualityVoteSchema } from "@promptlab/contracts";
import { isOptimizationCandidateEvidenceEligible } from "@promptlab/agent/evidence-manifest";
import { and, desc, eq, max } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; runId: string }> },
) {
  const { projectId: rawProjectId, runId: rawRunId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const runId = parseRouteId(rawRunId);
  if (!projectId || !runId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = PromptQualityVoteSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "INVALID_QUALITY_VOTE" }, { status: 400 });

  try {
    const result = await database.db.transaction(async (tx) => {
      const [run] = await tx
        .select({
          status: schema.runs.status,
          configSnapshot: schema.runs.configSnapshot,
        })
        .from(schema.runs)
        .where(
          and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)),
        )
        .for("update");
      if (!run) return { error: "RUN_NOT_FOUND" as const };
      if (
        run.status !== "succeeded" ||
        !Object.hasOwn(run.configSnapshot, "optimization")
      ) {
        return { error: "OPTIMIZATION_RESULT_NOT_READY" as const };
      }
      const [completed] = await tx
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
      const rootPayload = completed?.payload;
      if (
        !isOptimizationCandidateEvidenceEligible({
          runId,
          runStatus: run.status,
          runConfigSnapshot: run.configSnapshot,
          completionAttemptId: completed?.attemptId ?? null,
          completionPayload: rootPayload,
          candidateId: parsed.data.candidateId,
        })
      ) {
        return { error: "QUALITY_VOTE_CANDIDATE_MISMATCH" as const };
      }
      const [last] = await tx
        .select({ sequence: max(schema.runEvents.sequence) })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            eq(schema.runEvents.runId, runId),
          ),
        );
      await tx.insert(schema.runEvents).values({
        projectId,
        runId,
        sequence: (last?.sequence ?? 0) + 1,
        eventType: "optimization.vote",
        payload: {
          candidateId: parsed.data.candidateId,
          decision: parsed.data.decision,
          note: parsed.data.note,
        },
      });
      return { vote: parsed.data };
    });
    if ("error" in result) {
      const status = result.error === "RUN_NOT_FOUND" ? 404 : 409;
      return Response.json({ error: result.error }, { status });
    }
    return Response.json(result, { status: 201 });
  } catch {
    return safeApiFailure();
  }
}
