import { UsageSnapshotSchema, type UsageSnapshot } from "@promptlab/contracts";

export function parseSanitizedUsageSnapshot(
  value: unknown,
): UsageSnapshot | null {
  if (value === null || value === undefined) return null;
  return UsageSnapshotSchema.parse(value);
}
