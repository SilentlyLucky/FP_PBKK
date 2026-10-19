import type {
  EvaluationEvidencePack,
  EvaluationSourceVersion,
} from "@promptlab/contracts";
import type { RetrievalResult } from "@promptlab/db";
import type { OptimizationTestInput } from "@promptlab/agent";

import { sha256Text } from "@promptlab/agent";

export interface ResolveOptimizationEvidenceInput {
  testCases: readonly OptimizationTestInput[];
  sourceIds: readonly string[];
  retrievalStrategy: "lexical" | "graph" | "full_context" | "hybrid";
  graphSnapshotId: string | null;
  contextBudgetTokens: number;
  signal: AbortSignal;
  captureSourceManifest: (
    sourceIds: readonly string[],
  ) => Promise<readonly EvaluationSourceVersion[]>;
  retrieve: (input: {
    query: string;
    sourceIds: readonly string[];
    strategy: "lexical" | "graph" | "full_context" | "hybrid";
    snapshotId: string | null;
    signal: AbortSignal;
  }) => Promise<RetrievalResult>;
}

export async function resolveOptimizationEvaluationEvidence(
  input: ResolveOptimizationEvidenceInput,
): Promise<EvaluationEvidencePack[]> {
  if (input.sourceIds.length === 0) {
    return input.testCases.map((testCase) => emptyEvidencePack(testCase.id));
  }

  const sourceManifestBefore = canonicalSourceManifest(
    await input.captureSourceManifest(input.sourceIds),
  );
  const packs: EvaluationEvidencePack[] = [];
  for (const testCase of input.testCases) {
    if (input.signal.aborted) {
      throw input.signal.reason ?? new Error("Optimization canceled");
    }
    const retrieval = await input.retrieve({
      query: testCase.input,
      sourceIds: input.sourceIds,
      strategy: input.retrievalStrategy,
      snapshotId: input.graphSnapshotId,
      signal: input.signal,
    });
    assertEvidenceMatchesSourceManifest(retrieval, sourceManifestBefore);
    packs.push(
      toEvidencePack({
        caseId: testCase.id,
        retrievalStrategy: input.retrievalStrategy,
        selectedSourceIds: input.sourceIds,
        selectedSnapshotId: input.graphSnapshotId,
        contextBudgetTokens: input.contextBudgetTokens,
        retrieval,
        sourceManifest: sourceManifestBefore,
      }),
    );
  }
  const sourceManifestAfter = canonicalSourceManifest(
    await input.captureSourceManifest(input.sourceIds),
  );
  if (!sameSourceManifest(sourceManifestBefore, sourceManifestAfter)) {
    throw new Error("EVALUATION_SOURCE_SNAPSHOT_CHANGED_DURING_RESOLUTION");
  }
  return packs;
}

function emptyEvidencePack(caseId: string): EvaluationEvidencePack {
  return {
    caseId,
    requestedStrategy: "none",
    strategyUsed: "none",
    selectedSnapshotId: null,
    usedSnapshotId: null,
    fallbackReason: null,
    selectedSourceIds: [],
    sourceManifest: [],
    contextText: "",
    contextHash: sha256Text(""),
    evidence: [],
    graphPaths: [],
    estimatedContextTokens: 0,
    contextBudgetTokens: 0,
    clipping: {},
  };
}

function toEvidencePack(input: {
  caseId: string;
  retrievalStrategy: "lexical" | "graph" | "full_context" | "hybrid";
  selectedSourceIds: readonly string[];
  selectedSnapshotId: string | null;
  contextBudgetTokens: number;
  retrieval: RetrievalResult;
  sourceManifest: readonly EvaluationSourceVersion[];
}): EvaluationEvidencePack {
  const { retrieval } = input;
  return {
    caseId: input.caseId,
    requestedStrategy: input.retrievalStrategy,
    strategyUsed: retrieval.strategyUsed,
    selectedSnapshotId: input.selectedSnapshotId,
    usedSnapshotId: retrieval.snapshotId,
    fallbackReason: retrieval.fallbackReason,
    selectedSourceIds: [...input.selectedSourceIds],
    sourceManifest: [...input.sourceManifest],
    contextText: retrieval.packedContext,
    contextHash: sha256Text(retrieval.packedContext),
    evidence: retrieval.evidence.map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      documentId: evidence.documentId,
      documentName: evidence.documentName,
      documentVersionId: evidence.documentVersionId,
      documentVersion: evidence.documentVersion,
      chunkId: evidence.chunkId,
      sourceChecksum: evidence.sourceChecksum,
      quote: evidence.quote,
      contentHash: sha256Text(evidence.chunkContent),
      assertionVersionIds: [
        ...new Set(
          retrieval.paths.flatMap((path) =>
            path.evidence.some((item) => item.id === evidence.id)
              ? path.assertionVersionIds
              : [],
          ),
        ),
      ],
    })),
    graphPaths: retrieval.paths.map((path) => ({
      entityIds: [...path.entityIds],
      labels: [...path.labels],
      assertionVersionIds: [...path.assertionVersionIds],
      predicates: [...path.predicates],
      evidenceIds: path.evidence.map((evidence) => evidence.id),
    })),
    estimatedContextTokens: retrieval.estimatedContextTokens,
    contextBudgetTokens: input.contextBudgetTokens,
    clipping: structuredClone(retrieval.clipping),
  };
}

function canonicalSourceManifest(
  manifest: readonly EvaluationSourceVersion[],
): EvaluationSourceVersion[] {
  return [...manifest]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.documentVersionId.localeCompare(right.documentVersionId));
}

function sameSourceManifest(
  left: readonly EvaluationSourceVersion[],
  right: readonly EvaluationSourceVersion[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertEvidenceMatchesSourceManifest(
  retrieval: RetrievalResult,
  sourceManifest: readonly EvaluationSourceVersion[],
): void {
  for (const evidence of retrieval.evidence) {
    const source = sourceManifest.find(
      (entry) => entry.documentVersionId === evidence.documentVersionId,
    );
    if (
      !source ||
      source.documentId !== evidence.documentId ||
      source.documentVersion !== evidence.documentVersion ||
      source.checksum !== evidence.sourceChecksum
    ) {
      throw new Error("EVALUATION_EVIDENCE_SOURCE_VERSION_MISMATCH");
    }
  }
}
