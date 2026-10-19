import { describe, expect, it, vi } from "vitest";

import {
  ControlledEvaluationInterruptedError,
  sha256Text,
} from "@promptlab/agent";
import {
  type ControlledEvaluationRequest,
  type EvaluationSourceVersion,
  type UsageMetric,
} from "@promptlab/contracts";
import type { RetrievalResult } from "@promptlab/db";

import { executeControlledEvaluationBatch } from "./controlled-evaluation.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const documentVersionId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const source: EvaluationSourceVersion = {
  documentId,
  documentVersionId,
  documentVersion: 3,
  checksum: "source-checksum-v3",
};
const observedAt = "2026-10-16T00:00:00+00:00";

function metric(value: number): UsageMetric {
  return { status: "reported", value, observedAt, method: "fake-provider" };
}

function originalArm() {
  return {
    arm: "original" as const,
    provider: "codex_app_server" as const,
    requestedModel: "codex-test",
    reasoningEffort: null,
    retrieval: {
      strategy: "lexical" as const,
      sourceIds: [],
      snapshotId: null,
    },
    sources: [],
  };
}

function controlledRequest(
  arms: ControlledEvaluationRequest["arms"] = [
    originalArm(),
    sourceArm("rag"),
    sourceArm("graphrag"),
  ],
): ControlledEvaluationRequest {
  return {
    mode: "controlled_evaluation",
    format: "promptlab-controlled-evaluation-v1",
    datasetName: "Controlled batch",
    datasetVersion: "v1",
    promptId: "44444444-4444-4444-8444-444444444444",
    baselinePromptVersionId: "55555555-5555-4555-8555-555555555555",
    baselinePromptHash: sha256Text("Baseline prompt"),
    candidatePromptVersionId: "66666666-6666-4666-8666-666666666666",
    candidatePromptHash: sha256Text("Candidate prompt"),
    cases: [
      {
        id: "dev-alpha",
        split: "development",
        input: "Count even values from 1 through 10.",
        label: "Development criterion",
        verification: {
          kind: "divisibility",
          startInclusive: 1,
          endInclusive: 10,
          includeDivisors: [2],
          excludeDivisors: [],
          expected: { count: "5", sum: "30" },
        },
      },
      {
        id: "holdout-omega",
        split: "holdout",
        input: "Count even values from 1 through 10.",
        label: "PRIVATE_HOLDOUT_LABEL_DO_NOT_PROMPT",
        verification: {
          kind: "divisibility",
          startInclusive: 1,
          endInclusive: 10,
          includeDivisors: [2],
          excludeDivisors: [],
          expected: { count: "5", sum: "30" },
        },
      },
    ],
    arms,
  };
}

function sourceArm(arm: "rag" | "graphrag") {
  return {
    arm,
    provider: "codex_app_server" as const,
    requestedModel: "codex-test",
    reasoningEffort: null,
    retrieval:
      arm === "graphrag"
        ? {
            strategy: "graph" as const,
            sourceIds: [documentId],
            snapshotId,
          }
        : {
            strategy: "lexical" as const,
            sourceIds: [documentId],
            snapshotId: null,
          },
    sources: [
      {
        documentId,
        title: "Test source",
        documentVersionId,
        documentVersion: 3,
        checksum: source.checksum,
      },
    ],
  };
}

function retrievalResult(input: {
  query: string;
  strategy: "lexical" | "graph" | "full_context";
  snapshotId: string | null;
  fallback?: boolean;
}): RetrievalResult {
  const fallback = input.fallback && input.strategy === "graph";
  const strategyUsed = fallback ? "lexical" : input.strategy;
  return {
    projectId: "77777777-7777-4777-8777-777777777777",
    requestedStrategy: input.strategy,
    strategyUsed,
    snapshotId: strategyUsed === "graph" ? input.snapshotId : null,
    traceId: "88888888-8888-4888-8888-888888888888",
    seeds: [],
    paths: [],
    evidence: [],
    packedContext:
      input.strategy === "graph"
        ? `Graph context for ${input.query}`
        : `Lexical context for ${input.query}`,
    estimatedContextTokens: 12,
    fallbackReason: fallback ? "no_active_snapshot" : null,
    clipping: {},
    elapsedMs: 1,
  } as RetrievalResult;
}

function setup(
  input: {
    request?: ControlledEvaluationRequest;
    invoke?: Parameters<typeof executeControlledEvaluationBatch>[0]["invoke"];
    fallback?: boolean;
  } = {},
) {
  const request = input.request ?? controlledRequest();
  const invokes: Parameters<
    Parameters<typeof executeControlledEvaluationBatch>[0]["invoke"]
  >[0][] = [];
  const retrieve = vi.fn(
    async (retrieval: {
      query: string;
      strategy: "lexical" | "graph" | "full_context";
      snapshotId: string | null;
    }) => retrievalResult({ ...retrieval, fallback: input.fallback ?? false }),
  );
  const invoke = input.invoke
    ? vi.fn(input.invoke)
    : vi.fn(async (call: (typeof invokes)[number]) => {
        invokes.push(call);
        return {
          status: "succeeded" as const,
          text: '{"count":"5","sum":"30"}',
          responseId: `response-${invokes.length}`,
          responseModel: "codex-test",
          usage: {
            inputTokens: metric(20),
            outputTokens: metric(8),
            cacheReadTokens: {
              status: "unknown" as const,
              value: null,
              reason: "not reported",
            },
            cacheWriteTokens: {
              status: "unknown" as const,
              value: null,
              reason: "not reported",
            },
            completeness: "partial" as const,
            responseId: `response-${invokes.length}`,
            mapperVersion: "fake-provider-v1",
          },
          latencyMs: 7,
        };
      });
  const captureSourceManifest = vi.fn(async (sourceIds: readonly string[]) =>
    sourceIds.length ? [source] : [],
  );
  const handler = executeControlledEvaluationBatch({
    projectId: "77777777-7777-4777-8777-777777777777",
    runId: "99999999-9999-4999-8999-999999999999",
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    request,
    baselinePrompt: "Baseline prompt",
    candidatePrompt: "Candidate prompt",
    contextBudgetTokens: 3_000,
    signal: new AbortController().signal,
    captureSourceManifest,
    retrieve,
    invoke,
  });
  return { request, handler, invoke, retrieve, captureSourceManifest, invokes };
}

describe("controlled evaluation batch handler", () => {
  it("keeps holdout labels and oracles out of target requests and trace events", async () => {
    const traces: unknown[] = [];
    const { request, invoke } = setup();
    const report = await executeControlledEvaluationBatch({
      projectId: "77777777-7777-4777-8777-777777777777",
      runId: "99999999-9999-4999-8999-999999999999",
      attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      request,
      baselinePrompt: "Baseline prompt",
      candidatePrompt: "Candidate prompt",
      contextBudgetTokens: 3_000,
      signal: new AbortController().signal,
      captureSourceManifest: async (sourceIds) =>
        sourceIds.length ? [source] : [],
      retrieve: async (retrieval) => retrievalResult(retrieval),
      invoke: async (call) => {
        traces.push({ ...call, signal: undefined });
        return {
          status: "succeeded",
          text: '{"count":"5","sum":"30"}',
          responseId: "response",
          responseModel: "codex-test",
          usage: {
            inputTokens: metric(1),
            outputTokens: metric(1),
            cacheReadTokens: {
              status: "unknown",
              value: null,
              reason: "not reported",
            },
            cacheWriteTokens: {
              status: "unknown",
              value: null,
              reason: "not reported",
            },
            completeness: "partial",
            responseId: "response",
            mapperVersion: "fake-provider-v1",
          },
          latencyMs: 1,
        };
      },
      onTrace: (trace) => traces.push(trace),
    });
    expect(invoke).toHaveBeenCalledTimes(12);
    const serializedCalls = JSON.stringify(invoke.mock.calls);
    expect(serializedCalls).not.toContain(
      "PRIVATE_HOLDOUT_LABEL_DO_NOT_PROMPT",
    );
    expect(serializedCalls).not.toContain('"expected":{"count":"5"');
    expect(JSON.stringify(traces)).not.toContain(
      "PRIVATE_HOLDOUT_LABEL_DO_NOT_PROMPT",
    );
    expect(
      report.manifest.cases.find((item) => item.split === "holdout"),
    ).toMatchObject({ split: "holdout" });
  });

  it("uses one identical frozen pair configuration and context for each case", async () => {
    const rag = sourceArm("rag");
    const { handler, invokes } = setup({
      request: controlledRequest([originalArm(), rag, sourceArm("graphrag")]),
    });
    const report = await handler;
    expect(invokes).toHaveLength(12);
    for (const pair of report.pairs) {
      expect(pair.baseline.contextHash).toBe(pair.candidate.contextHash);
      expect(pair.baseline.requestHash).not.toBe(pair.candidate.requestHash);
      expect(pair.baseline.promptHash).toBe(report.baselinePromptHash);
      expect(pair.candidate.promptHash).toBe(report.candidatePromptHash);
      expect(pair.pairConfigHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(
      report.manifest.arms.find((arm) => arm.arm === "rag")?.evidencePacks,
    ).toHaveLength(2);
  });

  it("rejects GraphRAG fallback before making target calls", async () => {
    const { handler, invoke, retrieve } = setup({
      request: controlledRequest([
        originalArm(),
        sourceArm("rag"),
        sourceArm("graphrag"),
      ]),
      fallback: true,
    });
    await expect(handler).rejects.toThrow(
      "CONTROLLED_EVALUATION_GRAPHRAG_FALLBACK_REJECTED",
    );
    expect(retrieve).toHaveBeenCalledTimes(4);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records missing or failed target responses as partial and inconclusive", async () => {
    let callCount = 0;
    const { request } = setup();
    const report = await executeControlledEvaluationBatch({
      projectId: "77777777-7777-4777-8777-777777777777",
      runId: "99999999-9999-4999-8999-999999999999",
      attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      request,
      baselinePrompt: "Baseline prompt",
      candidatePrompt: "Candidate prompt",
      contextBudgetTokens: 3_000,
      signal: new AbortController().signal,
      captureSourceManifest: async (sourceIds) =>
        sourceIds.length ? [source] : [],
      retrieve: async (retrieval) => retrievalResult(retrieval),
      invoke: async () => {
        callCount += 1;
        return callCount === 1
          ? { status: "failed", errorCode: "FAKE_TARGET_FAILURE" }
          : {
              status: "succeeded",
              text: '{"count":"5","sum":"30"}',
              responseId: `response-${callCount}`,
              responseModel: "codex-test",
              usage: {
                inputTokens: metric(2),
                outputTokens: metric(1),
                cacheReadTokens: {
                  status: "unknown",
                  value: null,
                  reason: "not reported",
                },
                cacheWriteTokens: {
                  status: "unknown",
                  value: null,
                  reason: "not reported",
                },
                completeness: "partial",
                responseId: `response-${callCount}`,
                mapperVersion: "fake-provider-v1",
              },
              latencyMs: 1,
            };
      },
    });
    expect(report.status).toBe("partial");
    expect(report.pairs[0]?.baseline).toMatchObject({
      status: "failed",
      answerHash: null,
      errorCode: "FAKE_TARGET_FAILURE",
    });
    expect(report.pairs[0]?.judgment).toBe("inconclusive");
  });

  it("reports remote uncertainty when cancellation interrupts an active call", async () => {
    const controller = new AbortController();
    const { request } = setup();
    let markInvocationStarted: () => void = () => undefined;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    const handler = executeControlledEvaluationBatch({
      projectId: "77777777-7777-4777-8777-777777777777",
      runId: "99999999-9999-4999-8999-999999999999",
      attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      request,
      baselinePrompt: "Baseline prompt",
      candidatePrompt: "Candidate prompt",
      contextBudgetTokens: 3_000,
      signal: controller.signal,
      captureSourceManifest: async (sourceIds) =>
        sourceIds.length ? [source] : [],
      retrieve: async (retrieval) => retrievalResult(retrieval),
      invoke: ({ signal }) => {
        markInvocationStarted();
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    await invocationStarted;
    controller.abort();
    await expect(handler).rejects.toMatchObject({
      remoteOutcomeUncertain: true,
      code: "CONTROLLED_EVALUATION_INTERRUPTED",
    });
    expect(ControlledEvaluationInterruptedError).toBeDefined();
  });

  it("returns evidence only and never activates a saved candidate", async () => {
    const { handler, invoke } = setup();
    const report = await handler;
    expect(invoke).toHaveBeenCalledTimes(12);
    expect(report).toMatchObject({
      mode: "controlled_evaluation",
      optimizerLineage: { status: "not_used", calls: 0, overheadMs: null },
    });
    expect(report).not.toHaveProperty("decision");
    expect(report).not.toHaveProperty("apply");
    expect(report).not.toHaveProperty("activePromptVersionId");
  });
});
