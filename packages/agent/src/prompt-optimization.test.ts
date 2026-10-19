import { describe, expect, it, vi } from "vitest";
import type { PromptOptimizationRequest } from "@promptlab/contracts";

import { optimizePrompt } from "./prompt-optimization.js";

const invariant = "Answer each question in one sentence.";
const originalPrompt = `${invariant} Answer clearly.`;
const candidatePrompt = `${invariant} State the result directly.`;
const request: PromptOptimizationRequest = {
  objective: "Improve correct answers while preserving the required format.",
  maxIterations: 2,
  maxToolCalls: 8,
  testCases: [
    {
      id: "case-1",
      input: "What is the answer?",
      expectedTerms: ["42"],
      forbiddenTerms: [],
    },
  ],
};

type Scenario = {
  candidateText?: string;
  baselineAnswer: string;
  candidateAnswer: string;
  invariants?: string[];
  testCases?: PromptOptimizationRequest["testCases"];
};

function readPlannerValue<T>(prompt: string, label: string): T {
  const line = prompt.split("\n").find((item) => item.startsWith(label));
  if (!line) throw new Error(`Missing planner field: ${label}`);
  return JSON.parse(line.slice(label.length)) as T;
}

function answerEnvelope(answer: string): string {
  return JSON.stringify({ answers: [{ id: "case-1", answer }] });
}

function createModel(scenario: Scenario) {
  let plannerTurn = 0;
  let evaluationCall = 0;
  const invokeModel = vi.fn(async (prompt: string) => {
    if (prompt.includes("<PROMPT_UNDER_TEST>")) {
      evaluationCall += 1;
      return evaluationCall === 1
        ? answerEnvelope(scenario.baselineAnswer)
        : scenario.candidateAnswer;
    }

    plannerTurn += 1;
    if (plannerTurn === 1) {
      readPlannerValue<string>(prompt, "Next candidate ID: ");
      const candidateText = scenario.candidateText ?? candidatePrompt;
      return JSON.stringify({
        summary: "Saya mengusulkan kandidat yang mempertahankan aturan format.",
        toolCalls: [
          {
            name: "validate_candidate",
            arguments: {
              candidateText,
              invariants: scenario.invariants ?? [invariant],
            },
          },
        ],
        candidate: {
          text: candidateText,
          changeSummary: "Memperjelas instruksi jawaban.",
          riskSummary: "Periksa akurasi pada contoh uji.",
          strategy: "Structure",
        },
        finish: false,
      });
    }

    if (plannerTurn === 2) {
      const candidates = readPlannerValue<Array<{ id: string }>>(
        prompt,
        "Existing candidates and evaluations: ",
      );
      const developmentCaseIds = readPlannerValue<string[]>(
        prompt,
        "Internal case IDs for complete evaluation: ",
      );
      return JSON.stringify({
        summary:
          "Saya menjalankan contoh uji pada kandidat yang sudah divalidasi.",
        toolCalls: [
          {
            name: "evaluate_subset",
            arguments: {
              candidateId: candidates[0]!.id,
              developmentCaseIds,
            },
          },
        ],
        finish: false,
      });
    }

    return JSON.stringify({
      summary:
        "Saya membandingkan bukti dan mempertahankan keputusan yang didukung.",
      finish: true,
    });
  });
  return invokeModel;
}

async function runOptimization(scenario: Scenario) {
  const events: Array<{ type: string; summary?: string; toolName?: string }> =
    [];
  const evaluations: string[] = [];
  const result = await optimizePrompt({
    projectId: "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
    originalPrompt,
    invariants: scenario.invariants ?? [invariant],
    request: scenario.testCases
      ? { ...request, testCases: scenario.testCases }
      : request,
    signal: new AbortController().signal,
    invokeModel: createModel(scenario),
    onAgentEvent: (event) => {
      events.push(event);
    },
    onEvaluation: (subject) => {
      evaluations.push(subject);
    },
  });
  return { result, events, evaluations };
}

describe("bounded prompt optimization", () => {
  it("keeps a complete candidate as a review-only proposal without selecting it", async () => {
    const { result, events, evaluations } = await runOptimization({
      baselineAnswer: "I do not know.",
      candidateAnswer: answerEnvelope("42"),
    });

    expect(result).toMatchObject({
      status: "candidate_ready",
      selectedPrompt: originalPrompt,
      baseline: { evaluation: { complete: true } },
      toolCallCount: 2,
      decisionTurnCount: 3,
    });
    expect(result.selectedCandidateId).toBeNull();
    expect(result.candidates[0]).toMatchObject({
      text: candidatePrompt,
      invariantStatus: "preserved",
      evaluation: { complete: true, passedChecks: 1, totalChecks: 1 },
    });
    expect(result.candidates[0]).not.toHaveProperty("score");
    expect(result.baseline).not.toHaveProperty("score");
    expect(evaluations).toEqual(["baseline", "candidate"]);
    expect(events.map((event) => event.toolName).filter(Boolean)).toEqual([
      "validate_candidate",
      "validate_candidate",
      "evaluate_subset",
      "evaluate_subset",
    ]);
    expect(events.map((event) => event.type)).toContain("candidate.proposed");
  });

  it("keeps the baseline when candidate invariants fail and emits no candidate evaluation", async () => {
    const { result, evaluations } = await runOptimization({
      candidateText: "Answer briefly, without the required sentence format.",
      baselineAnswer: "42",
      candidateAnswer: answerEnvelope("0"),
    });

    expect(result).toMatchObject({
      status: "incomplete",
      selectedCandidateId: null,
      selectedPrompt: originalPrompt,
      candidates: [
        {
          invariantStatus: "violated",
          evaluation: null,
        },
      ],
    });
    expect(evaluations).toEqual(["baseline"]);
  });

  it("reports completed phrase checks without ranking candidate quality", async () => {
    const { result } = await runOptimization({
      baselineAnswer: "42",
      candidateAnswer: answerEnvelope("I cannot answer."),
    });

    expect(result.status).toBe("candidate_ready");
    expect(result.selectedCandidateId).toBeNull();
    expect(result.selectedPrompt).toBe(originalPrompt);
    expect(result.baseline.evaluation.passedChecks).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      invariantStatus: "preserved",
      evaluation: { complete: true },
      caseResults: [{ status: "fail" }],
    });
    expect(result.candidates[0]).not.toHaveProperty("score");
    expect(result.selectionReason).toContain("pengguna menilai kandidat");
  });

  it("keeps the baseline when candidate evaluation evidence is incomplete", async () => {
    const { result } = await runOptimization({
      baselineAnswer: "42",
      candidateAnswer: "not valid JSON",
    });

    expect(result).toMatchObject({
      status: "incomplete",
      selectedCandidateId: null,
      selectedPrompt: originalPrompt,
      candidates: [
        {
          invariantStatus: "preserved",
          evaluation: { complete: false },
        },
      ],
    });
  });

  it("keeps forbidden phrase failures as per-case evidence without ranking", async () => {
    const { result } = await runOptimization({
      baselineAnswer: "I do not know.",
      candidateAnswer: answerEnvelope(
        "42 is correct, with a forbidden phrase.",
      ),
      testCases: [
        {
          id: "case-1",
          input: "What is the answer?",
          expectedTerms: ["42", "correct"],
          forbiddenTerms: ["forbidden phrase"],
        },
      ],
    });

    expect(result.baseline.evaluation).toMatchObject({
      passedChecks: 1,
      totalChecks: 3,
    });
    expect(result.candidates[0]?.evaluation).toMatchObject({
      passedChecks: 2,
      totalChecks: 3,
    });
    expect(result.candidates[0]?.caseResults[0]?.status).toBe("fail");
    expect(result.status).toBe("candidate_ready");
    expect(result.selectedCandidateId).toBeNull();
    expect(result.selectedPrompt).toBe(originalPrompt);
    expect(result.selectionReason).toContain("pengguna menilai kandidat");
  });

  it("keeps missing required phrase failures as explicit evidence without ranking", async () => {
    const { result } = await runOptimization({
      baselineAnswer: "I do not know.",
      candidateAnswer: answerEnvelope("42"),
      testCases: [
        {
          id: "case-1",
          input: "What is the answer?",
          expectedTerms: ["42", "include this required phrase"],
          forbiddenTerms: [],
        },
      ],
    });

    expect(result.baseline.evaluation).toMatchObject({
      passedChecks: 0,
      totalChecks: 2,
    });
    expect(result.candidates[0]?.evaluation).toMatchObject({
      passedChecks: 1,
      totalChecks: 2,
    });
    expect(result.candidates[0]?.caseResults[0]?.status).toBe("fail");
    expect(result.status).toBe("candidate_ready");
    expect(result.selectedCandidateId).toBeNull();
    expect(result.selectedPrompt).toBe(originalPrompt);
    expect(result.selectionReason).toContain("pengguna menilai kandidat");
  });

  it("returns a no-invariant candidate for user review without selecting it", async () => {
    const { result } = await runOptimization({
      baselineAnswer: "I do not know.",
      candidateAnswer: answerEnvelope("42"),
      invariants: [],
    });

    expect(result.status).toBe("candidate_ready");
    expect(result.selectedCandidateId).toBeNull();
    expect(result.selectedPrompt).toBe(originalPrompt);
    expect(result.candidates[0]).toMatchObject({
      invariantStatus: "not_configured",
      evaluation: { complete: true, passedChecks: 1, totalChecks: 1 },
    });
    expect(result.selectionReason).toContain("pengguna menilai kandidat");
  });
});
