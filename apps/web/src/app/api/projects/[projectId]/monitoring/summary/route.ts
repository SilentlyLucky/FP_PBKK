import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  max,
  min,
} from "drizzle-orm";
import { schema } from "@promptlab/db";

import {
  aggregateMonitoringTelemetry,
  parseMonitoringRange,
} from "@/lib/monitoring-telemetry";
import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import { parseSanitizedUsageSnapshot } from "@/lib/usage-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const activeRunStatuses = [
  "created",
  "queued",
  "running",
  "cancel_requested",
  "paused_quota",
  "paused_auth_required",
] as const;

const agentEventTypes = [
  "agent.action",
  "agent.finished",
  "tool.started",
  "tool.completed",
] as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });

  const range = parseMonitoringRange(new URL(request.url).searchParams);
  if (!range)
    return Response.json(
      { error: "INVALID_MONITORING_RANGE" },
      { status: 400 },
    );

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const attempts = await database.db
      .select({
        id: schema.modelAttempts.id,
        provider: schema.modelAttempts.provider,
        purpose: schema.modelAttempts.purpose,
        status: schema.modelAttempts.status,
        startedAt: schema.modelAttempts.startedAt,
        finishedAt: schema.modelAttempts.finishedAt,
      })
      .from(schema.modelAttempts)
      .where(
        and(
          eq(schema.modelAttempts.projectId, projectId),
          gte(schema.modelAttempts.startedAt, range.from),
          lt(schema.modelAttempts.startedAt, range.to),
        ),
      )
      .orderBy(
        asc(schema.modelAttempts.startedAt),
        asc(schema.modelAttempts.id),
      );

    const attemptIds = attempts.map((attempt) => attempt.id);
    const [runs, usage, outputEvents, agentActivity, lastAgentActivity] =
      await Promise.all([
        database.db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.projectId, projectId),
              inArray(schema.runs.status, [...activeRunStatuses]),
            ),
          ),
        attemptIds.length
          ? database.db
              .select({
                attemptId: schema.usageRecords.attemptId,
                provenance: schema.usageRecords.provenance,
                inputTokens: schema.usageRecords.inputTokens,
                outputTokens: schema.usageRecords.outputTokens,
                cacheReadTokens: schema.usageRecords.cacheReadTokens,
                cacheWriteTokens: schema.usageRecords.cacheWriteTokens,
                sanitizedRawUsage: schema.usageRecords.sanitizedRawUsage,
              })
              .from(schema.usageRecords)
              .where(
                and(
                  eq(schema.usageRecords.projectId, projectId),
                  inArray(schema.usageRecords.attemptId, attemptIds),
                  eq(schema.usageRecords.usageScope, "response"),
                ),
              )
          : Promise.resolve([]),
        attemptIds.length
          ? database.db
              .select({
                attemptId: schema.runEvents.attemptId,
                firstAt: min(schema.runEvents.createdAt),
                lastAt: max(schema.runEvents.createdAt),
              })
              .from(schema.runEvents)
              .where(
                and(
                  eq(schema.runEvents.projectId, projectId),
                  inArray(schema.runEvents.attemptId, attemptIds),
                  eq(schema.runEvents.eventType, "output.delta"),
                ),
              )
              .groupBy(schema.runEvents.attemptId)
          : Promise.resolve([]),
        database.db
          .select({ value: count() })
          .from(schema.runEvents)
          .where(
            and(
              eq(schema.runEvents.projectId, projectId),
              inArray(schema.runEvents.eventType, [...agentEventTypes]),
              gte(schema.runEvents.createdAt, range.from),
              lt(schema.runEvents.createdAt, range.to),
            ),
          ),
        database.db
          .select({ createdAt: schema.runEvents.createdAt })
          .from(schema.runEvents)
          .where(
            and(
              eq(schema.runEvents.projectId, projectId),
              inArray(schema.runEvents.eventType, [...agentEventTypes]),
            ),
          )
          .orderBy(desc(schema.runEvents.createdAt), desc(schema.runEvents.id))
          .limit(1),
      ]);

    const sanitizedUsage = usage.map((record) => {
      let sanitizedRawUsage = null;
      try {
        sanitizedRawUsage = parseSanitizedUsageSnapshot(
          record.sanitizedRawUsage,
        );
      } catch {
        // A malformed persisted snapshot remains unavailable; normalized fields still apply.
      }
      return { ...record, sanitizedRawUsage };
    });

    const summary = aggregateMonitoringTelemetry({
      attempts,
      runs,
      usage: sanitizedUsage,
      outputEvents: outputEvents.flatMap((event) =>
        event.attemptId && event.firstAt && event.lastAt
          ? [
              {
                attemptId: event.attemptId,
                firstAt: event.firstAt,
                lastAt: event.lastAt,
              },
            ]
          : [],
      ),
      agentEventCount: agentActivity[0]?.value ?? 0,
      lastAgentActivityAt: lastAgentActivity[0]?.createdAt ?? null,
    });

    return Response.json(
      {
        projectId,
        range: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          label: range.label,
        },
        refreshedAt: new Date().toISOString(),
        summary,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    return safeApiFailure();
  }
}
