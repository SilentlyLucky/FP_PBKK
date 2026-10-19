import { describe, expect, it } from "vitest";

import {
  buildTargetEvaluationRequest,
  createEvaluationEvidenceManifest,
  sha256Json,
  sha256Text,
} from "@promptlab/agent/evidence-manifest";
import { LEGACY_UNTESTED_CANDIDATE } from "@/lib/optimization-result";

import {
  type CandidateApplyEligibilityInput,
  validateOptimizationCandidateApply,
} from "./eligibility.js";

const projectId = "project-1";
const runId = "run-1";
const promptId = "prompt-1";
const baselineVersionId = "version-1";
const candidateId = "candidate-1";
const draftVersionId = "draft-1";
const baselineText = "Jawab dengan aturan yang berlaku.";
const candidateText = "Jawab ringkas dengan aturan yang berlaku.";
const verification = {
  kind: "divisibility",
  startInclusive: 1,
  endInclusive: 10,
  includeDivisors: [2],
  excludeDivisors: [],
  expected: { count: "5", sum: "30" },
};

function eligibleInput(
  invariants: string[] = ["Jaga aturan yang berlaku."],
): CandidateApplyEligibilityInput {
  const testCase = {
    id: "case-1",
    input: "Hitung bilangan genap.",
    source: "user" as const,
    verification,
  };
  const evidencePack = {
    caseId: testCase.id,
    requestedStrategy: "none" as const,
    strategyUsed: "none" as const,
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
  const attemptId = "attempt-1";
  const optimization = {
    testCases: [{ id: testCase.id, input: testCase.input, verification }],
  };
  const runConfig = {
    retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
    optimization,
  };
  const optimizerConfig = { request: optimization };
  const targetConfig = {
    requestedModel: "gpt-test",
    resolvedModel: "gpt-test",
    requestedEffort: null,
    sentEffort: null,
    targetSelection: {},
  };
  const retrievalConfig = {
    requestedStrategy: "none",
    sourceIds: [],
    selectedSnapshotId: null,
    sourceManifest: [],
    evidencePacks: [evidencePack],
  };
  const executionSnapshot = {
    preflightComplete: true,
    testCases: [testCase],
    sourceIds: [],
    retrievalStrategy: "lexical",
    graphSnapshotId: null,
  };
  const baselineAnswer = "Hasil baseline.";
  const candidateAnswer = '{"count":5,"sum":30}';
  const responseReference = (
    subject: "baseline" | "candidate",
    prompt: string,
    answer: string,
  ) => ({
    caseId: testCase.id,
    responseId: `${subject}-response`,
    responseModel: "gpt-test",
    provider: "codex_app_server" as const,
    attemptId,
    requestHash: sha256Text(
      buildTargetEvaluationRequest({
        prompt,
        caseInput: testCase.input,
        evidencePack,
      }),
    ),
    contextHash: evidencePack.contextHash,
    answerHash: sha256Text(answer),
  });
  const evaluationManifest = createEvaluationEvidenceManifest({
    runId,
    attemptId,
    candidateRevisionId: candidateId,
    revision: 1,
    baselinePromptHash: sha256Text(baselineText),
    candidatePromptHash: sha256Text(candidateText),
    invariantsHash: sha256Json(invariants),
    caseManifest: [
      {
        caseId: testCase.id,
        input: testCase.input,
        inputHash: sha256Text(testCase.input),
        inputCharacters: testCase.input.length,
        source: testCase.source,
        split: "development",
        verificationHash: sha256Json(verification),
      },
    ],
    sourceManifest: [],
    graph: {
      requestedStrategy: "none",
      selectedSnapshotId: null,
      usedSnapshotIds: [],
      strategyUsed: "none",
      fallbackReasons: [],
    },
    workspaceSnapshot: { mode: "none", snapshotId: null, contentHash: null },
    target: {
      provider: "codex_app_server",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      requestedEffort: null,
      resolvedEffort: null,
      sentEffort: null,
      providerVersion: "codex-test",
      selection: {},
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
          baselinePromptHash: sha256Text(baselineText),
          candidatePromptHash: sha256Text(candidateText),
        },
        invariants,
      },
    },
    evidencePacks: [evidencePack],
    responses: {
      baseline: [responseReference("baseline", baselineText, baselineAnswer)],
      candidate: [responseReference("candidate", candidateText, candidateAnswer)],
    },
  });
  const baselineResponse = evaluationManifest.responses.baseline[0]!;
  const candidateResponse = evaluationManifest.responses.candidate[0]!;
  return {
    requested: {
      projectId,
      runId,
      promptId,
      candidateId,
      draftVersionId,
    },
    run: {
      id: runId,
      projectId,
      status: "succeeded",
      purpose: "target",
      promptVersionId: baselineVersionId,
      configSnapshot: {
        ...runConfig,
        optimizationExecutionSnapshot: {
          preflightComplete: true,
          testCases: [testCase],
          sourceIds: [],
          retrievalStrategy: "lexical",
          graphSnapshotId: null,
        },
      },
    },
    completionAttemptId: attemptId,
    prompt: {
      id: promptId,
      projectId,
      currentVersionId: baselineVersionId,
      deletedAt: null,
    },
    baselineVersion: {
      id: baselineVersionId,
      projectId,
      promptId,
      text: baselineText,
      invariants,
    },
    draftVersion: {
      id: draftVersionId,
      projectId,
      promptId,
      version: 2,
      parentVersionId: baselineVersionId,
      text: candidateText,
      invariants,
      createdBy: "prompt_optimization",
    },
    completionPayload: {
      status: "succeeded",
      mode: "prompt_optimization",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      reasoningEffort: null,
      targetSelection: {},
      result: {
        status: "candidate_ready",
        baseline: {
          prompt: baselineText,
          caseResults: [
            {
              id: testCase.id,
              input: testCase.input,
              source: testCase.source,
              verification,
              answer: baselineAnswer,
              ...baselineResponse,
              verificationEvidence: {
                kind: "divisibility",
                status: "failed",
                expected: { count: "5", sum: "30" },
                reference: { count: "5", sum: "30" },
                actual: null,
                reasonCode:
                  "answer_must_be_a_json_object_with_exact_count_and_sum",
              },
            },
          ],
        },
        candidate: {
          id: candidateId,
          revision: 1,
          prompt: candidateText,
          outcome: "candidate_ready",
          draftVersionId,
          testingStatus: "ready",
          evidenceBoundToPrompt: true,
          evaluationManifest,
          invariantStatus: "preserved",
          invariantsPreserved: true,
          caseResults: [
            {
              id: testCase.id,
              input: testCase.input,
              source: testCase.source,
              ...candidateResponse,
              verification,
              answer: candidateAnswer,
              verificationEvidence: {
                kind: "divisibility",
                status: "passed",
                expected: { count: "5", sum: "30" },
                reference: { count: "5", sum: "30" },
                actual: { count: "5", sum: "30" },
                reasonCode: null,
              },
            },
          ],
        },
      },
    },
  };
}

function updateCandidate(
  input: CandidateApplyEligibilityInput,
  patch: Record<string, unknown>,
): CandidateApplyEligibilityInput {
  const completion = input.completionPayload as Record<string, unknown>;
  const result = completion.result as Record<string, unknown>;
  const candidate = result.candidate as Record<string, unknown>;
  return {
    ...input,
    completionPayload: {
      ...completion,
      result: { ...result, candidate: { ...candidate, ...patch } },
    },
  };
}

function currentCandidate(input: CandidateApplyEligibilityInput) {
  const completion = input.completionPayload as Record<string, unknown>;
  const result = completion.result as Record<string, unknown>;
  return result.candidate as Record<string, unknown>;
}

describe("server-side optimization candidate apply eligibility", () => {
  it("allows a ready candidate after every frozen verification passes", () => {
    expect(validateOptimizationCandidateApply(eligibleInput())).toEqual({
      eligible: true,
      alreadyApplied: false,
    });
  });

  it("treats applying the already active persisted draft as idempotent", () => {
    const input = eligibleInput();
    input.prompt.currentVersionId = draftVersionId;

    expect(validateOptimizationCandidateApply(input)).toEqual({
      eligible: true,
      alreadyApplied: true,
    });
  });

  it.each([
    [
      "a failed result",
      (input: CandidateApplyEligibilityInput) => ({
        ...input,
        completionPayload: {
          ...(input.completionPayload as Record<string, unknown>),
          result: {
            ...((input.completionPayload as Record<string, unknown>)
              .result as Record<string, unknown>),
            status: "incomplete",
          },
        },
      }),
    ],
    [
      "an incomplete candidate",
      (input: CandidateApplyEligibilityInput) =>
        updateCandidate(input, { testingStatus: "incomplete" }),
    ],
  ])("blocks %s", (_label, prepare) => {
    const result = validateOptimizationCandidateApply(prepare(eligibleInput()));
    expect(result.eligible).toBe(false);
  });

  it.each(["failed", "invalid_fixture", "unavailable"] as const)(
    "blocks configured verification with status %s",
    (status) => {
      const input = eligibleInput();
      const candidate = currentCandidate(input);
      const caseResults = candidate.caseResults as Array<
        Record<string, unknown>
      >;
      const caseResult = caseResults[0]!;
      caseResult.verificationEvidence = {
        ...(caseResult.verificationEvidence as Record<string, unknown>),
        status,
      };

      expect(validateOptimizationCandidateApply(input)).toEqual({
        eligible: false,
        reason: "verification_not_passed",
      });
    },
  );

  it("blocks missing frozen case results", () => {
    const result = validateOptimizationCandidateApply(
      updateCandidate(eligibleInput(), { caseResults: [] }),
    );
    expect(result).toEqual({
      eligible: false,
      reason: "case_results_incomplete",
    });
  });

  it("blocks an otherwise complete candidate when its target request hash changes", () => {
    const input = eligibleInput();
    const candidate = currentCandidate(input);
    const caseResults = candidate.caseResults as Array<Record<string, unknown>>;
    caseResults[0]!.requestHash = sha256Text("different target request");

    expect(validateOptimizationCandidateApply(input)).toEqual({
      eligible: false,
      reason: "candidate_not_ready",
    });
  });

  it("blocks the historical untested candidate while retaining its stored result", () => {
    const input = eligibleInput();
    input.requested.runId = LEGACY_UNTESTED_CANDIDATE.runId;
    input.run.id = LEGACY_UNTESTED_CANDIDATE.runId;
    input.requested.candidateId = LEGACY_UNTESTED_CANDIDATE.candidateId;
    input.requested.draftVersionId = LEGACY_UNTESTED_CANDIDATE.draftVersionId;
    input.draftVersion!.id = LEGACY_UNTESTED_CANDIDATE.draftVersionId;
    const candidate = currentCandidate(input);
    candidate.id = LEGACY_UNTESTED_CANDIDATE.candidateId;
    candidate.draftVersionId = LEGACY_UNTESTED_CANDIDATE.draftVersionId;

    expect(validateOptimizationCandidateApply(input)).toEqual({
      eligible: false,
      reason: "legacy_candidate",
    });
    expect(candidate.prompt).toBe(candidateText);
  });

  it("blocks a candidate whose text differs from the saved draft", () => {
    expect(
      validateOptimizationCandidateApply(
        updateCandidate(eligibleInput(), { prompt: "teks hasil edit" }),
      ),
    ).toEqual({ eligible: false, reason: "candidate_text_mismatch" });
  });

  it("blocks a request whose project does not own the run", () => {
    const input = eligibleInput();
    input.requested.projectId = "other-project";

    expect(validateOptimizationCandidateApply(input)).toEqual({
      eligible: false,
      reason: "draft_scope_mismatch",
    });
  });

  it("blocks applying over a prompt version changed after the run started", () => {
    const input = eligibleInput();
    input.prompt.currentVersionId = "manual-version";

    expect(validateOptimizationCandidateApply(input)).toEqual({
      eligible: false,
      reason: "stale_baseline",
    });
  });

  it("allows valid optimizer results when the prompt has no configured invariants", () => {
    const input = eligibleInput([]);
    const candidate = currentCandidate(input);
    candidate.invariantStatus = "not_configured";
    candidate.invariantsPreserved = null;

    expect(validateOptimizationCandidateApply(input)).toEqual({
      eligible: true,
      alreadyApplied: false,
    });
  });
});
