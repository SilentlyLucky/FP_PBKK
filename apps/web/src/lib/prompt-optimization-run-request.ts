import type { PromptOptimizationRequest } from "@promptlab/contracts";

type TargetSelectionMode = "selected" | "auto";
type PromptOptimizationCase = Omit<
  PromptOptimizationRequest["testCases"][number],
  "expectedTerms" | "forbiddenTerms"
> &
  Partial<
    Pick<
      PromptOptimizationRequest["testCases"][number],
      "expectedTerms" | "forbiddenTerms"
    >
  >;

export function buildPromptOptimizationRunRequest(input: {
  projectId: string;
  promptVersionId: string;
  requestedModel: string;
  reasoningEffort: string | null;
  modelSelection: TargetSelectionMode;
  effortSelection: TargetSelectionMode;
  idempotencyKey: string;
  retrievalStrategy: "lexical" | "graph" | "full_context";
  knowledgeSourceIds: readonly string[];
  objective: string;
  testCases: readonly PromptOptimizationCase[];
}) {
  const objective = input.objective.trim();
  return {
    projectId: input.projectId,
    promptVersionId: input.promptVersionId,
    provider: "codex_app_server" as const,
    requestedModel: input.requestedModel,
    purpose: "target" as const,
    intent: "prompt_optimization" as const,
    ...(input.effortSelection === "selected" && input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    idempotencyKey: input.idempotencyKey,
    retrieval: {
      strategy: input.retrievalStrategy,
      sourceIds: [...input.knowledgeSourceIds],
    },
    optimization: {
      ...(objective ? { objective } : {}),
      ...(input.testCases.length ? { testCases: input.testCases } : {}),
      ...(input.modelSelection === "auto" || input.effortSelection === "auto"
        ? {
            targetSelection: {
              model: input.modelSelection,
              reasoningEffort: input.effortSelection,
            },
          }
        : {}),
    },
  };
}
