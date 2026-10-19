import { describe, expect, it, vi } from "vitest";
import type { AgentScope } from "@promptlab/tools";

import { runBoundedAgent } from "./index.js";

const scope: AgentScope = {
  projectId: "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
  allowedSourceIds: new Set(),
  allowedChunkIds: new Set(),
  allowedHistoryMessageIds: new Set(),
  developmentCaseIds: new Set(),
  candidateIds: new Set(),
  graphEntityIds: new Set(),
  graphAssertionIds: new Set(),
};

describe("bounded agent interface", () => {
  it("returns a public clarification before running tools", async () => {
    const tool = vi.fn(async () => ({ ok: true }));
    const events: Array<{ type: string; clarification?: unknown }> = [];
    const clarification = {
      question: "Untuk siapa panduan ini terutama digunakan?",
      reasonCode: "audience" as const,
      choices: ["Mahasiswa"],
      publicContext: "Audiens mengubah tingkat detail jawaban.",
    };
    const result = await runBoundedAgent({
      scope,
      handlers: { get_graph_status: tool },
      planner: async () => ({
        summary: "Saya memerlukan satu keputusan.",
        toolCalls: [],
        candidate: null,
        finish: false,
        clarificationRequired: true,
        clarification,
      }),
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("clarification_required");
    expect(result.clarification).toEqual(clarification);
    expect(tool).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: "agent.action",
      clarificationRequired: true,
      clarification,
    });
  });

  it("uses server handlers, reports only summaries, and stops on a finish decision", async () => {
    const events: string[] = [];
    const planner = vi.fn(async () => ({
      summary: "Tidak ada tool yang diperlukan.",
      finish: true,
    }));
    const result = await runBoundedAgent({
      scope,
      handlers: {},
      planner,
      onEvent: (event) => events.push(event.type),
    });

    expect(result).toMatchObject({
      status: "finished",
      candidate: null,
      toolCallCount: 0,
      decisionTurnCount: 1,
    });
    expect(events).toEqual(["agent.action", "agent.finished"]);
  });

  it("stops when the server tool-call budget is exhausted", async () => {
    const planner = vi.fn(async () => ({
      summary: "Periksa status graf.",
      toolCalls: [{ name: "get_graph_status", arguments: {} }],
    }));
    const result = await runBoundedAgent({
      scope,
      handlers: { get_graph_status: async () => ({ available: false }) },
      planner,
      budget: { maxToolCalls: 1, maxDecisionTurns: 4 },
    });

    expect(result.status).toBe("budget_exhausted");
    expect(result.toolCallCount).toBe(1);
  });

  it("records the selected tool name and a failure outcome without replacing the tool error", async () => {
    const events: Array<{
      type: string;
      selectedTools?: string[];
      toolName?: string;
      resultSummary?: Record<string, unknown>;
    }> = [];
    const toolError = new Error("private tool error detail");

    await expect(
      runBoundedAgent({
        scope,
        handlers: {
          get_graph_status: async () => {
            throw toolError;
          },
        },
        planner: async () => ({
          summary: "Run tool yang dipilih.",
          toolCalls: [{ name: "get_graph_status", arguments: {} }],
        }),
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toBe(toolError);

    expect(events).toEqual([
      expect.objectContaining({
        type: "agent.action",
        selectedTools: ["get_graph_status"],
      }),
      expect.objectContaining({
        type: "tool.started",
        toolName: "get_graph_status",
      }),
      expect.objectContaining({
        type: "tool.completed",
        toolName: "get_graph_status",
        resultSummary: { executionStatus: "failed" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private tool error detail");
  });

  it("rejects arbitrary shell tools before a handler can run", async () => {
    await expect(
      runBoundedAgent({
        scope,
        handlers: {},
        planner: async () => ({
          summary: "Try shell.",
          toolCalls: [{ name: "shell", arguments: { command: "ls" } }],
        }),
      }),
    ).rejects.toMatchObject({
      name: "AgentInterfaceError",
      code: "INVALID_TOOL_CALL",
      message: "Agent returned a tool call outside the allowed contract.",
    });
  });

  it("enforces candidate and revision caps across decision turns", async () => {
    let turn = 0;
    const result = await runBoundedAgent({
      scope,
      handlers: {},
      budget: { maxCandidates: 1, maxRevisions: 0 },
      planner: async () => {
        turn += 1;
        return {
          summary: `Candidate ${turn}`,
          candidate: {
            text: `draft ${turn}`,
            changeSummary: "Perubahan ringkas.",
            riskSummary: "Risiko belum diuji.",
            strategy: "Manual review",
          },
        };
      },
    });
    expect(result.status).toBe("budget_exhausted");
    expect(result.candidate?.text).toBe("draft 1");
  });
});
