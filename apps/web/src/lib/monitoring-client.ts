export interface MonitoringRequestScope {
  projectId: string | null;
  range: string;
  page: number;
  search: string;
  status: string;
  provider: string;
  purpose: string;
}

export function monitoringRequestScopeKey(
  scope: MonitoringRequestScope,
): string {
  return JSON.stringify(scope);
}

export interface MonitoringActivityIdentity {
  id: string;
  runId: string;
  sequence: number;
}

export interface MonitoringActivitySeenSet {
  ids: Set<string>;
  sequences: Set<string>;
  order: Array<{ id: string; sequence: string }>;
}

export function createMonitoringActivitySeenSet(): MonitoringActivitySeenSet {
  return { ids: new Set(), sequences: new Set(), order: [] };
}

export function rememberMonitoringActivity(
  event: MonitoringActivityIdentity,
  seen: MonitoringActivitySeenSet,
  maxEntries = 2_000,
): boolean {
  const sequenceKey = `${event.runId}:${event.sequence}`;
  if (seen.ids.has(event.id) || seen.sequences.has(sequenceKey)) return false;

  seen.ids.add(event.id);
  seen.sequences.add(sequenceKey);
  seen.order.push({ id: event.id, sequence: sequenceKey });
  while (seen.order.length > Math.max(1, maxEntries)) {
    const expired = seen.order.shift();
    if (!expired) break;
    seen.ids.delete(expired.id);
    seen.sequences.delete(expired.sequence);
  }
  return true;
}

export interface MonitoringCsvMetric {
  status: "reported" | "estimated" | "unknown";
  value: number | null;
}

export interface MonitoringCsvRequest {
  startedAt: string | null;
  finishedAt: string | null;
  attemptId: string;
  runId: string;
  attemptNumber: number;
  provider: string;
  purpose: string;
  requestedModel: string;
  responseModel: string | null;
  status: string;
  remoteOutcomeKnown: boolean;
  usage: {
    inputTokens: MonitoringCsvMetric;
    outputTokens: MonitoringCsvMetric;
    cacheReadTokens: MonitoringCsvMetric;
    cacheWriteTokens: MonitoringCsvMetric;
    completeness: string | null;
  } | null;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  durationMs: number | null;
  errorCode: string | null;
}

function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function metricCsvValue(metric: MonitoringCsvMetric | undefined): string {
  if (!metric || metric.status === "unknown" || metric.value === null)
    return "unknown";
  return `${metric.value} (${metric.status})`;
}

export function createMonitoringRequestCsv(
  requests: readonly MonitoringCsvRequest[],
): string {
  const columns = [
    "started_at",
    "finished_at",
    "attempt_id",
    "run_id",
    "attempt_number",
    "provider",
    "purpose",
    "requested_model",
    "response_model",
    "status",
    "remote_outcome_known",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "usage_completeness",
    "time_to_first_token_ms",
    "tokens_per_second",
    "duration_ms",
    "error_code",
  ];
  const rows = requests.map((request) => [
    request.startedAt,
    request.finishedAt,
    request.attemptId,
    request.runId,
    request.attemptNumber,
    request.provider,
    request.purpose,
    request.requestedModel,
    request.responseModel,
    request.status,
    request.remoteOutcomeKnown,
    metricCsvValue(request.usage?.inputTokens),
    metricCsvValue(request.usage?.outputTokens),
    metricCsvValue(request.usage?.cacheReadTokens),
    metricCsvValue(request.usage?.cacheWriteTokens),
    request.usage?.completeness ?? null,
    request.timeToFirstTokenMs,
    request.tokensPerSecond,
    request.durationMs,
    request.errorCode,
  ]);
  return [columns, ...rows]
    .map((row) => row.map((value) => csvCell(value)).join(","))
    .join("\r\n");
}

const secretLikeSource =
  "\\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ya29\\.[A-Za-z0-9_-]{10,})\\b|\\b(?:api[_ -]?key|access[_ -]?token|secret|password|authorization)\\b\\s*[:=]\\s*\\S+";

export function safeMonitoringModel(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(new RegExp(secretLikeSource, "gi"), "[redacted]")
    .slice(0, 200);
}

export function safeMonitoringErrorCode(value: string | null): string | null {
  if (value === null) return null;
  if (new RegExp(secretLikeSource, "i").test(value)) return "REDACTED";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : "UNKNOWN_ERROR";
}
