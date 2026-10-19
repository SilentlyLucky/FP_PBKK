import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  knowledgeEmbeddingProfileChecksum,
  validateKnowledgeEmbeddingVector,
  type KnowledgeEmbeddingProfileInput,
} from "./knowledge-embeddings.ts";

const profile: KnowledgeEmbeddingProfileInput = {
  provider: "campus_gateway",
  requestedModel: "embeddinggemma:latest",
  observedModel: "embeddinggemma:300m",
  modelDigest: "model-sha256",
  dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
  chunkingVersion: "structure-chunks-v1",
  preprocessingVersion: "plain-v1",
  queryTemplateVersion: "query-v1",
  documentTemplateVersion: "document-v1",
};

describe("knowledge embeddings", () => {
  it("requires exactly 768 finite, nonzero float32 values", () => {
    const valid = Array.from({ length: 768 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    expect(validateKnowledgeEmbeddingVector(valid)).toEqual(valid);
    expect(() => validateKnowledgeEmbeddingVector(valid.slice(1))).toThrow(
      /exactly 768 finite numbers/u,
    );
    expect(() =>
      validateKnowledgeEmbeddingVector(
        valid.map((value, index) =>
          index === 20 ? Number.POSITIVE_INFINITY : value,
        ),
      ),
    ).toThrow(/exactly 768 finite numbers/u);
    expect(() => validateKnowledgeEmbeddingVector(Array(768).fill(0))).toThrow(
      /nonzero magnitude/u,
    );
    expect(() =>
      validateKnowledgeEmbeddingVector(Array(768).fill(1e-100)),
    ).toThrow(/nonzero magnitude/u);
  });

  it("classifies malformed query vectors as a closed validation error", () => {
    let error: unknown;
    try {
      validateKnowledgeEmbeddingVector([1]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "KnowledgeEmbeddingError",
      code: "VECTOR_INVALID",
    });
  });

  it("hashes all profile identity fields so same-sized models stay separate", () => {
    const checksum = knowledgeEmbeddingProfileChecksum(profile);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      knowledgeEmbeddingProfileChecksum({
        ...profile,
        requestedModel: "embeddinggemma:stable",
      }),
    ).not.toBe(checksum);
    expect(
      knowledgeEmbeddingProfileChecksum({
        ...profile,
        observedModel: "embeddinggemma:300m-finetuned",
      }),
    ).not.toBe(checksum);
    expect(
      knowledgeEmbeddingProfileChecksum({
        ...profile,
        queryTemplateVersion: "query-v2",
      }),
    ).not.toBe(checksum);
    expect(
      knowledgeEmbeddingProfileChecksum({
        ...profile,
        chunkingVersion: "structure-chunks-v2",
      }),
    ).not.toBe(checksum);
    expect(
      knowledgeEmbeddingProfileChecksum({ ...profile, modelDigest: null }),
    ).not.toBe(checksum);
    expect(() =>
      knowledgeEmbeddingProfileChecksum({ ...profile, dimensions: 384 }),
    ).toThrow(/768 dimensions/u);
  });
});
