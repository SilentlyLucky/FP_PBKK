import { createHash } from "node:crypto";

import {
  OptimizationClarificationAnswerRequestSchema,
  OptimizationClarificationAnsweredEventSchema,
} from "@promptlab/contracts";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import {
  decideClarificationAnswer,
  decideClarificationPromptVersionScope,
  type StoredClarificationEvent,
} from "@/lib/optimization-clarifications";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: {
    params: Promise<{
      projectId: string;
      runId: string;
      clarificationId: string;
    }>;
  },
) {
  const {
    projectId: rawProjectId,
    runId: rawRunId,
    clarificationId: rawClarificationId,
  } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const runId = parseRouteId(rawRunId);
  const clarificationId = parseRouteId(rawClarificationId);
  if (!projectId || !runId || !clarificationId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = OptimizationClarificationAnswerRequestSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "INVALID_CLARIFICATION_ANSWER" },
      { status: 400 },
    );

  const idempotencyKeyHash = createHash("sha256")
    .update(
      [
        "promptlab-clarification-answer-v1",
        projectId,
        runId,
        clarificationId,
        parsed.data.idempotencyKey,
      ].join(":"),
    )
    .digest("hex");
  const answerHash = createHash("sha256")
    .update(parsed.data.answer)
    .digest("hex");

  try {
    const result = await database.db.transaction(async (tx) => {
      const [run] = await tx
        .select({
          id: schema.runs.id,
          status: schema.runs.status,
          promptVersionId: schema.runs.promptVersionId,
          configSnapshot: schema.runs.configSnapshot,
          purpose: schema.runs.purpose,
          provider: schema.runs.provider,
          requestedModel: schema.runs.requestedModel,
          createdAt: schema.runs.createdAt,
        })
        .from(schema.runs)
        .where(
          and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)),
        )
        .for("update");
      if (!run) return { kind: "run_not_found" as const };
      if (!Object.hasOwn(run.configSnapshot, "optimization"))
        return { kind: "clarification_not_found" as const };

      const events: StoredClarificationEvent[] = await tx
        .select({
          id: schema.runEvents.id,
          projectId: schema.runEvents.projectId,
          runId: schema.runEvents.runId,
          sequence: schema.runEvents.sequence,
          eventType: schema.runEvents.eventType,
          payload: schema.runEvents.payload,
          createdAt: schema.runEvents.createdAt,
        })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, projectId),
            eq(schema.runEvents.runId, runId),
            inArray(schema.runEvents.eventType, [
              "optimization.clarification.requested",
              "optimization.clarification.answered",
            ]),
          ),
        )
        .orderBy(asc(schema.runEvents.sequence));

      const decision = decideClarificationAnswer({
        events,
        projectId,
        runId,
        runStatus: run.status,
        runPromptVersionId: run.promptVersionId,
        clarificationId,
        idempotencyKeyHash,
        answerHash,
      });
      if (decision.status === "replay") {
        return {
          kind: "resumed" as const,
          clarificationId,
          run: { ...run, status: run.status },
        };
      }
      if (decision.status === "idempotency_conflict")
        return { kind: "idempotency_conflict" as const };
      if (decision.status === "not_found")
        return { kind: "clarification_not_found" as const };
      if (decision.status === "stale") return { kind: "stale" as const };

      const [promptScope] = await tx
        .select({
          promptId: schema.promptVersions.promptId,
          currentVersionId: schema.prompts.currentVersionId,
          promptDeletedAt: schema.prompts.deletedAt,
          projectDeletedAt: schema.projects.deletedAt,
        })
        .from(schema.promptVersions)
        .innerJoin(
          schema.prompts,
          and(
            eq(schema.prompts.projectId, schema.promptVersions.projectId),
            eq(schema.prompts.id, schema.promptVersions.promptId),
          ),
        )
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.promptVersions.projectId),
        )
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            eq(schema.promptVersions.id, decision.question.promptVersionId),
          ),
        )
        .limit(1);
      const promptVersionScope = promptScope
        ? decideClarificationPromptVersionScope({
            questionPromptId: decision.question.promptId,
            questionPromptVersionId: decision.question.promptVersionId,
            runPromptId: promptScope.promptId,
            runPromptVersionId: run.promptVersionId,
            currentPromptVersionId: promptScope.currentVersionId,
            promptDeletedAt: promptScope.promptDeletedAt,
            projectDeletedAt: promptScope.projectDeletedAt,
          })
        : "invalid";
      if (promptVersionScope === "invalid") {
        return { kind: "stale" as const };
      }

      const answerEvent = OptimizationClarificationAnsweredEventSchema.parse({
        clarificationId,
        answer: parsed.data.answer,
        promptId: decision.question.promptId,
        promptVersionId: decision.question.promptVersionId,
        idempotencyKeyHash,
        answerHash,
      });
      const [lastEvent] = await tx
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
        sequence: (lastEvent?.sequence ?? 0) + 1,
        eventType: "optimization.clarification.answered",
        payload: answerEvent,
      });
      await tx
        .update(schema.runs)
        .set({
          status: "queued",
          startedAt: null,
          finishedAt: null,
          cancelRequestedAt: null,
          errorCode: null,
          errorSummary: null,
        })
        .where(
          and(
            eq(schema.runs.projectId, projectId),
            eq(schema.runs.id, runId),
            eq(schema.runs.status, "queued"),
          ),
        );
      await tx.insert(schema.outbox).values({
        projectId,
        aggregateId: runId,
        eventType: "run.enqueue",
        payload: { projectId, runId },
      });
      return {
        kind: "resumed" as const,
        clarificationId,
        run: { ...run, status: "queued" },
      };
    });

    if (result.kind === "run_not_found")
      return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
    if (result.kind === "clarification_not_found")
      return Response.json(
        { error: "CLARIFICATION_NOT_FOUND" },
        { status: 404 },
      );
    if (result.kind === "idempotency_conflict")
      return Response.json(
        { error: "IDEMPOTENCY_KEY_CONFLICT" },
        { status: 409 },
      );
    if (result.kind === "stale")
      return Response.json({ error: "CLARIFICATION_STALE" }, { status: 409 });
    return Response.json({
      resumed: true,
      run: result.run,
      clarificationId: result.clarificationId,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return safeApiFailure(409);
    return safeApiFailure();
  }
}
