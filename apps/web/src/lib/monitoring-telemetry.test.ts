import { describe, expect, it } from "vitest";

import type { UsageSnapshot } from "@promptlab/contracts";
import {
  aggregateMonitoringTelemetry,
  deriveMonitoringAttemptStreamingMetrics,
  parseMonitoringRange,
  type MonitoringUsageInput,
} from "./monitoring-telemetry.js";

function usageMetric(
  status: "reported" | "estimated" | "unknown",
  value: number | null,
) {
  if (status === "unknown")
    return { status, value: null, reason: "Provider tidak melaporkan metrik." };
  return {
    status,
    value: value ?? 0,
    observedAt: "2026-10-16T00:00:00.000Z",
    method: "provider response",
  };
}

function usageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    inputTokens: usageMetric("unknown", null),
    outputTokens: usageMetric("unknown", null),
    cacheReadTokens: usageMetric("unknown", null),
    cacheWriteTokens: usageMetric("unknown", null),
    completeness: "partial",
    responseId: null,
    mapperVersion: "test",
    ...overrides,
  };
}

function usageRecord(
  input: Partial<MonitoringUsageInput> = {},
): MonitoringUsageInput {
  return {
    attemptId: "attempt-1",
    provenance: "unknown",
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    sanitizedRawUsage: null,
    ...input,
  };
}

describe("monitoring telemetry aggregation", () => {
  it("counts model attempts and keeps canceled or unknown outcomes out of error rate", () => {
    const summary = aggregateMonitoringTelemetry({
      attempts: [
        {
          id: "a1",
          provider: "campus_gateway",
          purpose: "optimizer",
          status: "succeeded",
          startedAt: "2026-10-16T00:00:00.000Z",
          finishedAt: "2026-10-16T00:00:01.000Z",
        },
        {
          id: "a2",
          provider: "campus_gateway",
          purpose: "optimizer",
          status: "failed",
          startedAt: "2026-10-16T00:00:00.000Z",
          finishedAt: "2026-10-16T00:00:02.000Z",
        },
        {
          id: "a3",
          provider: "codex_app_server",
          purpose: "target",
          status: "canceled",
          startedAt: "2026-10-16T00:00:00.000Z",
          finishedAt: null,
        },
        {
          id: "a4",
          provider: "codex_app_server",
          purpose: "target",
          status: "unknown",
          startedAt: "2026-10-16T00:00:00.000Z",
          finishedAt: null,
        },
      ],
      runs: [
        { status: "running" },
        { status: "paused_quota" },
        { status: "succeeded" },
      ],
      usage: [],
      outputEvents: [],
      agentEventCount: 0,
      lastAgentActivityAt: null,
    });

    expect(summary.requests).toMatchObject({
      total: 4,
      succeeded: 1,
      failed: 1,
      canceled: 1,
      unknown: 1,
      errorRate: 0.5,
      errorRateDenominator: 2,
    });
    expect(summary.activeRuns.total).toBe(2);
    expect(summary.tokens.input).toMatchObject({
      reported: null,
      estimated: null,
    });
    expect(summary.agentActivity.status).toBe("unavailable");
    expect(summary.worker.status).toBe("unavailable");
  });

  it("aggregates each token metric by its own provenance and leaves missing values unavailable", () => {
    const summary = aggregateMonitoringTelemetry({
      attempts: [],
      runs: [],
      usage: [
        usageRecord({
          provenance: "reported",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 40,
          sanitizedRawUsage: usageSnapshot({
            inputTokens: usageMetric("reported", 100),
            outputTokens: usageMetric("reported", 20),
            cacheReadTokens: usageMetric("reported", 40),
          }),
        }),
        usageRecord({
          attemptId: "attempt-2",
          provenance: "reported",
          inputTokens: 200,
          outputTokens: 30,
          cacheReadTokens: 50,
          sanitizedRawUsage: usageSnapshot({
            inputTokens: usageMetric("estimated", 200),
            outputTokens: usageMetric("unknown", null),
            cacheReadTokens: usageMetric("reported", 50),
          }),
        }),
      ],
      outputEvents: [],
      agentEventCount: 0,
      lastAgentActivityAt: null,
    });

    expect(summary.tokens.input).toEqual({
      reported: 100,
      estimated: 200,
      reportedRecords: 1,
      estimatedRecords: 1,
    });
    expect(summary.tokens.output).toMatchObject({
      reported: 20,
      estimated: null,
      reportedRecords: 1,
    });
    expect(summary.tokens.cacheRead).toMatchObject({ reported: 90 });
    expect(summary.tokens.cacheReadShare).toBe(0.4);
    expect(summary.tokens.cacheReadShareRecords).toBe(1);
    expect(summary.tokens.cacheWrite.reported).toBeNull();
  });

  it("does not infer cache share or generation speed without compatible reported evidence", () => {
    const summary = aggregateMonitoringTelemetry({
      attempts: [
        {
          id: "a1",
          provider: "campus_gateway",
          purpose: "optimizer",
          status: "succeeded",
          startedAt: "2026-10-16T00:00:00.000Z",
          finishedAt: "2026-10-16T00:00:05.000Z",
        },
      ],
      runs: [],
      usage: [
        usageRecord({
          attemptId: "a1",
          provenance: "estimated",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 2,
        }),
      ],
      outputEvents: [
        {
          attemptId: "a1",
          firstAt: "2026-10-16T00:00:01.000Z",
          lastAt: "2026-10-16T00:00:04.000Z",
        },
      ],
      agentEventCount: 2,
      lastAgentActivityAt: "2026-10-16T00:00:04.000Z",
    });

    expect(summary.tokens.cacheReadShare).toBeNull();
    expect(summary.timeToFirstToken[0]?.median).toBe(1_000);
    expect(summary.tokensPerSecond).toEqual([]);
    expect(summary.agentActivity).toMatchObject({
      eventsInRange: 2,
      status: "observed",
    });
  });

  it("keeps latency distributions separate by provider and purpose", () => {
    const attempts = [100, 200, 400].map((duration, index) => ({
      id: `campus-${index}`,
      provider: "campus_gateway",
      purpose: "optimizer",
      status: "succeeded",
      startedAt: "2026-10-16T00:00:00.000Z",
      finishedAt: new Date(
        new Date("2026-10-16T00:00:00.000Z").getTime() + duration,
      ),
    }));
    const summary = aggregateMonitoringTelemetry({
      attempts: [
        ...attempts,
        {
          id: "codex-1",
          provider: "codex_app_server",
          purpose: "target",
          status: "succeeded",
          startedAt: "2026-10-16T00:00:00.000Z",
          finishedAt: "2026-10-16T00:00:10.000Z",
        },
      ],
      runs: [],
      usage: [],
      outputEvents: [],
      agentEventCount: 0,
      lastAgentActivityAt: null,
    });

    expect(summary.latency).toHaveLength(2);
    expect(summary.latency[0]).toMatchObject({
      provider: "campus_gateway",
      purpose: "optimizer",
      samples: 3,
      median: 200,
      p95: 400,
    });
    expect(summary.latency[1]).toMatchObject({
      provider: "codex_app_server",
      purpose: "target",
      samples: 1,
      median: 10_000,
    });
  });
});

describe("monitoring time windows", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it("supports named windows and explicit ranges no longer than 90 days", () => {
    const lastHour = parseMonitoringRange(new URLSearchParams("range=1h"), now);
    expect(lastHour?.from.toISOString()).toBe("2026-10-16T11:00:00.000Z");
    expect(
      parseMonitoringRange(
        new URLSearchParams(
          "from=2026-10-15T00%3A00%3A00.000Z&to=2026-10-16T00%3A00%3A00.000Z",
        ),
        now,
      )?.label,
    ).toBe("rentang khusus");
    expect(
      parseMonitoringRange(
        new URLSearchParams("from=2026-10-15T00:00:00Z"),
        now,
      ),
    ).toBeNull();
  });

  it("rejects unsupported or inverted ranges", () => {
    expect(
      parseMonitoringRange(new URLSearchParams("range=all"), now),
    ).toBeNull();
    expect(
      parseMonitoringRange(
        new URLSearchParams(
          "from=2026-10-16T01%3A00%3A00Z&to=2026-10-16T00%3A00%3A00Z",
        ),
        now,
      ),
    ).toBeNull();
  });
});

describe("per-attempt streaming metrics", () => {
  it("derives TTFT from output events and TPS only with reported output usage", () => {
    expect(
      deriveMonitoringAttemptStreamingMetrics({
        startedAt: "2026-10-16T00:00:00.000Z",
        firstOutputAt: "2026-10-16T00:00:01.000Z",
        lastOutputAt: "2026-10-16T00:00:03.000Z",
        reportedOutputTokens: 20,
      }),
    ).toEqual({ timeToFirstTokenMs: 1_000, tokensPerSecond: 10 });

    expect(
      deriveMonitoringAttemptStreamingMetrics({
        startedAt: "2026-10-16T00:00:00.000Z",
        firstOutputAt: "2026-10-16T00:00:01.000Z",
        lastOutputAt: "2026-10-16T00:00:03.000Z",
        reportedOutputTokens: null,
      }),
    ).toEqual({ timeToFirstTokenMs: 1_000, tokensPerSecond: null });
  });
});
