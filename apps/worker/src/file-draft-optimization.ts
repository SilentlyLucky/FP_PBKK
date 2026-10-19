import {
  MAX_WORKSPACE_FILE_DRAFT_TASK_CHARACTERS,
  parseWorkspaceFileDraftPrompt,
  PromptOptimizationRequestSchema,
} from "@promptlab/contracts";
import { sha256Text } from "@promptlab/agent";

export type FileDraftTaskOptimizationOutcome =
  | "rewrite_unscored"
  | "no_change_unscored";

export function parseFileDraftPromptForOptimization(
  prompt: string,
  snapshotHash: string,
) {
  const parsed = parseWorkspaceFileDraftPrompt(prompt);
  if (!parsed || sha256Text(parsed.fileText) !== snapshotHash) return null;
  return parsed;
}

/**
 * Builds the shared optimizer input from task text alone. File contents are
 * deliberately not accepted by this helper.
 */
export function createFileDraftTaskOptimizationInput(task: string) {
  return {
    originalPrompt: task,
    invariants: [] as const,
    request: PromptOptimizationRequestSchema.parse({
      objective:
        "Perjelas instruksi tugas untuk draf file. Pertahankan tujuan dan batasan pengguna. Jangan menambah fakta, konteks file, atau perubahan di luar tugas.",
      maxIterations: 1,
      maxToolCalls: 6,
      testCases: [],
      targetSelection: { model: "selected", reasoningEffort: "selected" },
    }),
    sourceIds: [] as const,
    history: [] as const,
  };
}

export function selectFileDraftTaskOptimization(input: {
  originalTask: string;
  status: string;
  candidate: {
    prompt: string;
    testingStatus: string;
    evidenceBoundToPrompt: boolean;
  } | null;
}): { task: string; outcome: FileDraftTaskOptimizationOutcome } {
  if (input.status === "no_change_recommended") {
    return { task: input.originalTask, outcome: "no_change_unscored" };
  }

  const candidate = input.candidate;
  if (
    input.status !== "candidate_ready" ||
    !candidate ||
    candidate.testingStatus !== "ready" ||
    !candidate.evidenceBoundToPrompt ||
    !candidate.prompt.trim() ||
    Array.from(candidate.prompt).length >
      MAX_WORKSPACE_FILE_DRAFT_TASK_CHARACTERS
  ) {
    throw new Error("WORKSPACE_FILE_DRAFT_OPTIMIZATION_INCOMPLETE");
  }
  if (candidate.prompt === input.originalTask) {
    return { task: input.originalTask, outcome: "no_change_unscored" };
  }
  return { task: candidate.prompt, outcome: "rewrite_unscored" };
}

export function createFileDraftTaskOptimizationEvidence(input: {
  originalTask: string;
  optimizedTask: string;
  outcome: FileDraftTaskOptimizationOutcome;
  optimizerStatus: string;
}) {
  return {
    outcome: input.outcome,
    optimizerStatus: input.optimizerStatus,
    originalTaskHash: sha256Text(input.originalTask),
    optimizedTaskHash: sha256Text(input.optimizedTask),
    qualityVerified: false as const,
    fixtureEvaluationCount: 0 as const,
  };
}
