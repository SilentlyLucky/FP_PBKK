import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isVerifiedMemorySourceManifestCurrent,
  listVerifiedMemories,
  type VerifiedMemoryRuntimeProjection,
} from "@promptlab/agent/verified-memory";
import type { Database, WorkspaceSourceManifest } from "@promptlab/db";
import type { ToolContext } from "@promptlab/tools";

import { createVerifiedMemorySearchHandler } from "./verified-memory-tools.js";

vi.mock("@promptlab/agent/verified-memory", () => ({
  isVerifiedMemorySourceManifestCurrent: vi.fn(),
  listVerifiedMemories: vi.fn(),
}));

const projectId = "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceA = "1ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceAVersion = "2ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceB = "3ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceBVersion = "4ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const runId = "5ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const attemptId = "6ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const db = {} as Database;

function sourceManifest(
  sources: WorkspaceSourceManifest["sources"] = [],
): WorkspaceSourceManifest {
  return {
    format: "promptlab-workspace-source-manifest-v1",
    sources,
  };
}

function source(
  documentId: string,
  documentVersionId: string,
  checksum = "a".repeat(64),
): WorkspaceSourceManifest["sources"][number] {
  return {
    documentId,
    documentVersionId,
    documentVersion: 1,
    checksum,
    sourcePermission: "campus_indexer_allowed",
  };
}

function memory(
  memoryId: string,
  sources: WorkspaceSourceManifest["sources"] = [],
): VerifiedMemoryRuntimeProjection {
  return {
    format: "promptlab-verified-memory-runtime-v1",
    status: "eligible_accepted_experiment",
    memoryId,
    projectId,
    experimentId: runId,
    runId,
    acceptedDecisionSequence: 9,
    acceptedAt: "2026-10-18T08:00:00.000Z",
    task: "Summarize the current campus policy.",
    strategy: {
      arm: "rag",
      retrievalStrategy: "lexical",
      candidatePrompt: "Use a concise, sourced answer.",
      requestedModel: "private-model-choice",
      reasoningEffort: "private-effort-choice",
      privateGoldLabel: "private-gold-label",
      arms: [
        {
          arm: "rag",
          retrieval: { strategy: "graph", sourceIds: [sourceA, sourceB] },
          requestedModel: "private-comparison-model",
          reasoningEffort: "private-comparison-effort",
        },
      ],
    },
    scope: {
      datasetName: "campus-policy",
      datasetVersion: "v3",
      cases: [{ id: "development-1", split: "development" }],
    },
    constraints: {
      requestedModel: "private-model-choice",
      reasoningEffort: "private-effort-choice",
    },
    evaluationProvenance: {
      mode: "pilot",
      runId,
      attemptId,
      completionSequence: 7,
      evaluationSequences: [5, 6],
      manifestHash: null,
      status: "succeeded",
    },
    sourceVersionManifest: sourceManifest(sources),
    successConditions: [
      {
        arm: "rag",
        caseId: "development-1",
        split: "development",
        subject: "candidate",
        verificationKind: "exact_match",
        outcome: "passed",
        judgment: null,
        evidenceSequence: 6,
      },
    ],
    interpretation:
      "Experiment-scoped evidence; acceptance does not establish general truth.",
  };
}

function context(allowedSourceIds: readonly string[] = [sourceA]): ToolContext {
  return {
    scope: {
      projectId,
      allowedSourceIds: new Set(allowedSourceIds),
      allowedChunkIds: new Set(),
      allowedHistoryMessageIds: new Set(),
      developmentCaseIds: new Set(),
      candidateIds: new Set(),
      graphEntityIds: new Set(),
      graphAssertionIds: new Set(),
    },
    signal: new AbortController().signal,
  };
}

describe("verified memory optimization tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isVerifiedMemorySourceManifestCurrent).mockResolvedValue(true);
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [],
      truncated: false,
    });
  });

  it("queries the shared runtime audience and returns only matching frozen sources", async () => {
    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [
        memory("matching-source", frozenManifest.sources),
        memory("other-source", [source(sourceB, sourceBVersion)]),
        memory("changed-version", [
          source(sourceA, sourceAVersion, "b".repeat(64)),
        ]),
        memory("no-source"),
      ],
      truncated: false,
    });
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });

    const result = await handler(
      { query: "  campus policy  ", limit: 1 },
      context([sourceA, sourceB]),
    );

    expect(listVerifiedMemories).toHaveBeenCalledWith(db, {
      projectId,
      query: "campus policy",
      limit: 20,
      audience: "runtime",
    });
    expect(result).toMatchObject({
      available: true,
      resultCount: 1,
      truncated: true,
      memories: [{ memoryId: "matching-source" }],
    });
    expect(isVerifiedMemorySourceManifestCurrent).toHaveBeenCalledWith(
      db,
      projectId,
      frozenManifest,
    );
  });

  it("does not expand an empty source selection to project sources", async () => {
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [],
      sourceManifest: sourceManifest(),
    });
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [
        memory("source-backed", [source(sourceA, sourceAVersion)]),
        memory("source-free"),
      ],
      truncated: false,
    });

    const result = await handler(
      { query: "campus policy" },
      context([sourceA, sourceB]),
    );

    expect(result.memories.map(({ memoryId }) => memoryId)).toEqual([
      "source-free",
    ]);
    expect(listVerifiedMemories).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ projectId, audience: "runtime" }),
    );
  });

  it("rejects inconsistent or stale frozen source scopes before returning memory", async () => {
    const mismatched = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: sourceManifest([source(sourceB, sourceBVersion)]),
    });
    await expect(
      mismatched({ query: "policy" }, context([sourceA, sourceB])),
    ).resolves.toMatchObject({
      available: false,
      reason: "frozen_source_scope_mismatch",
      memories: [],
    });
    expect(listVerifiedMemories).not.toHaveBeenCalled();

    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    vi.mocked(isVerifiedMemorySourceManifestCurrent).mockResolvedValue(false);
    const stale = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });
    await expect(
      stale({ query: "policy" }, context([sourceA])),
    ).resolves.toMatchObject({
      available: false,
      reason: "frozen_sources_stale",
      memories: [],
    });
    expect(listVerifiedMemories).not.toHaveBeenCalled();
  });

  it("redacts model controls, criteria, case identifiers, and non-runtime fields", async () => {
    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [memory("safe-memory", frozenManifest.sources)],
      truncated: false,
    });
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });

    const result = await handler(
      { query: "campus policy", limit: 999 },
      context([sourceA]),
    );
    const serialized = JSON.stringify(result);

    expect(result.resultCount).toBe(1);
    expect(result.memories[0]).toMatchObject({
      strategy: {
        arm: "rag",
        retrievalStrategy: "lexical",
        comparativeStrategies: [{ arm: "rag", retrievalStrategy: "graph" }],
        candidatePrompt: "Use a concise, sourced answer.",
      },
      proof: {
        acceptedDecisionSequence: 9,
        evaluationMode: "pilot",
        evaluationStatus: "succeeded",
        developmentEvidenceCount: 1,
      },
    });
    expect(result.memories).toHaveLength(1);
    expect(result.guidance).toContain("Do not inherit model or effort choices");
    expect(serialized).not.toContain("private-model-choice");
    expect(serialized).not.toContain("private-effort-choice");
    expect(serialized).not.toContain("private-gold-label");
    expect(serialized).not.toContain("development-1");
    expect(serialized).not.toContain('"constraints"');
    expect(serialized).not.toContain('"judgment"');
    expect(serialized).not.toContain('"split"');
    expect(serialized).not.toContain("exact_match");
    expect(serialized).not.toContain("successEvidence");
    expect(listVerifiedMemories).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ limit: 20, audience: "runtime" }),
    );
  });

  it("keeps complete provenance records within one aggregate context budget", async () => {
    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    const first = memory("first-large", frozenManifest.sources);
    first.task = "t".repeat(4_000);
    first.strategy.candidatePrompt = "p".repeat(8_000);
    const second = memory("second-large", frozenManifest.sources);
    second.task = "t".repeat(4_000);
    second.strategy.candidatePrompt = "p".repeat(8_000);
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [first, second],
      truncated: false,
    });
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });

    const result = await handler(
      { query: "campus policy", limit: 5 },
      context([sourceA]),
    );

    expect(result).toMatchObject({
      available: true,
      reason: null,
      resultCount: 1,
      truncated: true,
      memories: [
        {
          memoryId: "first-large",
          proof: {
            sourceVersions: [
              {
                documentId: sourceA,
                documentVersionId: sourceAVersion,
                documentVersion: 1,
                checksum: "a".repeat(64),
              },
            ],
          },
        },
      ],
    });
    expect(
      Math.ceil(
        new TextEncoder().encode(JSON.stringify(result)).byteLength / 4,
      ),
    ).toBeLessThanOrEqual(4_000);
    expect(result.memories).not.toContainEqual(
      expect.objectContaining({ memoryId: "second-large" }),
    );
  });

  it("drops an individually oversized memory and later retains a smaller complete record", async () => {
    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    const oversized = memory("oversized", frozenManifest.sources);
    oversized.task = "😀".repeat(2_000);
    oversized.strategy.candidatePrompt = "p".repeat(8_000);
    const small = memory("small", frozenManifest.sources);
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [oversized, small],
      truncated: false,
    });
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });

    const result = await handler(
      { query: "campus policy" },
      context([sourceA]),
    );

    expect(result).toMatchObject({
      resultCount: 1,
      truncated: true,
      memories: [{ memoryId: "small" }],
    });

    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [oversized],
      truncated: false,
    });
    await expect(
      handler({ query: "campus policy" }, context([sourceA])),
    ).resolves.toMatchObject({
      available: true,
      reason: "context_budget_exceeded",
      resultCount: 0,
      truncated: true,
      memories: [],
    });
  });

  it("truncates multibyte text without splitting a surrogate pair", async () => {
    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    const value = memory("unicode", frozenManifest.sources);
    value.task = `${"a".repeat(3_999)}😀z`;
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [value],
      truncated: false,
    });
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });

    const result = await handler(
      { query: "campus policy" },
      context([sourceA]),
    );

    expect(result.memories[0]?.task).toBe("a".repeat(3_999));
    expect(result.memories[0]?.taskTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.memories[0]?.proof.sourceVersions).toEqual([
      {
        documentId: sourceA,
        documentVersionId: sourceAVersion,
        documentVersion: 1,
        checksum: "a".repeat(64),
      },
    ]);
  });

  it("rechecks source freshness after retrieval and discards a raced result", async () => {
    const frozenManifest = sourceManifest([source(sourceA, sourceAVersion)]);
    vi.mocked(isVerifiedMemorySourceManifestCurrent)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(listVerifiedMemories).mockResolvedValue({
      memories: [memory("raced-memory", frozenManifest.sources)],
      truncated: false,
    });
    const handler = createVerifiedMemorySearchHandler({
      db,
      sourceIds: [sourceA],
      sourceManifest: frozenManifest,
    });

    await expect(
      handler({ query: "campus policy" }, context([sourceA])),
    ).resolves.toMatchObject({
      available: false,
      reason: "frozen_sources_stale",
      memories: [],
    });
    expect(isVerifiedMemorySourceManifestCurrent).toHaveBeenCalledTimes(2);
  });
});
