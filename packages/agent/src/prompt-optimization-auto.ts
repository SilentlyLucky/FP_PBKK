import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  AgentBudgetSchema,
  type AgentToolCall,
  EvaluationEvidencePackSchema,
  type EvaluationEvidenceManifest,
  type EvaluationEvidencePack,
  OptimizationClarificationQuestionSchema,
  PromptOptimizationVerificationSchema,
  type PromptOptimizationRequest,
  type PromptOptimizationOutcome,
  type PromptOptimizationRevisionOutcome,
  type PromptOptimizationTargetSelection,
  type PromptOptimizationVerification,
  type ProviderId,
  type UsageMetric,
} from "@promptlab/contracts";
import type { AgentScope, ToolHandlers } from "@promptlab/tools";
import { z } from "zod";

import {
  runBoundedAgent,
  type AgentCandidate,
  type AgentTraceEvent,
} from "./index.js";
import {
  verifyOptimizationCase,
  type OptimizationVerificationEvidence,
} from "./prompt-optimization-verification.js";
import {
  buildTargetEvaluationRequest,
  createEvaluationEvidenceManifest,
  isEvaluationEvidenceManifestIntact,
  sha256Json,
  sha256Text,
} from "./evidence-manifest.js";

// Ignore harmless provider fields; tool actions are still checked against the strict agent contract before execution.
const ClarificationPreflightSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
    clarificationRequired: z.boolean().default(false),
    clarification:
      OptimizationClarificationQuestionSchema.nullable().default(null),
    targetRecommendation: z
      .object({
        modelId: z.string().trim().min(1).max(200).nullable().default(null),
        reasoningEffort: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .nullable()
          .default(null),
      })
      .nullable()
      .default(null),
    testCases: z
      .array(z.object({ input: z.string().trim().min(1).max(10_000) }))
      .max(3)
      .default([]),
  })
  .superRefine((decision, context) => {
    if (decision.clarificationRequired !== (decision.clarification !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "A clarification decision must contain exactly one public question.",
        path: ["clarification"],
      });
    }
  });

const DecisionSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
    toolCalls: z.array(z.unknown()).max(8).default([]),
    candidate: z
      .object({
        text: z.string().min(1).max(100_000),
        changeSummary: z.string().trim().min(1).max(500),
        riskSummary: z.string().trim().min(1).max(500),
        strategy: z.string().trim().min(1).max(300),
      })
      .nullable()
      .default(null),
    finish: z.boolean().default(false),
    clarificationRequired: z.boolean().default(false),
    clarification:
      OptimizationClarificationQuestionSchema.nullable().default(null),
  })
  .superRefine((decision, context) => {
    if (decision.clarificationRequired !== (decision.clarification !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "A clarification decision must contain exactly one public question.",
        path: ["clarification"],
      });
    }
    if (
      decision.clarificationRequired &&
      (decision.toolCalls.length > 0 ||
        decision.candidate !== null ||
        decision.finish)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A clarification turn cannot execute tools, propose a candidate, or finish.",
        path: ["clarificationRequired"],
      });
    }
  });

export interface OptimizationUsage {
  inputTokens: UsageMetric;
  outputTokens: UsageMetric;
  totalTokens: UsageMetric;
}

export interface OptimizationInvocation {
  text: string;
  responseModel: string | null;
  responseId: string | null;
  usage: OptimizationUsage;
  elapsedMs: number;
}

export interface OptimizationTestInput {
  id: string;
  input: string;
  source: "user" | "generated";
  verification?: PromptOptimizationVerification;
}

export interface OptimizationCaseRun {
  id: string;
  input: string;
  source: "user" | "generated";
  verification?: PromptOptimizationVerification;
  answer: string | null;
  responseId?: string | null;
  responseModel?: string | null;
  requestHash?: string | null;
  contextHash?: string | null;
  usage: OptimizationUsage;
  latencyMs: number | null;
  verificationEvidence: OptimizationVerificationEvidence | null;
}

export interface OptimizationRunMetrics {
  inputTokens: UsageMetric;
  outputTokens: UsageMetric;
  totalTokens: UsageMetric;
  latencyMs: number | null;
}

export type PublicOptimizationAnswer = OptimizationCaseRun & {
  caseId: string;
  text: string | null;
};

export interface OptimizationTargetSelectionEvidence {
  selection: {
    model: "selected" | "auto";
    reasoningEffort: "selected" | "auto";
  };
  requestedModel: string;
  resolvedModel: string;
  requestedReasoningEffort: string | null;
  resolvedReasoningEffort: string | null;
  sentReasoningEffort: string | null;
  modelResolution:
    | "explicit"
    | "first_current_compatible_text_model"
    | "task_aware_recommendation";
  effortResolution:
    | "explicit"
    | "advertised_default"
    | "first_advertised_supported"
    | "unsupported_recommendation_fallback"
    | "model_specific_auto_policy"
    | "provider_default"
    | "task_aware_recommendation";
  capabilitySource: "live_codex_model_list";
  observedAt: string;
  modelCatalogPosition: number;
  modelCatalogCount: number;
  modelCapabilities: {
    displayName: string;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: string[];
    inputModalities: string[];
  };
  selectionReason?: string;
  revalidatedAt?: string;
}

export const OptimizationTargetSelectionEvidenceSchema = z.strictObject({
  selection: z.strictObject({
    model: z.enum(["selected", "auto"]),
    reasoningEffort: z.enum(["selected", "auto"]),
  }),
  requestedModel: z.string().min(1).max(200),
  resolvedModel: z.string().min(1).max(200),
  requestedReasoningEffort: z.string().max(80).nullable(),
  resolvedReasoningEffort: z.string().max(80).nullable(),
  sentReasoningEffort: z.string().max(80).nullable(),
  modelResolution: z.enum([
    "explicit",
    "first_current_compatible_text_model",
    "task_aware_recommendation",
  ]),
  effortResolution: z.enum([
    "explicit",
    "advertised_default",
    "first_advertised_supported",
    "unsupported_recommendation_fallback",
    "model_specific_auto_policy",
    "provider_default",
    "task_aware_recommendation",
  ]),
  capabilitySource: z.literal("live_codex_model_list"),
  observedAt: z.string().min(1).max(80),
  modelCatalogPosition: z.number().int().positive(),
  modelCatalogCount: z.number().int().positive(),
  modelCapabilities: z.strictObject({
    displayName: z.string().min(1).max(200),
    defaultReasoningEffort: z.string().max(80),
    supportedReasoningEfforts: z.array(z.string().min(1).max(80)).max(20),
    inputModalities: z.array(z.string().min(1).max(40)).max(20),
  }),
  selectionReason: z.string().max(500).optional(),
  revalidatedAt: z.string().min(1).max(80).optional(),
});

export interface OptimizationTargetCapability {
  id: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  inputModalities: string[];
}

export interface OptimizationTargetRecommendation {
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface OptimizationFrozenExecutionSnapshot {
  preflightComplete: boolean;
  preflightSummary: string;
  targetSelection: OptimizationTargetSelectionEvidence | null;
  testCases: OptimizationTestInput[];
  sourceIds: string[];
  retrievalStrategy: "lexical" | "graph" | "full_context" | "hybrid";
  graphSnapshotId: string | null;
  history: Array<{ id: string; summary: string }>;
  caseEvidence?: EvaluationEvidencePack[];
}

export const OptimizationFrozenExecutionSnapshotSchema = z.strictObject({
  preflightComplete: z.boolean(),
  preflightSummary: z.string().max(500),
  targetSelection: OptimizationTargetSelectionEvidenceSchema.nullable(),
  testCases: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(80),
        input: z.string().trim().min(1).max(10_000),
        source: z.enum(["user", "generated"]),
        verification: PromptOptimizationVerificationSchema.optional(),
      }),
    )
    .max(3),
  sourceIds: z.array(z.uuid()).max(20),
  retrievalStrategy: z.enum(["lexical", "graph", "full_context", "hybrid"]),
  graphSnapshotId: z.uuid().nullable(),
  history: z
    .array(
      z.strictObject({
        id: z.uuid(),
        summary: z.string().max(4_000),
      }),
    )
    .max(20),
  caseEvidence: z.array(EvaluationEvidencePackSchema).max(20).optional(),
});

export interface AutomaticOptimizationCandidateResult {
  id: string;
  revision?: number;
  prompt: string;
  changeSummary: string;
  riskSummary: string;
  strategy: string;
  invariantStatus: "preserved" | "violated" | "not_configured";
  testingStatus: "ready" | "rejected" | "incomplete";
  evidenceBoundToPrompt: boolean;
  evaluationManifest?: EvaluationEvidenceManifest | null;
  caseResults: OptimizationCaseRun[];
  metrics: OptimizationRunMetrics;
  answers: PublicOptimizationAnswer[];
  aggregateUsage: Omit<OptimizationRunMetrics, "latencyMs">;
  totalTargetLatencyMs: number | null;
  invariantsPreserved: boolean | null;
  draftVersionId: string | null;
}

export interface AutomaticOptimizationCandidateRevision extends AutomaticOptimizationCandidateResult {
  outcome: PromptOptimizationRevisionOutcome;
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ImmutableAutomaticOptimizationCandidateRevision =
  DeepReadonly<AutomaticOptimizationCandidateRevision>;

export interface AutomaticPromptOptimizationResult {
  status: PromptOptimizationOutcome;
  baseline: {
    prompt: string;
    caseResults: OptimizationCaseRun[];
    metrics: OptimizationRunMetrics;
    answers: PublicOptimizationAnswer[];
    aggregateUsage: Omit<OptimizationRunMetrics, "latencyMs">;
    totalTargetLatencyMs: number | null;
  };
  /** Immutable, insertion-ordered snapshots of every proposed candidate revision. */
  candidates: readonly ImmutableAutomaticOptimizationCandidateRevision[];
  latestCandidateId: string | null;
  reviewableCandidateId: string | null;
  /** Legacy field: the latest ready revision, or the latest revision if none is ready. */
  candidate: AutomaticOptimizationCandidateResult | null;
  comparison: {
    tokenChange: number | null;
    tokenChangePercent: number | null;
    latencyChangeMs: number | null;
    latencyChangePercent: number | null;
  } | null;
  optimizer: {
    provider: "campus_gateway";
    model: string;
    requestedModel: string;
    responseModels: Array<string | null>;
    calls: number;
    usage: OptimizationUsage;
    inputTokens: UsageMetric;
    outputTokens: UsageMetric;
    totalTokens: UsageMetric;
    elapsedMs: number;
    overheadMs: number;
    providerElapsedMs: number;
  };
  targetSelection: OptimizationTargetSelectionEvidence | null;
  optimizationOverheadMs: number;
  decisionSummary: string;
  clarificationRequired: boolean;
  clarification: z.infer<typeof OptimizationClarificationQuestionSchema> | null;
  toolCallCount: number;
  decisionTurnCount: number;
}

type CandidateInvariantStatus = "preserved" | "violated" | "not_configured";

type CandidateValidation = {
  text: string;
  invariantKey: string;
  status: CandidateInvariantStatus;
};

type CandidateState = {
  id: string;
  revision: number;
  candidate: AgentCandidate;
  invariantStatus: CandidateInvariantStatus;
  validatedText: string | null;
  validatedInvariantKey: string | null;
  testedText: string | null;
  testedInvariantKey: string | null;
  caseResults: OptimizationCaseRun[] | null;
  metrics: OptimizationRunMetrics | null;
  draftVersionId: string | null;
  evaluationManifest: EvaluationEvidenceManifest | null;
};

export interface PromptOptimizationEvaluationContext {
  runId: string;
  attemptId: string;
  targetProvider: ProviderId;
  targetRequestedModel: string;
  targetRequestedEffort: string | null;
  targetProviderVersion: string | null;
  optimizerConfig: Record<string, unknown>;
  runConfig: Record<string, unknown>;
  targetConfig: Record<string, unknown>;
  retrievalConfig: Record<string, unknown>;
  workspaceSnapshot: EvaluationEvidenceManifest["workspaceSnapshot"];
  policyVersion: string;
  contextBudgetTokens: number;
}

export interface PromptOptimizationAutoOptions {
  projectId: string;
  originalPrompt: string;
  invariants: readonly string[];
  request: PromptOptimizationRequest;
  optimizerModel: string;
  targetSelection?: OptimizationTargetSelectionEvidence;
  targetSelectionRequest?: PromptOptimizationTargetSelection;
  targetRequestedModel?: string;
  targetRequestedReasoningEffort?: string;
  targetCapabilities?: readonly OptimizationTargetCapability[];
  resolveTargetSelection?: (
    recommendation: OptimizationTargetRecommendation | null,
  ) =>
    | OptimizationTargetSelectionEvidence
    | Promise<OptimizationTargetSelectionEvidence>;
  frozenExecutionSnapshot?: OptimizationFrozenExecutionSnapshot;
  evaluationContext?: PromptOptimizationEvaluationContext;
  resolveEvaluationEvidence?: (
    testCases: readonly OptimizationTestInput[],
    context: {
      sourceIds: readonly string[];
      retrievalStrategy: "lexical" | "graph" | "full_context" | "hybrid";
      graphSnapshotId: string | null;
    },
    signal: AbortSignal,
  ) => Promise<readonly EvaluationEvidencePack[]>;
  graphSnapshotId?: string | null;
  retrievalStrategy?: "lexical" | "graph" | "full_context" | "hybrid";
  persistExecutionSnapshot?: (
    snapshot: OptimizationFrozenExecutionSnapshot,
  ) => void | Promise<void>;
  sourceIds: readonly string[];
  history: readonly { id: string; summary: string }[];
  clarificationContext?: readonly { question: string; answer: string }[];
  signal: AbortSignal;
  invokeOptimizer: (
    text: string,
    signal: AbortSignal,
    analysisInput?: Record<string, unknown>,
  ) => Promise<OptimizationInvocation>;
  invokeTarget: (
    text: string,
    signal: AbortSignal,
    metadata?: {
      subject: "baseline" | "candidate";
      caseId: string;
      source: "user" | "generated";
      evidencePack?: EvaluationEvidencePack;
      requestHash?: string;
      contextHash?: string;
    },
  ) => Promise<OptimizationInvocation>;
  searchKnowledge?: (input: {
    query: string;
    sourceIds: readonly string[];
    snapshotId: string | null;
    signal: AbortSignal;
  }) => Promise<{
    context: string;
    chunkIds: readonly string[];
    resultCount: number;
  }>;
  readSource?: (chunkId: string, signal: AbortSignal) => Promise<unknown>;
  graphToolHandlers?: Pick<
    ToolHandlers,
    | "search_graph_entities"
    | "traverse_graph"
    | "get_graph_evidence"
    | "get_graph_status"
  >;
  persistDraft?: (candidate: AgentCandidate) => Promise<string>;
  onAgentEvent?: (event: AgentTraceEvent) => void | Promise<void>;
  onPhase?: (
    phase: string,
    summary: string,
    details?: Record<string, unknown>,
  ) => void | Promise<void>;
  onEvaluation?: (
    subject: "baseline" | "candidate",
    subjectId: string,
    caseResults: readonly OptimizationCaseRun[],
    metrics: OptimizationRunMetrics,
    invariantStatus: "preserved" | "violated" | "not_configured",
    evidenceManifest?: EvaluationEvidenceManifest | null,
  ) => void | Promise<void>;
}

const allowedToolNames = new Set<AgentToolCall["name"]>([
  "analyze_history",
  "search_knowledge",
  "get_source",
  "estimate_tokens",
  "inspect_capabilities",
  "validate_candidate",
  "evaluate_subset",
  "search_graph_entities",
  "traverse_graph",
  "get_graph_evidence",
  "get_graph_status",
]);

type OptimizationClarificationQuestion = z.infer<
  typeof OptimizationClarificationQuestionSchema
>;

/** Senopati plans prompt edits; the selected Codex model only runs the comparisons. */
export async function optimizePromptAutomatically(
  options: PromptOptimizationAutoOptions,
): Promise<AutomaticPromptOptimizationResult> {
  const startedAt = performance.now();
  const optimizerCalls: Array<
    Pick<OptimizationInvocation, "responseModel" | "usage" | "elapsedMs">
  > = [];
  const trackedOptimizer = async (
    text: string,
    signal: AbortSignal,
    analysisInput?: Record<string, unknown>,
  ) => {
    const response = await options.invokeOptimizer(text, signal, analysisInput);
    optimizerCalls.push({
      responseModel: response.responseModel,
      usage: response.usage,
      elapsedMs: response.elapsedMs,
    });
    return response;
  };
  let targetElapsedMs = 0;
  const trackedTarget: PromptOptimizationAutoOptions["invokeTarget"] = async (
    text,
    signal,
    metadata,
  ) => {
    const response = await options.invokeTarget(text, signal, metadata);
    targetElapsedMs += response.elapsedMs;
    return response;
  };
  const requestedCases: OptimizationTestInput[] = options.request.testCases.map(
    (testCase) => ({
      id: testCase.id,
      input: testCase.input,
      source: "user",
      ...(testCase.verification ? { verification: testCase.verification } : {}),
    }),
  );
  const frozenSnapshot = options.frozenExecutionSnapshot;
  const sourceIds = frozenSnapshot?.sourceIds ?? [...options.sourceIds];
  const graphSnapshotId = frozenSnapshot
    ? frozenSnapshot.graphSnapshotId
    : (options.graphSnapshotId ?? null);
  const retrievalStrategy =
    frozenSnapshot?.retrievalStrategy ?? options.retrievalStrategy ?? "lexical";
  const history = frozenSnapshot?.history ?? [...options.history];
  let targetSelection =
    frozenSnapshot?.targetSelection ?? options.targetSelection ?? null;

  let latestSummary = "Senopati menganalisis prompt dan hasil pengujian.";
  let preflight: z.infer<typeof ClarificationPreflightSchema>;
  if (frozenSnapshot?.preflightComplete) {
    preflight = {
      summary: frozenSnapshot.preflightSummary,
      clarificationRequired: false,
      clarification: null,
      testCases: frozenSnapshot.testCases.map(({ input }) => ({ input })),
      targetRecommendation: null,
    };
  } else {
    await options.onPhase?.(
      "clarification_check",
      "Memeriksa konteks dan kecocokan target sebelum contoh diuji.",
      { provider: "campus_gateway", model: options.optimizerModel },
    );
    const preflightResponse = await trackedOptimizer(
      buildClarificationPreflightRequest({
        originalPrompt: options.originalPrompt,
        invariants: options.invariants,
        objective: options.request.objective,
        testCases: requestedCases,
        history,
        clarificationContext: options.clarificationContext ?? [],
        targetSelection: options.targetSelectionRequest ??
          options.request.targetSelection ?? {
            model: "selected",
            reasoningEffort: "selected",
          },
        targetRequestedModel: options.targetRequestedModel ?? "",
        targetRequestedReasoningEffort:
          options.targetRequestedReasoningEffort ?? null,
        targetCapabilities: options.targetCapabilities ?? [],
        frozenTargetSelection: frozenSnapshot?.targetSelection ?? null,
      }),
      options.signal,
    );
    const preflightSchema = requestedCases.length
      ? ClarificationPreflightSchema
      : ClarificationPreflightSchema.superRefine((decision, context) => {
          if (
            !decision.clarificationRequired &&
            decision.testCases.length === 0
          ) {
            context.addIssue({
              code: "custom",
              message: "Generate representative test inputs before evaluation.",
              path: ["testCases"],
            });
          }
        });
    preflight = parseModelJson(preflightResponse.text, preflightSchema);
  }
  latestSummary = preflight.summary;
  if (!frozenSnapshot?.targetSelection && options.resolveTargetSelection) {
    targetSelection = await options.resolveTargetSelection(
      preflight.targetRecommendation,
    );
  }
  if (targetSelection) {
    await options.onPhase?.(
      "target_selection_resolved",
      targetSelection.selectionReason ??
        "Model dan effort target ditentukan sebelum pengujian.",
      { targetSelection },
    );
  }
  if (preflight.clarificationRequired) {
    const clarification = preflight.clarification!;
    await options.persistExecutionSnapshot?.({
      preflightComplete: false,
      preflightSummary: preflight.summary,
      targetSelection,
      testCases: frozenSnapshot?.testCases ?? requestedCases,
      sourceIds,
      retrievalStrategy,
      graphSnapshotId,
      history,
    });
    await options.onPhase?.(
      "clarification_required",
      "Menunggu jawaban untuk melanjutkan optimasi.",
      { reasonCode: clarification.reasonCode },
    );
    return createClarificationRequiredResult({
      startedAt,
      originalPrompt: options.originalPrompt,
      optimizerModel: options.optimizerModel,
      targetSelection,
      optimizerCalls,
      summary: preflight.summary,
      clarification,
    });
  }

  let testCases = frozenSnapshot?.preflightComplete
    ? frozenSnapshot.testCases.map((testCase) => ({ ...testCase }))
    : frozenSnapshot?.testCases.length
      ? frozenSnapshot.testCases.map((testCase) => ({ ...testCase }))
      : requestedCases;
  if (testCases.length === 0) {
    testCases = preflight.testCases.map((testCase) => ({
      id: randomUUID(),
      input: testCase.input,
      source: "generated" as const,
    }));
    await options.onPhase?.("cases_ready", preflight.summary, {
      source: "generated",
      count: testCases.length,
    });
  }

  const evaluationEvidence = await freezeEvaluationEvidence({
    testCases,
    sourceIds,
    retrievalStrategy,
    graphSnapshotId,
    frozenSnapshot,
    resolve: options.resolveEvaluationEvidence,
    signal: options.signal,
  });

  const effectiveExecutionSnapshot: OptimizationFrozenExecutionSnapshot = {
    preflightComplete: true,
    preflightSummary: preflight.summary,
    targetSelection,
    testCases: testCases.map((testCase) => ({ ...testCase })),
    sourceIds,
    retrievalStrategy,
    graphSnapshotId,
    history,
    caseEvidence: evaluationEvidence,
  };
  await options.persistExecutionSnapshot?.(effectiveExecutionSnapshot);

  const internalCaseIds = testCases.map(() => randomUUID());
  const candidateIds = Array.from(
    { length: options.request.maxIterations },
    () => randomUUID(),
  );
  const candidateById = new Map<string, CandidateState>();
  const invariantKey = canonicalInvariantKey(options.invariants);
  const validationByText = new Map<string, CandidateValidation>();
  let latestCandidateId: string | null = null;
  const allowedChunkIds = new Set<string>();
  const allowedGraphEntityIds = new Set<string>();
  const allowedGraphAssertionIds = new Set<string>();
  const baselineCaseResults = await evaluateCases(
    options.originalPrompt,
    testCases,
    evaluationEvidence,
    trackedTarget,
    options.signal,
    "baseline",
  );
  const baselineMetrics = aggregateCaseRuns(baselineCaseResults);
  await options.onEvaluation?.(
    "baseline",
    "baseline",
    baselineCaseResults,
    baselineMetrics,
    "not_configured",
  );

  const handlers: ToolHandlers = {
    analyze_history: async ({ messageIds, window }) => {
      const requested = new Set(messageIds);
      const matches = history
        .filter((item) => requested.has(item.id))
        .slice(-window);
      return {
        messageCount: matches.length,
        findingsCount: matches.length,
        messages: matches.map((item) => ({
          id: item.id,
          summary: item.summary,
        })),
      };
    },
    search_knowledge: async ({ query, sourceIds: requestedSourceIds }) => {
      if (!options.searchKnowledge) {
        return { resultCount: 0, context: "", reason: "knowledge_unavailable" };
      }
      const allowedSources = requestedSourceIds?.length
        ? requestedSourceIds.filter((id) => sourceIds.includes(id))
        : [...sourceIds];
      if (allowedSources.length === 0) {
        return { resultCount: 0, context: "", reason: "no_sources_selected" };
      }
      const result = await options.searchKnowledge({
        query,
        sourceIds: allowedSources,
        snapshotId: graphSnapshotId,
        signal: options.signal,
      });
      for (const chunkId of result.chunkIds) allowedChunkIds.add(chunkId);
      return {
        resultCount: result.resultCount,
        context: result.context,
        sourceIds: allowedSources,
      };
    },
    get_source: async ({ chunkId }) => {
      if (!options.readSource || !allowedChunkIds.has(chunkId)) {
        return { available: false, reason: "source_not_read_in_this_run" };
      }
      return options.readSource(chunkId, options.signal);
    },
    search_graph_entities: async (args, context) => {
      const handler = options.graphToolHandlers?.search_graph_entities;
      if (!handler) {
        return {
          available: false,
          resultCount: 0,
          entityIds: [],
          assertionIds: [],
        };
      }
      const result = await handler(args, context);
      collectGraphIds(result, "entityIds", allowedGraphEntityIds);
      collectGraphIds(result, "assertionIds", allowedGraphAssertionIds);
      return result;
    },
    traverse_graph: async (args, context) => {
      const handler = options.graphToolHandlers?.traverse_graph;
      if (!handler) {
        return {
          available: false,
          nodeCount: 0,
          edgeCount: 0,
          pathCount: 0,
          clipped: false,
        };
      }
      const result = await handler(args, context);
      collectGraphIds(result, "entityIds", allowedGraphEntityIds);
      collectGraphIds(result, "assertionIds", allowedGraphAssertionIds);
      return result;
    },
    get_graph_evidence: async (args, context) => {
      const handler = options.graphToolHandlers?.get_graph_evidence;
      return handler
        ? handler(args, context)
        : { available: false, resultCount: 0, evidence: [] };
    },
    get_graph_status: async (args, context) => {
      const handler = options.graphToolHandlers?.get_graph_status;
      return handler
        ? handler(args, context)
        : { available: false, reason: "graph_unavailable" };
    },
    estimate_tokens: async ({ text }) => ({
      estimatedTokens: Math.ceil(text.length / 4),
      method: "character_count_divided_by_four",
    }),
    inspect_capabilities: async ({ provider }) => ({
      provider,
      status:
        provider === "codex_app_server" || provider === "campus_gateway"
          ? "verified_for_current_run"
          : "not_available_for_optimization",
      capabilities: ["bounded_prompt_edits", "reported_usage", "elapsed_time"],
    }),
    validate_candidate: async ({ candidateText, invariants }) => {
      const invariantArgumentsMatch =
        canonicalInvariantKey(invariants) === invariantKey;
      const status = invariantArgumentsMatch
        ? validateCandidate(candidateText, options.invariants, invariants)
        : "violated";
      const missingInvariants = options.invariants.filter(
        (item) => !normalize(candidateText).includes(normalize(item)),
      );
      validationByText.set(candidateText, {
        text: candidateText,
        invariantKey,
        status,
      });
      for (const candidate of candidateById.values()) {
        if (candidate.candidate.text !== candidateText) continue;
        candidate.validatedText = candidateText;
        candidate.validatedInvariantKey = invariantKey;
        candidate.invariantStatus = status;
        if (
          candidate.testedText !== candidateText ||
          candidate.testedInvariantKey !== invariantKey
        ) {
          clearCandidateEvaluation(candidate);
        }
      }
      return {
        valid: status !== "violated",
        invariantStatus: status,
        preservedCount: options.invariants.filter((item) =>
          normalize(candidateText).includes(normalize(item)),
        ).length,
        totalCount: options.invariants.length,
        invariantArgumentsMatch,
        missingInvariants,
      };
    },
    evaluate_subset: async ({ candidateId, developmentCaseIds }) => {
      const candidate = candidateById.get(candidateId);
      if (!candidate) {
        return {
          status: "incomplete",
          reason: "Candidate must be proposed first.",
        };
      }
      if (candidate.candidate.text === options.originalPrompt) {
        return {
          status: "no_change_recommended",
          reason:
            "Candidate text is exactly the saved prompt; no improvement was proposed.",
        };
      }
      if (
        developmentCaseIds.length !== internalCaseIds.length ||
        internalCaseIds.some((id) => !developmentCaseIds.includes(id))
      ) {
        return {
          status: "incomplete",
          reason: "Run every test input for a fair comparison.",
        };
      }
      if (!hasCurrentCandidateValidation(candidate, invariantKey)) {
        return {
          status: "incomplete",
          reason:
            "Validate the exact current candidate text before testing it.",
        };
      }
      if (candidate.invariantStatus === "violated") {
        return {
          status: "blocked",
          reason: "A required instruction changed or disappeared.",
        };
      }
      if (hasCompleteCandidateEvaluation(candidate, testCases, invariantKey)) {
        return summarizeRuns(candidate.caseResults!, candidate.metrics!);
      }
      clearCandidateEvaluation(candidate);
      const testedText = candidate.candidate.text;
      const caseResults = await evaluateCases(
        testedText,
        testCases,
        evaluationEvidence,
        trackedTarget,
        options.signal,
        "candidate",
      );
      const metrics = aggregateCaseRuns(caseResults);
      if (
        candidate.candidate.text !== testedText ||
        !hasCurrentCandidateValidation(candidate, invariantKey) ||
        isCandidateValidationRejected(candidate)
      ) {
        clearCandidateEvaluation(candidate);
        return {
          status: "incomplete",
          reason:
            "The candidate changed during testing; validate and test its current text again.",
        };
      }
      candidate.testedText = testedText;
      candidate.testedInvariantKey = invariantKey;
      candidate.caseResults = caseResults;
      candidate.metrics = metrics;
      candidate.evaluationManifest = buildCandidateEvaluationManifest({
        candidateId: candidate.id,
        revision: candidate.revision,
        baselinePrompt: options.originalPrompt,
        candidatePrompt: testedText,
        invariants: options.invariants,
        testCases,
        baselineCaseResults,
        candidateCaseResults: caseResults,
        evidencePacks: evaluationEvidence,
        evaluationContext: options.evaluationContext,
        targetSelection,
        optimizerModel: options.optimizerModel,
        optimizerRequest: options.request,
        executionSnapshot: effectiveExecutionSnapshot,
      });
      await options.onEvaluation?.(
        "candidate",
        candidate.id,
        caseResults,
        metrics,
        candidate.invariantStatus,
        candidate.evaluationManifest,
      );
      return summarizeRuns(caseResults, metrics);
    },
  };

  const scope: AgentScope = {
    projectId: options.projectId,
    allowedSourceIds: new Set(sourceIds),
    allowedChunkIds,
    allowedHistoryMessageIds: new Set(history.map((item) => item.id)),
    developmentCaseIds: new Set(internalCaseIds),
    candidateIds: new Set(candidateIds),
    graphEntityIds: allowedGraphEntityIds,
    graphAssertionIds: allowedGraphAssertionIds,
  };

  let clarificationRequired = false;
  let requestedClarification: OptimizationClarificationQuestion | null = null;
  const budget = AgentBudgetSchema.parse({
    maxDecisionTurns: 4,
    maxToolCalls: options.request.maxToolCalls,
    maxCandidates: options.request.maxIterations,
    maxRevisions: options.request.maxIterations - 1,
    maxDurationMs: 180_000,
  });
  const agentResult = await runBoundedAgent({
    scope,
    handlers,
    budget,
    signal: options.signal,
    onEvent: async (event) => {
      if (event.type === "agent.action" && event.clarificationRequired) {
        clarificationRequired = true;
        requestedClarification = event.clarification ?? null;
      }
      if (event.type === "agent.action") latestSummary = event.summary;
      if (event.type === "candidate.proposed") {
        const index = candidateById.size;
        const candidate: AgentCandidate = event.candidate ?? {
          text: "",
          changeSummary: "Kandidat tidak tersedia.",
          riskSummary: "Kandidat belum lengkap.",
          strategy: "Belum ditentukan.",
        };
        const id = candidateIds[index]!;
        const previous = candidateById.get(id);
        const sameTestBinding =
          previous?.candidate.text === candidate.text &&
          previous.testedText === candidate.text &&
          previous.testedInvariantKey === invariantKey;
        const validation = validationByText.get(candidate.text);
        const currentValidation =
          validation?.text === candidate.text &&
          validation.invariantKey === invariantKey
            ? validation
            : null;
        candidateById.set(id, {
          id,
          revision: index + 1,
          candidate,
          invariantStatus: currentValidation?.status ?? "violated",
          validatedText: currentValidation ? candidate.text : null,
          validatedInvariantKey: currentValidation?.invariantKey ?? null,
          testedText: sameTestBinding ? candidate.text : null,
          testedInvariantKey: sameTestBinding ? invariantKey : null,
          caseResults: sameTestBinding ? previous!.caseResults : null,
          metrics: sameTestBinding ? previous!.metrics : null,
          draftVersionId: null,
          evaluationManifest: sameTestBinding
            ? previous!.evaluationManifest
            : null,
        });
        latestCandidateId = id;
      }
      await options.onAgentEvent?.(event);
    },
    planner: async (context) => {
      // Validation evidence is attached only to a candidate proposed in the
      // same planner turn; a previous revision cannot validate a later one.
      validationByText.clear();
      const existingLatestCandidate = latestCandidateId
        ? candidateById.get(latestCandidateId)
        : undefined;
      const candidateSlotAvailable = candidateById.size < candidateIds.length;
      if (
        existingLatestCandidate?.invariantStatus === "violated" &&
        !candidateSlotAvailable
      ) {
        return {
          summary:
            "Batas percobaan tercapai; kandidat belum mempertahankan aturan penting.",
          toolCalls: [],
          candidate: null,
          finish: true,
          clarificationRequired: false,
          clarification: null,
        };
      }
      if (
        existingLatestCandidate &&
        existingLatestCandidate.candidate.text !== options.originalPrompt &&
        hasCurrentCandidateValidation(existingLatestCandidate, invariantKey) &&
        !isCandidateValidationRejected(existingLatestCandidate) &&
        !hasCompleteCandidateEvaluation(
          existingLatestCandidate,
          testCases,
          invariantKey,
        )
      ) {
        return {
          summary:
            "Kandidat terbaru diuji pada semua contoh sebelum revisi berikutnya.",
          toolCalls: [
            {
              name: "evaluate_subset",
              arguments: {
                candidateId: existingLatestCandidate.id,
                developmentCaseIds: internalCaseIds,
              },
            },
          ],
          candidate: null,
          finish: false,
          clarificationRequired: false,
          clarification: null,
        };
      }
      const nextCandidateId = candidateIds[candidateById.size] ?? null;
      const request = buildDecisionRequest({
        originalPrompt: options.originalPrompt,
        invariants: options.invariants,
        objective: options.request.objective,
        testCases,
        baselineCaseResults,
        baselineMetrics,
        evaluationEvidence,
        candidates: [...candidateById.values()],
        historyIds: options.history.map((item) => item.id),
        historySummaries: options.history,
        clarificationContext: options.clarificationContext ?? [],
        sourceIds,
        priorToolResults: context.priorToolResults,
        turn: context.turn,
        nextCandidateId,
        candidateIds,
        internalCaseIds,
      });
      const analysisInput = {
        requestCharacters: request.length,
        requestFingerprint: sha256Text(request),
        promptCharacters: options.originalPrompt.length,
        objectiveCharacters: options.request.objective.length,
        invariantCount: options.invariants.length,
        testCaseCount: testCases.length,
        baselineResultCount: baselineCaseResults.length,
        evaluationEvidenceCount: evaluationEvidence.length,
        selectedSourceCount: sourceIds.length,
        historySummaryCount: options.history.length,
        clarificationCount: options.clarificationContext?.length ?? 0,
        priorToolResults: context.priorToolSummaries,
      };
      const response = await trackedOptimizer(
        request,
        context.signal,
        analysisInput,
      );
      const envelope = parseModelJson(response.text, DecisionSchema);
      for (const call of envelope.toolCalls) {
        if (
          typeof call !== "object" ||
          call === null ||
          !("name" in call) ||
          typeof call.name !== "string" ||
          !allowedToolNames.has(call.name as AgentToolCall["name"])
        ) {
          throw new Error("AGENT_TOOL_NOT_ALLOWED");
        }
      }
      clarificationRequired ||= envelope.clarificationRequired;
      requestedClarification = envelope.clarification;
      const latestCandidate = latestCandidateId
        ? candidateById.get(latestCandidateId)
        : undefined;
      const candidateIsNoOp =
        envelope.candidate?.text === options.originalPrompt;
      const candidateNeedsWork =
        (envelope.candidate !== null && !candidateIsNoOp) ||
        (latestCandidate !== undefined &&
          latestCandidate.candidate.text !== options.originalPrompt &&
          !isCandidateReady(
            latestCandidate,
            testCases,
            invariantKey,
            options.originalPrompt,
            options.invariants,
            baselineCaseResults,
          ));
      const canContinue = context.turn < context.budget.maxDecisionTurns;
      return {
        ...envelope,
        finish:
          candidateIsNoOp ||
          (envelope.finish && !(candidateNeedsWork && canContinue)),
      };
    },
  });

  const latestCandidate = latestCandidateId
    ? (candidateById.get(latestCandidateId) ?? null)
    : null;
  const reviewableCandidate =
    agentResult.status === "clarification_required"
      ? null
      : ([...candidateById.values()]
          .filter(
            (candidate) =>
              candidate.candidate.text !== options.originalPrompt &&
              isCandidateReady(
                candidate,
                testCases,
                invariantKey,
                options.originalPrompt,
                options.invariants,
                baselineCaseResults,
              ),
          )
          .at(-1) ?? null);
  const incompleteCandidateSummary =
    agentResult.status !== "clarification_required" &&
    latestCandidate &&
    latestCandidate !== reviewableCandidate
      ? latestCandidate.candidate.text === options.originalPrompt
        ? "Kandidat terbaru sama persis dengan prompt awal dan tidak disimpan sebagai draft; kandidat siap sebelumnya tetap tersedia untuk ditinjau."
        : hasDeterministicVerificationProblem(latestCandidate) ||
            (hasCurrentCandidateValidation(latestCandidate, invariantKey) &&
              latestCandidate.invariantStatus === "violated")
          ? "Kandidat terbaru ditolak oleh validasi atau pemeriksaan deterministik. Kandidat siap sebelumnya tetap tersedia untuk ditinjau."
          : "Kandidat terbaru belum lolos validasi dan pengujian pada semua contoh. Kandidat siap sebelumnya tetap tersedia untuk ditinjau."
      : null;
  if (
    agentResult.status !== "clarification_required" &&
    reviewableCandidate &&
    options.persistDraft
  ) {
    reviewableCandidate.draftVersionId = await options.persistDraft(
      reviewableCandidate.candidate,
    );
    await options.onPhase?.(
      "draft_saved",
      "Prompt baru disimpan sebagai draft. Prompt aktif belum berubah.",
      { draftVersionId: reviewableCandidate.draftVersionId },
    );
  }
  const totalElapsedMs = performance.now() - startedAt;
  const optimizerUsage = aggregateInvocationUsage(optimizerCalls);
  const candidates = deepFreeze(
    [...candidateById.values()].map((candidate) =>
      buildCandidateResult(
        candidate,
        options.originalPrompt,
        testCases,
        invariantKey,
        options.invariants,
        baselineCaseResults,
      ),
    ),
  );
  const latestCandidateResult = latestCandidateId
    ? (candidates.find((candidate) => candidate.id === latestCandidateId) ??
      null)
    : null;
  const reviewableCandidateResult = reviewableCandidate
    ? (candidates.find(
        (candidate) => candidate.id === reviewableCandidate.id,
      ) ?? null)
    : null;
  const legacyCandidateSource =
    agentResult.status === "clarification_required"
      ? null
      : (reviewableCandidateResult ?? latestCandidateResult);
  const candidateResult = legacyCandidateSource
    ? cloneCandidateResult(legacyCandidateSource)
    : null;
  const latestRevisionOutcome = latestCandidateResult?.outcome ?? null;
  const status: PromptOptimizationOutcome =
    agentResult.status === "clarification_required"
      ? "clarification_required"
      : reviewableCandidate
        ? "candidate_ready"
        : agentResult.status === "budget_exhausted"
          ? "incomplete"
          : latestRevisionOutcome === "no_change_recommended" ||
              (!latestCandidate && agentResult.status === "finished")
            ? "no_change_recommended"
            : latestRevisionOutcome === "candidate_rejected"
              ? "candidate_rejected"
              : "incomplete";
  const baselineUsage = usageFromMetrics(baselineMetrics);
  const optimizationOverheadMs = Math.max(
    0,
    Math.round(totalElapsedMs - targetElapsedMs),
  );
  const optimizerElapsedMs = optimizerCalls.reduce(
    (sum, call) => sum + call.elapsedMs,
    0,
  );
  return {
    status,
    baseline: {
      prompt: options.originalPrompt,
      caseResults: baselineCaseResults,
      metrics: baselineMetrics,
      answers: baselineCaseResults.map(toPublicAnswer),
      aggregateUsage: baselineUsage,
      totalTargetLatencyMs: baselineMetrics.latencyMs,
    },
    candidates,
    latestCandidateId,
    reviewableCandidateId: reviewableCandidate?.id ?? null,
    candidate: candidateResult,
    comparison: reviewableCandidate
      ? compareMetrics(baselineMetrics, reviewableCandidate.metrics!)
      : null,
    optimizer: {
      provider: "campus_gateway",
      model:
        optimizerCalls.find((call) => call.responseModel)?.responseModel ??
        options.optimizerModel,
      requestedModel: options.optimizerModel,
      responseModels: optimizerCalls.map((call) => call.responseModel),
      calls: optimizerCalls.length,
      usage: optimizerUsage,
      inputTokens: optimizerUsage.inputTokens,
      outputTokens: optimizerUsage.outputTokens,
      totalTokens: optimizerUsage.totalTokens,
      elapsedMs: optimizerElapsedMs,
      overheadMs: optimizationOverheadMs,
      providerElapsedMs: optimizerElapsedMs,
    },
    optimizationOverheadMs,
    targetSelection,
    decisionSummary:
      status === "no_change_recommended"
        ? "Tidak ada perubahan yang disarankan; prompt awal tetap dipertahankan."
        : (incompleteCandidateSummary ?? latestSummary),
    clarificationRequired,
    clarification: requestedClarification,
    toolCallCount: agentResult.toolCallCount,
    decisionTurnCount: agentResult.decisionTurnCount,
  };
}

async function evaluateCases(
  prompt: string,
  cases: readonly OptimizationTestInput[],
  evidencePacks: readonly EvaluationEvidencePack[],
  invokeTarget: PromptOptimizationAutoOptions["invokeTarget"],
  signal: AbortSignal,
  subject: "baseline" | "candidate",
): Promise<OptimizationCaseRun[]> {
  const results: OptimizationCaseRun[] = [];
  const evidenceByCaseId = new Map(
    evidencePacks.map((pack) => [pack.caseId, pack]),
  );
  for (const testCase of cases) {
    if (signal.aborted)
      throw signal.reason ?? new Error("Optimization canceled");
    const evidencePack = evidenceByCaseId.get(testCase.id);
    if (!evidencePack) throw new Error("EVALUATION_EVIDENCE_CASE_MISSING");
    const request = buildTargetEvaluationRequest({
      prompt,
      caseInput: testCase.input,
      evidencePack,
    });
    const requestHash = sha256Text(request);
    const result = await invokeTarget(request, signal, {
      subject,
      caseId: testCase.id,
      source: testCase.source,
      evidencePack,
      requestHash,
      contextHash: evidencePack.contextHash,
    });
    results.push({
      ...testCase,
      answer: result.text,
      responseId: result.responseId,
      responseModel: result.responseModel,
      requestHash,
      contextHash: evidencePack.contextHash,
      usage: result.usage,
      latencyMs: Math.round(result.elapsedMs),
      verificationEvidence: await verifyOptimizationCase(
        result.text,
        testCase.verification,
      ),
    });
  }
  return results;
}

async function freezeEvaluationEvidence(input: {
  testCases: readonly OptimizationTestInput[];
  sourceIds: readonly string[];
  retrievalStrategy: "lexical" | "graph" | "full_context" | "hybrid";
  graphSnapshotId: string | null;
  frozenSnapshot: OptimizationFrozenExecutionSnapshot | undefined;
  resolve: PromptOptimizationAutoOptions["resolveEvaluationEvidence"];
  signal: AbortSignal;
}): Promise<EvaluationEvidencePack[]> {
  const expectedStrategy = input.sourceIds.length
    ? input.retrievalStrategy
    : "none";
  let packs = input.frozenSnapshot?.caseEvidence;
  if (!packs?.length && input.resolve) {
    packs = [
      ...(await input.resolve(
        input.testCases,
        {
          sourceIds: input.sourceIds,
          retrievalStrategy: input.retrievalStrategy,
          graphSnapshotId: input.graphSnapshotId,
        },
        input.signal,
      )),
    ];
  }
  if (!packs?.length && input.sourceIds.length === 0) {
    packs = input.testCases.map((testCase) => ({
      caseId: testCase.id,
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
    }));
  }
  if (!packs?.length) {
    throw new Error("EVALUATION_EVIDENCE_RESOLVER_REQUIRED");
  }

  const parsed = packs.map((pack) => EvaluationEvidencePackSchema.parse(pack));
  const sortedSourceIds = [...input.sourceIds].sort();
  if (
    parsed.length !== input.testCases.length ||
    parsed.some(
      (pack, index) =>
        pack.caseId !== input.testCases[index]?.id ||
        pack.requestedStrategy !== expectedStrategy ||
        canonicalInvariantKey(pack.selectedSourceIds) !==
          canonicalInvariantKey(sortedSourceIds) ||
        pack.selectedSnapshotId !== input.graphSnapshotId,
    )
  ) {
    throw new Error("EVALUATION_EVIDENCE_SNAPSHOT_MISMATCH");
  }
  const sourceManifestKey = JSON.stringify(parsed[0]?.sourceManifest ?? []);
  if (
    parsed.some(
      (pack) => JSON.stringify(pack.sourceManifest) !== sourceManifestKey,
    )
  ) {
    throw new Error("EVALUATION_SOURCE_SNAPSHOT_CHANGED_DURING_RESOLUTION");
  }
  return deepFreeze(structuredClone(parsed));
}

function buildCandidateEvaluationManifest(input: {
  candidateId: string;
  revision: number;
  baselinePrompt: string;
  candidatePrompt: string;
  invariants: readonly string[];
  testCases: readonly OptimizationTestInput[];
  baselineCaseResults: readonly OptimizationCaseRun[];
  candidateCaseResults: readonly OptimizationCaseRun[];
  evidencePacks: readonly EvaluationEvidencePack[];
  evaluationContext: PromptOptimizationEvaluationContext | undefined;
  targetSelection: OptimizationTargetSelectionEvidence | null;
  optimizerModel: string;
  optimizerRequest: PromptOptimizationRequest;
  executionSnapshot: OptimizationFrozenExecutionSnapshot;
}): EvaluationEvidenceManifest | null {
  const context = input.evaluationContext;
  if (!context) return null;
  const baselineResponses = toManifestResponses(
    input.baselineCaseResults,
    context,
  );
  const candidateResponses = toManifestResponses(
    input.candidateCaseResults,
    context,
  );
  if (
    !baselineResponses ||
    !candidateResponses ||
    input.evidencePacks.length !== input.testCases.length
  ) {
    return null;
  }

  const optimizerConfiguration = {
    ...context.optimizerConfig,
    model: input.optimizerModel,
    request: input.optimizerRequest,
  };
  const targetResolvedModel =
    input.targetSelection?.resolvedModel ??
    (typeof context.targetConfig.resolvedModel === "string"
      ? context.targetConfig.resolvedModel
      : context.targetRequestedModel);
  const targetRequestedEffort =
    context.targetRequestedEffort ??
    input.targetSelection?.requestedReasoningEffort ??
    null;
  const targetResolvedEffort =
    input.targetSelection?.resolvedReasoningEffort ?? null;
  const targetSentEffort = input.targetSelection?.sentReasoningEffort ?? null;
  const targetConfiguration = {
    ...context.targetConfig,
    requestedModel: context.targetRequestedModel,
    resolvedModel: targetResolvedModel,
    requestedEffort: targetRequestedEffort,
    resolvedEffort: targetResolvedEffort,
    sentEffort: targetSentEffort,
    targetSelection: input.targetSelection,
  };
  const sourceManifest = uniqueEvidenceSources(input.evidencePacks);
  const retrievalConfiguration = {
    ...context.retrievalConfig,
    requestedStrategy: input.evidencePacks[0]?.requestedStrategy ?? "none",
    sourceIds: [...(input.evidencePacks[0]?.selectedSourceIds ?? [])],
    selectedSnapshotId: input.evidencePacks[0]?.selectedSnapshotId ?? null,
    sourceManifest,
    evidencePacks: input.evidencePacks,
  };
  const frozenConfiguration = {
    run: context.runConfig,
    optimizer: optimizerConfiguration,
    target: targetConfiguration,
    retrieval: retrievalConfiguration,
    executionSnapshot: input.executionSnapshot,
    candidate: {
      candidateRevisionId: input.candidateId,
      revision: input.revision,
      baselinePromptHash: sha256Text(input.baselinePrompt),
      candidatePromptHash: sha256Text(input.candidatePrompt),
    },
    invariants: [...input.invariants],
  };
  const strategyUsedValues = new Set(
    input.evidencePacks.map((pack) => pack.strategyUsed),
  );
  const usedSnapshotIds = [
    ...new Set(
      input.evidencePacks.flatMap((pack) =>
        pack.usedSnapshotId ? [pack.usedSnapshotId] : [],
      ),
    ),
  ].sort();
  const policy = {
    version: context.policyVersion,
    hash: sha256Json({
      version: context.policyVersion,
      caseSplit: "development_only",
    }),
    caseSplit: "development_only" as const,
  };
  try {
    return createEvaluationEvidenceManifest({
      runId: context.runId,
      attemptId: context.attemptId,
      candidateRevisionId: input.candidateId,
      revision: input.revision,
      baselinePromptHash: sha256Text(input.baselinePrompt),
      candidatePromptHash: sha256Text(input.candidatePrompt),
      invariantsHash: sha256Json([...input.invariants]),
      caseManifest: input.testCases.map((testCase) => ({
        caseId: testCase.id,
        input: testCase.input,
        inputHash: sha256Text(testCase.input),
        inputCharacters: testCase.input.length,
        source: testCase.source,
        split: "development",
        verificationHash: testCase.verification
          ? sha256Json(testCase.verification)
          : null,
      })),
      sourceManifest,
      graph: {
        requestedStrategy: input.evidencePacks[0]?.requestedStrategy ?? "none",
        selectedSnapshotId: input.evidencePacks[0]?.selectedSnapshotId ?? null,
        usedSnapshotIds,
        strategyUsed:
          strategyUsedValues.size === 1
            ? input.evidencePacks[0]!.strategyUsed
            : "mixed",
        fallbackReasons: [
          ...new Set(
            input.evidencePacks.flatMap((pack) =>
              pack.fallbackReason ? [pack.fallbackReason] : [],
            ),
          ),
        ].sort(),
      },
      workspaceSnapshot: context.workspaceSnapshot,
      target: {
        provider: context.targetProvider,
        requestedModel: context.targetRequestedModel,
        resolvedModel: targetResolvedModel,
        requestedEffort: targetRequestedEffort,
        resolvedEffort: targetResolvedEffort,
        sentEffort: targetSentEffort,
        providerVersion: context.targetProviderVersion,
        selection: input.targetSelection
          ? { ...structuredClone(input.targetSelection) }
          : {},
      },
      policy,
      configuration: {
        runConfigHash: sha256Json(context.runConfig),
        optimizerConfigHash: sha256Json(optimizerConfiguration),
        targetConfigHash: sha256Json(targetConfiguration),
        retrievalConfigHash: sha256Json(retrievalConfiguration),
        frozen: frozenConfiguration,
      },
      evidencePacks: [...input.evidencePacks],
      responses: {
        baseline: baselineResponses,
        candidate: candidateResponses,
      },
    });
  } catch {
    return null;
  }
}

function toManifestResponses(
  caseResults: readonly OptimizationCaseRun[],
  context: PromptOptimizationEvaluationContext,
) {
  if (
    caseResults.some(
      (result) =>
        !result.responseId ||
        !result.responseModel ||
        typeof result.answer !== "string" ||
        !result.requestHash ||
        !result.contextHash,
    )
  ) {
    return null;
  }
  return caseResults.map((result) => ({
    caseId: result.id,
    responseId: result.responseId!,
    responseModel: result.responseModel!,
    provider: context.targetProvider,
    attemptId: context.attemptId,
    requestHash: result.requestHash!,
    contextHash: result.contextHash!,
    answerHash: sha256Text(result.answer as string),
  }));
}

function uniqueEvidenceSources(
  packs: readonly EvaluationEvidencePack[],
): EvaluationEvidenceManifest["sourceManifest"] {
  const byVersion = new Map(
    packs.flatMap((pack) =>
      pack.sourceManifest.map((source) => [source.documentVersionId, source]),
    ),
  );
  return [...byVersion.values()].sort((left, right) =>
    left.documentVersionId.localeCompare(right.documentVersionId),
  );
}

function createClarificationRequiredResult(input: {
  startedAt: number;
  originalPrompt: string;
  optimizerModel: string;
  targetSelection: OptimizationTargetSelectionEvidence | null;
  optimizerCalls: readonly Pick<
    OptimizationInvocation,
    "responseModel" | "usage" | "elapsedMs"
  >[];
  summary: string;
  clarification: OptimizationClarificationQuestion;
}): AutomaticPromptOptimizationResult {
  const elapsedMs = Math.max(
    0,
    Math.round(performance.now() - input.startedAt),
  );
  const optimizerUsage = aggregateInvocationUsage(input.optimizerCalls);
  const optimizerElapsedMs = input.optimizerCalls.reduce(
    (sum, call) => sum + call.elapsedMs,
    0,
  );
  const unavailable = (reason: string): UsageMetric => ({
    status: "unknown",
    value: null,
    reason,
  });
  const unavailableTokens = {
    inputTokens: unavailable("target_tests_not_started"),
    outputTokens: unavailable("target_tests_not_started"),
    totalTokens: unavailable("target_tests_not_started"),
  };
  return {
    status: "clarification_required",
    baseline: {
      prompt: input.originalPrompt,
      caseResults: [],
      metrics: { ...unavailableTokens, latencyMs: null },
      answers: [],
      aggregateUsage: unavailableTokens,
      totalTargetLatencyMs: null,
    },
    candidates: [],
    latestCandidateId: null,
    reviewableCandidateId: null,
    candidate: null,
    comparison: null,
    optimizer: {
      provider: "campus_gateway",
      model:
        input.optimizerCalls.find((call) => call.responseModel)
          ?.responseModel ?? input.optimizerModel,
      requestedModel: input.optimizerModel,
      responseModels: input.optimizerCalls.map((call) => call.responseModel),
      calls: input.optimizerCalls.length,
      usage: optimizerUsage,
      inputTokens: optimizerUsage.inputTokens,
      outputTokens: optimizerUsage.outputTokens,
      totalTokens: optimizerUsage.totalTokens,
      elapsedMs: optimizerElapsedMs,
      overheadMs: elapsedMs,
      providerElapsedMs: optimizerElapsedMs,
    },
    targetSelection: input.targetSelection,
    optimizationOverheadMs: elapsedMs,
    decisionSummary: input.summary,
    clarificationRequired: true,
    clarification: input.clarification,
    toolCallCount: 0,
    decisionTurnCount: 0,
  };
}

function aggregateCaseRuns(
  results: readonly OptimizationCaseRun[],
): OptimizationRunMetrics {
  const inputTokens = aggregateMetrics(
    results.map((result) => result.usage.inputTokens),
  );
  const outputTokens = aggregateMetrics(
    results.map((result) => result.usage.outputTokens),
  );
  const totalTokens = aggregateMetrics(
    results.map((result) => result.usage.totalTokens),
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs: results.every((result) => result.latencyMs !== null)
      ? results.reduce((sum, result) => sum + (result.latencyMs ?? 0), 0)
      : null,
  };
}

function aggregateInvocationUsage(
  calls: readonly Pick<OptimizationInvocation, "usage">[],
) {
  return {
    inputTokens: aggregateMetrics(calls.map((call) => call.usage.inputTokens)),
    outputTokens: aggregateMetrics(
      calls.map((call) => call.usage.outputTokens),
    ),
    totalTokens: aggregateMetrics(calls.map((call) => call.usage.totalTokens)),
  };
}

function aggregateMetrics(metrics: readonly UsageMetric[]): UsageMetric {
  if (
    metrics.length === 0 ||
    metrics.some((metric) => metric.status === "unknown")
  ) {
    return {
      status: "unknown",
      value: null,
      reason: "Provider tidak melaporkan penggunaan untuk semua panggilan.",
    };
  }
  const observedAt = new Date().toISOString();
  const value = metrics.reduce(
    (sum, metric) => sum + (metric.status === "unknown" ? 0 : metric.value),
    0,
  );
  return {
    status: metrics.every((metric) => metric.status === "reported")
      ? "reported"
      : "estimated",
    value,
    observedAt,
    method: metrics.every((metric) => metric.status === "reported")
      ? "sum_of_provider_reported_calls"
      : "sum_with_estimated_calls",
  };
}

function usageFromMetrics(
  metrics: OptimizationRunMetrics,
): Omit<OptimizationRunMetrics, "latencyMs"> {
  return {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    totalTokens: metrics.totalTokens,
  };
}

function toPublicAnswer(result: OptimizationCaseRun): PublicOptimizationAnswer {
  return {
    ...result,
    caseId: result.id,
    text: result.answer,
  };
}

function compareMetrics(
  baseline: OptimizationRunMetrics,
  candidate: OptimizationRunMetrics,
) {
  const baseTokens =
    baseline.totalTokens.status === "unknown"
      ? null
      : baseline.totalTokens.value;
  const candidateTokens =
    candidate.totalTokens.status === "unknown"
      ? null
      : candidate.totalTokens.value;
  const baseLatency = baseline.latencyMs;
  const candidateLatency = candidate.latencyMs;
  return {
    tokenChange:
      baseTokens === null || candidateTokens === null
        ? null
        : candidateTokens - baseTokens,
    tokenChangePercent:
      baseTokens === null || candidateTokens === null || baseTokens === 0
        ? null
        : ((candidateTokens - baseTokens) / baseTokens) * 100,
    latencyChangeMs:
      baseLatency === null || candidateLatency === null
        ? null
        : candidateLatency - baseLatency,
    latencyChangePercent:
      baseLatency === null || candidateLatency === null || baseLatency === 0
        ? null
        : ((candidateLatency - baseLatency) / baseLatency) * 100,
  };
}

function canonicalInvariantKey(invariants: readonly string[]): string {
  return JSON.stringify([...invariants].sort());
}

function hasCurrentCandidateValidation(
  candidate: CandidateState,
  invariantKey: string,
): boolean {
  return (
    candidate.validatedText === candidate.candidate.text &&
    candidate.validatedInvariantKey === invariantKey
  );
}

function buildCandidateResult(
  candidate: CandidateState,
  originalPrompt: string,
  testCases: readonly OptimizationTestInput[],
  invariantKey: string,
  invariants: readonly string[],
  baselineCaseResults: readonly OptimizationCaseRun[],
): AutomaticOptimizationCandidateRevision {
  const outcome = getCandidateRevisionOutcome(
    candidate,
    originalPrompt,
    testCases,
    invariantKey,
    invariants,
    baselineCaseResults,
  );
  const evidenceBoundToPrompt =
    candidate.testedText === candidate.candidate.text &&
    candidate.testedInvariantKey === invariantKey &&
    hasCompleteCandidateEvaluation(candidate, testCases, invariantKey) &&
    candidateManifestMatches(
      candidate,
      originalPrompt,
      invariants,
      testCases,
      baselineCaseResults,
    );
  const caseResults =
    hasCompleteCandidateEvaluation(candidate, testCases, invariantKey) &&
    candidate.caseResults
      ? structuredClone(candidate.caseResults)
      : [];
  const metrics =
    hasCompleteCandidateEvaluation(candidate, testCases, invariantKey) &&
    candidate.metrics
      ? structuredClone(candidate.metrics)
      : aggregateCaseRuns([]);

  return {
    id: candidate.id,
    revision: candidate.revision,
    prompt: candidate.candidate.text,
    changeSummary:
      outcome === "no_change_recommended"
        ? "Teks kandidat sama persis dengan prompt awal; tidak ada perubahan."
        : candidate.candidate.changeSummary,
    riskSummary:
      outcome === "no_change_recommended"
        ? "Tidak ada perubahan untuk dibandingkan."
        : candidate.candidate.riskSummary,
    strategy:
      outcome === "no_change_recommended"
        ? "Pertahankan prompt awal."
        : candidate.candidate.strategy,
    outcome,
    invariantStatus: candidate.invariantStatus,
    testingStatus:
      outcome === "candidate_ready"
        ? "ready"
        : outcome === "candidate_rejected"
          ? "rejected"
          : "incomplete",
    evidenceBoundToPrompt,
    evaluationManifest: candidate.evaluationManifest
      ? structuredClone(candidate.evaluationManifest)
      : null,
    caseResults,
    metrics,
    answers: caseResults.map(toPublicAnswer),
    aggregateUsage: usageFromMetrics(metrics),
    totalTargetLatencyMs: metrics.latencyMs,
    invariantsPreserved:
      candidate.invariantStatus === "preserved"
        ? true
        : candidate.invariantStatus === "violated"
          ? false
          : null,
    draftVersionId:
      outcome === "candidate_ready" ? candidate.draftVersionId : null,
  };
}

function getCandidateRevisionOutcome(
  candidate: CandidateState,
  originalPrompt: string,
  testCases: readonly OptimizationTestInput[],
  invariantKey: string,
  invariants: readonly string[],
  baselineCaseResults: readonly OptimizationCaseRun[],
): PromptOptimizationRevisionOutcome {
  if (candidate.candidate.text === originalPrompt) {
    return "no_change_recommended";
  }
  if (
    isCandidateReady(
      candidate,
      testCases,
      invariantKey,
      originalPrompt,
      invariants,
      baselineCaseResults,
    )
  ) {
    return "candidate_ready";
  }
  if (
    hasDeterministicVerificationProblem(candidate) ||
    (hasCurrentCandidateValidation(candidate, invariantKey) &&
      candidate.invariantStatus === "violated")
  ) {
    return "candidate_rejected";
  }
  return "incomplete";
}

function cloneCandidateResult(
  candidate:
    | Readonly<AutomaticOptimizationCandidateRevision>
    | ImmutableAutomaticOptimizationCandidateRevision,
): AutomaticOptimizationCandidateResult {
  const { outcome: _outcome, ...legacyCandidate } = structuredClone(candidate);
  return legacyCandidate as AutomaticOptimizationCandidateResult;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isCandidateValidationRejected(candidate: CandidateState): boolean {
  return candidate.invariantStatus === "violated";
}

function hasCompleteCandidateEvaluation(
  candidate: CandidateState,
  testCases: readonly OptimizationTestInput[],
  invariantKey: string,
): boolean {
  return (
    candidate.testedText === candidate.candidate.text &&
    candidate.testedInvariantKey === invariantKey &&
    candidate.caseResults !== null &&
    candidate.metrics !== null &&
    candidate.caseResults.length === testCases.length &&
    testCases.every(
      (testCase, index) => candidate.caseResults?.[index]?.id === testCase.id,
    )
  );
}

function isCandidateReady(
  candidate: CandidateState,
  testCases: readonly OptimizationTestInput[],
  invariantKey: string,
  originalPrompt: string,
  invariants: readonly string[],
  baselineCaseResults: readonly OptimizationCaseRun[],
): boolean {
  return (
    hasCurrentCandidateValidation(candidate, invariantKey) &&
    candidate.invariantStatus !== "violated" &&
    hasCompleteCandidateEvaluation(candidate, testCases, invariantKey) &&
    candidateManifestMatches(
      candidate,
      originalPrompt,
      invariants,
      testCases,
      baselineCaseResults,
    ) &&
    !hasDeterministicVerificationProblem(candidate)
  );
}

function candidateManifestMatches(
  candidate: CandidateState,
  baselinePrompt: string,
  invariants: readonly string[],
  testCases: readonly OptimizationTestInput[],
  baselineCaseResults: readonly OptimizationCaseRun[],
): boolean {
  const manifest = candidate.evaluationManifest;
  if (
    !manifest ||
    !isEvaluationEvidenceManifestIntact(manifest) ||
    manifest.candidateRevisionId !== candidate.id ||
    manifest.revision !== candidate.revision ||
    manifest.baselinePromptHash !== sha256Text(baselinePrompt) ||
    manifest.candidatePromptHash !== sha256Text(candidate.candidate.text) ||
    manifest.invariantsHash !== sha256Json([...invariants]) ||
    manifest.caseManifest.length !== testCases.length ||
    manifest.target.resolvedModel === ""
  ) {
    return false;
  }

  const expectedCasesMatch = testCases.every((testCase, index) => {
    const bound = manifest.caseManifest[index];
    const pack = manifest.evidencePacks[index];
    return Boolean(
      bound &&
      pack &&
      bound.caseId === testCase.id &&
      bound.input === testCase.input &&
      bound.inputHash === sha256Text(testCase.input) &&
      bound.inputCharacters === testCase.input.length &&
      bound.source === testCase.source &&
      bound.split === "development" &&
      bound.verificationHash ===
        (testCase.verification ? sha256Json(testCase.verification) : null) &&
      pack.caseId === testCase.id,
    );
  });
  if (!expectedCasesMatch) return false;

  return (
    caseResultsMatchManifest(
      baselineCaseResults,
      manifest.responses.baseline,
      manifest,
      manifest.evidencePacks,
      testCases,
      baselinePrompt,
    ) &&
    candidate.caseResults !== null &&
    caseResultsMatchManifest(
      candidate.caseResults,
      manifest.responses.candidate,
      manifest,
      manifest.evidencePacks,
      testCases,
      candidate.candidate.text,
    )
  );
}

function caseResultsMatchManifest(
  caseResults: readonly OptimizationCaseRun[],
  responses: readonly EvaluationEvidenceManifest["responses"]["baseline"][number][],
  manifest: EvaluationEvidenceManifest,
  evidencePacks: readonly EvaluationEvidencePack[],
  testCases: readonly OptimizationTestInput[],
  prompt: string,
): boolean {
  if (
    caseResults.length !== testCases.length ||
    responses.length !== testCases.length
  ) {
    return false;
  }
  return testCases.every((testCase, index) => {
    const result = caseResults[index];
    const response = responses.find((item) => item.caseId === testCase.id);
    const evidencePack = evidencePacks.find(
      (item) => item.caseId === testCase.id,
    );
    if (
      !result ||
      !response ||
      !evidencePack ||
      typeof result.answer !== "string"
    ) {
      return false;
    }
    const exactRequest = buildTargetEvaluationRequest({
      prompt,
      caseInput: testCase.input,
      evidencePack,
    });
    return (
      result.id === testCase.id &&
      result.input === testCase.input &&
      result.source === testCase.source &&
      result.responseId === response.responseId &&
      result.responseModel === response.responseModel &&
      result.requestHash === response.requestHash &&
      result.contextHash === response.contextHash &&
      response.provider === manifest.target.provider &&
      response.attemptId === manifest.attemptId &&
      response.responseModel === manifest.target.resolvedModel &&
      response.contextHash === evidencePack.contextHash &&
      response.requestHash === sha256Text(exactRequest)
    );
  });
}

function hasDeterministicVerificationProblem(
  candidate: CandidateState,
): boolean {
  return (
    candidate.caseResults?.some((result) => {
      const status = result.verificationEvidence?.status;
      return (
        status === "failed" ||
        status === "invalid_fixture" ||
        status === "unavailable"
      );
    }) ?? false
  );
}

function clearCandidateEvaluation(candidate: CandidateState): void {
  candidate.testedText = null;
  candidate.testedInvariantKey = null;
  candidate.caseResults = null;
  candidate.metrics = null;
  candidate.evaluationManifest = null;
}

function summarizeRuns(
  caseResults: readonly OptimizationCaseRun[],
  metrics: OptimizationRunMetrics,
): Record<string, unknown> {
  return {
    status: "complete",
    caseCount: caseResults.length,
    totalTokens: metrics.totalTokens,
    latencyMs: metrics.latencyMs,
    answerCharacterCounts: caseResults.map((item) => item.answer?.length ?? 0),
    verificationEvidence: caseResults.map((item) => ({
      caseId: item.id,
      evidence: item.verificationEvidence,
    })),
  };
}

function collectGraphIds(
  value: unknown,
  field: "entityIds" | "assertionIds",
  target: Set<string>,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const ids = (value as Record<string, unknown>)[field];
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id === "string" && z.uuid().safeParse(id).success) {
      target.add(id);
    }
  }
}

function buildClarificationPreflightRequest(input: {
  originalPrompt: string;
  invariants: readonly string[];
  objective: string;
  testCases: readonly OptimizationTestInput[];
  history: readonly { id: string; summary: string }[];
  clarificationContext: readonly { question: string; answer: string }[];
  targetSelection: PromptOptimizationTargetSelection;
  targetRequestedModel: string;
  targetRequestedReasoningEffort: string | null;
  targetCapabilities: readonly OptimizationTargetCapability[];
  frozenTargetSelection: OptimizationTargetSelectionEvidence | null;
}): string {
  return [
    "Kamu adalah Senopati, asisten optimasi prompt untuk PromptLab.",
    "Sebelum pengujian apa pun, tentukan apakah ada satu hal penting yang belum diketahui dan jawabannya akan mengubah prompt atau cara menilainya. Tanyakan hanya jika benar-benar perlu. Jika tujuan sudah cukup jelas, jangan meminta preferensi tambahan dan lanjutkan.",
    "Jika perlu bertanya, buat tepat satu pertanyaan singkat dalam bahasa Indonesia. Pilih reasonCode dari objective_choice, audience, output_format, source_scope, evaluation_criteria, atau user_feedback. Pilihan jawaban boleh kosong. publicContext hanya satu kalimat aman yang menjelaskan keputusan yang perlu dibuat; jangan tampilkan penalaran privat, dugaan sebagai fakta, atau data rahasia.",
    "Jika pengguna sudah memberikan input uji, keluarkan testCases sebagai array kosong. Jika belum, buat 2 atau 3 input perwakilan untuk menguji prompt setelah pengguna menjawab. Input buatan adalah probe, bukan fakta benar atau standar kualitas.",
    "Jika model atau reasoningEffort bertanda auto dan belum ada pilihan yang dibekukan, berikan targetRecommendation opsional yang cocok untuk tugas ini. Pilih modelId hanya persis dari katalog Codex live di bawah, dan reasoningEffort hanya dari supportedReasoningEfforts pada model yang sama. Jangan mengisi field yang ditandai selected. Jika tidak ada pilihan yang cocok, gunakan null. Jangan menebak kemampuan yang tidak tercantum.",
    "Aturan Auto khusus: untuk model ber-ID berakhiran -luna, rekomendasikan max pada setiap tugas; jika max tidak tercantum sebagai kemampuan, keluarkan reasoningEffort null dan jangan mengarang dukungan. Untuk gpt-6.1-sol, rekomendasikan medium untuk pekerjaan teknis yang terbatas dan high untuk perencanaan atau debugging lintas-modul yang kompleks atau ambigu. Untuk gpt-6-astra, gunakan high untuk analisis sulit dan xhigh hanya untuk analisis paling berat. Aturan ini hanya berlaku jika effort berstatus auto; pilihan manual tidak boleh diubah.",
    "Jika target selection yang dibekukan tersedia, rekomendasi harus null; pertahankan profil tersebut. Sistem memvalidasi rekomendasi terhadap katalog dan mencatat alasan publik singkat tanpa memakai penalaran privat.",
    'Keluarkan satu objek JSON: {"summary":"ringkasan publik singkat","clarificationRequired":false,"clarification":null,"testCases":[],"targetRecommendation":{"modelId":null,"reasoningEffort":null}}. Saat bertanya, set clarificationRequired=true dan isi clarification dengan {"question":"pertanyaan langsung","reasonCode":"audience","choices":[],"publicContext":null}; jangan membuat kandidat atau jawaban target.',
    `Tujuan pengguna: ${JSON.stringify(input.objective)}`,
    `Prompt tersimpan: ${JSON.stringify(input.originalPrompt)}`,
    `Aturan penting: ${JSON.stringify(input.invariants)}`,
    `Input uji dari pengguna: ${JSON.stringify(input.testCases)}`,
    `Jawaban klarifikasi sebelumnya: ${JSON.stringify(input.clarificationContext)}`,
    `Umpan balik kualitas eksplisit pengguna dari optimasi sebelumnya: ${JSON.stringify(input.history.map((item) => ({ runId: item.id, feedback: item.summary })))}`,
    `Pilihan target diminta: ${JSON.stringify({ selection: input.targetSelection, requestedModel: input.targetRequestedModel, requestedReasoningEffort: input.targetRequestedReasoningEffort })}`,
    `Katalog kemampuan Codex live (hanya model text): ${JSON.stringify(input.targetCapabilities)}`,
    `Profil target yang sudah dibekukan: ${JSON.stringify(input.frozenTargetSelection)}`,
  ].join("\n\n");
}

function buildDecisionRequest(input: {
  originalPrompt: string;
  invariants: readonly string[];
  objective: string;
  testCases: readonly OptimizationTestInput[];
  baselineCaseResults: readonly OptimizationCaseRun[];
  baselineMetrics: OptimizationRunMetrics;
  evaluationEvidence: readonly EvaluationEvidencePack[];
  candidates: readonly {
    id: string;
    candidate: AgentCandidate;
    invariantStatus: "preserved" | "violated" | "not_configured";
    caseResults: OptimizationCaseRun[] | null;
    metrics: OptimizationRunMetrics | null;
    draftVersionId: string | null;
  }[];
  historyIds: readonly string[];
  historySummaries: readonly { id: string; summary: string }[];
  clarificationContext: readonly { question: string; answer: string }[];
  sourceIds: readonly string[];
  priorToolResults: readonly unknown[];
  turn: number;
  nextCandidateId: string | null;
  candidateIds: readonly string[];
  internalCaseIds: readonly string[];
}): string {
  return [
    "Kamu adalah Senopati, agen pengarah perbaikan prompt. Analisis prompt lama, contoh hasil, konteks sumber yang dipilih, dan hasil tools. Buat satu kandidat lengkap, uji, lalu revisi paling banyak satu kali bila bukti menunjukkan bagian tertentu perlu diperbaiki.",
    "Jawaban akhir harus tepat satu objek JSON standar. Letakkan JSON setelah bagian analisis internal model berakhir. Jangan sertakan teks lain, Markdown, pagar kode, komentar, atau penalaran privat di dalam jawaban akhir.",
    'Semua enam field wajib ada dan bertipe tepat seperti contoh kosong ini: {"summary":"Ringkasan tindakan publik satu kalimat.","toolCalls":[],"candidate":null,"finish":false,"clarificationRequired":false,"clarification":null}.',
    'Jika mengusulkan prompt, candidate harus berupa objek lengkap: {"text":"prompt pengganti lengkap","changeSummary":"perubahan singkat","riskSummary":"risiko singkat","strategy":"strategi singkat"}. Jika belum mengusulkan kandidat pada giliran ini, isi candidate dengan null.',
    "Teks pada candidate.text harus sama persis dengan candidateText yang dikirim ke validate_candidate. Untuk sebuah revisi, ajukan candidate baru dan validasi teks yang sama; memanggil alat validasi dengan teks lain tidak memperbarui kandidat sebelumnya.",
    'Setiap panggilan tool harus berbentuk tepat {"name":"nama_tool","arguments":{...}}. Tool yang diizinkan dan semua argumennya: analyze_history memakai {"messageIds":["ID riwayat yang tersedia"],"window":20}; search_knowledge memakai {"query":"pertanyaan singkat","sourceIds":["ID sumber yang dipilih"],"limit":5} (sourceIds boleh dihilangkan); get_source memakai {"chunkId":"ID cuplikan yang dikembalikan search_knowledge"}; search_graph_entities memakai {"query":"topik singkat","limit":5}; traverse_graph memakai {"seedEntityIds":["ID entitas yang dikembalikan search_graph_entities"],"maxHops":2,"maxNodes":30,"maxEdges":60,"maxPaths":3,"maxEstimatedContextTokens":3000}; get_graph_evidence memakai {"assertionIds":["ID assertion yang dikembalikan pencarian atau traversal graph"]}; get_graph_status memakai {}; estimate_tokens memakai {"text":"teks yang akan dihitung"}; inspect_capabilities memakai {"provider":"codex_app_server"} atau {"provider":"campus_gateway"}; validate_candidate memakai {"candidateText":"prompt lengkap","invariants":["aturan penting yang diberikan"]}; evaluate_subset memakai {"candidateId":"ID kandidat dari slot yang tersedia","developmentCaseIds":["semua ID pengujian internal yang tersedia"]}.',
    "Pakai hanya nama tool dan field argumen persis seperti di atas. Jangan menambahkan field argumen. ID harus diambil persis dari data yang disediakan; jangan membuat ID. Bila tidak memakai tool, toolCalls harus berupa [].",
    "Setiap string pada Aturan penting adalah aturan literal: salin setiap string persis ke dalam candidate.text. Jangan hanya mempertahankan maknanya, meringkasnya, menggabungkannya, atau memparafrasakannya. validate_candidate harus menerima seluruh array aturan persis seperti yang diberikan.",
    "Hasil tool adalah bukti yang mengikat. Jika validate_candidate mengembalikan valid=false atau invariantStatus=violated, kandidat ditolak; buat kandidat yang diperbaiki dengan menyalin semua aturan literal, lalu validasi lagi sebelum mengujinya. Setiap perubahan teks membatalkan jawaban dan metrik dari teks sebelumnya; uji ulang teks kandidat terakhir pada semua contoh sebelum selesai.",
    "verificationEvidence adalah hasil deterministik yang mengikat: status failed berarti kandidat gagal pada fixture itu; status invalid_fixture berarti oracle bertentangan dengan referensi dan kandidat tidak dapat disebut berhasil. Revisi prompt/kode lalu uji lagi semua contoh yang sama. Status unavailable bukan bukti lulus. Pengujian perilaku tidak membuktikan kompleksitas asimtotik; jangan membuat klaim kompleksitas.",
    "Saat hasil validate_candidate menyertakan missingInvariants, salin setiap string di dalamnya persis ke candidate.text. Selalu kirim seluruh array Aturan penting, dalam urutan apa pun, pada argumen invariants.",
    ...(input.nextCandidateId === null
      ? [
          "Tidak ada slot kandidat baru yang tersisa. Jangan usulkan atau validasi revisi kandidat; jika kandidat yang ada lolos aturan penting dan belum diuji, uji kandidat itu. Jika kandidat ditolak atau semua contoh sudah diuji, rangkum hasil yang tersedia dan akhiri.",
        ]
      : []),
    "Sebelum kandidat baru, gunakan validate_candidate dengan daftar aturan persis. Setelah kandidat tercatat dan valid, panggil evaluate_subset untuk semua ID contoh yang tersedia. Gunakan hasil jawaban, token, dan waktu untuk memutuskan apakah perlu revisi. Jangan memilih pemenang kualitas secara otomatis; pengguna yang menilai jawaban. Jangan membuat klaim benar/salah tanpa bukti.",
    "Contoh uji berasal dari pengguna atau dibuat Senopati dan tetap sama untuk prompt lama/kandidat. Preflight sudah meminta konteks penting sebelum target diuji; jika masih ada satu kebutuhan penting baru yang benar-benar muncul, keluarkan satu pertanyaan publik di clarification dan jangan menyertakan toolCalls atau kandidat pada giliran itu. Kandidat harus berupa prompt lengkap pengganti, bukan catatan perubahan.",
    'Contoh format usulan: {"summary":"Saya membuat kandidat dan memeriksa aturan penting.","toolCalls":[{"name":"validate_candidate","arguments":{"candidateText":"prompt lengkap","invariants":["aturan penting yang diberikan"]}}],"candidate":{"text":"prompt lengkap","changeSummary":"instruksi diperjelas","riskSummary":"periksa contoh yang sama","strategy":"perjelas instruksi"},"finish":false,"clarificationRequired":false,"clarification":null}. Ganti teks contoh dengan isi yang benar-benar tersedia; jangan menyalin placeholder.',
    'Contoh format pertanyaan: {"summary":"Saya memerlukan satu keputusan sebelum melanjutkan.","toolCalls":[],"candidate":null,"finish":false,"clarificationRequired":true,"clarification":{"question":"Untuk siapa prompt ini terutama digunakan?","reasonCode":"audience","choices":["Mahasiswa","Pengajar"],"publicContext":"Pilihan ini mengubah tingkat detail jawaban."}}.',
    'Contoh format pengujian kandidat: {"summary":"Saya menguji kandidat pada semua contoh yang sama.","toolCalls":[{"name":"evaluate_subset","arguments":{"candidateId":"ID kandidat yang disediakan","developmentCaseIds":["semua ID pengujian internal"]}}],"candidate":null,"finish":false,"clarificationRequired":false,"clarification":null}.',
    `Turn: ${input.turn}`,
    `Arahan tambahan: ${JSON.stringify(input.objective)}`,
    `Prompt lama: ${JSON.stringify(input.originalPrompt)}`,
    `Aturan penting: ${JSON.stringify(input.invariants)}`,
    `Contoh input/source: ${JSON.stringify(input.testCases)}`,
    `Hasil prompt lama: ${JSON.stringify(input.baselineCaseResults)}`,
    `Pengukuran prompt lama: ${JSON.stringify(input.baselineMetrics)}`,
    `Paket retrieval yang dibekukan dan juga diteruskan utuh ke target: ${JSON.stringify(input.evaluationEvidence)}`,
    `Sumber knowledge yang boleh dicari: ${JSON.stringify(input.sourceIds)}`,
    `Riwayat yang boleh dibaca: ${JSON.stringify(input.historyIds)}`,
    `Ringkasan jawaban dan umpan balik pengguna sebelumnya: ${JSON.stringify(input.historySummaries)}`,
    `Jawaban klarifikasi pada run ini: ${JSON.stringify(input.clarificationContext)}`,
    `Slot ID kandidat: ${JSON.stringify(input.candidateIds)}`,
    `ID kandidat berikutnya: ${JSON.stringify(input.nextCandidateId)}`,
    `ID pengujian internal: ${JSON.stringify(input.internalCaseIds)}`,
    `Kandidat dan hasil sebelumnya: ${JSON.stringify(input.candidates)}`,
    `Hasil tool sebelumnya: ${JSON.stringify(input.priorToolResults)}`,
  ].join("\n\n");
}

function validateCandidate(
  text: string,
  expected: readonly string[],
  received: readonly string[],
): "preserved" | "violated" | "not_configured" {
  if (canonicalInvariantKey(expected) !== canonicalInvariantKey(received)) {
    return "violated";
  }
  if (expected.length === 0) return "not_configured";
  if (expected.some((item) => !normalize(text).includes(normalize(item)))) {
    return "violated";
  }
  return "preserved";
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function parseModelJson<T extends z.ZodType>(
  text: string,
  schema: T,
  options: { readonly requireSingleObject?: boolean } = {},
): z.infer<T> {
  const publicText = stripPrivateReasoning(text);
  const objects = extractJsonObjects(publicText);
  if (
    objects.length === 0 ||
    (options.requireSingleObject && objects.length !== 1)
  ) {
    throw new Error("MODEL_OUTPUT_INVALID_JSON");
  }

  let foundJson = false;
  for (const objectText of objects.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(objectText);
    } catch {
      continue;
    }
    foundJson = true;
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  }
  throw new Error(
    foundJson ? "MODEL_OUTPUT_INVALID_SCHEMA" : "MODEL_OUTPUT_INVALID_JSON",
  );
}

/** Ignore provider reasoning tags and parse only JSON from the public answer. */
function stripPrivateReasoning(text: string): string {
  const withoutClosedBlocks = text.replace(
    /<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  return withoutClosedBlocks
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

/** Finds balanced top-level JSON objects without treating braces in strings as structure. */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}
