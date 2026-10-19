import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_EMBEDDING_QUEUE_OPTIONS,
  knowledgeEmbeddingRetryDecision,
} from "./knowledge-embedding-retry.ts";

describe("knowledge embedding queue retries", () => {
  it("uses bounded exponential retries for embedding jobs", () => {
    expect(KNOWLEDGE_EMBEDDING_QUEUE_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
    });
  });

  it("retries only retryable failures before the final attempt", () => {
    expect(knowledgeEmbeddingRetryDecision({ retryable: true }, 0, 3)).toBe(
      "retry",
    );
    expect(knowledgeEmbeddingRetryDecision({ retryable: true }, 1, 3)).toBe(
      "retry",
    );
    expect(knowledgeEmbeddingRetryDecision({ retryable: true }, 2, 3)).toBe(
      "exhausted",
    );
    expect(knowledgeEmbeddingRetryDecision({ retryable: false }, 0, 3)).toBe(
      "complete",
    );
  });

  it("fails closed on invalid attempt settings", () => {
    expect(knowledgeEmbeddingRetryDecision({ retryable: true }, -1, 3)).toBe(
      "exhausted",
    );
    expect(knowledgeEmbeddingRetryDecision({ retryable: true }, 0, 1)).toBe(
      "exhausted",
    );
  });
});
