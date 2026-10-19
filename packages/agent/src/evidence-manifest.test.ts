import { describe, expect, it } from "vitest";

import type {
  EvaluationEvidenceManifest,
  EvaluationEvidencePack,
} from "@promptlab/contracts";

import {
  buildTargetEvaluationRequest,
  createEvaluationEvidenceManifest,
  type EvaluationEvidenceManifestInput,
  isEvaluationEvidenceManifestIntact,
  isOptimizationCandidateEvidenceEligible,
  sha256Json,
  sha256Text,
} from "./evidence-manifest.js";

const sourceOne = {
  documentId: "11111111-1111-4111-8111-111111111111",
  documentVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  documentVersion: 2,
  checksum: "source-one-checksum",
};
const sourceTwo = {
  documentId: "22222222-2222-4222-8222-222222222222",
  documentVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  documentVersion: 1,
  checksum: "source-two-checksum",
};
const snapshotId = "33333333-3333-4333-8333-333333333333";

function requiredItem<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error("Expected manifest test item.");
  return item;
}

function evidencePack(
  caseId: string,
  input: string,
  strategy: "graph" | "hybrid" = "graph",
): EvaluationEvidencePack {
  const isGraph = strategy === "graph";
  const contextText = isGraph
    ? "Graph evidence: Senopati is north of the target; Target is in Jakarta."
    : "Chunk evidence: 2 + 2 = 5.";
  return {
    caseId,
    requestedStrategy: strategy,
    strategyUsed: strategy,
    selectedSnapshotId: isGraph ? snapshotId : null,
    usedSnapshotId: isGraph ? snapshotId : null,
    fallbackReason: null,
    selectedSourceIds: [sourceOne.documentId, sourceTwo.documentId],
    sourceManifest: [sourceOne, sourceTwo],
    contextText,
    contextHash: sha256Text(contextText),
    evidence: [
      {
        id: "evidence-1",
        kind: isGraph ? "graph" : "chunk",
        documentId: sourceOne.documentId,
        documentName: "Source One",
        documentVersionId: sourceOne.documentVersionId,
        documentVersion: sourceOne.documentVersion,
        chunkId: "44444444-4444-4444-8444-444444444444",
        sourceChecksum: sourceOne.checksum,
        quote: isGraph ? "Senopati is north of the target." : "2 + 2 = 5.",
        contentHash: sha256Text(input),
        assertionVersionIds: isGraph
          ? ["55555555-5555-4555-8555-555555555555"]
          : [],
      },
    ],
    graphPaths: isGraph
      ? [
          {
            entityIds: [
              "88888888-8888-4888-8888-888888888888",
              "99999999-9999-4999-8999-999999999999",
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ],
            labels: ["Senopati", "Target", "Jakarta"],
            assertionVersionIds: ["55555555-5555-4555-8555-555555555555"],
            predicates: ["north_of"],
            evidenceIds: ["evidence-1"],
          },
        ]
      : [],
    estimatedContextTokens: 36,
    contextBudgetTokens: 512,
    clipping: { clippedPathsByContextBudget: 0 },
  };
}

function manifestInput(
  strategy: "graph" | "hybrid" = "graph",
): EvaluationEvidenceManifestInput {
  const selectedSnapshotId = strategy === "graph" ? snapshotId : null;
  const cases = [
    { caseId: "case-1", input: "Where is Senopati relative to the target?" },
    { caseId: "case-2", input: "Which city contains the target?" },
  ];
  const evidencePacks = cases.map(({ caseId, input }) =>
    evidencePack(caseId, input, strategy),
  );
  const targetSelection = {
    model: "selected",
    reasoningEffort: "selected",
  };
  const optimizerRequest = {
    objective: "Answer from the supplied evidence.",
    maxIterations: 1,
    maxToolCalls: 4,
    testCases: cases.map(({ caseId, input }) => ({ id: caseId, input })),
  };
  const runConfig = {
    optimization: optimizerRequest,
    retrieval: {
      strategy,
      sourceIds: [sourceOne.documentId, sourceTwo.documentId],
      snapshotId: selectedSnapshotId,
    },
  };
  const optimizerConfig = { model: "senopati-test", request: optimizerRequest };
  const targetConfig = {
    requestedModel: "gpt-test",
    resolvedModel: "gpt-test",
    requestedEffort: "high",
    sentEffort: "high",
    targetSelection,
  };
  const sourceManifest = [sourceOne, sourceTwo];
  const retrievalConfig = {
    requestedStrategy: strategy,
    sourceIds: [sourceOne.documentId, sourceTwo.documentId],
    selectedSnapshotId,
    sourceManifest,
    evidencePacks,
  };
  const executionSnapshot = {
    preflightComplete: true,
    testCases: cases.map(({ caseId, input }) => ({
      id: caseId,
      input,
      source: "user",
    })),
    sourceIds: [sourceOne.documentId, sourceTwo.documentId],
    retrievalStrategy: strategy,
    graphSnapshotId: selectedSnapshotId,
  };
  const invariants = ["Answer from the supplied evidence."];
  const makeResponse = (
    caseId: string,
    subject: "baseline" | "candidate",
    pack: EvaluationEvidencePack,
  ) => ({
    caseId,
    responseId: `${subject}-${caseId}`,
    responseModel: "gpt-test",
    provider: "codex_app_server" as const,
    attemptId: "attempt-test",
    requestHash: sha256Text(
      buildTargetEvaluationRequest({
        prompt: subject === "baseline" ? "baseline prompt" : "candidate prompt",
        caseInput: cases.find((item) => item.caseId === caseId)!.input,
        evidencePack: pack,
      }),
    ),
    contextHash: pack.contextHash,
    answerHash: sha256Text(`Answer for ${caseId}`),
  });

  return {
    runId: "run-test",
    attemptId: "attempt-test",
    candidateRevisionId: "candidate-revision-1",
    revision: 1,
    baselinePromptHash: sha256Text("baseline prompt"),
    candidatePromptHash: sha256Text("candidate prompt"),
    invariantsHash: sha256Json(invariants),
    caseManifest: cases.map(({ caseId, input }) => ({
      caseId,
      input,
      inputHash: sha256Text(input),
      inputCharacters: input.length,
      source: "user" as const,
      split: "development" as const,
      verificationHash: null,
    })),
    sourceManifest,
    graph: {
      requestedStrategy: strategy,
      selectedSnapshotId,
      usedSnapshotIds: selectedSnapshotId ? [selectedSnapshotId] : [],
      strategyUsed: strategy,
      fallbackReasons: [],
    },
    workspaceSnapshot: {
      mode: "none",
      snapshotId: null,
      contentHash: null,
    },
    target: {
      provider: "codex_app_server",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      requestedEffort: "high",
      resolvedEffort: "high",
      sentEffort: "high",
      providerVersion: "codex-test",
      selection: targetSelection,
    },
    policy: {
      version: "promptlab.r3.evidence.v1",
      hash: sha256Json({
        version: "promptlab.r3.evidence.v1",
        caseSplit: "development_only",
      }),
      caseSplit: "development_only",
    },
    configuration: {
      runConfigHash: sha256Json(runConfig),
      optimizerConfigHash: sha256Json(optimizerConfig),
      targetConfigHash: sha256Json(targetConfig),
      retrievalConfigHash: sha256Json(retrievalConfig),
      frozen: {
        run: runConfig,
        optimizer: optimizerConfig,
        target: targetConfig,
        retrieval: retrievalConfig,
        executionSnapshot,
        candidate: {
          candidateRevisionId: "candidate-revision-1",
          revision: 1,
          baselinePromptHash: sha256Text("baseline prompt"),
          candidatePromptHash: sha256Text("candidate prompt"),
        },
        invariants,
      },
    },
    evidencePacks,
    responses: {
      baseline: evidencePacks.map((pack) =>
        makeResponse(pack.caseId, "baseline", pack),
      ),
      candidate: evidencePacks.map((pack) =>
        makeResponse(pack.caseId, "candidate", pack),
      ),
    },
  };
}

describe("evaluation evidence manifests", () => {
  it("hashes and freezes a two-source graph evidence pack and both response sets", () => {
    const manifest = createEvaluationEvidenceManifest(manifestInput());

    expect(isEvaluationEvidenceManifestIntact(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.evidencePacks[0])).toBe(true);
    expect(manifest.sourceManifest).toHaveLength(2);
    expect(manifest.evidencePacks[0]?.graphPaths[0]?.entityIds).toHaveLength(3);
    expect(createEvaluationEvidenceManifest(manifestInput()).manifestHash).toBe(
      manifest.manifestHash,
    );
  });

  it("hashes and validates a hybrid evidence snapshot without a graph snapshot", () => {
    const manifest = createEvaluationEvidenceManifest(manifestInput("hybrid"));

    expect(isEvaluationEvidenceManifestIntact(manifest)).toBe(true);
    expect(manifest.graph).toMatchObject({
      requestedStrategy: "hybrid",
      selectedSnapshotId: null,
      usedSnapshotIds: [],
      strategyUsed: "hybrid",
    });
    expect(manifest.evidencePacks[0]).toMatchObject({
      requestedStrategy: "hybrid",
      strategyUsed: "hybrid",
      selectedSnapshotId: null,
      evidence: [{ kind: "chunk", quote: "2 + 2 = 5." }],
      graphPaths: [],
    });
  });

  it("rejects mutation in every frozen manifest dimension", () => {
    const manifest = createEvaluationEvidenceManifest(manifestInput());
    const mutations: Array<(value: EvaluationEvidenceManifest) => void> = [
      (value) => (value.baselinePromptHash = sha256Text("changed baseline")),
      (value) => (value.candidatePromptHash = sha256Text("changed candidate")),
      (value) => (value.invariantsHash = sha256Text("changed invariants")),
      (value) => (value.candidateRevisionId = "revision-b"),
      (value) => (value.revision = 2),
      (value) => (value.target.resolvedModel = "different-model"),
      (value) => (value.target.sentEffort = "low"),
      (value) => (value.configuration.runConfigHash = sha256Text("run")),
      (value) => (value.configuration.optimizerConfigHash = sha256Text("opt")),
      (value) => (value.configuration.targetConfigHash = sha256Text("target")),
      (value) =>
        (value.configuration.retrievalConfigHash = sha256Text("retrieval")),
      (value) => (requiredItem(value.caseManifest).input = "changed case"),
      (value) => (requiredItem(value.caseManifest).split = "holdout"),
      (value) =>
        (requiredItem(value.sourceManifest).checksum = "changed checksum"),
      (value) => (value.graph.selectedSnapshotId = null),
      (value) =>
        (value.workspaceSnapshot.contentHash = sha256Text("workspace")),
      (value) => (value.policy.version = "changed policy"),
      (value) =>
        (requiredItem(value.evidencePacks).contextText = "changed evidence"),
      (value) =>
        (requiredItem(value.responses.baseline).responseId = "changed-response"),
      (value) =>
        (requiredItem(value.responses.candidate).contextHash = sha256Text("other")),
    ];

    for (const mutate of mutations) {
      const changed = structuredClone(manifest);
      mutate(changed);
      expect(isEvaluationEvidenceManifestIntact(changed)).toBe(false);
    }
  });

  it("inserts identical frozen evidence into both target arms", () => {
    const pack = evidencePack(
      "case-1",
      "Where is Senopati relative to the target?",
    );
    const baseline = buildTargetEvaluationRequest({
      prompt: "baseline prompt",
      caseInput: "Where is Senopati relative to the target?",
      evidencePack: pack,
    });
    const candidate = buildTargetEvaluationRequest({
      prompt: "candidate prompt",
      caseInput: "Where is Senopati relative to the target?",
      evidencePack: pack,
    });

    expect(baseline.match(/<FROZEN_SOURCE_EVIDENCE>/gu)).toHaveLength(1);
    expect(candidate.match(/<FROZEN_SOURCE_EVIDENCE>/gu)).toHaveLength(1);
    expect(baseline).toContain(pack.contextText);
    expect(candidate).toContain(pack.contextText);
    expect(sha256Text(pack.contextText)).toBe(pack.contextHash);
  });

  it("requires exact prompt and paired response bindings before a decision", () => {
    const manifest = createEvaluationEvidenceManifest(manifestInput());
    const makeCaseResults = (
      references: EvaluationEvidenceManifestInput["responses"]["baseline"],
    ) =>
      references.map((reference) => {
        const testCase = manifest.caseManifest.find(
          (item) => item.caseId === reference.caseId,
        )!;
        return {
          id: reference.caseId,
          input: testCase.input,
          source: testCase.source,
          answer: `Answer for ${reference.caseId}`,
          answerHash: reference.answerHash,
          responseId: reference.responseId,
          responseModel: reference.responseModel,
          requestHash: reference.requestHash,
          contextHash: reference.contextHash,
        };
      });
    const candidate = {
      id: manifest.candidateRevisionId,
      revision: manifest.revision,
      prompt: "candidate prompt",
      outcome: "candidate_ready",
      testingStatus: "ready",
      evidenceBoundToPrompt: true,
      draftVersionId: "draft-version-1",
      evaluationManifest: manifest,
      invariantStatus: "preserved",
      invariantsPreserved: true,
      caseResults: makeCaseResults(manifest.responses.candidate),
    };
    const result = {
      status: "candidate_ready",
      baseline: {
        prompt: "baseline prompt",
        caseResults: makeCaseResults(manifest.responses.baseline),
      },
      candidate,
      candidates: [candidate],
    };
    const request = {
      runId: manifest.runId,
      runStatus: "succeeded",
      runConfigSnapshot: manifest.configuration.frozen.run as Record<
        string,
        unknown
      >,
      completionAttemptId: manifest.attemptId,
      completionPayload: {
        status: "succeeded",
        mode: "prompt_optimization",
        requestedModel: manifest.target.requestedModel,
        resolvedModel: manifest.target.resolvedModel,
        reasoningEffort: manifest.target.sentEffort,
        targetSelection: manifest.target.selection,
        result,
      },
      candidateId: candidate.id,
    };

    expect(isOptimizationCandidateEvidenceEligible(request)).toBe(true);
    expect(
      isOptimizationCandidateEvidenceEligible({
        ...request,
        completionPayload: {
          ...request.completionPayload,
          result: {
          ...result,
          candidates: [{ ...candidate, prompt: "changed prompt" }],
          },
        },
      }),
    ).toBe(false);
    expect(
      isOptimizationCandidateEvidenceEligible({
        ...request,
        completionPayload: {
          ...request.completionPayload,
          result: {
          ...result,
          baseline: {
            ...result.baseline,
            caseResults: [
              {
                ...result.baseline.caseResults[0],
                responseId: "wrong-response",
              },
              result.baseline.caseResults[1],
            ],
          },
          },
        },
      }),
    ).toBe(false);
  });
});
