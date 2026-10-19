import { and, eq, max } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string; runId: string }> },
) {
  const { projectId: rawProjectId, runId: rawRunId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const runId = parseRouteId(rawRunId);
  if (!projectId || !runId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const result = await database.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(
          and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)),
        )
        .for("update");
      if (!run) return { notFound: true as const };
      if (!["queued", "running", "cancel_requested"].includes(run.status)) {
        return { status: run.status, canceled: false };
      }

      const now = new Date();
      await tx
        .update(schema.runs)
        .set({
          status: "canceled",
          cancelRequestedAt: now,
          finishedAt: now,
          errorCode: null,
          errorSummary: null,
        })
        .where(
          and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)),
        );
      await tx
        .update(schema.modelAttempts)
        .set({ status: "canceled", remoteOutcomeKnown: false, finishedAt: now })
        .where(
          and(
            eq(schema.modelAttempts.projectId, projectId),
            eq(schema.modelAttempts.runId, runId),
            eq(schema.modelAttempts.status, "running"),
          ),
        );
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
        eventType: "run.status",
        payload: {
          status: "canceled",
          mode: "prompt_optimization",
          remoteOutcomeMayBeUnknown: run.status === "running",
        },
      });
      return { status: "canceled", canceled: true };
    });
    if ("notFound" in result)
      return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
    return Response.json({ runId, ...result });
  } catch {
    return Response.json({ error: "RUN_CANCEL_FAILED" }, { status: 500 });
  }
}
