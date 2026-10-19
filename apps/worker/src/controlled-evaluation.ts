import type {
  ControlledEvaluationArm,
  ControlledEvaluationCase,
  ControlledEvaluationReport,
  ControlledEvaluationRequest,
  EvaluationSourceVersion,
} from "@promptlab/contracts";
import type { RetrievalResult } from "@promptlab/db";
import {
  runControlledEvaluation,
  type ControlledEvaluationInvocation,
  type ControlledEvaluationTargetCall,
  type ControlledEvaluationTrace,
} from "@promptlab/agent";

import { resolveOptimizationEvaluationEvidence } from "./optimization-evaluation-evidence.ts";

export interface ExecuteControlledEvaluationInput {
  projectId: string;
  runId: string;
  attemptId: string;
  request: ControlledEvaluationRequest;
  baselinePrompt: string;
  candidatePrompt: string;
  contextBudgetTokens: number;
  signal: AbortSignal;
  captureSourceManifest: (
    sourceIds: readonly string[],
  ) => Promise<readonly EvaluationSourceVersion[]>;
  retrieve: (input: {
    query: string;
    sourceIds: readonly string[];
    strategy: "lexical" | "graph" | "full_context";
    snapshotId: string | null;
    signal: AbortSignal;
  }) => Promise<RetrievalResult>;
  invoke: (
    call: ControlledEvaluationTargetCall,
  ) => Promise<ControlledEvaluationInvocation>;
  onTrace?: (trace: ControlledEvaluationTrace) => unknown;
  onEvidenceResolved?: () => unknown;
}

/** Resolves one evidence pack per case and arm, then evaluates the frozen pairs. */
export async function executeControlledEvaluationBatch(
  input: ExecuteControlledEvaluationInput,
): Promise<ControlledEvaluationReport> {
  return runControlledEvaluation({
    runId: input.runId,
    attemptId: input.attemptId,
    request: input.request,
    baselinePrompt: input.baselinePrompt,
    candidatePrompt: input.candidatePrompt,
    signal: input.signal,
    ...(input.onTrace ? { onTrace: input.onTrace } : {}),
    ...(input.onEvidenceResolved
      ? { onEvidenceResolved: input.onEvidenceResolved }
      : {}),
    invoke: input.invoke,
    resolveEvidence: async (
      arm: ControlledEvaluationArm,
      cases: readonly Pick<ControlledEvaluationCase, "id" | "input">[],
      signal: AbortSignal,
    ) =>
      resolveOptimizationEvaluationEvidence({
        testCases: cases.map((testCase) => ({
          ...testCase,
          source: "user" as const,
        })),
        sourceIds: [...arm.retrieval.sourceIds],
        retrievalStrategy: arm.arm === "graphrag" ? "graph" : "lexical",
        graphSnapshotId: arm.retrieval.snapshotId ?? null,
        contextBudgetTokens: input.contextBudgetTokens,
        signal,
        captureSourceManifest: input.captureSourceManifest,
        retrieve: (retrieval) => {
          const strategy = retrieval.strategy;
          if (strategy === "hybrid") {
            throw new Error("CONTROLLED_EVALUATION_RETRIEVAL_STRATEGY_INVALID");
          }
          return input.retrieve({ ...retrieval, strategy });
        },
      }),
  });
}
