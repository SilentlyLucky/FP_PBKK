import type { UsageSnapshot } from "@promptlab/contracts";

export type AggregateUsageProvenance = "reported" | "estimated" | "unknown";

/** A mixed snapshot is summarized conservatively; per-metric detail remains in the event. */
export function aggregateUsageProvenance(
  usage: UsageSnapshot,
): AggregateUsageProvenance {
  const metrics = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  if (metrics.some((metric) => metric.status === "estimated"))
    return "estimated";
  if (metrics.some((metric) => metric.status === "reported")) return "reported";
  return "unknown";
}

export function usageProvenanceLabel(
  provenance: AggregateUsageProvenance,
  completeness: UsageSnapshot["completeness"],
): string {
  if (provenance === "estimated")
    return completeness === "complete"
      ? "Estimasi"
      : completeness === "partial"
        ? "Estimasi parsial"
        : "Estimasi; kelengkapan tidak diketahui";
  if (provenance === "reported")
    return completeness === "complete"
      ? "Dilaporkan lengkap"
      : completeness === "partial"
        ? "Dilaporkan parsial"
        : "Dilaporkan; kelengkapan tidak diketahui";
  return "Tidak diketahui";
}
