import type { UsageMetric, UsageSnapshot } from "@promptlab/contracts";
import { describe, expect, it } from "vitest";

import {
  aggregateUsageProvenance,
  usageProvenanceLabel,
} from "./usage-provenance.js";

const reported: UsageMetric = {
  status: "reported",
  value: 12,
  observedAt: "2026-10-11T00:00:00.000Z",
  method: "test",
};
const estimated: UsageMetric = {
  status: "estimated",
  value: 8,
  observedAt: "2026-10-11T00:00:00.000Z",
  method: "test estimate",
};
const unknown: UsageMetric = {
  status: "unknown",
  value: null,
  reason: "not provided",
};

function snapshot(
  metrics: [UsageMetric, UsageMetric, UsageMetric, UsageMetric],
  completeness: UsageSnapshot["completeness"],
): UsageSnapshot {
  return {
    inputTokens: metrics[0],
    outputTokens: metrics[1],
    cacheReadTokens: metrics[2],
    cacheWriteTokens: metrics[3],
    completeness,
    responseId: null,
    mapperVersion: "test-v1",
  };
}

describe("usage provenance aggregation", () => {
  it("labels a complete reported snapshot as fully reported", () => {
    const usage = snapshot(
      [reported, reported, reported, reported],
      "complete",
    );
    const provenance = aggregateUsageProvenance(usage);
    expect(provenance).toBe("reported");
    expect(usageProvenanceLabel(provenance, usage.completeness)).toBe(
      "Dilaporkan lengkap",
    );
  });

  it("keeps reported metrics partial when other metrics are unknown", () => {
    const usage = snapshot([reported, reported, unknown, unknown], "partial");
    const provenance = aggregateUsageProvenance(usage);
    expect(provenance).toBe("reported");
    expect(usageProvenanceLabel(provenance, usage.completeness)).toBe(
      "Dilaporkan parsial",
    );
  });

  it("summarizes mixed reported and estimated metrics as estimated", () => {
    const usage = snapshot([reported, estimated, unknown, unknown], "partial");
    const provenance = aggregateUsageProvenance(usage);
    expect(provenance).toBe("estimated");
    expect(usageProvenanceLabel(provenance, usage.completeness)).toBe(
      "Estimasi parsial",
    );
    expect(usage.inputTokens.status).toBe("reported");
    expect(usage.outputTokens.status).toBe("estimated");
  });

  it("keeps missing metrics unknown", () => {
    const usage = snapshot([unknown, unknown, unknown, unknown], "unknown");
    const provenance = aggregateUsageProvenance(usage);
    expect(provenance).toBe("unknown");
    expect(usageProvenanceLabel(provenance, usage.completeness)).toBe(
      "Tidak diketahui",
    );
  });

  it("does not label reported metrics complete when completeness is unknown", () => {
    const usage = snapshot([reported, unknown, unknown, unknown], "unknown");
    expect(
      usageProvenanceLabel(aggregateUsageProvenance(usage), usage.completeness),
    ).toBe("Dilaporkan; kelengkapan tidak diketahui");
  });
});
