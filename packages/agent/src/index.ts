import {
  AgentBudgetSchema,
  type AgentBudgetInput,
  AgentToolCallSchema,
  type AgentBudget,
  type AgentToolCall,
  OptimizationClarificationQuestionSchema,
} from "@promptlab/contracts";
import {
  AgentBudgetLedger,
  ToolExecutionError,
  createToolExecutor,
  type AgentScope,
  type ToolContext,
  type ToolHandlers,
} from "@promptlab/tools";
import { z } from "zod";

export const AgentCandidateSchema = z.strictObject({
  text: z.string().min(1).max(100_000),
  changeSummary: z.string().trim().min(1).max(500),
  riskSummary: z.string().trim().min(1).max(500),
  strategy: z.string().trim().min(1).max(300),
});

export const AgentDecisionSchema = z
  .strictObject({
    summary: z.string().trim().min(1).max(500),
    targetRecommendation: z
      .strictObject({
        modelId: z.string().trim().min(1).max(200).nullable(),
        reasoningEffort: z.string().trim().min(1).max(80).nullable(),
      })
      .nullable()
      .default(null),
    toolCalls: z.array(AgentToolCallSchema).max(8).default([]),
    candidate: AgentCandidateSchema.nullable().default(null),
    noChangeRecommended: z.boolean().default(false),
    finalText: z.string().trim().min(1).max(100_000).nullable().default(null),
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
        decision.finalText !== null ||
        decision.finish)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A clarification turn cannot execute tools, propose a candidate, or finish.",
        path: ["clarificationRequired"],
      });
    }
    if (
      decision.finalText !== null &&
      (!decision.finish || decision.toolCalls.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A final answer must finish the decision turn without starting another tool.",
        path: ["finalText"],
      });
    }
    if (
      decision.noChangeRecommended &&
      (decision.candidate !== null ||
        decision.finalText === null ||
        !decision.finish ||
        decision.toolCalls.length > 0 ||
        decision.clarificationRequired)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A no-change recommendation must finish without a candidate, tools, or clarification.",
        path: ["noChangeRecommended"],
      });
    }
  });

export type AgentCandidate = z.infer<typeof AgentCandidateSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export class AgentInterfaceError extends Error {
  constructor(readonly code: "INVALID_AGENT_DECISION" | "INVALID_TOOL_CALL") {
    super(
      code === "INVALID_TOOL_CALL"
        ? "Agent returned a tool call outside the allowed contract."
        : "Agent returned a decision outside the allowed contract.",
    );
    this.name = "AgentInterfaceError";
  }
}

export interface AgentTraceEvent {
  type:
    | "agent.action"
    | "tool.started"
    | "tool.completed"
    | "candidate.proposed"
    | "agent.finished";
  turn: number;
  selectedTools?: AgentToolCall["name"][];
  toolName?: AgentToolCall["name"];
  argumentsSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  candidate?: AgentCandidate;
  clarificationRequired?: boolean;
  clarification?: z.infer<typeof OptimizationClarificationQuestionSchema>;
  summary: string;
}

export interface AgentPlannerContext {
  readonly turn: number;
  readonly budget: AgentBudget;
  readonly priorToolResults: readonly unknown[];
  readonly priorCandidate: AgentCandidate | null;
  readonly signal: AbortSignal;
}

export interface RunBoundedAgentOptions {
  readonly scope: AgentScope;
  readonly handlers: ToolHandlers;
  readonly planner: (context: AgentPlannerContext) => Promise<unknown>;
  /** Server-selected tools run before the first planner turn using the normal ledger and trace. */
  readonly initialToolCalls?: readonly AgentToolCall[];
  readonly budget?: AgentBudgetInput;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentTraceEvent) => unknown;
}

export interface BoundedAgentResult {
  status: "finished" | "clarification_required" | "budget_exhausted";
  candidate: AgentCandidate | null;
  noChangeRecommended: boolean;
  finalText: string | null;
  clarification?: z.infer<typeof OptimizationClarificationQuestionSchema>;
  toolCallCount: number;
  decisionTurnCount: number;
}

/** Executes only server-defined tools and bounded plans; it cannot access shell, SQL, filesystem, or arbitrary network. */
export async function runBoundedAgent(
  options: RunBoundedAgentOptions,
): Promise<BoundedAgentResult> {
  const budget = AgentBudgetSchema.parse(options.budget ?? {});
  const ledger = new AgentBudgetLedger(budget);
  const executor = createToolExecutor(options.handlers, ledger);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort(options.signal.reason);

  const toolResults: unknown[] = [];
  let candidate: AgentCandidate | null = null;
  const executeToolCall = async (
    toolCall: AgentToolCall,
    turn: number,
    signal: AbortSignal,
  ) => {
    if (controller.signal.aborted)
      throw new Error("Agent execution was canceled");
    await options.onEvent?.({
      type: "tool.started",
      turn,
      toolName: toolCall.name,
      argumentsSummary: summarizeToolArguments(toolCall),
      summary: `Menjalankan ${toolCall.name}`,
    });
    let output: unknown;
    try {
      output = await executor.execute(toolCall, {
        scope: options.scope,
        signal,
      });
    } catch (error) {
      try {
        await options.onEvent?.({
          type: "tool.completed",
          turn,
          toolName: toolCall.name,
          resultSummary: { executionStatus: "failed" },
          summary: `Gagal ${toolCall.name}`,
        });
      } catch {
        // A trace write must not replace the original tool failure.
      }
      throw error;
    }
    toolResults.push(output);
    await options.onEvent?.({
      type: "tool.completed",
      turn,
      toolName: toolCall.name,
      resultSummary: summarizeToolResult(toolCall.name, output),
      summary: `Selesai ${toolCall.name}`,
    });
  };

  try {
    for (const toolCall of options.initialToolCalls ?? []) {
      const timeout = AbortSignal.timeout(Math.max(1, ledger.remainingMs));
      await executeToolCall(
        toolCall,
        1,
        AbortSignal.any([controller.signal, timeout]),
      );
    }

    while (ledger.decisionTurnCount < budget.maxDecisionTurns) {
      if (controller.signal.aborted)
        throw new Error("Agent execution was canceled");
      ledger.beginDecisionTurn();
      const turn = ledger.decisionTurnCount;
      const timeout = AbortSignal.timeout(Math.max(1, ledger.remainingMs));
      let rawDecision: unknown;
      try {
        rawDecision = await Promise.race([
          options.planner({
            turn,
            budget,
            priorToolResults: toolResults,
            priorCandidate: candidate,
            signal: AbortSignal.any([controller.signal, timeout]),
          }),
          new Promise<never>((_, reject) =>
            timeout.addEventListener(
              "abort",
              () => reject(new Error("Agent wall-clock budget exhausted")),
              { once: true },
            ),
          ),
        ]);
      } catch (error) {
        if (timeout.aborted) {
          return {
            status: "budget_exhausted",
            candidate,
            noChangeRecommended: false,
            finalText: null,
            toolCallCount: ledger.toolCallCount,
            decisionTurnCount: turn,
          };
        }
        throw error;
      }

      const parsedDecision = AgentDecisionSchema.safeParse(rawDecision);
      if (!parsedDecision.success) {
        const invalidToolCall = parsedDecision.error.issues.some(
          (issue) => issue.path[0] === "toolCalls",
        );
        throw new AgentInterfaceError(
          invalidToolCall ? "INVALID_TOOL_CALL" : "INVALID_AGENT_DECISION",
        );
      }
      const decision = parsedDecision.data;
      await options.onEvent?.({
        type: "agent.action",
        turn,
        clarificationRequired: decision.clarificationRequired,
        selectedTools: decision.toolCalls.map((toolCall) => toolCall.name),
        ...(decision.clarification
          ? { clarification: decision.clarification }
          : {}),
        summary: decision.summary,
      });
      if (decision.clarificationRequired) {
        return {
          status: "clarification_required",
          candidate,
          noChangeRecommended: false,
          finalText: null,
          clarification: decision.clarification!,
          toolCallCount: ledger.toolCallCount,
          decisionTurnCount: turn,
        };
      }

      for (const toolCall of decision.toolCalls) {
        await executeToolCall(
          toolCall,
          turn,
          AbortSignal.any([controller.signal, timeout]),
        );
      }

      if (decision.candidate) {
        ledger.reserveCandidate(candidate !== null);
        candidate = decision.candidate;
        await options.onEvent?.({
          type: "candidate.proposed",
          turn,
          candidate: decision.candidate,
          summary: decision.candidate.changeSummary,
        });
      }
      if (decision.finish) {
        await options.onEvent?.({
          type: "agent.finished",
          turn,
          summary: "Proses agent selesai",
        });
        return {
          status: "finished",
          candidate,
          noChangeRecommended: decision.noChangeRecommended,
          finalText: decision.finalText,
          toolCallCount: ledger.toolCallCount,
          decisionTurnCount: turn,
        };
      }
    }
    return {
      status: "budget_exhausted",
      candidate,
      noChangeRecommended: false,
      finalText: null,
      toolCallCount: ledger.toolCallCount,
      decisionTurnCount: ledger.decisionTurnCount,
    };
  } catch (error) {
    if (
      error instanceof ToolExecutionError &&
      error.code === "TOOL_BUDGET_EXCEEDED"
    ) {
      return {
        status: "budget_exhausted",
        candidate,
        noChangeRecommended: false,
        finalText: null,
        toolCallCount: ledger.toolCallCount,
        decisionTurnCount: ledger.decisionTurnCount,
      };
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export { optimizePrompt } from "./prompt-optimization.js";
export {
  optimizePromptAutomatically,
  parseModelJson,
} from "./prompt-optimization-auto.js";

export const WORKSPACE_CHAT_BUDGET = Object.freeze({
  maxDecisionTurns: 5,
  maxToolCalls: 8,
  maxCandidates: 1,
  maxRevisions: 0,
  maxDurationMs: 180_000,
});

export interface MandatoryWorkspaceOptimization {
  /** The exact prompt that should be sent to the target when Senopati chooses no-op. */
  readonly originalPrompt: string;
  /** Require one successful bounded verified-memory search before optimization. */
  readonly requireVerifiedMemorySearch?: boolean;
  /** Require one successful bounded GraphRAG search before a target decision. */
  readonly requireGraphSearch?: boolean;
  /** Auto retrieval permits one Senopati-selected lexical or graph route. */
  readonly autoRetrieval?: boolean;
}

/**
 * Run Workspace orchestration on the shared bounded controller. When
 * mandatoryOptimization is set, Senopati must explicitly return a candidate,
 * an explicit no-op, or a clarification before Codex can run. The target call
 * is server-injected with that exact candidate/original prompt, and its result
 * is the only final answer returned to the UI.
 */
export async function runWorkspaceChatAgent(
  options: Omit<RunBoundedAgentOptions, "budget"> & {
    readonly mandatoryOptimization?: MandatoryWorkspaceOptimization;
  },
): Promise<BoundedAgentResult> {
  let targetCallCount = 0;
  const mandatoryOptimization = options.mandatoryOptimization;
  const verifiedMemoryQuery = mandatoryOptimization?.requireVerifiedMemorySearch
    ? mandatoryOptimization.originalPrompt.trim().slice(0, 2_000)
    : null;
  const handlers: ToolHandlers = { ...options.handlers };
  const targetHandler = options.handlers.call_codex_target;
  if (mandatoryOptimization && !targetHandler) {
    throw new Error("WORKSPACE_CHAT_TARGET_UNAVAILABLE");
  }
  let optimizationResolved = false;
  let optimizerNoChangeRecommended = false;
  let targetPrompt: string | null = null;
  let targetResult: unknown = null;
  let graphSearchCompleted = false;
  let verifiedMemorySearchCompleted = false;
  let knowledgeSearchCompleted = false;
  let knowledgeSearchTurn = 0;
  let activeDecisionTurn = 0;
  if (mandatoryOptimization?.requireVerifiedMemorySearch) {
    if (!verifiedMemoryQuery) {
      throw new Error("WORKSPACE_CHAT_VERIFIED_MEMORY_UNAVAILABLE");
    }
    const memorySearchHandler = handlers.search_verified_memory;
    if (!memorySearchHandler) {
      throw new Error("WORKSPACE_CHAT_VERIFIED_MEMORY_UNAVAILABLE");
    }
    handlers.search_verified_memory = async (args, context) => {
      if (verifiedMemorySearchCompleted) {
        throw new AgentInterfaceError("INVALID_TOOL_CALL");
      }
      const result = await memorySearchHandler(args, context);
      const resultRecord =
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null;
      if (resultRecord?.available !== true) {
        throw new Error("WORKSPACE_CHAT_VERIFIED_MEMORY_UNAVAILABLE");
      }
      verifiedMemorySearchCompleted = true;
      return result;
    };
  }
  const knowledgeSearchHandler = handlers.search_knowledge;
  if (knowledgeSearchHandler) {
    handlers.search_knowledge = async (args, context) => {
      const result = await knowledgeSearchHandler(args, context);
      knowledgeSearchCompleted = true;
      knowledgeSearchTurn = activeDecisionTurn;
      return result;
    };
  }
  if (mandatoryOptimization?.requireGraphSearch) {
    const graphSearchHandler = handlers.search_graph_entities;
    if (!graphSearchHandler) {
      throw new Error("WORKSPACE_CHAT_GRAPH_RETRIEVAL_UNAVAILABLE");
    }
    handlers.search_graph_entities = async (args, context) => {
      const result = await graphSearchHandler(args, context);
      const resultRecord =
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null;
      if (resultRecord?.available !== true) {
        throw new Error("WORKSPACE_CHAT_GRAPH_RETRIEVAL_UNAVAILABLE");
      }
      graphSearchCompleted = true;
      if (resultRecord.strategyUsed === "lexical") {
        knowledgeSearchCompleted = true;
        knowledgeSearchTurn = activeDecisionTurn;
      }
      return result;
    };
  } else if (mandatoryOptimization && handlers.search_graph_entities) {
    const graphSearchHandler = handlers.search_graph_entities;
    handlers.search_graph_entities = async (args, context) => {
      const result = await graphSearchHandler(args, context);
      const resultRecord =
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null;
      if (resultRecord?.available === true) {
        graphSearchCompleted = true;
        if (resultRecord.strategyUsed === "lexical") {
          knowledgeSearchCompleted = true;
          knowledgeSearchTurn = activeDecisionTurn;
        }
      }
      return result;
    };
  }
  if (targetHandler) {
    handlers.call_codex_target = async (
      args: Extract<AgentToolCall, { name: "call_codex_target" }>["arguments"],
      context: ToolContext,
    ) => {
      if (targetCallCount >= 1) {
        if (mandatoryOptimization) {
          throw new AgentInterfaceError("INVALID_TOOL_CALL");
        }
        return {
          available: false,
          status: "target_call_limit_reached",
        };
      }
      if (
        mandatoryOptimization &&
        (!optimizationResolved ||
          args.prompt !== targetPrompt ||
          (mandatoryOptimization.requireVerifiedMemorySearch &&
            !verifiedMemorySearchCompleted))
      ) {
        throw new AgentInterfaceError("INVALID_TOOL_CALL");
      }
      targetCallCount += 1;
      const result = await targetHandler(args, context);
      if (mandatoryOptimization) {
        const resultRecord =
          typeof result === "object" &&
          result !== null &&
          !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : null;
        if (
          resultRecord?.available !== true ||
          typeof resultRecord.text !== "string" ||
          !resultRecord.text.trim()
        ) {
          throw new Error("WORKSPACE_CHAT_TARGET_UNAVAILABLE");
        }
        targetResult = result;
      }
      return result;
    };
  }

  const planner = async (context: AgentPlannerContext) => {
    if (mandatoryOptimization && targetResult !== null) {
      const result = targetResult as Record<string, unknown>;
      return {
        summary: "Codex menyelesaikan prompt yang telah dioptimasi.",
        toolCalls: [],
        candidate: null,
        noChangeRecommended: false,
        finalText: result.text as string,
        finish: true,
        clarificationRequired: false,
        clarification: null,
      };
    }

    activeDecisionTurn = context.turn;
    const rawDecision = await options.planner(context);
    if (!mandatoryOptimization) return rawDecision;

    const parsedDecision = AgentDecisionSchema.safeParse(rawDecision);
    if (!parsedDecision.success) {
      const invalidToolCall = parsedDecision.error.issues.some(
        (issue) => issue.path[0] === "toolCalls",
      );
      throw new AgentInterfaceError(
        invalidToolCall ? "INVALID_TOOL_CALL" : "INVALID_AGENT_DECISION",
      );
    }
    const decision = parsedDecision.data;
    if (decision.clarificationRequired) return decision;

    const memoryToolCalls = decision.toolCalls.filter(
      (toolCall) => toolCall.name === "search_verified_memory",
    );
    if (mandatoryOptimization.requireVerifiedMemorySearch) {
      if (!verifiedMemorySearchCompleted) {
        throw new AgentInterfaceError("INVALID_AGENT_DECISION");
      }
      if (memoryToolCalls.length > 0) {
        throw new AgentInterfaceError("INVALID_TOOL_CALL");
      }
    }

    const detailSourceToolCalls = decision.toolCalls.filter(
      (toolCall) => toolCall.name === "get_source",
    );
    if (detailSourceToolCalls.length > 0) {
      const detailTurn = 2;
      if (
        detailSourceToolCalls.length !== 1 ||
        decision.toolCalls.length !== 1 ||
        context.turn !== detailTurn ||
        !knowledgeSearchCompleted ||
        knowledgeSearchTurn !== context.turn - 1 ||
        decision.candidate !== null ||
        decision.noChangeRecommended ||
        decision.finalText !== null ||
        decision.finish
      ) {
        throw new AgentInterfaceError("INVALID_AGENT_DECISION");
      }
      return decision;
    }

    const sourceToolCalls = decision.toolCalls.filter(
      (toolCall) =>
        toolCall.name === "search_knowledge" ||
        toolCall.name === "search_graph_entities",
    );
    if (sourceToolCalls.length > 0) {
      const sourceOnly = sourceToolCalls.length === decision.toolCalls.length;
      const sourceSearchTurn = 1;
      if (
        !sourceOnly ||
        context.turn !== sourceSearchTurn ||
        knowledgeSearchCompleted ||
        graphSearchCompleted ||
        (mandatoryOptimization.autoRetrieval &&
          (sourceToolCalls.length !== 1 ||
            (sourceToolCalls[0]?.name !== "search_knowledge" &&
              sourceToolCalls[0]?.name !== "search_graph_entities"))) ||
        (mandatoryOptimization.requireGraphSearch &&
          (sourceToolCalls.length !== 1 ||
            sourceToolCalls[0]?.name !== "search_graph_entities")) ||
        decision.candidate !== null ||
        decision.noChangeRecommended ||
        decision.finalText !== null ||
        decision.finish
      ) {
        throw new AgentInterfaceError("INVALID_AGENT_DECISION");
      }
      return decision;
    }

    if (decision.toolCalls.length > 0) {
      // In particular, the optimizer cannot choose a different prompt for
      // Codex. The exact server-selected candidate is injected below.
      throw new AgentInterfaceError("INVALID_TOOL_CALL");
    }
    if (decision.candidate === null && !decision.noChangeRecommended) {
      throw new AgentInterfaceError("INVALID_AGENT_DECISION");
    }
    if (mandatoryOptimization.requireGraphSearch && !graphSearchCompleted) {
      throw new AgentInterfaceError("INVALID_AGENT_DECISION");
    }
    if (
      mandatoryOptimization.requireVerifiedMemorySearch &&
      !verifiedMemorySearchCompleted
    ) {
      throw new AgentInterfaceError("INVALID_AGENT_DECISION");
    }
    if (
      decision.candidate &&
      decision.candidate.text.trim() ===
        mandatoryOptimization.originalPrompt.trim()
    ) {
      throw new AgentInterfaceError("INVALID_AGENT_DECISION");
    }

    optimizerNoChangeRecommended = decision.noChangeRecommended;
    const effectivePrompt =
      decision.candidate?.text ?? mandatoryOptimization.originalPrompt;
    targetPrompt = effectivePrompt;
    optimizationResolved = true;

    // AgentDecisionSchema correctly keeps a no-op separate from a candidate
    // and from tool calls. Convert it only inside this execution boundary so
    // the bounded runner can record the target call and preserve the explicit
    // no-op result for the caller.
    const candidate =
      decision.candidate ??
      ({
        text: mandatoryOptimization.originalPrompt,
        changeSummary: "Senopati memutuskan prompt sudah memadai.",
        riskSummary: "Tidak ada perubahan; prompt asli akan dipakai.",
        strategy: "No-op optimasi yang diputuskan Senopati.",
      } satisfies AgentCandidate);

    return {
      ...decision,
      toolCalls: [
        {
          name: "call_codex_target" as const,
          arguments: { prompt: effectivePrompt },
        },
      ],
      candidate,
      noChangeRecommended: false,
      finalText: null,
      finish: false,
    };
  };

  const result = await runBoundedAgent({
    ...options,
    handlers,
    planner,
    ...(verifiedMemoryQuery
      ? {
          initialToolCalls: [
            {
              name: "search_verified_memory" as const,
              arguments: { query: verifiedMemoryQuery, limit: 5 },
            },
          ],
        }
      : {}),
    budget: WORKSPACE_CHAT_BUDGET,
  });
  return mandatoryOptimization && optimizerNoChangeRecommended
    ? { ...result, noChangeRecommended: true }
    : result;
}
export {
  buildTargetEvaluationRequest,
  canonicalJson,
  createEvaluationEvidenceManifest,
  isEvaluationEvidenceManifestIntact,
  isOptimizationCandidateEvidenceEligible,
  sha256Json,
  sha256Text,
} from "./evidence-manifest.js";
export {
  isControlledEvaluationConfigurationValid,
  isControlledEvaluationReportIntact,
  runControlledEvaluation,
  ControlledEvaluationFatalError,
  ControlledEvaluationInterruptedError,
} from "./controlled-evaluation.js";
export type {
  ControlledEvaluationInvocation,
  ControlledEvaluationSubject,
  ControlledEvaluationTargetCall,
  ControlledEvaluationTrace,
  RunControlledEvaluationInput,
} from "./controlled-evaluation.js";
export {
  OptimizationFrozenExecutionSnapshotSchema,
  OptimizationTargetSelectionEvidenceSchema,
} from "./prompt-optimization-auto.js";
export { verifyOptimizationCase } from "./prompt-optimization-verification.js";
export type { OptimizationVerificationEvidence } from "./prompt-optimization-verification.js";
export type {
  AutomaticPromptOptimizationResult,
  AutomaticOptimizationCandidateResult,
  AutomaticOptimizationCandidateRevision,
  OptimizationCaseRun,
  ImmutableAutomaticOptimizationCandidateRevision,
  OptimizationFrozenExecutionSnapshot,
  OptimizationInvocation,
  OptimizationRunMetrics,
  OptimizationTestInput,
  OptimizationTargetCapability,
  OptimizationTargetRecommendation,
  OptimizationTargetSelectionEvidence,
  OptimizationUsage,
  PromptOptimizationEvaluationContext,
  PromptOptimizationAutoOptions,
} from "./prompt-optimization-auto.js";
export type {
  OptimizationCaseResult,
  OptimizationEvaluation,
  OptimizationCandidateResult,
  PromptOptimizationOptions,
  PromptOptimizationResult,
} from "./prompt-optimization.js";

/** Tool event payloads expose bounded metadata, never raw prompt/input/output text. */
function summarizeToolArguments(call: AgentToolCall): Record<string, unknown> {
  switch (call.name) {
    case "validate_candidate":
      return {
        candidateCharacters: call.arguments.candidateText.length,
        invariantCount: call.arguments.invariants.length,
      };
    case "evaluate_subset":
      return {
        candidateId: call.arguments.candidateId,
        developmentCaseCount: call.arguments.developmentCaseIds.length,
      };
    case "estimate_tokens":
      return { textCharacters: call.arguments.text.length };
    case "search_knowledge":
      return {
        queryCharacters: call.arguments.query.length,
        sourceCount: call.arguments.sourceIds?.length ?? null,
        limit: call.arguments.limit,
      };
    case "search_verified_memory":
      return {
        queryCharacters: call.arguments.query.length,
        limit: call.arguments.limit,
      };
    case "get_source":
      return { chunkId: call.arguments.chunkId };
    case "inspect_capabilities":
      return { provider: call.arguments.provider };
    case "analyze_history":
      return {
        messageCount: call.arguments.messageIds.length,
        window: call.arguments.window,
      };
    case "search_graph_entities":
      return {
        queryCharacters: call.arguments.query.length,
        limit: call.arguments.limit,
      };
    case "traverse_graph":
      return {
        seedCount: call.arguments.seedEntityIds.length,
        maxHops: call.arguments.maxHops,
        maxNodes: call.arguments.maxNodes,
      };
    case "get_graph_evidence":
      return { assertionCount: call.arguments.assertionIds.length };
    case "get_graph_status":
      return {};
    case "call_codex_target":
      return { promptCharacters: call.arguments.prompt.length };
  }
}

function summarizeToolResult(
  name: AgentToolCall["name"],
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { returned: typeof value };
  }
  const result = value as Record<string, unknown>;
  const keysByTool: Record<AgentToolCall["name"], readonly string[]> = {
    analyze_history: ["messageCount", "findingsCount"],
    search_knowledge: ["resultCount", "truncated"],
    search_verified_memory: ["available", "reason", "resultCount", "truncated"],
    get_source: ["sourceId", "chunkId", "characterCount"],
    estimate_tokens: ["estimatedTokens", "method"],
    inspect_capabilities: ["provider", "status", "capabilities"],
    validate_candidate: [
      "valid",
      "invariantStatus",
      "preservedCount",
      "missingCount",
    ],
    evaluate_subset: [
      "status",
      "passedChecks",
      "totalChecks",
      "passedCases",
      "totalCases",
    ],
    search_graph_entities: [
      "available",
      "resultCount",
      "pathCount",
      "evidenceCount",
      "snapshotId",
      "traceId",
    ],
    traverse_graph: ["nodeCount", "edgeCount", "pathCount", "clipped"],
    get_graph_evidence: ["resultCount"],
    get_graph_status: [
      "available",
      "revision",
      "entityCount",
      "assertionCount",
    ],
    call_codex_target: ["available", "status", "responseModel", "usage"],
  };
  const summary: Record<string, unknown> = {};
  for (const key of keysByTool[name]) {
    const item = result[key];
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      summary[key] = item;
    }
  }
  return summary;
}
