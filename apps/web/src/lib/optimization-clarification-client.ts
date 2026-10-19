import { OptimizationClarificationSchema } from "@promptlab/contracts";

export interface StoredOptimizationRun {
  projectId: string;
  promptId: string;
  promptVersionId: string;
  runId: string;
  status: string;
  baselinePrompt: string;
  objective: string | null;
}

export type OptimizationClarification = ReturnType<
  typeof OptimizationClarificationSchema.parse
>;

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const maxStoredRunBytes = 150_000;

export function optimizationRunStorageKey(projectId: string) {
  return `promptlab.optimization.active-run.v1:${projectId}`;
}

export function parseStoredOptimizationRun(
  value: unknown,
  projectId: string,
): StoredOptimizationRun | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    record.projectId !== projectId ||
    typeof record.promptId !== "string" ||
    typeof record.promptVersionId !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.status !== "string" ||
    typeof record.baselinePrompt !== "string" ||
    record.baselinePrompt.length > 100_000 ||
    !(record.objective === null || typeof record.objective === "string") ||
    (typeof record.objective === "string" && record.objective.length > 1_000)
  ) {
    return null;
  }
  return {
    projectId,
    promptId: record.promptId,
    promptVersionId: record.promptVersionId,
    runId: record.runId,
    status: record.status,
    baselinePrompt: record.baselinePrompt,
    objective: record.objective,
  };
}

export function readStoredOptimizationRun(
  storage: KeyValueStorage,
  projectId: string,
): StoredOptimizationRun | null {
  try {
    const value = storage.getItem(optimizationRunStorageKey(projectId));
    if (!value || value.length > maxStoredRunBytes) return null;
    return parseStoredOptimizationRun(JSON.parse(value), projectId);
  } catch {
    return null;
  }
}

export function writeStoredOptimizationRun(
  storage: KeyValueStorage,
  run: StoredOptimizationRun,
): boolean {
  try {
    const serialized = JSON.stringify(run);
    if (serialized.length > maxStoredRunBytes) return false;
    storage.setItem(optimizationRunStorageKey(run.projectId), serialized);
    return true;
  } catch {
    return false;
  }
}

export function parseProjectClarifications(
  value: unknown,
  projectId: string,
): OptimizationClarification[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [];
  const clarifications = (value as Record<string, unknown>).clarifications;
  if (!Array.isArray(clarifications)) return [];
  return clarifications.flatMap((item) => {
    const parsed = OptimizationClarificationSchema.safeParse(item);
    return parsed.success && parsed.data.projectId === projectId
      ? [parsed.data]
      : [];
  });
}

export function newestClarification(
  clarifications: readonly OptimizationClarification[],
) {
  return (
    [...clarifications].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )[0] ?? null
  );
}
