import { describe, expect, it, vi } from "vitest";

import {
  AgentBudgetLedger,
  ToolExecutionError,
  clampGraphBounds,
  createToolExecutor,
  type AgentScope,
} from "./executor.js";

const scope: AgentScope = {
  projectId: "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
  allowedSourceIds: new Set(["1ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
  allowedChunkIds: new Set(["5ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
  allowedHistoryMessageIds: new Set(["6ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
  developmentCaseIds: new Set(["2ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
  candidateIds: new Set(["7ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
  graphEntityIds: new Set(["8ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
  graphAssertionIds: new Set(["9ab1d010-a1bb-4dc8-a520-12b6270fb8b3"]),
};

describe("bounded tool executor", () => {
  it("injects project scope from the server and rejects caller-supplied scope", async () => {
    const handler = vi.fn(async (_args, context) => ({
      projectId: context.scope.projectId,
    }));
    const executor = createToolExecutor(
      { get_graph_status: handler },
      new AgentBudgetLedger(),
    );
    const controller = new AbortController();

    await expect(
      executor.execute(
        { name: "get_graph_status", arguments: { projectId: scope.projectId } },
        { scope, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_CALL" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a source outside the server-selected project", async () => {
    const executor = createToolExecutor(
      { search_knowledge: vi.fn(async () => []) },
      new AgentBudgetLedger(),
    );
    const controller = new AbortController();

    await expect(
      executor.execute(
        {
          name: "search_knowledge",
          arguments: {
            query: "queue order",
            sourceIds: ["3ab1d010-a1bb-4dc8-a520-12b6270fb8b3"],
            limit: 5,
          },
        },
        { scope, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
  });

  it("refuses holdout ids even when they are valid UUIDs", async () => {
    const executor = createToolExecutor(
      { evaluate_subset: vi.fn(async () => []) },
      new AgentBudgetLedger(),
    );
    const controller = new AbortController();

    await expect(
      executor.execute(
        {
          name: "evaluate_subset",
          arguments: {
            candidateId: "7ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
            developmentCaseIds: ["4ab1d010-a1bb-4dc8-a520-12b6270fb8b3"],
          },
        },
        { scope, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
  });

  it("has no shell, filesystem, network, or SQL tool names", () => {
    const executor = createToolExecutor({}, new AgentBudgetLedger());

    return expect(
      executor.execute(
        { name: "shell", arguments: { command: "id" } },
        { scope, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_CALL" });
  });

  it("accepts each retrieval maximum and clamps it to the run budget", () => {
    const hardLimits = {
      maxSeeds: 2,
      maxHops: 2,
      maxNeighborsPerExpansion: 20,
      maxNodes: 30,
      maxEdges: 60,
      maxPaths: 3,
      maxEstimatedContextTokens: 3_000,
    } as const;
    const runBudget = {
      maxSeeds: 1,
      maxHops: 1,
      maxNeighborsPerExpansion: 8,
      maxNodes: 20,
      maxEdges: 30,
      maxPaths: 2,
      maxEstimatedContextTokens: 1_000,
    };

    expect(clampGraphBounds(hardLimits, runBudget)).toEqual(runBudget);
  });

  it.each([
    ["maxSeeds", 2],
    ["maxHops", 2],
    ["maxNeighborsPerExpansion", 20],
    ["maxNodes", 30],
    ["maxEdges", 60],
    ["maxPaths", 3],
    ["maxEstimatedContextTokens", 3_000],
  ] as const)("rejects %s above its hard maximum", (bound, maximum) => {
    const hardLimits = {
      maxSeeds: 2,
      maxHops: 2,
      maxNeighborsPerExpansion: 20,
      maxNodes: 30,
      maxEdges: 60,
      maxPaths: 3,
      maxEstimatedContextTokens: 3_000,
    } as const;

    expect(() =>
      clampGraphBounds({ [bound]: maximum + 1 }, hardLimits),
    ).toThrow();
  });

  it("requires each graph seed to belong to the selected project scope", async () => {
    const executor = createToolExecutor(
      { traverse_graph: vi.fn(async (args) => args) },
      new AgentBudgetLedger(),
    );
    await expect(
      executor.execute(
        {
          name: "traverse_graph",
          arguments: {
            seedEntityIds: ["4ab1d010-a1bb-4dc8-a520-12b6270fb8b3"],
          },
        },
        { scope, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
  });

  it("passes only server-clamped traversal bounds to the handler", async () => {
    const handler = vi.fn(async (args) => args);
    const executor = createToolExecutor(
      { traverse_graph: handler },
      new AgentBudgetLedger({ graph: { maxHops: 1, maxNodes: 8 } }),
    );
    await executor.execute(
      {
        name: "traverse_graph",
        arguments: {
          seedEntityIds: ["8ab1d010-a1bb-4dc8-a520-12b6270fb8b3"],
          maxHops: 2,
          maxNodes: 30,
        },
      },
      { scope, signal: new AbortController().signal },
    );
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      maxHops: 1,
      maxNodes: 8,
    });
  });

  it("caps graph search results to the server seed budget", async () => {
    const handler = vi.fn(async (args) => args);
    const executor = createToolExecutor(
      { search_graph_entities: handler },
      new AgentBudgetLedger({ graph: { maxSeeds: 1 } }),
    );
    await executor.execute(
      {
        name: "search_graph_entities",
        arguments: { query: "prompt evaluation", limit: 10 },
      },
      { scope, signal: new AbortController().signal },
    );
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ limit: 1 });
  });

  it("caps verified-memory search results at five before dispatch", async () => {
    const handler = vi.fn(async (args) => args);
    const executor = createToolExecutor(
      { search_verified_memory: handler },
      new AgentBudgetLedger(),
    );
    await executor.execute(
      {
        name: "search_verified_memory",
        arguments: { query: "current task", limit: 20 },
      },
      { scope, signal: new AbortController().signal },
    );

    expect(handler.mock.calls[0]?.[0]).toMatchObject({ limit: 5 });
  });

  it("rejects graph evidence requests above the edge budget", async () => {
    const assertionIds = [
      "9ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
      "9ab1d010-a1bb-4dc8-a520-12b6270fb8b4",
    ];
    const handler = vi.fn(async () => []);
    const executor = createToolExecutor(
      { get_graph_evidence: handler },
      new AgentBudgetLedger({ graph: { maxEdges: 1 } }),
    );
    await expect(
      executor.execute(
        { name: "get_graph_evidence", arguments: { assertionIds } },
        {
          scope: {
            ...scope,
            graphAssertionIds: new Set(assertionIds),
          },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "TOOL_BUDGET_EXCEEDED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("charges each valid tool call before handler execution and stops at budget", async () => {
    const handler = vi.fn(async () => ({}));
    const ledger = new AgentBudgetLedger({ maxToolCalls: 1 });
    const executor = createToolExecutor({ get_graph_status: handler }, ledger);
    const context = { scope, signal: new AbortController().signal };
    const call = { name: "get_graph_status", arguments: {} };

    await executor.execute(call, context);
    await expect(executor.execute(call, context)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
    expect(ledger.toolCallCount).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
