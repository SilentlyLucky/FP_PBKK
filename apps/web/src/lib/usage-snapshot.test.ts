import { describe, expect, it } from "vitest";

import { parseSanitizedUsageSnapshot } from "./usage-snapshot.js";

describe("sanitized usage API snapshot parsing", () => {
  it("preserves per-metric provenance and snapshot completeness", () => {
    const parsed = parseSanitizedUsageSnapshot({
      inputTokens: {
        status: "reported",
        value: 12,
        observedAt: "2026-10-11T00:00:00.000Z",
        method: "provider response usage.prompt_tokens",
      },
      outputTokens: {
        status: "estimated",
        value: 8,
        observedAt: "2026-10-11T00:00:00.000Z",
        method: "adapter estimate",
      },
      cacheReadTokens: { status: "unknown", value: null, reason: "absent" },
      cacheWriteTokens: { status: "unknown", value: null, reason: "absent" },
      completeness: "partial",
      responseId: "resp-test",
      mapperVersion: "campus-openai-chat-v1",
    });

    expect(parsed?.inputTokens.status).toBe("reported");
    expect(parsed?.outputTokens.status).toBe("estimated");
    expect(parsed?.completeness).toBe("partial");
  });

  it("accepts absent snapshots and rejects malformed persisted data", () => {
    expect(parseSanitizedUsageSnapshot(null)).toBeNull();
    expect(() => parseSanitizedUsageSnapshot({ inputTokens: 12 })).toThrow();
  });
});
