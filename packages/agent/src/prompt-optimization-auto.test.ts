import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  PromptOptimizationRequestSchema,
  type PromptOptimizationRequest,
} from "@promptlab/contracts";

import {
  OptimizationFrozenExecutionSnapshotSchema,
  optimizePromptAutomatically,
} from "./prompt-optimization-auto.js";
import type {
  OptimizationCaseRun,
  OptimizationFrozenExecutionSnapshot,
  OptimizationInvocation,
  OptimizationTargetSelectionEvidence,
  PromptOptimizationAutoOptions,
} from "./prompt-optimization-auto.js";

const projectId = "1aab9ee1-9421-4643-aac0-a8e96d56c1f2";
const invariant = "Answer in one sentence.";
const originalPrompt = `${invariant} Be clear.`;
const candidatePrompt = `${invariant} Be direct and use concrete details.`;

function readValue<T>(prompt: string, label: string): T {
  const line = prompt.split("\n").find((item) => item.startsWith(label));
  if (!line) throw new Error(`Missing prompt field: ${label}`);
  return JSON.parse(line.slice(label.length)) as T;
}

function reported(value: number) {
  return {
    status: "reported" as const,
    value,
    observedAt: "2026-10-13T00:00:00.000Z",
    method: "provider_test_receipt",
  };
}

function estimated(value: number) {
  return {
    status: "estimated" as const,
    value,
    observedAt: "2026-10-13T00:00:00.000Z",
    method: "local_character_estimate",
  };
}

function optimizerInvocation(
  text: string,
  callNumber: number,
): OptimizationInvocation {
  const inputTokens = estimated(100 + callNumber);
  const outputTokens = reported(20 + callNumber);
  return {
    text,
    responseModel: "qwen3:14b",
    responseId: `senopati-response-${callNumber}`,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: estimated(inputTokens.value + outputTokens.value),
    },
    elapsedMs: 30,
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function createDecisionModel(
  candidateText = candidatePrompt,
  generateCases = false,
  preflightText?: string,
  includeExtraFields = false,
) {
  let turn = 0;
  return vi.fn(async (prompt: string) => {
    turn += 1;
    await delay(30);
    if (turn === 1) {
      return optimizerInvocation(
        preflightText ??
          JSON.stringify({
            summary: "Konteks sudah cukup untuk melanjutkan.",
            clarificationRequired: false,
            clarification: null,
            testCases: generateCases
              ? [{ input: "Explain the key point." }]
              : [],
          }),
        turn,
      );
    }
    const decisionTurn = turn - 1;
    if (decisionTurn === 1) {
      const candidateId = readValue<string>(prompt, "ID kandidat berikutnya: ");
      expect(candidateId).toBeTruthy();
      return optimizerInvocation(
        JSON.stringify({
          summary: "Saya memperjelas instruksi sambil menjaga aturan penting.",
          toolCalls: [
            {
              name: "validate_candidate",
              arguments: { candidateText, invariants: [invariant] },
            },
          ],
          candidate: {
            text: candidateText,
            changeSummary: "Instruksi dibuat lebih langsung.",
            riskSummary: "Periksa kelengkapan jawaban pada contoh yang sama.",
            strategy: "Clarify instructions",
            ...(includeExtraFields
              ? { providerNote: "candidate metadata" }
              : {}),
          },
          finish: false,
          ...(includeExtraFields
            ? { providerMetadata: { traceId: "trace-2" } }
            : {}),
        }),
        turn,
      );
    }
    if (decisionTurn === 2) {
      const candidates = readValue<Array<{ id: string }>>(
        prompt,
        "Kandidat dan hasil sebelumnya: ",
      );
      const developmentCaseIds = readValue<string[]>(
        prompt,
        "ID pengujian internal: ",
      );
      return optimizerInvocation(
        JSON.stringify({
          summary: "Saya menguji prompt baru pada input yang sama.",
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
        }),
        turn,
      );
    }
    return optimizerInvocation(
      JSON.stringify({
        summary: "Perbandingan siap ditinjau pengguna.",
        finish: true,
      }),
      turn,
    );
  });
}

function createOptions(input: {
  inputs?: Array<{
    id: string;
    input: string;
    verification?: PromptOptimizationRequest["testCases"][number]["verification"];
  }>;
  candidateText?: string;
  invariants?: string[];
  maxIterations?: number;
  useIterationDefault?: boolean;
  targetSelection?: OptimizationTargetSelectionEvidence;
  targetResponseModel?: string;
  preflightText?: string;
  includeExtraFields?: boolean;
  history?: Array<{ id: string; summary: string }>;
  clarificationContext?: Array<{ question: string; answer: string }>;
}) {
  const optimizer = createDecisionModel(
    input.candidateText,
    input.inputs === undefined,
    input.preflightText,
    input.includeExtraFields,
  );
  const targetCalls: Array<{
    text: string;
    subject: string | undefined;
    caseId: string | undefined;
    answer: string;
  }> = [];
  const phaseEvents: string[] = [];
  const evaluations: Array<{
    subject: "baseline" | "candidate";
    caseResults: Parameters<
      NonNullable<PromptOptimizationAutoOptions["onEvaluation"]>
    >[2];
  }> = [];
  const optimizationRequest = PromptOptimizationRequestSchema.parse({
    objective: "Buat prompt lebih jelas untuk dipakai sehari-hari.",
    ...(input.useIterationDefault
      ? {}
      : { maxIterations: input.maxIterations ?? 1 }),
    maxToolCalls: 6,
    testCases: input.inputs ?? [],
  });
  const options = {
    projectId,
    originalPrompt,
    invariants: input.invariants ?? [invariant],
    request: optimizationRequest,
    optimizerModel: "qwen3:14b",
    evaluationContext: {
      runId: "run-test-1",
      attemptId: "attempt-test-1",
      targetProvider: "codex_app_server" as const,
      targetRequestedModel: "gpt-5.6-codex",
      targetRequestedEffort: null,
      targetProviderVersion: "codex-test",
      optimizerConfig: { provider: "campus_gateway" },
      runConfig: {
        optimization: optimizationRequest,
        retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
      },
      targetConfig: {
        resolvedModel:
          input.targetSelection?.resolvedModel ??
          input.targetResponseModel ??
          "gpt-5.6-codex",
      },
      retrievalConfig: {
        strategy: "lexical",
        sourceIds: [],
        snapshotId: null,
      },
      workspaceSnapshot: {
        mode: "none",
        snapshotId: null,
        contentHash: null,
      },
      policyVersion: "promptlab.r3.evidence.v1",
      contextBudgetTokens: 0,
    },
    ...(input.targetSelection
      ? { targetSelection: input.targetSelection }
      : {}),
    sourceIds: [],
    history: input.history ?? [],
    clarificationContext: input.clarificationContext ?? [],
    signal: new AbortController().signal,
    invokeOptimizer: optimizer,
    invokeTarget: vi.fn(
      async (
        text: string,
        _signal: AbortSignal,
        metadata?: { subject: "baseline" | "candidate"; caseId: string },
      ) => {
        const elapsedMs = metadata?.subject === "baseline" ? 45 : 35;
        await delay(elapsedMs);
        const answer =
          metadata?.subject === "baseline" ? "Old answer." : "New answer.";
        targetCalls.push({
          text,
          subject: metadata?.subject,
          caseId: metadata?.caseId,
          answer,
        });
        const inputTokens =
          metadata?.subject === "candidate"
            ? estimated(100 + targetCalls.length)
            : reported(100 + targetCalls.length);
        const outputTokens = reported(20 + targetCalls.length);
        return {
          text: answer,
          responseModel:
            input.targetSelection?.resolvedModel ??
            input.targetResponseModel ??
            "gpt-5.6-codex",
          responseId: `response-${targetCalls.length}`,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens:
              metadata?.subject === "candidate"
                ? estimated(inputTokens.value + outputTokens.value)
                : reported(inputTokens.value + outputTokens.value),
          },
          elapsedMs,
        };
      },
    ),
    persistDraft: vi.fn(async () => "84a0bef8-259e-47cd-8a95-7ce8d8fadba1"),
    onPhase: (phase: string) => {
      phaseEvents.push(phase);
    },
    onEvaluation: (
      subject: "baseline" | "candidate",
      _subjectId: string,
      caseResults: readonly OptimizationCaseRun[],
    ) => {
      evaluations.push({ subject, caseResults });
    },
  } satisfies PromptOptimizationAutoOptions;
  return { options, optimizer, targetCalls, phaseEvents, evaluations };
}

describe("automatic prompt optimization", () => {
  it("restores a frozen hybrid retrieval strategy", () => {
    const snapshot = OptimizationFrozenExecutionSnapshotSchema.parse({
      preflightComplete: true,
      preflightSummary: "Evidence and target configuration are frozen.",
      targetSelection: null,
      testCases: [],
      sourceIds: [projectId],
      retrievalStrategy: "hybrid",
      graphSnapshotId: null,
      history: [],
    });

    expect(snapshot.retrievalStrategy).toBe("hybrid");
  });

  it("includes the model-specific effort rules only for Auto recommendations", async () => {
    const { options: baseOptions, optimizer } = createOptions({
      inputs: [{ id: "auto-effort-case", input: "Explain this code change." }],
    });
    const options: PromptOptimizationAutoOptions = {
      ...baseOptions,
      request: PromptOptimizationRequestSchema.parse({
        ...baseOptions.request,
        targetSelection: { model: "selected", reasoningEffort: "auto" },
      }),
      targetRequestedModel: "gpt-6.1-sol",
      targetCapabilities: [
        {
          id: "gpt-6-luna",
          displayName: "GPT-6 Luna",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high", "max"],
          inputModalities: ["text"],
        },
        {
          id: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high"],
          inputModalities: ["text"],
        },
        {
          id: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["high", "xhigh"],
          inputModalities: ["text"],
        },
      ],
    };

    await optimizePromptAutomatically(options);

    const preflight = optimizer.mock.calls[0]?.[0] ?? "";
    expect(preflight).toContain("berakhiran -luna");
    expect(preflight).toContain("medium untuk pekerjaan teknis yang terbatas");
    expect(preflight).toContain(
      "high untuk perencanaan atau debugging lintas-modul",
    );
    expect(preflight).toContain("xhigh hanya untuk analisis paling berat");
    expect(preflight).toContain('"reasoningEffort":"auto"');
  });

  it("awaits task-aware target resolution before paired tests and persists frozen context", async () => {
    const { options, targetCalls } = createOptions({
      inputs: [{ id: "frozen-case", input: "Explain the result." }],
      history: [{ id: "history-1", summary: "Earlier answer context." }],
      targetResponseModel: "recommended-model",
    });
    const targetSelection: OptimizationTargetSelectionEvidence = {
      selection: { model: "auto", reasoningEffort: "auto" },
      requestedModel: "requested-model",
      resolvedModel: "recommended-model",
      requestedReasoningEffort: null,
      resolvedReasoningEffort: "high",
      sentReasoningEffort: "high",
      modelResolution: "task_aware_recommendation",
      effortResolution: "task_aware_recommendation",
      capabilitySource: "live_codex_model_list",
      observedAt: "2026-10-15T00:00:00.000Z",
      modelCatalogPosition: 2,
      modelCatalogCount: 3,
      modelCapabilities: {
        displayName: "Recommended model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"],
        inputModalities: ["text"],
      },
    };
    const snapshots: OptimizationFrozenExecutionSnapshot[] = [];
    const resolveTargetSelection = vi.fn(async () => {
      expect(targetCalls).toHaveLength(0);
      return targetSelection;
    });
    const persistExecutionSnapshot = vi.fn(
      (snapshot: OptimizationFrozenExecutionSnapshot) => {
        snapshots.push(snapshot);
      },
    );
    const frozenOptions: PromptOptimizationAutoOptions = {
      ...options,
      retrievalStrategy: "graph",
      resolveTargetSelection,
      persistExecutionSnapshot,
    };

    const result = await optimizePromptAutomatically(frozenOptions);

    expect(result.status).toBe("candidate_ready");
    expect(resolveTargetSelection).toHaveBeenCalledTimes(1);
    expect(snapshots[0]).toMatchObject({
      preflightComplete: true,
      targetSelection,
      testCases: [
        { id: "frozen-case", input: "Explain the result.", source: "user" },
      ],
      retrievalStrategy: "graph",
      history: [{ id: "history-1", summary: "Earlier answer context." }],
    });
    expect(targetCalls.map((call) => call.subject)).toEqual([
      "baseline",
      "candidate",
    ]);
  });

  it("asks an essential question before any target test call", async () => {
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [{ id: "user-case-1", input: "Write onboarding guidance." }],
    });
    optimizer.mockImplementationOnce(async () =>
      optimizerInvocation(
        JSON.stringify({
          summary: "Saya perlu memastikan audiensnya.",
          clarificationRequired: true,
          clarification: {
            question: "Untuk siapa panduan ini terutama ditujukan?",
            reasonCode: "audience",
            choices: ["Pengguna baru", "Admin"],
            publicContext:
              "Audiens mengubah langkah dan istilah yang diperlukan.",
          },
          testCases: [],
        }),
        1,
      ),
    );

    const result = await optimizePromptAutomatically(options);

    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(targetCalls).toEqual([]);
    expect(options.persistDraft).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "clarification_required",
      clarificationRequired: true,
      clarification: {
        question: "Untuk siapa panduan ini terutama ditujukan?",
        reasonCode: "audience",
        choices: ["Pengguna baru", "Admin"],
      },
      baseline: {
        caseResults: [],
        metrics: { totalTokens: { status: "unknown" }, latencyMs: null },
      },
      candidate: null,
    });
  });

  it("uses Senopati for edits and the selected target for paired answers and measurements", async () => {
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
    });

    const result = await optimizePromptAutomatically(options);

    expect(optimizer).toHaveBeenCalledTimes(4);
    expect(targetCalls).toHaveLength(2);
    expect(targetCalls[0]?.subject).toBe("baseline");
    expect(targetCalls[1]?.subject).toBe("candidate");
    expect(targetCalls[0]?.caseId).toBe("user-case-1");
    expect(targetCalls[1]?.caseId).toBe("user-case-1");
    expect(result).toMatchObject({
      status: "candidate_ready",
      baseline: {
        caseResults: [{ source: "user", answer: "Old answer." }],
        answers: [
          {
            caseId: "user-case-1",
            source: "user",
            text: "Old answer.",
          },
        ],
        metrics: {
          totalTokens: { status: "reported" },
          latencyMs: 45,
        },
        totalTargetLatencyMs: 45,
      },
      candidate: {
        prompt: candidatePrompt,
        invariantStatus: "preserved",
        invariantsPreserved: true,
        caseResults: [{ source: "user", answer: "New answer." }],
        answers: [
          {
            caseId: "user-case-1",
            source: "user",
            text: "New answer.",
          },
        ],
        metrics: {
          totalTokens: { status: "estimated" },
          latencyMs: 35,
        },
        totalTargetLatencyMs: 35,
        draftVersionId: "84a0bef8-259e-47cd-8a95-7ce8d8fadba1",
      },
      comparison: { latencyChangeMs: -10 },
      optimizer: {
        provider: "campus_gateway",
        model: "qwen3:14b",
        requestedModel: "qwen3:14b",
        elapsedMs: 120,
        overheadMs: expect.any(Number),
        providerElapsedMs: 120,
        usage: { totalTokens: { status: "estimated" } },
        totalTokens: { status: "estimated" },
      },
    });
    expect(result.optimizationOverheadMs).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("selectedCandidateId");
    expect(result).not.toHaveProperty("qualityScore");
    const decisionPrompt = optimizer.mock.calls[1]?.[0] ?? "";
    expect(decisionPrompt).toContain('"clarificationRequired":false');
    expect(decisionPrompt).toContain('"name":"validate_candidate"');
    expect(decisionPrompt).toContain('"candidateId":"ID kandidat');
    expect(decisionPrompt).toContain('"developmentCaseIds"');
  });

  it("preserves independent verification evidence for both frozen answer sets", async () => {
    const { options, evaluations } = createOptions({
      inputs: [
        {
          id: "math-case",
          input: "Return a JSON object with count and sum.",
          verification: {
            kind: "divisibility",
            startInclusive: 1,
            endInclusive: 1_000,
            includeDivisors: [3, 5],
            excludeDivisors: [7],
            expected: { count: "401", sum: "200995" },
          },
        },
      ],
      targetSelection: {
        selection: { model: "auto", reasoningEffort: "auto" },
        requestedModel: "gpt-5.6-codex",
        resolvedModel: "gpt-6-luna",
        requestedReasoningEffort: null,
        resolvedReasoningEffort: "medium",
        sentReasoningEffort: "medium",
        modelResolution: "first_current_compatible_text_model",
        effortResolution: "advertised_default",
        capabilitySource: "live_codex_model_list",
        observedAt: "2026-10-15T00:00:00.000Z",
        modelCatalogPosition: 1,
        modelCatalogCount: 2,
        modelCapabilities: {
          displayName: "GPT 6 Luna",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high"],
          inputModalities: ["text"],
        },
      },
    });
    options.invokeTarget.mockImplementation(
      async (_text, _signal, metadata) => ({
        text: '{"count":401,"sum":"200995"}',
        responseModel: "gpt-6-luna",
        responseId: `verified-${metadata?.subject}`,
        usage: {
          inputTokens: reported(10),
          outputTokens: reported(10),
          totalTokens: reported(20),
        },
        elapsedMs: 12,
      }),
    );

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("candidate_ready");
    expect(result.targetSelection).toMatchObject({
      resolvedModel: "gpt-6-luna",
      resolvedReasoningEffort: "medium",
      capabilitySource: "live_codex_model_list",
    });
    expect(result.baseline.caseResults[0]?.verificationEvidence).toMatchObject({
      kind: "divisibility",
      status: "passed",
      expected: { count: "401", sum: "200995" },
      reference: { count: "401", sum: "200995" },
    });
    expect(
      result.candidate?.caseResults[0]?.verificationEvidence,
    ).toMatchObject({
      kind: "divisibility",
      status: "passed",
      actual: { count: "401", sum: "200995" },
    });
    expect(result.baseline.answers[0]?.verificationEvidence?.status).toBe(
      "passed",
    );
    expect(result.candidate?.answers[0]?.verificationEvidence?.status).toBe(
      "passed",
    );
    expect(evaluations.map((item) => item.subject)).toEqual([
      "baseline",
      "candidate",
    ]);
    expect(
      evaluations.every(
        (item) =>
          item.caseResults[0]?.verificationEvidence?.status === "passed",
      ),
    ).toBe(true);
  });

  it("feeds failed and invalid fixture evidence into the next optimizer decision", async () => {
    const { options, optimizer } = createOptions({
      inputs: [
        {
          id: "invalid-math-case",
          input: "Return a JSON object with count and sum.",
          verification: {
            kind: "divisibility",
            startInclusive: 1,
            endInclusive: 100,
            includeDivisors: [3],
            excludeDivisors: [],
            expected: { count: "33", sum: "1682" },
          },
        },
      ],
    });

    const result = await optimizePromptAutomatically(options);

    const feedbackPrompt = optimizer.mock.calls
      .slice(2)
      .map(([prompt]) => prompt)
      .find((prompt) =>
        prompt.includes("expected_values_do_not_match_exact_reference"),
      );
    expect(feedbackPrompt).toContain('"status":"invalid_fixture"');
    expect(result.status).toBe("candidate_rejected");
    expect(result.candidate).toMatchObject({
      testingStatus: "rejected",
      evidenceBoundToPrompt: true,
      caseResults: [
        {
          verificationEvidence: {
            status: "invalid_fixture",
            expected: { count: "33", sum: "1682" },
            reference: { count: "33", sum: "1683" },
          },
        },
      ],
      draftVersionId: null,
    });
    expect(options.persistDraft).not.toHaveBeenCalled();
  });

  it("subtracts target time from overhead after validation invalidates a tested candidate", async () => {
    let nowMs = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    try {
      const { options, optimizer } = createOptions({
        inputs: [{ id: "case-1", input: "Explain the result." }],
      });
      let callNumber = 0;
      optimizer.mockReset().mockImplementation(async (prompt) => {
        callNumber += 1;
        nowMs += 30;
        if (callNumber === 1) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Konteks sudah cukup untuk melanjutkan.",
              clarificationRequired: false,
              clarification: null,
              testCases: [],
            }),
            callNumber,
          );
        }

        const decisionTurn = callNumber - 1;
        if (decisionTurn === 1) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Saya memvalidasi dan mengusulkan kandidat.",
              toolCalls: [
                {
                  name: "validate_candidate",
                  arguments: {
                    candidateText: candidatePrompt,
                    invariants: [invariant],
                  },
                },
              ],
              candidate: {
                text: candidatePrompt,
                changeSummary: "Instruksi dibuat lebih langsung.",
                riskSummary: "Periksa hasil pada contoh yang sama.",
                strategy: "Clarify instructions",
              },
              finish: false,
            }),
            callNumber,
          );
        }

        if (decisionTurn === 2) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Saya memeriksa ulang aturan kandidat yang sudah diuji.",
              toolCalls: [
                {
                  name: "validate_candidate",
                  arguments: {
                    candidateText: candidatePrompt,
                    invariants: [],
                  },
                },
              ],
              finish: false,
            }),
            callNumber,
          );
        }

        if (decisionTurn === 3) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Validasi ulang menolak aturan yang berbeda.",
              toolCalls: [
                {
                  name: "validate_candidate",
                  arguments: { candidateText: candidatePrompt, invariants: [] },
                },
              ],
              finish: false,
            }),
            callNumber,
          );
        }

        return optimizerInvocation(
          JSON.stringify({
            summary: "Pengujian kandidat selesai.",
            finish: true,
          }),
          callNumber,
        );
      });
      const targetDurations: number[] = [];
      options.invokeTarget.mockImplementation(
        async (_text, _signal, metadata) => {
          const elapsedMs = metadata?.subject === "baseline" ? 10.4 : 20.4;
          targetDurations.push(elapsedMs);
          nowMs += elapsedMs;
          return {
            text: "Controlled answer.",
            responseModel: "gpt-5.6-codex",
            responseId: `controlled-${metadata?.subject}`,
            usage: {
              inputTokens: reported(1),
              outputTokens: reported(1),
              totalTokens: reported(2),
            },
            elapsedMs,
          };
        },
      );

      const result = await optimizePromptAutomatically(options);

      expect(targetDurations).toEqual([10.4, 20.4]);
      expect(result.baseline.metrics.latencyMs).toBe(10);
      expect(options.invokeTarget).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("candidate_rejected");
      expect(result.candidate).toMatchObject({
        prompt: candidatePrompt,
        testingStatus: "rejected",
        evidenceBoundToPrompt: true,
        caseResults: [{ answer: "Controlled answer." }],
        draftVersionId: null,
      });
      expect(result.toolCallCount).toBe(3);
      expect(result.optimizer.providerElapsedMs).toBe(90);
      expect(result.optimizationOverheadMs).toBe(90);
    } finally {
      clock.mockRestore();
    }
  });

  it("feeds previous qualitative votes and accepted clarification answers into preflight", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
      history: [
        {
          id: "previous-run",
          summary:
            "Umpan balik eksplisit: candidate_better. Catatan pengguna: pertahankan istilah teknis.",
        },
      ],
      clarificationContext: [
        {
          question: "Untuk siapa panduan ini?",
          answer: "Untuk mahasiswa tingkat awal.",
        },
      ],
    });

    await optimizePromptAutomatically(options);

    expect(optimizer.mock.calls[0]?.[0]).toContain("candidate_better");
    expect(optimizer.mock.calls[0]?.[0]).toContain(
      "pertahankan istilah teknis",
    );
    expect(optimizer.mock.calls[0]?.[0]).toContain(
      "Untuk mahasiswa tingkat awal.",
    );
  });

  it("asks Senopati to create labeled examples when the user supplies none", async () => {
    const { options, optimizer, targetCalls, phaseEvents } = createOptions({
      preflightText: [
        "<think>Meninjau contoh format tanpa menampilkan analisis.</think>",
        "```json",
        JSON.stringify({
          summary: "Saya menyiapkan dua input untuk mencoba prompt.",
          clarificationRequired: false,
          clarification: null,
          testCases: [
            { input: "Summarize this paragraph." },
            { input: "Explain the key point." },
          ],
        }),
        "```",
      ].join("\n"),
    });

    const result = await optimizePromptAutomatically(options);

    expect(optimizer).toHaveBeenCalledTimes(4);
    expect(phaseEvents).toContain("cases_ready");
    expect(result.baseline.caseResults.map((item) => item.source)).toEqual([
      "generated",
      "generated",
    ]);
    expect(result.baseline.answers.map((item) => item.source)).toEqual([
      "generated",
      "generated",
    ]);
    expect(result.baseline.answers.map((item) => item.caseId)).toEqual(
      result.candidate?.answers.map((item) => item.caseId),
    );
    expect(result.candidate?.caseResults.map((item) => item.input)).toEqual([
      "Summarize this paragraph.",
      "Explain the key point.",
    ]);
    expect(targetCalls.map((item) => item.subject)).toEqual([
      "baseline",
      "baseline",
      "candidate",
      "candidate",
    ]);
  });

  it("ignores extra Senopati fields on generated cases and decisions", async () => {
    const { options, phaseEvents } = createOptions({
      includeExtraFields: true,
      preflightText: JSON.stringify({
        id: "senopati-response-1",
        model: "qwen3:14b",
        summary: "Saya membuat satu input untuk mencoba prompt.",
        clarificationRequired: false,
        clarification: null,
        testCases: [
          { input: "Summarize this paragraph.", category: "summary" },
        ],
        providerMetadata: { traceId: "trace-1" },
      }),
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("candidate_ready");
    expect(result.baseline.caseResults).toMatchObject([
      { input: "Summarize this paragraph.", source: "generated" },
    ]);
    expect(result.candidate?.prompt).toBe(candidatePrompt);
    expect(phaseEvents).toContain("cases_ready");
  });

  it("uses only the final public JSON after Qwen thinking tags and handles braces in strings", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
    });
    let turn = 0;
    optimizer.mockReset().mockImplementation(async (prompt) => {
      turn += 1;
      if (turn === 1) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Konteks sudah cukup untuk melanjutkan.",
            clarificationRequired: false,
            clarification: null,
            testCases: [],
          }),
          turn,
        );
      }
      const decisionTurn = turn - 1;
      if (decisionTurn === 1) {
        const candidateId = readValue<string>(
          prompt,
          "ID kandidat berikutnya: ",
        );
        const candidateWithJsonExample = `${candidatePrompt} Return JSON like {"key":"value"}.`;
        const finalDecision = {
          summary: "Saya memperjelas instruksi dan memeriksa aturan penting.",
          toolCalls: [
            {
              name: "validate_candidate",
              arguments: {
                candidateText: candidateWithJsonExample,
                invariants: [invariant],
              },
            },
          ],
          candidate: {
            text: candidateWithJsonExample,
            changeSummary: "Instruksi dibuat lebih langsung.",
            riskSummary: "Periksa kelengkapan jawaban pada contoh yang sama.",
            strategy: "Clarify instructions",
          },
          finish: false,
          clarificationRequired: false,
        };
        expect(candidateId).toBeTruthy();
        return optimizerInvocation(
          [
            '<think>Contoh bentuk yang sedang dipertimbangkan: {"summary":"decoy","finish":true}</think>',
            "Berikut hasilnya:",
            "```json",
            JSON.stringify(finalDecision),
            "```",
          ].join("\n"),
          turn,
        );
      }
      if (decisionTurn === 2) {
        const candidates = readValue<Array<{ id: string }>>(
          prompt,
          "Kandidat dan hasil sebelumnya: ",
        );
        const developmentCaseIds = readValue<string[]>(
          prompt,
          "ID pengujian internal: ",
        );
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya menguji prompt baru pada input yang sama.",
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
          }),
          turn,
        );
      }
      return optimizerInvocation(
        JSON.stringify({
          summary: "Perbandingan siap ditinjau pengguna.",
          finish: true,
        }),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("candidate_ready");
    expect(result.candidate?.prompt).toBe(
      `${candidatePrompt} Return JSON like {"key":"value"}.`,
    );
    expect(result.decisionSummary).toBe("Perbandingan siap ditinjau pengguna.");
  });

  it("still rejects tool names outside the allowlist", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
    });
    let turn = 0;
    optimizer.mockImplementation(async () => {
      turn += 1;
      return optimizerInvocation(
        JSON.stringify(
          turn === 1
            ? {
                summary: "Konteks sudah cukup untuk melanjutkan.",
                clarificationRequired: false,
                clarification: null,
                testCases: [],
              }
            : {
                summary: "Saya meminta tool yang tidak diizinkan.",
                toolCalls: [{ name: "shell", arguments: { command: "id" } }],
                finish: false,
              },
        ),
        turn,
      );
    });

    await expect(optimizePromptAutomatically(options)).rejects.toMatchObject({
      message: "AGENT_TOOL_NOT_ALLOWED",
    });
  });

  it("still validates tool arguments against the strict agent contract", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
    });
    let turn = 0;
    optimizer.mockImplementation(async () => {
      turn += 1;
      return optimizerInvocation(
        JSON.stringify(
          turn === 1
            ? {
                summary: "Konteks sudah cukup untuk melanjutkan.",
                clarificationRequired: false,
                clarification: null,
                testCases: [],
              }
            : {
                summary:
                  "Saya mengirim argumen tool yang tidak sesuai kontrak.",
                toolCalls: [
                  {
                    name: "validate_candidate",
                    arguments: {
                      candidateText: candidatePrompt,
                      invariants: [invariant],
                      unexpected: true,
                    },
                  },
                ],
                finish: false,
              },
        ),
        turn,
      );
    });

    await expect(optimizePromptAutomatically(options)).rejects.toMatchObject({
      name: "AgentInterfaceError",
      code: "INVALID_TOOL_CALL",
    });
  });

  it("still rejects invalid decision fields", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
    });
    optimizer.mockImplementationOnce(async () =>
      optimizerInvocation(JSON.stringify({ summary: "", finish: true }), 1),
    );

    await expect(optimizePromptAutomatically(options)).rejects.toMatchObject({
      message: "MODEL_OUTPUT_INVALID_SCHEMA",
    });
  });

  it("continues after a rejected or untested candidate even when Senopati says finish", async () => {
    const correctedPrompt = `${invariant} Be direct and use concrete details.`;
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
      maxIterations: 2,
    });
    let turn = 0;
    optimizer.mockImplementation(async (prompt: string) => {
      turn += 1;
      if (turn === 1) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Konteks sudah cukup untuk melanjutkan.",
            clarificationRequired: false,
            clarification: null,
            testCases: [],
          }),
          turn,
        );
      }
      const decisionTurn = turn - 1;
      if (decisionTurn === 1) {
        expect(prompt).toContain(
          "salin setiap string persis ke dalam candidate.text",
        );
        expect(prompt).toContain(
          `Aturan penting: ${JSON.stringify([invariant])}`,
        );
        const candidateId = readValue<string>(
          prompt,
          "ID kandidat berikutnya: ",
        );
        expect(candidateId).toBeTruthy();
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya mengusulkan kandidat awal.",
            toolCalls: [
              {
                name: "validate_candidate",
                arguments: {
                  candidateText: "Be concise.",
                  invariants: [invariant],
                },
              },
            ],
            candidate: {
              text: "Be concise.",
              changeSummary: "Instruksi diringkas.",
              riskSummary: "Aturan penting mungkin belum dipertahankan.",
              strategy: "Remove repetition",
            },
            finish: true,
          }),
          turn,
        );
      }

      if (decisionTurn === 2) {
        expect(prompt).toContain('"invariantStatus":"violated"');
        expect(prompt).toContain('"valid":false');
        expect(prompt).toContain(
          `"missingInvariants":[${JSON.stringify(invariant)}]`,
        );
        expect(prompt).toContain('"invariantArgumentsMatch":true');
        expect(prompt).toContain(
          "salin setiap string di dalamnya persis ke candidate.text",
        );
        const candidates = readValue<Array<{ id: string }>>(
          prompt,
          "Kandidat dan hasil sebelumnya: ",
        );
        expect(candidates).toHaveLength(1);
        return optimizerInvocation(
          JSON.stringify({
            summary:
              "Saya memperbaiki kandidat dengan mempertahankan aturan literal.",
            toolCalls: [
              {
                name: "validate_candidate",
                arguments: {
                  candidateText: correctedPrompt,
                  invariants: [invariant],
                },
              },
            ],
            candidate: {
              text: correctedPrompt,
              changeSummary: "Instruksi berulang diringkas.",
              riskSummary: "Periksa hasil pada input yang sama.",
              strategy: "Remove repetition",
            },
            finish: true,
          }),
          turn,
        );
      }

      if (decisionTurn === 3) {
        expect(prompt).toContain('"invariantStatus":"preserved"');
        const candidates = readValue<Array<{ id: string }>>(
          prompt,
          "Kandidat dan hasil sebelumnya: ",
        );
        const developmentCaseIds = readValue<string[]>(
          prompt,
          "ID pengujian internal: ",
        );
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya menguji kandidat yang lolos validasi.",
            toolCalls: [
              {
                name: "evaluate_subset",
                arguments: {
                  candidateId: candidates[1]!.id,
                  developmentCaseIds,
                },
              },
            ],
            finish: true,
          }),
          turn,
        );
      }

      const candidates = readValue<
        Array<{ caseResults: unknown[] | null; metrics: unknown | null }>
      >(prompt, "Kandidat dan hasil sebelumnya: ");
      expect(candidates[1]?.caseResults).not.toBeNull();
      expect(candidates[1]?.metrics).not.toBeNull();
      return optimizerInvocation(
        JSON.stringify({
          summary: "Perbandingan siap ditinjau pengguna.",
          finish: true,
        }),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(optimizer).toHaveBeenCalledTimes(4);
    expect(result.decisionTurnCount).toBe(4);
    expect(result.status).toBe("candidate_ready");
    expect(result.candidate).toMatchObject({
      prompt: correctedPrompt,
      invariantStatus: "preserved",
      invariantsPreserved: true,
      caseResults: [{ answer: "New answer." }],
    });
    expect(result.comparison).not.toBeNull();
    expect(targetCalls.map((call) => call.subject)).toEqual([
      "baseline",
      "candidate",
    ]);
  });

  it.each([
    ["case-only", `${invariant} USE THE FIRST APPROACH.`],
    ["whitespace-only", `${invariant}  Use the first approach.`],
  ])(
    "keeps the earlier verified candidate reviewable when revision B changes only %s and is not tested",
    async (_change, promptB) => {
      const promptA = `${invariant} Use the first approach.`;
      const { options, optimizer, targetCalls } = createOptions({
        inputs: [
          { id: "case-1", input: "Explain the first case." },
          { id: "case-2", input: "Explain the second case." },
        ],
        maxIterations: 2,
      });
      options.invokeTarget.mockImplementation(
        async (text, _signal, metadata) => {
          const label = text.includes(promptB)
            ? "B"
            : text.includes(promptA)
              ? "A"
              : "baseline";
          const answer = `${label} answer for ${metadata?.caseId}`;
          const inputTokens = label === "B" ? 200 : label === "A" ? 100 : 50;
          const outputTokens = label === "B" ? 40 : label === "A" ? 20 : 10;
          const elapsedMs = label === "B" ? 24 : label === "A" ? 12 : 45;
          targetCalls.push({
            text,
            subject: metadata?.subject,
            caseId: metadata?.caseId,
            answer,
          });
          return {
            text: answer,
            responseModel: "gpt-5.6-codex",
            responseId: `response-${targetCalls.length}`,
            usage: {
              inputTokens: reported(inputTokens),
              outputTokens: reported(outputTokens),
              totalTokens: reported(inputTokens + outputTokens),
            },
            elapsedMs,
          };
        },
      );

      let turn = 0;
      let candidateAId = "";
      optimizer.mockReset().mockImplementation(async (prompt) => {
        turn += 1;
        if (turn === 1) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Konteks sudah cukup untuk melanjutkan.",
              clarificationRequired: false,
              clarification: null,
              testCases: [],
            }),
            turn,
          );
        }
        const decisionTurn = turn - 1;
        if (decisionTurn === 1) {
          candidateAId = readValue<string>(prompt, "ID kandidat berikutnya: ");
          return optimizerInvocation(
            JSON.stringify({
              summary: "Saya memvalidasi dan mengusulkan kandidat pertama.",
              toolCalls: [
                {
                  name: "validate_candidate",
                  arguments: {
                    candidateText: promptA,
                    invariants: [invariant],
                  },
                },
              ],
              candidate: {
                text: promptA,
                changeSummary: "Menguji pendekatan pertama.",
                riskSummary: "Periksa jawaban pada kedua contoh.",
                strategy: "First approach",
              },
              finish: false,
            }),
            turn,
          );
        }
        const candidates = readValue<Array<{ id: string }>>(
          prompt,
          "Kandidat dan hasil sebelumnya: ",
        );
        const developmentCaseIds = readValue<string[]>(
          prompt,
          "ID pengujian internal: ",
        );
        if (decisionTurn === 2) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Saya menguji kandidat pertama pada semua contoh.",
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
            }),
            turn,
          );
        }
        if (decisionTurn === 3) {
          return optimizerInvocation(
            JSON.stringify({
              summary: "Saya merevisi prompt setelah melihat hasil pertama.",
              toolCalls: [
                {
                  name: "validate_candidate",
                  arguments: {
                    candidateText: promptB,
                    invariants: [invariant],
                  },
                },
              ],
              candidate: {
                text: promptB,
                changeSummary: "Merevisi pendekatan.",
                riskSummary: "Revisi harus diuji kembali.",
                strategy: "Revise approach",
              },
              finish: false,
            }),
            turn,
          );
        }

        expect(candidates).toHaveLength(2);
        expect(candidates[0]?.id).toBe(candidateAId);
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya meminta hasil memakai ID kandidat sebelumnya.",
            toolCalls: [
              {
                name: "evaluate_subset",
                arguments: {
                  candidateId: candidateAId,
                  developmentCaseIds,
                },
              },
            ],
            finish: true,
          }),
          turn,
        );
      });

      const result = await optimizePromptAutomatically(options);

      expect(result.status).toBe("candidate_ready");
      expect(result.latestCandidateId).toBe(result.candidates[1]?.id);
      expect(result.reviewableCandidateId).toBe(result.candidates[0]?.id);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toMatchObject({
        prompt: promptA,
        outcome: "candidate_ready",
        testingStatus: "ready",
        evidenceBoundToPrompt: true,
        caseResults: [
          { answer: "A answer for case-1" },
          { answer: "A answer for case-2" },
        ],
        draftVersionId: "84a0bef8-259e-47cd-8a95-7ce8d8fadba1",
      });
      expect(result.candidates[1]).toMatchObject({
        prompt: promptB,
        outcome: "incomplete",
        testingStatus: "incomplete",
        evidenceBoundToPrompt: false,
        caseResults: [],
        answers: [],
        draftVersionId: null,
      });
      expect(result.candidate).toMatchObject({
        id: result.candidates[0]?.id,
        prompt: promptA,
        testingStatus: "ready",
        evidenceBoundToPrompt: true,
        caseResults: [
          { answer: "A answer for case-1" },
          { answer: "A answer for case-2" },
        ],
        draftVersionId: "84a0bef8-259e-47cd-8a95-7ce8d8fadba1",
      });
      expect(result.comparison).not.toBeNull();
      expect(result.baseline.caseResults.map((item) => item.answer)).toEqual([
        "baseline answer for case-1",
        "baseline answer for case-2",
      ]);
      expect(
        targetCalls
          .filter((call) => call.subject === "candidate")
          .map((call) => call.answer),
      ).toEqual(["A answer for case-1", "A answer for case-2"]);
      expect(targetCalls.some((call) => call.text.includes(promptB))).toBe(
        false,
      );
      expect(options.persistDraft).toHaveBeenCalledTimes(1);
      expect(options.persistDraft).toHaveBeenCalledWith(
        expect.objectContaining({ text: promptA }),
      );
      expect(result.decisionSummary).toContain("belum lolos validasi");
      expect(Object.isFrozen(result.candidates)).toBe(true);
      expect(Object.isFrozen(result.candidates[0])).toBe(true);
      expect(Object.isFrozen(result.candidates[0]?.caseResults)).toBe(true);
    },
  );

  it("tests every valid candidate before the next revision and returns the final prompt's exact evidence", async () => {
    const promptA = `${invariant} Use the first approach.`;
    const promptB = `${invariant} Use the revised approach.`;
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [
        { id: "case-1", input: "Explain the first case." },
        { id: "case-2", input: "Explain the second case." },
      ],
      useIterationDefault: true,
    });
    expect(options.request.maxIterations).toBe(2);
    options.invokeTarget.mockImplementation(async (text, _signal, metadata) => {
      const label = text.includes(promptB)
        ? "B"
        : text.includes(promptA)
          ? "A"
          : "baseline";
      const answer = `${label} answer for ${metadata?.caseId}`;
      const inputTokens = label === "B" ? 200 : label === "A" ? 100 : 50;
      const outputTokens = label === "B" ? 40 : label === "A" ? 20 : 10;
      const elapsedMs = label === "B" ? 24 : label === "A" ? 12 : 45;
      targetCalls.push({
        text,
        subject: metadata?.subject,
        caseId: metadata?.caseId,
        answer,
      });
      return {
        text: answer,
        responseModel: "gpt-5.6-codex",
        responseId: `response-${targetCalls.length}`,
        usage: {
          inputTokens: reported(inputTokens),
          outputTokens: reported(outputTokens),
          totalTokens: reported(inputTokens + outputTokens),
        },
        elapsedMs,
      };
    });

    let turn = 0;
    optimizer.mockReset().mockImplementation(async (prompt) => {
      turn += 1;
      if (turn === 1) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Konteks sudah cukup untuk melanjutkan.",
            clarificationRequired: false,
            clarification: null,
            testCases: [],
          }),
          turn,
        );
      }
      const decisionTurn = turn - 1;
      if (decisionTurn === 1) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya memvalidasi dan mengusulkan kandidat pertama.",
            toolCalls: [
              {
                name: "validate_candidate",
                arguments: { candidateText: promptA, invariants: [invariant] },
              },
            ],
            candidate: {
              text: promptA,
              changeSummary: "Menguji pendekatan pertama.",
              riskSummary: "Periksa jawaban pada kedua contoh.",
              strategy: "First approach",
            },
            finish: true,
          }),
          turn,
        );
      }
      const candidates = readValue<
        Array<{ id: string; prompt: string; caseResults: unknown[] | null }>
      >(prompt, "Kandidat dan hasil sebelumnya: ");
      expect(decisionTurn).toBe(2);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        candidate: { text: promptA },
      });
      expect(candidates[0]?.caseResults).toHaveLength(2);
      return optimizerInvocation(
        JSON.stringify({
          summary:
            "Saya mengusulkan revisi setelah hasil kandidat pertama tersedia.",
          toolCalls: [
            {
              name: "validate_candidate",
              arguments: {
                candidateText: promptB,
                invariants: [invariant],
              },
            },
          ],
          candidate: {
            text: promptB,
            changeSummary: "Merevisi pendekatan.",
            riskSummary: "Uji seluruh contoh lagi.",
            strategy: "Revise approach",
          },
          finish: true,
        }),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("candidate_ready");
    expect(result.decisionTurnCount).toBe(4);
    expect(optimizer).toHaveBeenCalledTimes(3);
    expect(result.candidates).toMatchObject([
      { prompt: promptA, outcome: "candidate_ready" },
      { prompt: promptB, outcome: "candidate_ready" },
    ]);
    expect(result.candidate).toMatchObject({
      prompt: promptB,
      invariantStatus: "preserved",
      caseResults: [
        { id: "case-1", answer: "B answer for case-1" },
        { id: "case-2", answer: "B answer for case-2" },
      ],
      answers: [
        { caseId: "case-1", text: "B answer for case-1" },
        { caseId: "case-2", text: "B answer for case-2" },
      ],
      metrics: {
        inputTokens: { value: 400 },
        outputTokens: { value: 80 },
        totalTokens: { value: 480 },
        latencyMs: 48,
      },
    });
    expect(
      targetCalls.filter((call) => call.subject === "candidate"),
    ).toHaveLength(4);
    expect(
      targetCalls
        .filter((call) => call.text.includes(promptB))
        .map((call) => call.answer),
    ).toEqual(["B answer for case-1", "B answer for case-2"]);
    expect(options.persistDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: promptB }),
    );
  });

  it("keeps ready revision A reviewable when revision B fails invariant validation", async () => {
    const promptA = `${invariant} Use the first approach.`;
    const promptB =
      "Use a different approach without the required sentence rule.";
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [{ id: "case-1", input: "Explain the result." }],
      maxIterations: 2,
    });
    let turn = 0;
    optimizer.mockReset().mockImplementation(async (prompt) => {
      turn += 1;
      if (turn === 1) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Konteks sudah cukup untuk melanjutkan.",
            clarificationRequired: false,
            clarification: null,
            testCases: [],
          }),
          turn,
        );
      }
      const decisionTurn = turn - 1;
      const candidates = readValue<Array<{ id: string }>>(
        prompt,
        "Kandidat dan hasil sebelumnya: ",
      );
      const developmentCaseIds = readValue<string[]>(
        prompt,
        "ID pengujian internal: ",
      );
      if (decisionTurn === 1) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya memvalidasi dan mengusulkan kandidat pertama.",
            toolCalls: [
              {
                name: "validate_candidate",
                arguments: { candidateText: promptA, invariants: [invariant] },
              },
            ],
            candidate: {
              text: promptA,
              changeSummary: "Menguji pendekatan pertama.",
              riskSummary: "Periksa jawaban pada contoh yang sama.",
              strategy: "First approach",
            },
            finish: false,
          }),
          turn,
        );
      }
      if (decisionTurn === 2) {
        return optimizerInvocation(
          JSON.stringify({
            summary: "Saya menguji kandidat pertama.",
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
          }),
          turn,
        );
      }
      return optimizerInvocation(
        JSON.stringify({
          summary: "Saya mengusulkan revisi yang melanggar aturan.",
          toolCalls: [
            {
              name: "validate_candidate",
              arguments: { candidateText: promptB, invariants: [invariant] },
            },
          ],
          candidate: {
            text: promptB,
            changeSummary: "Menguji revisi kedua.",
            riskSummary: "Revisi harus mempertahankan aturan.",
            strategy: "Invalid revision",
          },
          finish: true,
        }),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("candidate_ready");
    expect(result.latestCandidateId).toBe(result.candidates[1]?.id);
    expect(result.reviewableCandidateId).toBe(result.candidates[0]?.id);
    expect(result.candidates[0]).toMatchObject({
      prompt: promptA,
      outcome: "candidate_ready",
      evidenceBoundToPrompt: true,
      caseResults: [{ answer: "New answer." }],
    });
    expect(result.candidates[1]).toMatchObject({
      prompt: promptB,
      outcome: "candidate_rejected",
      testingStatus: "rejected",
      invariantStatus: "violated",
      evidenceBoundToPrompt: false,
      caseResults: [],
      draftVersionId: null,
    });
    expect(result.candidate).toMatchObject({
      prompt: promptA,
      testingStatus: "ready",
      caseResults: [{ answer: "New answer." }],
    });
    expect(
      targetCalls.filter((call) => call.subject === "candidate"),
    ).toHaveLength(1);
    expect(options.persistDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: promptA }),
    );
  });

  it("returns no_change_recommended when the planner explicitly finishes without a candidate", async () => {
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [{ id: "case-1", input: "Explain the result." }],
    });
    let turn = 0;
    optimizer.mockReset().mockImplementation(async () => {
      turn += 1;
      return optimizerInvocation(
        JSON.stringify(
          turn === 1
            ? {
                summary: "Konteks sudah cukup untuk melanjutkan.",
                clarificationRequired: false,
                clarification: null,
                testCases: [],
              }
            : {
                summary: "Prompt awal sudah memenuhi kebutuhan.",
                toolCalls: [],
                candidate: null,
                finish: true,
                clarificationRequired: false,
                clarification: null,
              },
        ),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("no_change_recommended");
    expect(result.candidate).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.latestCandidateId).toBeNull();
    expect(result.reviewableCandidateId).toBeNull();
    expect(result.comparison).toBeNull();
    expect(result.decisionSummary).toBe(
      "Tidak ada perubahan yang disarankan; prompt awal tetap dipertahankan.",
    );
    expect(targetCalls.map((call) => call.subject)).toEqual(["baseline"]);
    expect(options.persistDraft).not.toHaveBeenCalled();
  });

  it("does not evaluate or persist an exact unchanged candidate", async () => {
    const { options, optimizer, targetCalls } = createOptions({
      inputs: [{ id: "case-1", input: "Explain the result." }],
    });
    let turn = 0;
    optimizer.mockReset().mockImplementation(async () => {
      turn += 1;
      return optimizerInvocation(
        JSON.stringify(
          turn === 1
            ? {
                summary: "Konteks sudah cukup untuk melanjutkan.",
                clarificationRequired: false,
                clarification: null,
                testCases: [],
              }
            : {
                summary: "Kandidat sama dengan prompt awal.",
                toolCalls: [
                  {
                    name: "validate_candidate",
                    arguments: {
                      candidateText: originalPrompt,
                      invariants: [invariant],
                    },
                  },
                ],
                candidate: {
                  text: originalPrompt,
                  changeSummary: "Tidak ada perubahan.",
                  riskSummary: "Tidak ada perubahan yang diuji.",
                  strategy: "Keep the saved prompt",
                },
                finish: true,
                clarificationRequired: false,
                clarification: null,
              },
        ),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("no_change_recommended");
    expect(result.candidate).toMatchObject({
      prompt: originalPrompt,
      changeSummary:
        "Teks kandidat sama persis dengan prompt awal; tidak ada perubahan.",
      riskSummary: "Tidak ada perubahan untuk dibandingkan.",
      testingStatus: "incomplete",
      evidenceBoundToPrompt: false,
      caseResults: [],
      draftVersionId: null,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      prompt: originalPrompt,
      outcome: "no_change_recommended",
      changeSummary:
        "Teks kandidat sama persis dengan prompt awal; tidak ada perubahan.",
      evidenceBoundToPrompt: false,
      caseResults: [],
    });
    expect(result.comparison).toBeNull();
    expect(targetCalls.map((call) => call.subject)).toEqual(["baseline"]);
    expect(options.persistDraft).not.toHaveBeenCalled();
  });

  it("propagates target execution failures instead of mapping them to recommendation outcomes", async () => {
    const { options } = createOptions({
      inputs: [{ id: "case-1", input: "Explain the result." }],
    });
    options.invokeTarget.mockRejectedValue(new Error("target provider failed"));

    await expect(optimizePromptAutomatically(options)).rejects.toThrow(
      "target provider failed",
    );
    expect(options.persistDraft).not.toHaveBeenCalled();
  });

  it("keeps planner budget exhaustion incomplete when no recommendation is reached", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "case-1", input: "Explain the result." }],
    });
    let turn = 0;
    optimizer.mockReset().mockImplementation(async () => {
      turn += 1;
      return optimizerInvocation(
        JSON.stringify(
          turn === 1
            ? {
                summary: "Konteks sudah cukup untuk melanjutkan.",
                clarificationRequired: false,
                clarification: null,
                testCases: [],
              }
            : {
                summary: "Masih mengumpulkan bukti.",
                toolCalls: [],
                candidate: null,
                finish: false,
                clarificationRequired: false,
                clarification: null,
              },
        ),
        turn,
      );
    });

    const result = await optimizePromptAutomatically(options);

    expect(result.status).toBe("incomplete");
    expect(result.decisionTurnCount).toBe(4);
    expect(result.candidate).toBeNull();
    expect(result.comparison).toBeNull();
    expect(options.persistDraft).not.toHaveBeenCalled();
  });

  it("rejects validation results whose invariant list differs even when no invariants are configured", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "case-1", input: "Explain the result." }],
      invariants: [],
    });

    const result = await optimizePromptAutomatically(options);

    expect(optimizer).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("candidate_rejected");
    expect(result.candidate).toMatchObject({
      prompt: candidatePrompt,
      testingStatus: "rejected",
      invariantStatus: "violated",
      draftVersionId: null,
    });
    expect(options.persistDraft).not.toHaveBeenCalled();
  });

  it("does not save or expose a candidate that removes a saved rule", async () => {
    const { options, optimizer } = createOptions({
      inputs: [{ id: "user-case-1", input: "Explain the result." }],
      candidateText: "Answer in many sentences and be clear.",
    });

    const result = await optimizePromptAutomatically(options);

    expect(optimizer).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("candidate_rejected");
    expect(result.candidate).toMatchObject({
      prompt: "Answer in many sentences and be clear.",
      testingStatus: "rejected",
      invariantStatus: "violated",
      draftVersionId: null,
    });
    expect(options.persistDraft).not.toHaveBeenCalled();
  });
});
