import type { UsageSnapshot } from "@promptlab/contracts";

export type MonitoringRange = {
  from: Date;
  to: Date;
  label: string;
};

export type MonitoringMetricTotal = {
  reported: number | null;
  estimated: number | null;
  reportedRecords: number;
  estimatedRecords: number;
};

export type MonitoringDistribution = {
  provider: string;
  purpose: string;
  samples: number;
  median: number | null;
  p95: number | null;
};

export interface MonitoringAttemptInput {
  id: string;
  provider: string;
  purpose: string;
  status: string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
}

export interface MonitoringRunInput {
  status: string;
}

export interface MonitoringUsageInput {
  attemptId: string | null;
  provenance: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  sanitizedRawUsage: UsageSnapshot | null;
}

export interface MonitoringOutputEventInput {
  attemptId: string;
  firstAt: Date | string;
  lastAt: Date | string;
}

export interface MonitoringTelemetryInput {
  attempts: MonitoringAttemptInput[];
  runs: MonitoringRunInput[];
  usage: MonitoringUsageInput[];
  outputEvents: MonitoringOutputEventInput[];
  agentEventCount: number;
  lastAgentActivityAt: Date | string | null;
  workerHeartbeatAt?: Date | string | null;
}

const metricFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

type MetricField = (typeof metricFields)[number];
type Provenance = "reported" | "estimated";

export type MonitoringMetricObservation = {
  status: Provenance | "unknown";
  value: number | null;
};

export type MonitoringAttemptStreamingMetrics = {
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
};

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const milliseconds =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function metricValue(
  record: MonitoringUsageInput,
  field: MetricField,
): { status: Provenance; value: number } | null {
  const observed = record.sanitizedRawUsage?.[field];
  if (observed) {
    if (
      (observed.status === "reported" || observed.status === "estimated") &&
      Number.isSafeInteger(observed.value) &&
      observed.value >= 0
    ) {
      return { status: observed.status, value: observed.value };
    }
    return null;
  }

  const value = record[field];
  if (
    (record.provenance === "reported" || record.provenance === "estimated") &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return { status: record.provenance, value };
  }
  return null;
}

export function readMonitoringMetric(
  record: MonitoringUsageInput,
  field: MetricField,
): MonitoringMetricObservation {
  return metricValue(record, field) ?? { status: "unknown", value: null };
}

export function deriveMonitoringAttemptStreamingMetrics(input: {
  startedAt: Date | string | null;
  firstOutputAt: Date | string | null;
  lastOutputAt: Date | string | null;
  reportedOutputTokens: number | null;
}): MonitoringAttemptStreamingMetrics {
  const startedAt = timestamp(input.startedAt);
  const firstOutputAt = timestamp(input.firstOutputAt);
  const lastOutputAt = timestamp(input.lastOutputAt);
  const timeToFirstTokenMs =
    startedAt !== null && firstOutputAt !== null && firstOutputAt >= startedAt
      ? firstOutputAt - startedAt
      : null;
  const durationSeconds =
    firstOutputAt !== null &&
    lastOutputAt !== null &&
    lastOutputAt > firstOutputAt
      ? (lastOutputAt - firstOutputAt) / 1_000
      : null;
  const tokensPerSecond =
    input.reportedOutputTokens !== null &&
    Number.isSafeInteger(input.reportedOutputTokens) &&
    input.reportedOutputTokens > 0 &&
    durationSeconds !== null
      ? input.reportedOutputTokens / durationSeconds
      : null;

  return {
    timeToFirstTokenMs,
    tokensPerSecond:
      tokensPerSecond !== null && Number.isFinite(tokensPerSecond)
        ? tokensPerSecond
        : null,
  };
}

function safeTotal(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function aggregateMetric(
  records: MonitoringUsageInput[],
  field: MetricField,
): MonitoringMetricTotal {
  const reported: number[] = [];
  const estimated: number[] = [];

  for (const record of records) {
    const value = metricValue(record, field);
    if (!value) continue;
    (value.status === "reported" ? reported : estimated).push(value.value);
  }

  return {
    reported: safeTotal(reported),
    estimated: safeTotal(estimated),
    reportedRecords: reported.length,
    estimatedRecords: estimated.length,
  };
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? null;
}

function distributionGroups(
  values: Array<{ provider: string; purpose: string; milliseconds: number }>,
): MonitoringDistribution[] {
  const groups = new Map<string, number[]>();
  for (const value of values) {
    const key = `${value.provider}\u0000${value.purpose}`;
    const group = groups.get(key) ?? [];
    group.push(value.milliseconds);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, durations]) => {
      const [provider, purpose] = key.split("\u0000");
      const sorted = [...durations].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0
          ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
          : (sorted[middle] ?? null);
      return {
        provider: provider ?? "",
        purpose: purpose ?? "",
        samples: sorted.length,
        median,
        p95: percentile(sorted, 0.95),
      };
    })
    .sort((left, right) =>
      `${left.provider}:${left.purpose}`.localeCompare(
        `${right.provider}:${right.purpose}`,
      ),
    );
}

function toIso(value: Date | string | null): string | null {
  const milliseconds = timestamp(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

export function parseMonitoringRange(
  params: URLSearchParams,
  now = new Date(),
): MonitoringRange | null {
  const fromParam = params.get("from");
  const toParam = params.get("to");
  if (fromParam !== null || toParam !== null) {
    if (!fromParam || !toParam) return null;
    const from = new Date(fromParam);
    const to = new Date(toParam);
    const duration = to.getTime() - from.getTime();
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      duration <= 0 ||
      duration > 90 * 24 * 60 * 60 * 1000
    ) {
      return null;
    }
    return { from, to, label: "rentang khusus" };
  }

  const range = params.get("range") ?? "24h";
  const durations: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  const duration = durations[range];
  if (!duration || !Number.isFinite(now.getTime())) return null;
  return {
    from: new Date(now.getTime() - duration),
    to: now,
    label: range,
  };
}

export function aggregateMonitoringTelemetry(input: MonitoringTelemetryInput) {
  const statusCounts: Record<string, number> = {};
  for (const attempt of input.attempts) {
    statusCounts[attempt.status] = (statusCounts[attempt.status] ?? 0) + 1;
  }

  const succeeded = statusCounts.succeeded ?? 0;
  const failed = statusCounts.failed ?? 0;
  const errorDenominator = succeeded + failed;
  const canceled = statusCounts.canceled ?? 0;
  const unknown = statusCounts.unknown ?? 0;
  const inProgress = input.attempts.filter((attempt) =>
    ["created", "running"].includes(attempt.status),
  ).length;

  const runStatusCounts: Record<string, number> = {};
  for (const run of input.runs) {
    runStatusCounts[run.status] = (runStatusCounts[run.status] ?? 0) + 1;
  }
  const terminalRunStates = new Set([
    "succeeded",
    "failed",
    "canceled",
    "interrupted_unknown",
  ]);

  const outputTokenByAttempt = new Map<string, number[]>();
  for (const record of input.usage) {
    if (!record.attemptId) continue;
    const output = metricValue(record, "outputTokens");
    if (output?.status === "reported") {
      const values = outputTokenByAttempt.get(record.attemptId) ?? [];
      values.push(output.value);
      outputTokenByAttempt.set(record.attemptId, values);
    }
  }

  const attemptById = new Map(
    input.attempts.map((attempt) => [attempt.id, attempt]),
  );
  const timeToFirstToken: Array<{
    provider: string;
    purpose: string;
    milliseconds: number;
  }> = [];
  const tokensPerSecond: Array<{
    provider: string;
    purpose: string;
    milliseconds: number;
  }> = [];
  for (const event of input.outputEvents) {
    const attempt = attemptById.get(event.attemptId);
    if (!attempt) continue;
    const reportedOutputs = outputTokenByAttempt.get(attempt.id) ?? [];
    const streamingMetrics = deriveMonitoringAttemptStreamingMetrics({
      startedAt: attempt.startedAt,
      firstOutputAt: event.firstAt,
      lastOutputAt: event.lastAt,
      reportedOutputTokens:
        reportedOutputs.length === 1 ? (reportedOutputs[0] ?? null) : null,
    });
    if (streamingMetrics.timeToFirstTokenMs !== null)
      timeToFirstToken.push({
        provider: attempt.provider,
        purpose: attempt.purpose,
        milliseconds: streamingMetrics.timeToFirstTokenMs,
      });
    if (streamingMetrics.tokensPerSecond !== null)
      tokensPerSecond.push({
        provider: attempt.provider,
        purpose: attempt.purpose,
        milliseconds: streamingMetrics.tokensPerSecond,
      });
  }

  const durationSamples: Array<{
    provider: string;
    purpose: string;
    milliseconds: number;
  }> = [];
  for (const attempt of input.attempts) {
    const startedAt = timestamp(attempt.startedAt);
    const finishedAt = timestamp(attempt.finishedAt);
    if (startedAt === null || finishedAt === null || finishedAt <= startedAt)
      continue;
    durationSamples.push({
      provider: attempt.provider,
      purpose: attempt.purpose,
      milliseconds: finishedAt - startedAt,
    });
  }

  const tokenTotals = {
    input: aggregateMetric(input.usage, "inputTokens"),
    output: aggregateMetric(input.usage, "outputTokens"),
    cacheRead: aggregateMetric(input.usage, "cacheReadTokens"),
    cacheWrite: aggregateMetric(input.usage, "cacheWriteTokens"),
  };

  let compatibleCacheInput = 0;
  let compatibleCacheRead = 0;
  let compatibleCacheRecords = 0;
  for (const record of input.usage) {
    const inputValue = metricValue(record, "inputTokens");
    const cacheValue = metricValue(record, "cacheReadTokens");
    if (
      inputValue?.status !== "reported" ||
      cacheValue?.status !== "reported" ||
      cacheValue.value > inputValue.value
    ) {
      continue;
    }
    compatibleCacheInput += inputValue.value;
    compatibleCacheRead += cacheValue.value;
    compatibleCacheRecords += 1;
  }

  return {
    requests: {
      total: input.attempts.length,
      succeeded,
      failed,
      canceled,
      unknown,
      inProgress,
      byStatus: statusCounts,
      errorRate: errorDenominator > 0 ? failed / errorDenominator : null,
      errorRateDenominator: errorDenominator,
    },
    activeRuns: {
      total: input.runs.filter((run) => !terminalRunStates.has(run.status))
        .length,
      byStatus: runStatusCounts,
    },
    tokens: {
      ...tokenTotals,
      cacheReadShare:
        compatibleCacheInput > 0
          ? compatibleCacheRead / compatibleCacheInput
          : null,
      cacheReadShareRecords: compatibleCacheRecords,
      usageRecords: input.usage.length,
    },
    latency: distributionGroups(durationSamples),
    timeToFirstToken: distributionGroups(timeToFirstToken),
    tokensPerSecond: distributionGroups(tokensPerSecond),
    agentActivity: {
      eventsInRange: input.agentEventCount,
      lastObservedAt: toIso(input.lastAgentActivityAt),
      status: input.agentEventCount > 0 ? "observed" : "unavailable",
    },
    worker: {
      status: input.workerHeartbeatAt ? "observed" : "unavailable",
      lastHeartbeatAt: toIso(input.workerHeartbeatAt ?? null),
      reason: input.workerHeartbeatAt
        ? null
        : "Telemetry heartbeat worker belum tersedia.",
    },
  };
}
