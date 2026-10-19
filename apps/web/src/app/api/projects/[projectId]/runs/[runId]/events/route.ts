import { setTimeout as sleep } from "node:timers/promises";

import { isOptimizationCandidateEvidenceEligible } from "@promptlab/agent/evidence-manifest";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const terminalStates = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted_unknown",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function projectCompletionEvidence(input: {
  runId: string;
  runStatus: string;
  runConfigSnapshot: Record<string, unknown>;
  attemptId: string | null;
  value: unknown;
}): unknown {
  const { runId, runStatus, runConfigSnapshot, attemptId, value } = input;
  const payload = asRecord(value);
  const result = asRecord(payload?.result);
  if (payload?.mode !== "prompt_optimization" || !result) {
    return value;
  }
  const rawCandidates = Array.isArray(result.candidates)
    ? result.candidates
    : result.candidate === null || result.candidate === undefined
      ? []
      : [result.candidate];
  const candidates = rawCandidates.map((value) => {
    const candidate = asRecord(value);
    if (!candidate || typeof candidate.id !== "string") return value;
    return {
      ...candidate,
      evidenceEligible: isOptimizationCandidateEvidenceEligible({
        runId,
        runStatus,
        runConfigSnapshot,
        completionAttemptId: attemptId,
        completionPayload: payload,
        candidateId: candidate.id,
      }),
    };
  });
  const declaredCandidateId =
    typeof result.reviewableCandidateId === "string"
      ? result.reviewableCandidateId
      : candidates.find((value) => asRecord(value)?.evidenceEligible === true)
        ? (asRecord(
            candidates.find(
              (value) => asRecord(value)?.evidenceEligible === true,
            ),
          )?.id as string)
        : null;
  const reviewableCandidateId = candidates.some(
    (value) =>
      asRecord(value)?.id === declaredCandidateId &&
      asRecord(value)?.evidenceEligible === true,
  )
    ? declaredCandidateId
    : null;
  const legacy = asRecord(result.candidate);
  const projectedLegacy = legacy
    ? {
        ...legacy,
        evidenceEligible: isOptimizationCandidateEvidenceEligible({
          runId,
          runStatus,
          runConfigSnapshot,
          completionAttemptId: attemptId,
          completionPayload: payload,
          candidateId:
            typeof legacy.id === "string" ? legacy.id : "unavailable",
        }),
      }
    : result.candidate;
  return {
    ...payload,
    result: {
      ...result,
      candidates,
      latestCandidateId:
        typeof result.latestCandidateId === "string"
          ? result.latestCandidateId
          : (asRecord(candidates.at(-1))?.id ?? null),
      reviewableCandidateId,
      candidate: projectedLegacy,
    },
  };
}

export async function GET(
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

  const [run] = await database.db
    .select({
      id: schema.runs.id,
      status: schema.runs.status,
      configSnapshot: schema.runs.configSnapshot,
    })
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)))
    .limit(1);
  if (!run) return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });

  let latestCompletion = (
    await database.db
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
      .limit(1)
  )[0] ?? null;

  const headerCursor = Number(request.headers.get("last-event-id") ?? 0);
  const queryCursor = Number(
    new URL(request.url).searchParams.get("after") ?? 0,
  );
  let cursor =
    Number.isSafeInteger(headerCursor) && headerCursor > 0
      ? headerCursor
      : Number.isSafeInteger(queryCursor) && queryCursor > 0
        ? queryCursor
        : 0;
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          /* Client may already have disconnected. */
        }
      };
      const abort = () => close();
      request.signal.addEventListener("abort", abort, { once: true });
      void (async () => {
        if (!closed && !request.signal.aborted)
          controller.enqueue(encoder.encode("retry: 2500\n\n"));
        let lastHeartbeat = Date.now();
        while (!closed && !request.signal.aborted) {
          const [current] = await database.db
            .select({ status: schema.runs.status })
            .from(schema.runs)
            .where(
              and(
                eq(schema.runs.projectId, projectId),
                eq(schema.runs.id, runId),
              ),
            )
            .limit(1);
          const events = await database.db
            .select({
              id: schema.runEvents.id,
              sequence: schema.runEvents.sequence,
              attemptId: schema.runEvents.attemptId,
              eventType: schema.runEvents.eventType,
              payload: schema.runEvents.payload,
              createdAt: schema.runEvents.createdAt,
            })
            .from(schema.runEvents)
            .where(
              and(
                eq(schema.runEvents.projectId, projectId),
                eq(schema.runEvents.runId, runId),
                gt(schema.runEvents.sequence, cursor),
              ),
            )
            .orderBy(asc(schema.runEvents.sequence))
            .limit(100);

          for (const event of events) {
            cursor = event.sequence;
            if (event.eventType === "run.completed") {
              latestCompletion = {
                attemptId: event.attemptId,
                payload: event.payload,
              };
            }
            const payload = event.eventType === "run.completed"
              ? projectCompletionEvidence({
                  runId,
                  runStatus: current?.status ?? run.status,
                  runConfigSnapshot: run.configSnapshot,
                  attemptId: event.attemptId,
                  value: event.payload,
                })
              : event.eventType === "optimization.vote"
                ? {
                    ...(asRecord(event.payload) ?? {}),
                    evidenceEligible: latestCompletion
                      ? isOptimizationCandidateEvidenceEligible({
                          runId,
                          runStatus: current?.status ?? run.status,
                          runConfigSnapshot: run.configSnapshot,
                          completionAttemptId: latestCompletion.attemptId,
                          completionPayload: latestCompletion.payload,
                          candidateId:
                            typeof asRecord(event.payload)?.candidateId ===
                            "string"
                              ? (asRecord(event.payload)?.candidateId as string)
                              : "unavailable",
                        })
                      : false,
                  }
                : event.payload;
            const data = JSON.stringify({
              id: event.id,
              sequence: event.sequence,
              timestamp: event.createdAt.toISOString(),
              eventType: event.eventType,
              payload,
            });
            if (!closed && !request.signal.aborted)
              controller.enqueue(
                encoder.encode(
                  `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${data}\n\n`,
                ),
              );
          }

          if (
            !current ||
            (terminalStates.has(current.status) && events.length === 0)
          ) {
            if (!closed && !request.signal.aborted && current && terminalStates.has(current.status)) {
              controller.enqueue(
                encoder.encode(
                  `event: run.stream.ended\ndata: ${JSON.stringify({ status: current.status })}\n\n`,
                ),
              );
            }
            close();
            return;
          }
          if (Date.now() - lastHeartbeat > 15_000) {
            if (!closed && !request.signal.aborted)
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
            lastHeartbeat = Date.now();
          }
          await sleep(750, undefined, { signal: request.signal }).catch(
            () => undefined,
          );
        }
        close();
      })().catch(() => {
        if (!closed) {
          controller.enqueue(
            encoder.encode(
              'event: error\ndata: {"error":"EVENT_STREAM_UNAVAILABLE"}\n\n',
            ),
          );
          close();
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
