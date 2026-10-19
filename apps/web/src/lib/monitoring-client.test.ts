import { describe, expect, it } from "vitest";

import {
  createMonitoringActivitySeenSet,
  createMonitoringRequestCsv,
  monitoringRequestScopeKey,
  rememberMonitoringActivity,
  safeMonitoringErrorCode,
  safeMonitoringModel,
} from "./monitoring-client.js";

describe("monitoring client scope and export safeguards", () => {
  it("keys cached request data by project and every visible query filter", () => {
    const base = {
      projectId: "0d5a5412-7abe-4a48-b733-4e41508c9fc0",
      range: "24h",
      page: 1,
      search: "",
      status: "all",
      provider: "all",
      purpose: "all",
    };
    const key = monitoringRequestScopeKey(base);

    expect(
      monitoringRequestScopeKey({ ...base, projectId: "other-project" }),
    ).not.toBe(key);
    expect(monitoringRequestScopeKey({ ...base, range: "7d" })).not.toBe(key);
    expect(monitoringRequestScopeKey({ ...base, page: 2 })).not.toBe(key);
    expect(monitoringRequestScopeKey({ ...base, search: "model-x" })).not.toBe(
      key,
    );
    expect(monitoringRequestScopeKey({ ...base, status: "failed" })).not.toBe(
      key,
    );
    expect(
      monitoringRequestScopeKey({ ...base, provider: "fixture" }),
    ).not.toBe(key);
    expect(
      monitoringRequestScopeKey({ ...base, purpose: "optimizer" }),
    ).not.toBe(key);
  });

  it("deduplicates reconnect replay by event ID and run sequence", () => {
    const seen = createMonitoringActivitySeenSet();
    const first = {
      id: "event-id-1",
      runId: "run-id-1",
      sequence: 4,
    };
    expect(rememberMonitoringActivity(first, seen)).toBe(true);
    expect(rememberMonitoringActivity(first, seen)).toBe(false);
    expect(
      rememberMonitoringActivity(
        { ...first, id: "replayed-with-new-id" },
        seen,
      ),
    ).toBe(false);
  });

  it("exports only the visible request fields, escapes formulas, and redacts secret-like model/error strings", () => {
    const request = {
      startedAt: "2026-10-16T12:00:00.000Z",
      finishedAt: null,
      attemptId: "0d5a5412-7abe-4a48-b733-4e41508c9fc0",
      runId: "1d5a5412-7abe-4a48-b733-4e41508c9fc0",
      attemptNumber: 1,
      provider: "fixture",
      purpose: "optimizer",
      requestedModel: ' =HYPERLINK("https://example.invalid","open")',
      responseModel: null,
      status: "failed",
      remoteOutcomeKnown: false,
      usage: null,
      timeToFirstTokenMs: null,
      tokensPerSecond: null,
      durationMs: null,
      errorCode: "@SUM(1,1)",
      prompt: "private prompt payload",
      output: "private model output",
    };
    const csv = createMonitoringRequestCsv([request]);

    expect(csv).toContain("' =HYPERLINK");
    expect(csv).toContain("'@SUM(1");
    expect(csv).not.toContain("private prompt payload");
    expect(csv).not.toContain("private model output");
    expect(csv.split("\r\n")[0]).not.toMatch(/prompt|output_payload/i);
    expect(safeMonitoringModel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(safeMonitoringModel("sk-123456789012345678901234")).toBe(
      "[redacted]",
    );
    expect(safeMonitoringErrorCode("authorization=Bearer-secret")).toBe(
      "REDACTED",
    );
  });
});
