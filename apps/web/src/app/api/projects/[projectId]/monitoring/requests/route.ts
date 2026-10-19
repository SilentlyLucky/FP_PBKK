import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  max,
  min,
  or,
  sql,
} from "drizzle-orm";
import { schema } from "@promptlab/db";

import {
  deriveMonitoringAttemptStreamingMetrics,
  parseMonitoringRange,
  readMonitoringMetric,
  type MonitoringUsageInput,
} from "@/lib/monitoring-telemetry";
import {
  safeMonitoringErrorCode,
  safeMonitoringModel,
} from "@/lib/monitoring-client";
import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import { parseSanitizedUsageSnapshot } from "@/lib/usage-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const attemptStatuses = [
  "created",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
] as const;

const providers = [
  "campus_gateway",
  "codex_app_server",
  "claude_cli",
  "fixture",
] as const;

const purposes = [
  "optimizer",
  "target",
  "evaluator",
  "auxiliary",
  "graph_indexing",
  "graph_query_model",
] as const;

function positiveInteger(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });

  const params = new URL(request.url).searchParams;
  const range = parseMonitoringRange(params);
  if (!range)
    return Response.json(
      { error: "INVALID_MONITORING_RANGE" },
      { status: 400 },
    );

  const page = positiveInteger(params.get("page"), 1);
  const pageSize = positiveInteger(params.get("pageSize"), 20);
  const status = params.get("status");
  const provider = params.get("provider");
  const purpose = params.get("purpose");
  const search = params.get("search")?.trim() ?? "";
  if (
    page === null ||
    page > 1_000 ||
    pageSize === null ||
    pageSize > 50 ||
    (status &&
      status !== "all" &&
      !attemptStatuses.includes(status as never)) ||
    (provider &&
      provider !== "all" &&
      !providers.includes(provider as never)) ||
    (purpose && purpose !== "all" && !purposes.includes(purpose as never)) ||
    search.length > 120
  ) {
    return Response.json({ error: "INVALID_REQUEST_FILTER" }, { status: 400 });
  }

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const conditions = [
      eq(schema.modelAttempts.projectId, projectId),
      gte(schema.modelAttempts.startedAt, range.from),
      lt(schema.modelAttempts.startedAt, range.to),
    ];
    if (status && status !== "all")
      conditions.push(
        eq(
          schema.modelAttempts.status,
          status as (typeof attemptStatuses)[number],
        ),
      );
    if (provider && provider !== "all")
      conditions.push(
        eq(
          schema.modelAttempts.provider,
          provider as (typeof providers)[number],
        ),
      );
    if (purpose && purpose !== "all")
      conditions.push(
        eq(schema.modelAttempts.purpose, purpose as (typeof purposes)[number]),
      );
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        or(
          sql`${schema.modelAttempts.id}::text ilike ${pattern} escape '\\'`,
          sql`${schema.modelAttempts.runId}::text ilike ${pattern} escape '\\'`,
          ilike(schema.modelAttempts.provider, pattern),
          ilike(schema.modelAttempts.requestedModel, pattern),
          ilike(schema.modelAttempts.responseModel, pattern),
          ilike(schema.modelAttempts.purpose, pattern),
        )!,
      );
    }
    const where = and(...conditions);

    const [totalRows, attempts] = await Promise.all([
      database.db
        .select({ value: count() })
        .from(schema.modelAttempts)
        .where(where),
      database.db
        .select({
          attemptId: schema.modelAttempts.id,
          runId: schema.modelAttempts.runId,
          attemptNumber: schema.modelAttempts.attemptNumber,
          provider: schema.modelAttempts.provider,
          purpose: schema.modelAttempts.purpose,
          requestedModel: schema.modelAttempts.requestedModel,
          responseModel: schema.modelAttempts.responseModel,
          status: schema.modelAttempts.status,
          remoteOutcomeKnown: schema.modelAttempts.remoteOutcomeKnown,
          startedAt: schema.modelAttempts.startedAt,
          finishedAt: schema.modelAttempts.finishedAt,
          errorCode: schema.modelAttempts.errorCode,
        })
        .from(schema.modelAttempts)
        .where(where)
        .orderBy(
          desc(schema.modelAttempts.startedAt),
          desc(schema.modelAttempts.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const attemptIds = attempts.map((attempt) => attempt.attemptId);
    const [usageRecords, outputEvents] = await Promise.all([
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
              createdAt: schema.usageRecords.createdAt,
            })
            .from(schema.usageRecords)
            .where(
              and(
                eq(schema.usageRecords.projectId, projectId),
                inArray(schema.usageRecords.attemptId, attemptIds),
                eq(schema.usageRecords.usageScope, "response"),
              ),
            )
            .orderBy(desc(schema.usageRecords.createdAt))
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
    ]);

    const usageByAttempt = new Map<
      string,
      { usage: MonitoringUsageInput; count: number }
    >();
    for (const record of usageRecords) {
      if (!record.attemptId) continue;
      let sanitizedRawUsage = null;
      try {
        sanitizedRawUsage = parseSanitizedUsageSnapshot(
          record.sanitizedRawUsage,
        );
      } catch {
        // Invalid stored details remain unavailable instead of breaking the log page.
      }
      const previous = usageByAttempt.get(record.attemptId);
      if (previous) {
        previous.count += 1;
      } else {
        usageByAttempt.set(record.attemptId, {
          usage: { ...record, sanitizedRawUsage },
          count: 1,
        });
      }
    }

    const outputEventByAttempt = new Map(
      outputEvents.flatMap((event) =>
        event.attemptId && event.firstAt && event.lastAt
          ? [[event.attemptId, event] as const]
          : [],
      ),
    );

    const total = totalRows[0]?.value ?? 0;
    const requests = attempts.map((attempt) => {
      const usageEntry = usageByAttempt.get(attempt.attemptId);
      const usage = usageEntry?.usage;
      const outputEvent = outputEventByAttempt.get(attempt.attemptId);
      const reportedOutput =
        usageEntry?.count === 1 && usage
          ? readMonitoringMetric(usage, "outputTokens")
          : null;
      const streamingMetrics = deriveMonitoringAttemptStreamingMetrics({
        startedAt: attempt.startedAt,
        firstOutputAt: outputEvent?.firstAt ?? null,
        lastOutputAt: outputEvent?.lastAt ?? null,
        reportedOutputTokens:
          reportedOutput?.status === "reported" ? reportedOutput.value : null,
      });
      const startedAt = attempt.startedAt?.toISOString() ?? null;
      const finishedAt = attempt.finishedAt?.toISOString() ?? null;
      const durationMs =
        attempt.startedAt && attempt.finishedAt
          ? attempt.finishedAt.getTime() - attempt.startedAt.getTime()
          : null;
      return {
        ...attempt,
        requestedModel:
          safeMonitoringModel(attempt.requestedModel) ?? "unknown",
        responseModel: safeMonitoringModel(attempt.responseModel),
        errorCode: safeMonitoringErrorCode(attempt.errorCode),
        startedAt,
        finishedAt,
        durationMs: durationMs !== null && durationMs >= 0 ? durationMs : null,
        timeToFirstTokenMs: streamingMetrics.timeToFirstTokenMs,
        tokensPerSecond: streamingMetrics.tokensPerSecond,
        usage: usage
          ? {
              inputTokens: readMonitoringMetric(usage, "inputTokens"),
              outputTokens: readMonitoringMetric(usage, "outputTokens"),
              cacheReadTokens: readMonitoringMetric(usage, "cacheReadTokens"),
              cacheWriteTokens: readMonitoringMetric(usage, "cacheWriteTokens"),
              completeness: usage.sanitizedRawUsage?.completeness ?? null,
            }
          : null,
      };
    });

    return Response.json(
      {
        projectId,
        range: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          label: range.label,
        },
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        requests,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    return safeApiFailure();
  }
}
