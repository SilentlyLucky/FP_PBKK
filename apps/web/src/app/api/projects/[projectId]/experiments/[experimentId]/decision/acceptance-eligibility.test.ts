import { describe, expect, it } from "vitest";

import {
  buildTargetEvaluationRequest,
  createEvaluationEvidenceManifest,
  sha256Json,
  sha256Text,
} from "@promptlab/agent/evidence-manifest";
import {
  PromptOptimizationRequestSchema,
  type EvaluationEvidencePack,
} from "@promptlab/contracts";

import {
  hasExperimentAcceptanceEvidence,
  type ExperimentAcceptanceEvent,
  type ExperimentAcceptanceRun,
} from "./acceptance-eligibility.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const promptVersionId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const caseId = "pilot-case-1";
const input = "Summarize the example.";
const baselinePrompt = "Answer the input clearly.";
const requestedModel = "gpt-5.6";

const targetSelection = {
  selection: { model: "selected", reasoningEffort: "selected" },
  requestedModel,
  resolvedModel: requestedModel,
  requestedReasoningEffort: null,
  resolvedReasoningEffort: null,
  sentReasoningEffort: null,
  modelResolution: "explicit",
  effortResolution: "provider_default",
  capabilitySource: "live_codex_model_list",
  observedAt: "2026-10-15T00:00:00.000Z",
  modelCatalogPosition: 1,
  modelCatalogCount: 1,
  modelCapabilities: {
    displayName: "GPT 5.6",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
    inputModalities: ["text"],
  },
};

type FixtureStatus = "passed" | "failed" | "unavailable" | "invalid_fixture";

function pythonFixtureEvidence(status: FixtureStatus) {
  const actualOutput =
    status === "passed" ? "1" : status === "failed" ? "0" : null;
  const expectedMatchesReference = status !== "invalid_fixture";
  return {
    kind: "python_tests",
    status,
    execution: {
      status: status === "unavailable" ? "unavailable" : "passed",
      reasonCode:
        status === "unavailable"
          ? "verified_isolated_python_runner_unavailable"
          : null,
    },
    limitations: ["complexity_not_proved_by_behavioral_tests"],
    fixtures: [
      {
        id: "one-cell-grid",
        expectedOutput: "1",
        referenceOutput: expectedMatchesReference ? "1" : "2",
        expectedMatchesReference,
        actualOutput,
        status,
        reasonCode:
          status === "passed"
            ? null
            : status === "failed"
              ? "candidate_output_does_not_match_expected"
              : status === "invalid_fixture"
                ? "expected_values_do_not_match_exact_reference"
                : "verified_isolated_python_runner_unavailable",
      },
    ],
  };
}

function verificationEvidence(
  verification: Record<string, unknown>,
  status: FixtureStatus,
) {
  if (verification.kind === "python_tests") {
    return pythonFixtureEvidence(status);
  }

  const expected = verification.expected as { count: string; sum: string };
  const wrongCount = expected.count === "0" ? "1" : "0";
  return {
    kind: "divisibility",
    status,
    expected,
    reference:
      status === "invalid_fixture"
        ? { count: wrongCount, sum: expected.sum }
        : expected,
    actual:
      status === "passed"
        ? expected
        : status === "failed"
          ? { count: wrongCount, sum: expected.sum }
          : null,
    reasonCode:
      status === "passed"
        ? null
        : status === "failed"
          ? "answer_does_not_match_expected_values"
          : status === "unavailable"
            ? "target_answer_missing"
            : "expected_values_do_not_match_exact_reference",
  };
}

function scenario(
  options: {
    verification?: Record<string, unknown>;
    baselineFixtureStatus?: FixtureStatus;
    candidateFixtureStatus?: FixtureStatus;
    arm?: "original" | "rag" | "graphrag";
    graphFallback?: boolean;
  } = {},
) {
  const arm = options.arm ?? "original";
  const sourceId = "88888888-8888-4888-8888-888888888888";
  const sourceVersionId = "99999999-9999-4999-8999-999999999999";
  const graphSnapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sourceChecksum = "frozen-source-checksum";
  const sourceIds = arm === "original" ? [] : [sourceId];
  const activeSnapshotId = arm === "graphrag" ? graphSnapshotId : null;
  const retrievalStrategy: "graph" | "lexical" =
    arm === "graphrag" ? "graph" : "lexical";
  const requestedStrategy: "none" | "lexical" | "graph" =
    arm === "original" ? "none" : arm === "rag" ? "lexical" : "graph";
  const actualStrategy: "none" | "lexical" | "graph" =
    arm === "graphrag" && options.graphFallback ? "lexical" : requestedStrategy;
  const usedSnapshotId =
    arm === "graphrag" && options.graphFallback ? null : activeSnapshotId;
  const fallbackReason = options.graphFallback
    ? "no_lexical_graph_seed"
    : null;
  const sourceManifest = arm === "original"
    ? []
    : [
        {
          documentId: sourceId,
          documentVersionId: sourceVersionId,
          documentVersion: 3,
          checksum: sourceChecksum,
        },
      ];
  const verification = options.verification;
  const optimization = PromptOptimizationRequestSchema.parse({
    maxIterations: 1,
    maxToolCalls: 6,
    testCases: [
      {
        id: caseId,
        input,
        ...(verification ? { verification } : {}),
      },
    ],
  });
  const expectedCase = {
    id: caseId,
    input,
    source: "user",
    ...(optimization.testCases[0]?.verification
      ? { verification: optimization.testCases[0].verification }
      : {}),
  };
  const candidateId = "55555555-5555-4555-8555-555555555555";
  const candidatePrompt = "Summarize the input in one concise paragraph.";
  const contextText = arm === "original" ? "" : "Frozen source evidence.";
  const evidenceId = "source-evidence-1";
  const evidencePack: EvaluationEvidencePack = {
    caseId,
    requestedStrategy,
    strategyUsed: actualStrategy,
    selectedSnapshotId: activeSnapshotId,
    usedSnapshotId,
    fallbackReason,
    selectedSourceIds: sourceIds,
    sourceManifest,
    contextText,
    contextHash: sha256Text(contextText),
    evidence:
      arm === "original"
        ? []
        : [
            {
              id: evidenceId,
              kind: actualStrategy === "graph" ? "graph" : "chunk",
              documentId: sourceId,
              documentName: "Frozen source",
              documentVersionId: sourceVersionId,
              documentVersion: 3,
              chunkId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sourceChecksum,
              quote: "Frozen source evidence.",
              contentHash: sha256Text("Frozen source evidence."),
              assertionVersionIds:
                actualStrategy === "graph"
                  ? ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]
                  : [],
            },
          ],
    graphPaths:
      actualStrategy === "graph"
        ? [
            {
              entityIds: [
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              ],
              labels: ["Source entity", "Related entity"],
              assertionVersionIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
              predicates: ["related_to"],
              evidenceIds: [evidenceId],
            },
          ]
        : [],
    estimatedContextTokens: 0,
    contextBudgetTokens: 0,
    clipping: {},
  };
  const baselineStatus = options.baselineFixtureStatus ?? "passed";
  const candidateStatus = options.candidateFixtureStatus ?? "passed";
  const answerFor = (
    spec: Record<string, unknown> | undefined,
    status: FixtureStatus,
    fallback: string,
  ) => {
    if (!spec) return fallback;
    if (spec.kind === "python_tests") return "def solve(): return 1";
    const expected = spec.expected as { count: string; sum: string };
    if (status === "invalid_fixture") return "not json";
    const count =
      status === "failed"
        ? expected.count === "0"
          ? "1"
          : "0"
        : expected.count;
    return JSON.stringify({ count, sum: expected.sum });
  };
  const baselineAnswer = answerFor(
    verification,
    baselineStatus,
    "A clear summary.",
  );
  const candidateAnswer = answerFor(
    verification,
    candidateStatus,
    "A concise summary.",
  );
  const runConfig = {
    retrieval: {
      strategy: retrievalStrategy,
      sourceIds,
      snapshotId: activeSnapshotId,
    },
    optimization,
  };
  const optimizerConfig = { request: optimization };
  const targetConfig = {
    requestedModel,
    resolvedModel: requestedModel,
    requestedEffort: null,
    sentEffort: null,
    targetSelection,
  };
  const retrievalConfig = {
    strategy: retrievalStrategy,
    sourceIds,
    snapshotId: activeSnapshotId,
    requestedStrategy,
    selectedSnapshotId: activeSnapshotId,
    sourceManifest,
    evidencePacks: [evidencePack],
  };
  const executionSnapshot = {
    preflightComplete: true,
    testCases: [expectedCase],
    sourceIds,
    retrievalStrategy,
    graphSnapshotId: activeSnapshotId,
  };
  const baselineResponse = {
    caseId,
    responseId: "baseline-response",
    responseModel: requestedModel,
    provider: "codex_app_server" as const,
    attemptId,
    requestHash: sha256Text(
      buildTargetEvaluationRequest({
        prompt: baselinePrompt,
        caseInput: input,
        evidencePack,
      }),
    ),
    contextHash: evidencePack.contextHash,
    answerHash: sha256Text(baselineAnswer),
  };
  const candidateResponse = {
    ...baselineResponse,
    responseId: "candidate-response",
    requestHash: sha256Text(
      buildTargetEvaluationRequest({
        prompt: candidatePrompt,
        caseInput: input,
        evidencePack,
      }),
    ),
    answerHash: sha256Text(candidateAnswer),
  };
  const evaluationManifest = createEvaluationEvidenceManifest({
    runId: experimentId,
    attemptId,
    candidateRevisionId: candidateId,
    revision: 1,
    baselinePromptHash: sha256Text(baselinePrompt),
    candidatePromptHash: sha256Text(candidatePrompt),
    invariantsHash: sha256Json([]),
    caseManifest: [
      {
        caseId,
        input,
        inputHash: sha256Text(input),
        inputCharacters: input.length,
        source: "user",
        split: "development",
        verificationHash: optimization.testCases[0]?.verification
          ? sha256Json(optimization.testCases[0].verification)
          : null,
      },
    ],
    sourceManifest,
    graph: {
      requestedStrategy,
      selectedSnapshotId: activeSnapshotId,
      usedSnapshotIds: usedSnapshotId ? [usedSnapshotId] : [],
      strategyUsed: actualStrategy,
      fallbackReasons: fallbackReason ? [fallbackReason] : [],
    },
    workspaceSnapshot: { mode: "none", snapshotId: null, contentHash: null },
    target: {
      provider: "codex_app_server",
      requestedModel,
      resolvedModel: requestedModel,
      requestedEffort: null,
      resolvedEffort: null,
      sentEffort: null,
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
          candidateRevisionId: candidateId,
          revision: 1,
          baselinePromptHash: sha256Text(baselinePrompt),
          candidatePromptHash: sha256Text(candidatePrompt),
        },
        invariants: [],
      },
    },
    evidencePacks: [evidencePack],
    responses: {
      baseline: [baselineResponse],
      candidate: [candidateResponse],
    },
  });
  const baselineEvidence = verification
    ? verificationEvidence(
        verification,
        baselineStatus,
      )
    : null;
  const candidateEvidence = verification
    ? verificationEvidence(
        verification,
        candidateStatus,
      )
    : null;
  const baselineCase = {
    ...expectedCase,
    answer: baselineAnswer,
    ...baselineResponse,
    usage: { inputTokens: {}, outputTokens: {}, totalTokens: {} },
    latencyMs: 20,
    verificationEvidence: baselineEvidence,
  };
  const candidateCase = {
    ...expectedCase,
    answer: candidateAnswer,
    ...candidateResponse,
    usage: { inputTokens: {}, outputTokens: {}, totalTokens: {} },
    latencyMs: 18,
    verificationEvidence: candidateEvidence,
  };
  const candidate = {
    id: candidateId,
    revision: 1,
    prompt: candidatePrompt,
    outcome: "candidate_ready",
    testingStatus: "ready",
    evidenceBoundToPrompt: true,
    draftVersionId: "77777777-7777-4777-8777-777777777777",
    evaluationManifest,
    invariantStatus: "not_configured",
    invariantsPreserved: null,
    caseResults: [candidateCase],
  };
  const result = {
    status: "candidate_ready",
    clarificationRequired: false,
    baseline: { prompt: baselinePrompt, caseResults: [baselineCase] },
    candidate,
    candidates: [candidate],
    latestCandidateId: candidateId,
    reviewableCandidateId: candidateId,
    comparison: { tokenChange: null, tokenChangePercent: null },
    targetSelection,
  };

  const run: ExperimentAcceptanceRun = {
    id: experimentId,
    projectId,
    status: "succeeded",
    promptVersionId,
    provider: "codex_app_server",
    purpose: "target",
    requestedModel,
    configSnapshot: {
      retrieval: runConfig.retrieval,
      optimization,
      optimizationExecutionSnapshot: {
        preflightComplete: true,
        preflightSummary: "The provided case is ready.",
        targetSelection,
        testCases: [expectedCase],
        sourceIds,
        retrievalStrategy,
        graphSnapshotId: activeSnapshotId,
        history: [],
      },
    },
  };

  const metadata = {
    datasetName: "Pilot dataset",
    datasetVersion: "1",
    caseId,
    input,
    promptId: "66666666-6666-4666-8666-666666666666",
    promptVersionId,
    promptName: "Support prompt",
    promptVersion: 1,
    baselinePrompt,
    requestedModel,
    reasoningEffort: null,
    arm,
    split: "development",
    retrieval: runConfig.retrieval,
    activeSnapshotId,
    sources:
      arm === "original"
        ? []
        : [
            {
              id: sourceId,
              title: "Frozen source",
              version: 3,
              versionId: sourceVersionId,
              checksum: sourceChecksum,
            },
          ],
  };

  function event(
    sequence: number,
    eventType: string,
    payload: unknown,
  ): ExperimentAcceptanceEvent {
    return {
      projectId,
      runId: experimentId,
      attemptId,
      sequence,
      eventType,
      payload,
    };
  }

  const evaluationCase = (caseResult: typeof baselineCase) => ({
    ...caseResult,
    caseId: caseResult.id,
    text: caseResult.answer,
  });
  const events: ExperimentAcceptanceEvent[] = [
    event(1, "agent.action", {
      mode: "prompt_optimization",
      phase: "target_test",
      model: requestedModel,
      modelSelection: "selected",
      effortSelection: "selected",
      caseId,
      source: "user",
    }),
    event(2, "usage.snapshot", {
      mode: "prompt_optimization",
      provider: "codex_app_server",
      purpose: "target",
      responseModel: requestedModel,
      responseId: "baseline-response",
      subject: "baseline",
      caseId,
      source: "user",
    }),
    event(3, "evaluation.result", {
      mode: "prompt_optimization",
      subject: "baseline",
      subjectId: "baseline",
      caseResults: [evaluationCase(baselineCase)],
    }),
    event(4, "agent.action", {
      mode: "prompt_optimization",
      phase: "target_test",
      model: requestedModel,
      modelSelection: "selected",
      effortSelection: "selected",
      caseId,
      source: "user",
    }),
    event(5, "usage.snapshot", {
      mode: "prompt_optimization",
      provider: "codex_app_server",
      purpose: "target",
      responseModel: requestedModel,
      responseId: "candidate-response",
      subject: "candidate",
      caseId,
      source: "user",
    }),
    event(6, "evaluation.result", {
      mode: "prompt_optimization",
      subject: "candidate",
      subjectId: result.candidate.id,
      caseResults: [evaluationCase(candidateCase)],
    }),
    event(7, "run.completed", {
      status: "succeeded",
      mode: "prompt_optimization",
      requestedModel,
      resolvedModel: requestedModel,
      reasoningEffort: null,
      targetSelection,
      result,
    }),
  ];

  return { run, metadata, events, result, baselineCase, candidateCase };
}

function isEligible(input: ReturnType<typeof scenario>) {
  return hasExperimentAcceptanceEvidence({
    projectId,
    experimentId,
    run: input.run,
    metadata: input.metadata,
    events: input.events,
  });
}

describe("Experiments acceptance evidence", () => {
  it("rejects a fabricated completed result without stored paired calls and evaluations", () => {
    const input = scenario();
    input.events = [input.events.at(-1)!];

    expect(isEligible(input)).toBe(false);
  });

  it("rejects an incomplete pair and a candidate not bound to its tested prompt", () => {
    const missingCase = scenario();
    missingCase.result.candidate.caseResults = [];
    expect(isEligible(missingCase)).toBe(false);

    const unboundCandidate = scenario();
    unboundCandidate.result.candidate.evidenceBoundToPrompt = false;
    expect(isEligible(unboundCandidate)).toBe(false);
  });

  it("accepts a complete comparison when a valid baseline fixture fails and the candidate passes", () => {
    const input = scenario({
      verification: {
        kind: "python_tests",
        tests: [
          { id: "one-cell-grid", n: 1, expectedOutput: "1", blocked: [] },
        ],
      },
      baselineFixtureStatus: "failed",
      candidateFixtureStatus: "passed",
    });

    expect(isEligible(input)).toBe(true);
  });

  it("accepts a failed baseline divisibility check when the candidate passes", () => {
    const input = scenario({
      verification: {
        kind: "divisibility",
        startInclusive: 1,
        endInclusive: 2,
        includeDivisors: [1],
        excludeDivisors: [],
        expected: { count: "2", sum: "3" },
      },
      baselineFixtureStatus: "failed",
      candidateFixtureStatus: "passed",
    });

    expect(isEligible(input)).toBe(true);
  });

  it("rejects a comparison when a valid candidate fixture fails", () => {
    const input = scenario({
      verification: {
        kind: "python_tests",
        tests: [
          { id: "one-cell-grid", n: 1, expectedOutput: "1", blocked: [] },
        ],
      },
      baselineFixtureStatus: "passed",
      candidateFixtureStatus: "failed",
    });

    expect(isEligible(input)).toBe(false);
  });

  it.each(["baseline", "candidate"] as const)(
    "rejects an invalid %s fixture even when the other result is usable",
    (subject) => {
      const input = scenario({
        verification: {
          kind: "python_tests",
          tests: [
            { id: "one-cell-grid", n: 1, expectedOutput: "1", blocked: [] },
          ],
        },
        baselineFixtureStatus:
          subject === "baseline" ? "invalid_fixture" : "failed",
        candidateFixtureStatus:
          subject === "candidate" ? "invalid_fixture" : "passed",
      });

      expect(isEligible(input)).toBe(false);
    },
  );

  it("rejects configured verification that is unavailable", () => {
    const input = scenario({
      verification: {
        kind: "python_tests",
        tests: [
          { id: "one-cell-grid", n: 1, expectedOutput: "1", blocked: [] },
        ],
      },
      baselineFixtureStatus: "unavailable",
      candidateFixtureStatus: "passed",
    });

    expect(isEligible(input)).toBe(false);
  });

  it("accepts a complete actual pair bound to its frozen run evidence", () => {
    expect(isEligible(scenario())).toBe(true);
  });

  it.each(["rag", "graphrag"] as const)(
    "accepts source-backed %s evidence only when the frozen source version is bound",
    (arm) => {
      const input = scenario({ arm });
      expect(isEligible(input)).toBe(true);

      const changedSource = scenario({ arm });
      (changedSource.metadata.sources[0] as { checksum: string }).checksum =
        "a-different-source-checksum";
      expect(isEligible(changedSource)).toBe(false);
    },
  );

  it("does not count lexical fallback as a GraphRAG experiment", () => {
    expect(isEligible(scenario({ arm: "graphrag", graphFallback: true }))).toBe(
      false,
    );
  });

  it("rejects either result when its target request is detached from the manifest", () => {
    const changedBaseline = scenario();
    changedBaseline.baselineCase.requestHash = sha256Text(
      "different baseline request",
    );
    expect(isEligible(changedBaseline)).toBe(false);

    const changedCandidate = scenario();
    changedCandidate.candidateCase.requestHash = sha256Text(
      "different candidate request",
    );
    expect(isEligible(changedCandidate)).toBe(false);
  });

  it("accepts a complete pair when every configured fixture passed", () => {
    expect(
      isEligible(
        scenario({
          verification: {
            kind: "python_tests",
            tests: [
              { id: "one-cell-grid", n: 1, expectedOutput: "1", blocked: [] },
            ],
          },
          baselineFixtureStatus: "passed",
          candidateFixtureStatus: "passed",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a pair whose target-call model, effort, or frozen context differs", () => {
    const mismatchedModel = scenario();
    mismatchedModel.events[3]!.payload = {
      ...(mismatchedModel.events[3]!.payload as Record<string, unknown>),
      model: "another-model",
    };
    expect(isEligible(mismatchedModel)).toBe(false);

    const mismatchedEffort = scenario();
    mismatchedEffort.events[3]!.payload = {
      ...(mismatchedEffort.events[3]!.payload as Record<string, unknown>),
      reasoningEffort: "high",
    };
    expect(isEligible(mismatchedEffort)).toBe(false);

    const sourceBackedContext = scenario();
    Object.assign(sourceBackedContext.metadata as Record<string, unknown>, {
      activeSnapshotId: "88888888-8888-4888-8888-888888888888",
    });
    expect(isEligible(sourceBackedContext)).toBe(false);
  });

  it("does not use run evidence belonging to another project", () => {
    const input = scenario();
    input.events = input.events.map((event) => ({
      ...event,
      projectId: "77777777-7777-4777-8777-777777777777",
    }));

    expect(isEligible(input)).toBe(false);
  });
});
