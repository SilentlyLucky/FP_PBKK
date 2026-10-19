import { describe, expect, it, vi } from "vitest";

import type { EvaluationSourceVersion } from "@promptlab/contracts";
import type { RetrievalResult } from "@promptlab/db";
import type { OptimizationTestInput } from "@promptlab/agent";

import { resolveOptimizationEvaluationEvidence } from "./optimization-evaluation-evidence.js";

const documentOne = "11111111-1111-4111-8111-111111111111";
const documentTwo = "22222222-2222-4222-8222-222222222222";
const versionOne = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionTwo = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const chunkOne = "44444444-4444-4444-8444-444444444444";
const chunkTwo = "55555555-5555-4555-8555-555555555555";
const assertionOne = "66666666-6666-4666-8666-666666666666";
const assertionTwo = "77777777-7777-4777-8777-777777777777";

const sources: EvaluationSourceVersion[] = [
  {
    documentId: documentOne,
    documentVersionId: versionOne,
    documentVersion: 2,
    checksum: "source-one-checksum",
  },
  {
    documentId: documentTwo,
    documentVersionId: versionTwo,
    documentVersion: 1,
    checksum: "source-two-checksum",
  },
];

function graphRetrieval(query: string): RetrievalResult {
  const one = {
    id: "evidence-one",
    kind: "graph" as const,
    quote: "Senopati is north of the target.",
    documentId: documentOne,
    documentName: "Campus map",
    sourceRef: null,
    sourceMetadata: {},
    documentVersionId: versionOne,
    documentVersion: 2,
    chunkId: chunkOne,
    pageNumber: 1,
    chunkContent: "Senopati is north of the target.",
    sourceChecksum: sources[0]!.checksum,
  };
  const two = {
    id: "evidence-two",
    kind: "graph" as const,
    quote: "The target is in Jakarta.",
    documentId: documentTwo,
    documentName: "Regional guide",
    sourceRef: null,
    sourceMetadata: {},
    documentVersionId: versionTwo,
    documentVersion: 1,
    chunkId: chunkTwo,
    pageNumber: 3,
    chunkContent: "The target is in Jakarta.",
    sourceChecksum: sources[1]!.checksum,
  };
  return {
    projectId: "88888888-8888-4888-8888-888888888888",
    requestedStrategy: "graph",
    strategyUsed: "graph",
    snapshotId,
    traceId: "99999999-9999-4999-8999-999999999999",
    seeds: [{ id: "a", label: "Senopati", entityType: "place" }],
    paths: [
      {
        entityIds: ["a", "b", "c"],
        labels: ["Senopati", "Target", "Jakarta"],
        assertionVersionIds: [assertionOne, assertionTwo],
        predicates: ["north_of", "located_in"],
        evidence: [one, two],
      },
    ],
    evidence: [one, two],
    packedContext: `Graph context for ${query}: ${one.quote} ${two.quote}`,
    estimatedContextTokens: 28,
    fallbackReason: null,
    clipping: { clippedPathsByContextBudget: 0 },
    elapsedMs: 5,
  };
}

describe("frozen optimization evaluation retrieval", () => {
  it("resolves each case once and binds two-hop evidence to both source versions", async () => {
    const testCases: OptimizationTestInput[] = [
      { id: "dev-1", input: "Where is Senopati?", source: "user" },
      { id: "dev-2", input: "Which city contains the target?", source: "user" },
    ];
    const retrieve = vi.fn(async ({ query }: { query: string }) =>
      graphRetrieval(query),
    );
    const captureSourceManifest = vi.fn(async () => sources);

    const packs = await resolveOptimizationEvaluationEvidence({
      testCases,
      sourceIds: [documentOne, documentTwo],
      retrievalStrategy: "graph",
      graphSnapshotId: snapshotId,
      contextBudgetTokens: 3_000,
      signal: new AbortController().signal,
      captureSourceManifest,
      retrieve,
    });

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(captureSourceManifest).toHaveBeenCalledTimes(2);
    expect(packs.map((pack) => pack.caseId)).toEqual(["dev-1", "dev-2"]);
    expect(packs[0]?.requestedStrategy).toBe("graph");
    expect(packs[0]?.strategyUsed).toBe("graph");
    expect(packs[0]?.usedSnapshotId).toBe(snapshotId);
    expect(packs[0]?.sourceManifest).toEqual(sources);
    expect(packs[0]?.evidence.map((item) => item.documentId)).toEqual([
      documentOne,
      documentTwo,
    ]);
    expect(packs[0]?.graphPaths[0]?.assertionVersionIds).toEqual([
      assertionOne,
      assertionTwo,
    ]);
    expect(packs[0]?.contextText).toContain("Senopati");
    expect(packs[0]?.contextText).toContain("Jakarta");
  });

  it("fails before target calls when selected source versions change during resolution", async () => {
    const changedSources = sources.map((source, index) =>
      index === 0 ? { ...source, checksum: "changed-source-checksum" } : source,
    );
    let captureCount = 0;
    const captureSourceManifest = vi.fn(async () => {
      captureCount += 1;
      return captureCount === 1 ? sources : changedSources;
    });

    await expect(
      resolveOptimizationEvaluationEvidence({
        testCases: [
          { id: "dev-1", input: "Where is Senopati?", source: "user" },
        ],
        sourceIds: [documentOne, documentTwo],
        retrievalStrategy: "graph",
        graphSnapshotId: snapshotId,
        contextBudgetTokens: 3_000,
        signal: new AbortController().signal,
        captureSourceManifest,
        retrieve: async ({ query }) => graphRetrieval(query),
      }),
    ).rejects.toThrow("EVALUATION_SOURCE_SNAPSHOT_CHANGED_DURING_RESOLUTION");
  });

  it("retains a visible lexical fallback instead of claiming GraphRAG", async () => {
    const lexicalFallback: RetrievalResult = {
      ...graphRetrieval("fallback"),
      strategyUsed: "lexical",
      snapshotId: null,
      paths: [],
      evidence: [],
      packedContext: "Graph retrieval used lexical fallback (no_active_snapshot).",
      fallbackReason: "no_active_snapshot",
    };
    const packs = await resolveOptimizationEvaluationEvidence({
      testCases: [
        { id: "dev-1", input: "Where is Senopati?", source: "user" },
      ],
      sourceIds: [documentOne, documentTwo],
      retrievalStrategy: "graph",
      graphSnapshotId: snapshotId,
      contextBudgetTokens: 3_000,
      signal: new AbortController().signal,
      captureSourceManifest: async () => sources,
      retrieve: async () => lexicalFallback,
    });

    expect(packs[0]).toMatchObject({
      requestedStrategy: "graph",
      strategyUsed: "lexical",
      selectedSnapshotId: snapshotId,
      usedSnapshotId: null,
      fallbackReason: "no_active_snapshot",
      graphPaths: [],
    });
  });
});
