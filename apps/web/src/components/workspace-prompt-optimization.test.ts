import { describe, expect, it } from "vitest";
import {
  PromptOptimizationRequestSchema,
  RunCreateSchema,
} from "@promptlab/contracts";

import {
  canApplyOptimizationCandidate,
  LEGACY_UNTESTED_CANDIDATE,
  parseOptimizationResult,
} from "../lib/optimization-result.js";
import { buildPromptOptimizationRunRequest } from "../lib/prompt-optimization-run-request.js";

describe("prompt optimization run request", () => {
  it("sends Auto effort mode without leaking the workspace's prior concrete effort", () => {
    const request = buildPromptOptimizationRunRequest({
      projectId: "11111111-1111-4111-8111-111111111111",
      promptVersionId: "22222222-2222-4222-8222-222222222222",
      requestedModel: "gpt-6.1-sol",
      reasoningEffort: "medium",
      modelSelection: "selected",
      effortSelection: "auto",
      idempotencyKey: "auto-effort-ui-request",
      retrievalStrategy: "lexical",
      knowledgeSourceIds: [],
      objective: "  Keep the answer concise.  ",
      testCases: [],
    });

    expect(Object.hasOwn(request, "reasoningEffort")).toBe(false);
    expect(request).toMatchObject({
      requestedModel: "gpt-6.1-sol",
      optimization: {
        objective: "Keep the answer concise.",
        targetSelection: { model: "selected", reasoningEffort: "auto" },
      },
    });
    const validated = RunCreateSchema.parse(request);
    const persisted = JSON.parse(
      JSON.stringify({ optimization: validated.optimization }),
    ) as { optimization: unknown };
    expect(
      PromptOptimizationRequestSchema.parse(persisted.optimization)
        .targetSelection,
    ).toEqual({ model: "selected", reasoningEffort: "auto" });
  });

  it("keeps a manually selected effort when model selection is Auto", () => {
    const request = buildPromptOptimizationRunRequest({
      projectId: "11111111-1111-4111-8111-111111111111",
      promptVersionId: "22222222-2222-4222-8222-222222222222",
      requestedModel: "gpt-6-luna",
      reasoningEffort: "high",
      modelSelection: "auto",
      effortSelection: "selected",
      idempotencyKey: "manual-effort-ui-request",
      retrievalStrategy: "lexical",
      knowledgeSourceIds: [],
      objective: "",
      testCases: [],
    });

    expect(request.reasoningEffort).toBe("high");
    expect(request.optimization.targetSelection).toEqual({
      model: "auto",
      reasoningEffort: "selected",
    });
  });
});

describe("optimization comparison parsing", () => {
  it("shows Auto selection together with the concrete effort and its policy reason", () => {
    const parsed = parseOptimizationResult(
      {
        baseline: { prompt: "prompt lama", answers: [] },
        targetSelection: {
          selection: { model: "selected", reasoningEffort: "auto" },
          requestedModel: "gpt-6-luna",
          resolvedModel: "gpt-6-luna",
          requestedReasoningEffort: null,
          resolvedReasoningEffort: "max",
          sentReasoningEffort: "max",
          modelResolution: "explicit",
          effortResolution: "model_specific_auto_policy",
          capabilitySource: "live_codex_model_list",
          observedAt: "2026-10-15T00:00:00.000Z",
          modelCatalogPosition: 1,
          modelCatalogCount: 1,
          modelCapabilities: {
            displayName: "GPT-6 Luna",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium", "high", "max"],
            inputModalities: ["text"],
          },
          selectionReason:
            "Kebijakan effort Auto untuk GPT-6 Luna memilih max; nilai ini divalidasi terhadap katalog Codex live.",
        },
      },
      "prompt lama",
    );

    expect(parsed?.targetSelection).toMatchObject({
      selection: { model: "selected", reasoningEffort: "auto" },
      resolvedReasoningEffort: "max",
      sentReasoningEffort: "max",
      selectionReason: expect.stringContaining("memilih max"),
    });
  });

  it("keeps per-case verification and live target capability evidence", () => {
    const parsed = parseOptimizationResult(
      {
        baseline: {
          prompt: "prompt lama",
          caseResults: [
            {
              id: "case-1",
              input: "Hitung",
              answer: '{"count":41,"sum":2133}',
              verification: {
                kind: "divisibility",
                startInclusive: 1,
                endInclusive: 100,
              },
              verificationEvidence: {
                kind: "divisibility",
                status: "passed",
                expected: { count: "41", sum: "2133" },
                reference: { count: "41", sum: "2133" },
                actual: { count: "41", sum: "2133" },
                reasonCode: null,
              },
            },
          ],
          metrics: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        },
        candidate: { prompt: "prompt baru", caseResults: [] },
        targetSelection: {
          selection: { model: "auto", reasoningEffort: "selected" },
          requestedModel: "gpt-6-luna",
          resolvedModel: "gpt-6-sol",
          requestedReasoningEffort: "high",
          resolvedReasoningEffort: "high",
          sentReasoningEffort: "high",
          modelResolution: "first_current_compatible_text_model",
          effortResolution: "explicit",
          capabilitySource: "live_codex_model_list",
          observedAt: "2026-10-15T00:00:00.000Z",
          modelCatalogPosition: 1,
          modelCatalogCount: 3,
          modelCapabilities: {
            displayName: "GPT 6 Sol",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
            inputModalities: ["text"],
          },
        },
      },
      "prompt lama",
    );

    expect(parsed?.baseline.answers[0]?.verification?.kind).toBe(
      "divisibility",
    );
    expect(parsed?.baseline.answers[0]?.verificationEvidence?.status).toBe(
      "passed",
    );
    expect(parsed?.targetSelection).toMatchObject({
      selection: { model: "auto", reasoningEffort: "selected" },
      requestedModel: "gpt-6-luna",
      resolvedModel: "gpt-6-sol",
      modelCapabilities: {
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    });
  });

  it("keeps target measurements, estimates, unknowns, and optimizer overhead separate", () => {
    const parsed = parseOptimizationResult(
      {
        status: "candidate_ready",
        baseline: {
          prompt: "Jawab berdasarkan sumber.",
          answers: [
            {
              caseId: "case-1",
              input: "Jelaskan kebijakan.",
              text: "Kebijakan berlaku mulai bulan ini.",
              usage: {
                inputTokens: { status: "reported", value: 30 },
                outputTokens: { status: "reported", value: 10 },
              },
              latencyMs: 1_200,
            },
          ],
          aggregateUsage: {
            inputTokens: { status: "reported", value: 30 },
            outputTokens: { status: "reported", value: 10 },
            totalTokens: { status: "reported", value: 40 },
          },
          totalTargetLatencyMs: 1_200,
        },
        candidate: {
          id: "candidate-1",
          prompt: "Jawab singkat berdasarkan sumber.",
          draftVersionId: "draft-1",
          testingStatus: "ready",
          evidenceBoundToPrompt: true,
          evidenceEligible: true,
          answers: [],
          aggregateUsage: {
            inputTokens: { status: "estimated", value: 32 },
            outputTokens: { status: "unknown", value: null },
            totalTokens: { status: "unknown", value: null },
          },
          totalTargetLatencyMs: null,
          invariantsPreserved: true,
        },
        optimizer: {
          model: "senopati-test-model",
          calls: 2,
          usage: {
            input: { status: "estimated", value: 2_000 },
            output: { status: "reported", value: 500 },
            total: { status: "estimated", value: 2_500 },
          },
          elapsedMs: 8_400,
        },
        optimizationOverheadMs: 9_600,
      },
      "Prompt fallback",
    );

    expect(parsed?.status).toBe("candidate_ready");
    expect(parsed?.selectedCandidate?.id).toBe("candidate-1");
    expect(parsed?.baseline.usage.total).toEqual({
      status: "reported",
      value: 40,
    });
    expect(parsed?.baseline.latencyMs).toBe(1_200);
    expect(parsed?.candidates[0]?.usage.input).toEqual({
      status: "estimated",
      value: 32,
    });
    expect(parsed?.candidates[0]?.usage.output).toEqual({
      status: "unknown",
      value: null,
    });
    expect(parsed?.candidates[0]?.latencyMs).toBeNull();
    expect(parsed?.optimizer.usage.total).toEqual({
      status: "estimated",
      value: 2_500,
    });
    expect(parsed?.optimizer.elapsedMs).toBe(8_400);
    expect(parsed?.optimizationOverheadMs).toBe(9_600);
    expect(parsed?.qualityVote).toBeNull();
    expect(
      canApplyOptimizationCandidate({
        runId: "run-1",
        resultStatus: parsed?.status ?? null,
        candidate: parsed!.candidates[0]!,
      }),
    ).toBe(true);
  });

  it("requires a ready result, exact-text evidence, and a saved draft to apply", () => {
    const parsed = parseOptimizationResult(
      {
        status: "incomplete",
        baseline: { prompt: "old", answers: [] },
        candidate: {
          id: "candidate-1",
          prompt: "new prompt",
          draftVersionId: "draft-1",
          testingStatus: "incomplete",
          evidenceBoundToPrompt: false,
          answers: [],
        },
      },
      "old",
    );
    expect(parsed).not.toBeNull();
    expect(
      canApplyOptimizationCandidate({
        runId: "run-1",
        resultStatus: parsed?.status ?? null,
        candidate: parsed!.candidates[0]!,
      }),
    ).toBe(false);
  });

  it("blocks the known legacy untested draft while retaining it for display", () => {
    const parsed = parseOptimizationResult(
      {
        status: "candidate_ready",
        baseline: { prompt: "old", answers: [] },
        candidate: {
          id: LEGACY_UNTESTED_CANDIDATE.candidateId,
          prompt: "historical prompt",
          draftVersionId: LEGACY_UNTESTED_CANDIDATE.draftVersionId,
          testingStatus: "ready",
          evidenceBoundToPrompt: true,
          evidenceEligible: false,
          invariantsPreserved: true,
          answers: [],
        },
      },
      "old",
    );
    expect(parsed?.candidates[0]?.prompt).toBe("historical prompt");
    expect(parsed?.selectedCandidate).toBeNull();
    expect(parsed?.reviewableCandidateId).toBeNull();
    expect(
      canApplyOptimizationCandidate({
        runId: LEGACY_UNTESTED_CANDIDATE.runId,
        resultStatus: parsed?.status ?? null,
        candidate: parsed!.candidates[0]!,
      }),
    ).toBe(false);
  });

  it("selects the declared ready revision after an earlier incomplete revision", () => {
    const first = {
      id: "candidate-a",
      prompt: "draft A",
      outcome: "incomplete",
      testingStatus: "incomplete",
      evidenceBoundToPrompt: false,
      answers: [],
    };
    const latest = {
      id: "candidate-b",
      prompt: "draft B",
      outcome: "candidate_ready",
      testingStatus: "ready",
      draftVersionId: "draft-b",
      evidenceBoundToPrompt: true,
      evidenceEligible: true,
      invariantsPreserved: true,
      answers: [],
    };
    const parsed = parseOptimizationResult(
      {
        status: "candidate_ready",
        baseline: { prompt: "old", answers: [] },
        candidates: [first, latest],
        latestCandidateId: "candidate-b",
        reviewableCandidateId: "candidate-b",
        candidate: latest,
      },
      "old",
    );

    expect(parsed?.candidates.map(({ id }) => id)).toEqual([
      "candidate-a",
      "candidate-b",
    ]);
    expect(parsed?.candidates.map(({ outcome }) => outcome)).toEqual([
      "incomplete",
      "candidate_ready",
    ]);
    expect(parsed?.latestCandidateId).toBe("candidate-b");
    expect(parsed?.reviewableCandidateId).toBe("candidate-b");
    expect(parsed?.selectedCandidate?.prompt).toBe("draft B");
    expect(parsed?.selectionConsistent).toBe(true);
    expect(
      canApplyOptimizationCandidate({
        runId: "run-1",
        resultStatus: parsed?.status ?? null,
        candidate: parsed!.selectedCandidate!,
      }),
    ).toBe(true);
  });

  it("keeps an earlier ready selection when the latest revision fails", () => {
    const ready = {
      id: "candidate-a",
      prompt: "ready draft",
      outcome: "candidate_ready",
      testingStatus: "ready",
      draftVersionId: "draft-a",
      evidenceBoundToPrompt: true,
      evidenceEligible: true,
      invariantsPreserved: true,
      answers: [],
    };
    const failed = {
      id: "candidate-b",
      prompt: "failed refinement",
      outcome: "candidate_rejected",
      testingStatus: "rejected",
      evidenceBoundToPrompt: false,
      riskSummary: "A required invariant changed.",
      answers: [],
    };
    const parsed = parseOptimizationResult(
      {
        status: "candidate_ready",
        baseline: { prompt: "old", answers: [] },
        candidates: [ready, failed],
        latestCandidateId: "candidate-b",
        reviewableCandidateId: "candidate-a",
        candidate: ready,
      },
      "old",
    );

    expect(parsed?.latestCandidateId).toBe("candidate-b");
    expect(parsed?.reviewableCandidateId).toBe("candidate-a");
    expect(parsed?.selectedCandidate?.prompt).toBe("ready draft");
    expect(parsed?.candidates.at(-1)).toMatchObject({
      id: "candidate-b",
      outcome: "candidate_rejected",
      riskSummary: "A required invariant changed.",
    });
    expect(parsed?.selectionConsistent).toBe(true);
    expect(
      canApplyOptimizationCandidate({
        runId: "run-1",
        resultStatus: parsed?.status ?? null,
        candidate: parsed!.selectedCandidate!,
      }),
    ).toBe(true);
  });

  it("keeps no-change and incomplete outcomes distinct without selecting either", () => {
    const cases = [
      {
        status: "no_change_recommended",
        outcome: "no_change_recommended",
        testingStatus: null,
      },
      {
        status: "incomplete",
        outcome: "incomplete",
        testingStatus: "incomplete",
      },
    ] as const;

    for (const item of cases) {
      const revision = {
        id: `candidate-${item.status}`,
        prompt: "unreviewed draft",
        outcome: item.outcome,
        testingStatus: item.testingStatus,
        evidenceBoundToPrompt: false,
        answers: [],
      };
      const parsed = parseOptimizationResult(
        {
          status: item.status,
          baseline: { prompt: "old", answers: [] },
          candidates: [revision],
          latestCandidateId: revision.id,
          reviewableCandidateId: null,
          candidate: revision,
        },
        "old",
      );

      expect(parsed?.status).toBe(item.status);
      expect(parsed?.candidates[0]?.outcome).toBe(item.outcome);
      expect(parsed?.selectedCandidate).toBeNull();
      expect(parsed?.selectionConsistent).toBe(true);
      expect(
        canApplyOptimizationCandidate({
          runId: "run-1",
          resultStatus: parsed?.status ?? null,
          candidate: parsed!.candidates[0]!,
        }),
      ).toBe(false);
    }
  });

  it("fails closed when the declared reviewable revision is not the latest ready one", () => {
    const incomplete = {
      id: "candidate-a",
      prompt: "incomplete draft",
      outcome: "incomplete",
      testingStatus: "incomplete",
      evidenceBoundToPrompt: false,
      answers: [],
    };
    const ready = {
      id: "candidate-b",
      prompt: "ready draft",
      outcome: "candidate_ready",
      testingStatus: "ready",
      draftVersionId: "draft-b",
      evidenceBoundToPrompt: true,
      answers: [],
    };
    const parsed = parseOptimizationResult(
      {
        status: "candidate_ready",
        baseline: { prompt: "old", answers: [] },
        candidates: [incomplete, ready],
        latestCandidateId: "candidate-b",
        reviewableCandidateId: "candidate-a",
        candidate: incomplete,
      },
      "old",
    );

    expect(parsed?.candidates.map(({ id }) => id)).toEqual([
      "candidate-a",
      "candidate-b",
    ]);
    expect(parsed?.selectionConsistent).toBe(false);
    expect(parsed?.selectedCandidate).toBeNull();
  });

  it("does not invent a result when the baseline envelope is missing", () => {
    expect(
      parseOptimizationResult({ candidate: { prompt: "draft" } }, "old"),
    ).toBeNull();
  });
});
