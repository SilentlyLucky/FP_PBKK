import type { KnowledgeEmbeddingJobOutcome } from "./knowledge-embedding-runtime.ts";

export const KNOWLEDGE_EMBEDDING_QUEUE_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1_000 },
} as const;

export function knowledgeEmbeddingRetryDecision(
  outcome: Pick<KnowledgeEmbeddingJobOutcome, "retryable">,
  attemptsMade: number,
  maxAttempts: number,
): "complete" | "retry" | "exhausted" {
  if (outcome.retryable !== true) return "complete";
  return Number.isSafeInteger(attemptsMade) &&
    attemptsMade >= 0 &&
    Number.isSafeInteger(maxAttempts) &&
    maxAttempts > 1 &&
    attemptsMade + 1 < maxAttempts
    ? "retry"
    : "exhausted";
}
