import {
  AgentBudgetSchema,
  AgentToolCallSchema,
  GraphQueryBoundsSchema,
  type AgentBudget,
  type AgentBudgetInput,
  type AgentToolCall,
  type GraphQueryBounds,
} from "@promptlab/contracts";
import { z } from "zod";

export interface AgentScope {
  readonly projectId: string;
  readonly allowedSourceIds: ReadonlySet<string>;
  readonly allowedChunkIds: ReadonlySet<string>;
  readonly allowedHistoryMessageIds: ReadonlySet<string>;
  readonly developmentCaseIds: ReadonlySet<string>;
  readonly candidateIds: ReadonlySet<string>;
  readonly graphEntityIds: ReadonlySet<string>;
  readonly graphAssertionIds: ReadonlySet<string>;
}

export interface ToolContext {
  readonly scope: AgentScope;
  readonly signal: AbortSignal;
}

export type ToolHandler<TName extends AgentToolCall["name"]> = (
  args: Extract<AgentToolCall, { name: TName }>["arguments"],
  context: ToolContext,
) => Promise<unknown>;

export type ToolHandlers = Partial<{
  [TName in AgentToolCall["name"]]: ToolHandler<TName>;
}>;

export class ToolExecutionError extends Error {
  constructor(
    readonly code:
      | "INVALID_TOOL_CALL"
      | "TOOL_BUDGET_EXCEEDED"
      | "TOOL_NOT_AVAILABLE"
      | "PROJECT_SCOPE_VIOLATION"
      | "HOLDOUT_ACCESS_DENIED"
      | "ABORTED",
    message: string,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export class AgentBudgetLedger {
  readonly limits: AgentBudget;
  private toolCalls = 0;
  private decisionTurns = 0;
  private candidates = 0;
  private revisions = 0;
  private readonly deadlineAt: number;

  constructor(budget: AgentBudgetInput = {}, now = Date.now()) {
    this.limits = AgentBudgetSchema.parse({
      maxDecisionTurns: budget.maxDecisionTurns,
      maxToolCalls: budget.maxToolCalls,
      maxCandidates: budget.maxCandidates,
      maxRevisions: budget.maxRevisions,
      maxDurationMs: budget.maxDurationMs,
      graph: budget.graph,
    });
    this.deadlineAt = now + this.limits.maxDurationMs;
  }

  get toolCallCount(): number {
    return this.toolCalls;
  }

  get decisionTurnCount(): number {
    return this.decisionTurns;
  }

  get candidateCount(): number {
    return this.candidates;
  }

  get revisionCount(): number {
    return this.revisions;
  }

  get remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  beginDecisionTurn(now = Date.now()): void {
    this.assertTime(now);
    if (this.decisionTurns >= this.limits.maxDecisionTurns) {
      throw new ToolExecutionError(
        "TOOL_BUDGET_EXCEEDED",
        "Decision-turn budget exhausted",
      );
    }
    this.decisionTurns += 1;
  }

  reserveToolCall(now = Date.now()): void {
    this.assertTime(now);
    if (this.toolCalls >= this.limits.maxToolCalls) {
      throw new ToolExecutionError(
        "TOOL_BUDGET_EXCEEDED",
        "Tool-call budget exhausted",
      );
    }
    this.toolCalls += 1;
  }

  reserveCandidate(isRevision: boolean, now = Date.now()): void {
    this.assertTime(now);
    if (this.candidates >= this.limits.maxCandidates) {
      throw new ToolExecutionError(
        "TOOL_BUDGET_EXCEEDED",
        "Candidate budget exhausted",
      );
    }
    if (isRevision && this.revisions >= this.limits.maxRevisions) {
      throw new ToolExecutionError(
        "TOOL_BUDGET_EXCEEDED",
        "Revision budget exhausted",
      );
    }
    this.candidates += 1;
    if (isRevision) this.revisions += 1;
  }

  private assertTime(now: number): void {
    if (now >= this.deadlineAt) {
      throw new ToolExecutionError(
        "TOOL_BUDGET_EXCEEDED",
        "Agent wall-clock budget exhausted",
      );
    }
  }
}

const safeIdArray = z.array(z.uuid());

export function clampGraphBounds(
  requested: Partial<GraphQueryBounds>,
  budget: GraphQueryBounds,
): GraphQueryBounds {
  const requestedBounds = GraphQueryBoundsSchema.parse({
    maxSeeds: requested.maxSeeds ?? budget.maxSeeds,
    maxHops: requested.maxHops ?? budget.maxHops,
    maxNeighborsPerExpansion:
      requested.maxNeighborsPerExpansion ?? budget.maxNeighborsPerExpansion,
    maxNodes: requested.maxNodes ?? budget.maxNodes,
    maxEdges: requested.maxEdges ?? budget.maxEdges,
    maxPaths: requested.maxPaths ?? budget.maxPaths,
    maxEstimatedContextTokens:
      requested.maxEstimatedContextTokens ?? budget.maxEstimatedContextTokens,
  });

  return {
    maxSeeds: Math.min(requestedBounds.maxSeeds, budget.maxSeeds),
    maxHops: Math.min(requestedBounds.maxHops, budget.maxHops),
    maxNeighborsPerExpansion: Math.min(
      requestedBounds.maxNeighborsPerExpansion,
      budget.maxNeighborsPerExpansion,
    ),
    maxNodes: Math.min(requestedBounds.maxNodes, budget.maxNodes),
    maxEdges: Math.min(requestedBounds.maxEdges, budget.maxEdges),
    maxPaths: Math.min(requestedBounds.maxPaths, budget.maxPaths),
    maxEstimatedContextTokens: Math.min(
      requestedBounds.maxEstimatedContextTokens,
      budget.maxEstimatedContextTokens,
    ),
  };
}

export function createToolExecutor(
  handlers: ToolHandlers,
  ledger: AgentBudgetLedger,
) {
  return {
    async execute(rawCall: unknown, context: ToolContext): Promise<unknown> {
      if (context.signal.aborted) {
        throw new ToolExecutionError("ABORTED", "Tool execution was canceled");
      }

      const parsed = AgentToolCallSchema.safeParse(rawCall);
      if (!parsed.success) {
        throw new ToolExecutionError(
          "INVALID_TOOL_CALL",
          "Tool call did not match its server schema",
        );
      }

      ledger.reserveToolCall();
      const output = dispatch(parsed.data, handlers, context, ledger);
      return raceAbort(output, context.signal);
    },
  };
}

function raceAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new ToolExecutionError("ABORTED", "Tool execution was canceled"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new ToolExecutionError("ABORTED", "Tool execution was canceled"));
    signal.addEventListener("abort", onAbort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function dispatch(
  call: AgentToolCall,
  handlers: ToolHandlers,
  context: ToolContext,
  ledger: AgentBudgetLedger,
): Promise<unknown> {
  const boundedCall = enforceScopeAndBounds(call, context.scope, ledger);

  const handler = handlers[boundedCall.name] as
    | ((
        args: AgentToolCall["arguments"],
        context: ToolContext,
      ) => Promise<unknown>)
    | undefined;

  if (!handler) {
    throw new ToolExecutionError(
      "TOOL_NOT_AVAILABLE",
      `Tool ${boundedCall.name} is not implemented`,
    );
  }

  return handler(boundedCall.arguments as AgentToolCall["arguments"], context);
}

function enforceScopeAndBounds(
  call: AgentToolCall,
  scope: AgentScope,
  ledger: AgentBudgetLedger,
): AgentToolCall {
  if (call.name === "analyze_history") {
    assertIdsInScope(call.arguments.messageIds, scope.allowedHistoryMessageIds);
  }
  if (call.name === "search_knowledge" && call.arguments.sourceIds) {
    assertIdsInScope(call.arguments.sourceIds, scope.allowedSourceIds);
  }
  if (call.name === "get_source") {
    assertIdsInScope([call.arguments.chunkId], scope.allowedChunkIds);
  }
  if (call.name === "evaluate_subset") {
    assertIdsInScope(
      call.arguments.developmentCaseIds,
      scope.developmentCaseIds,
    );
    assertIdsInScope([call.arguments.candidateId], scope.candidateIds);
  }
  if (call.name === "traverse_graph") {
    assertIdsInScope(call.arguments.seedEntityIds, scope.graphEntityIds);
    const bounds = clampGraphBounds(
      {
        maxSeeds: call.arguments.seedEntityIds.length,
        maxHops: call.arguments.maxHops,
        maxNeighborsPerExpansion: call.arguments.maxNeighborsPerExpansion,
        maxNodes: call.arguments.maxNodes,
        maxEdges: call.arguments.maxEdges,
        maxPaths: call.arguments.maxPaths,
        maxEstimatedContextTokens: call.arguments.maxEstimatedContextTokens,
      },
      ledger.limits.graph,
    );
    return {
      ...call,
      arguments: {
        ...call.arguments,
        maxHops: bounds.maxHops,
        maxNeighborsPerExpansion: bounds.maxNeighborsPerExpansion,
        maxNodes: bounds.maxNodes,
        maxEdges: bounds.maxEdges,
        maxPaths: bounds.maxPaths,
        maxEstimatedContextTokens: bounds.maxEstimatedContextTokens,
      },
    };
  }
  if (call.name === "search_graph_entities") {
    return {
      ...call,
      arguments: {
        ...call.arguments,
        limit: Math.min(call.arguments.limit, ledger.limits.graph.maxSeeds),
      },
    };
  }
  if (call.name === "search_verified_memory") {
    return {
      ...call,
      arguments: {
        ...call.arguments,
        limit: Math.min(call.arguments.limit, 5),
      },
    };
  }
  if (call.name === "get_graph_evidence") {
    assertIdsInScope(call.arguments.assertionIds, scope.graphAssertionIds);
    if (call.arguments.assertionIds.length > ledger.limits.graph.maxEdges) {
      throw new ToolExecutionError(
        "TOOL_BUDGET_EXCEEDED",
        "Graph evidence request exceeds the graph edge budget",
      );
    }
  }
  return call;
}

function assertIdsInScope(
  ids: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  const parsedIds = safeIdArray.safeParse(ids);
  if (!parsedIds.success || ids.some((id) => !allowed.has(id))) {
    throw new ToolExecutionError(
      "PROJECT_SCOPE_VIOLATION",
      "Requested resource is outside server scope",
    );
  }
}
