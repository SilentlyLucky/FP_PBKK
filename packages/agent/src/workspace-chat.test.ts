import { describe, expect, it, vi } from "vitest";

import {
  runWorkspaceChatAgent,
  WORKSPACE_CHAT_BUDGET,
  type AgentPlannerContext,
} from "./index.js";

const scope = {
  projectId: "1aab9ee1-9421-4643-aac0-a8e96d56c1f2",
  allowedSourceIds: new Set<string>(),
  allowedChunkIds: new Set<string>(),
  allowedHistoryMessageIds: new Set<string>(),
  developmentCaseIds: new Set<string>(),
  candidateIds: new Set<string>(),
  graphEntityIds: new Set<string>(),
  graphAssertionIds: new Set<string>(),
};

function completed(answer: string) {
  return {
    summary: "Senopati menyelesaikan permintaan.",
    toolCalls: [],
    candidate: null,
    finalText: answer,
    finish: true,
    clarificationRequired: false,
    clarification: null,
  };
}

describe("workspace chat agent", () => {
  it("answers directly without making a target call for a simple message", async () => {
    const target = vi.fn(async () => ({ available: true, text: "target" }));
    const result = await runWorkspaceChatAgent({
      scope,
      handlers: { call_codex_target: target },
      planner: async () => completed("Halo! Ada yang bisa saya bantu?"),
    });

    expect(result).toMatchObject({
      status: "finished",
      finalText: "Halo! Ada yang bisa saya bantu?",
      toolCallCount: 0,
      decisionTurnCount: 1,
    });
    expect(target).not.toHaveBeenCalled();
    expect(WORKSPACE_CHAT_BUDGET).toMatchObject({
      maxDecisionTurns: 5,
      maxToolCalls: 8,
      maxCandidates: 1,
      maxRevisions: 0,
    });
  });

  it("allows a contextual recommendation without activating or evaluating it", async () => {
    const candidate = {
      text: "Jelaskan konsep dengan satu contoh singkat.",
      changeSummary: "Menambahkan contoh ringkas.",
      riskSummary: "Belum diuji pada contoh representatif.",
      strategy: "Perjelas format jawaban.",
    };
    const onEvent = vi.fn();
    const result = await runWorkspaceChatAgent({
      scope,
      handlers: {},
      onEvent,
      planner: async () => ({
        ...completed("Saya menyiapkan saran yang belum diuji."),
        candidate,
      }),
    });

    expect(result).toMatchObject({
      status: "finished",
      candidate,
      finalText: "Saya menyiapkan saran yang belum diuji.",
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "candidate.proposed", candidate }),
    );
  });

  it("represents an explicit no-change recommendation separately from an ordinary answer", async () => {
    const result = await runWorkspaceChatAgent({
      scope,
      handlers: {},
      planner: async () => ({
        ...completed("Prompt ini sudah sesuai untuk tugas yang diminta."),
        noChangeRecommended: true,
      }),
    });

    expect(result).toMatchObject({
      status: "finished",
      candidate: null,
      noChangeRecommended: true,
      finalText: "Prompt ini sudah sesuai untuk tugas yang diminta.",
    });
  });

  it("rejects a no-change recommendation combined with an untested candidate", async () => {
    await expect(
      runWorkspaceChatAgent({
        scope,
        handlers: {},
        planner: async () => ({
          ...completed("Saya punya saran."),
          noChangeRecommended: true,
          candidate: {
            text: "Gunakan saran ini.",
            changeSummary: "Perubahan ringkas.",
            riskSummary: "Belum diuji.",
            strategy: "Perjelas.",
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_DECISION" });
  });

  it("keeps a clarifying turn separate from a completed answer", async () => {
    const result = await runWorkspaceChatAgent({
      scope,
      handlers: {},
      planner: async () => ({
        summary: "Senopati meminta satu keputusan.",
        toolCalls: [],
        candidate: null,
        finalText: null,
        finish: false,
        clarificationRequired: true,
        clarification: {
          question: "Apakah jawaban ini ditujukan untuk pemula atau ahli?",
          reasonCode: "audience",
          choices: ["Pemula", "Ahli"],
          publicContext: "Tingkat detail akan berbeda.",
        },
      }),
    });

    expect(result.status).toBe("clarification_required");
    expect(result.finalText).toBeNull();
    expect(result.clarification?.reasonCode).toBe("audience");
  });

  it("limits Codex delegation to one target request per chat", async () => {
    const target = vi.fn(async () => ({
      available: true,
      responseModel: "gpt-6-codex",
    }));
    const planner = vi
      .fn()
      .mockResolvedValueOnce({
        summary: "Saya meminta satu jawaban target.",
        toolCalls: [
          {
            name: "call_codex_target",
            arguments: { prompt: "Jawab singkat." },
          },
        ],
        candidate: null,
        finalText: null,
        finish: false,
        clarificationRequired: false,
        clarification: null,
      })
      .mockResolvedValueOnce({
        summary: "Saya memeriksa satu jawaban target.",
        toolCalls: [
          { name: "call_codex_target", arguments: { prompt: "Coba lagi." } },
        ],
        candidate: null,
        finalText: null,
        finish: false,
        clarificationRequired: false,
        clarification: null,
      })
      .mockResolvedValueOnce(completed("Saya sudah meninjau jawabannya."));

    const result = await runWorkspaceChatAgent({
      scope,
      handlers: { call_codex_target: target },
      planner,
    });

    expect(result.finalText).toBe("Saya sudah meninjau jawabannya.");
    expect(target).toHaveBeenCalledTimes(1);
    expect(result.toolCallCount).toBe(2);
  });

  it("returns an incomplete bounded result instead of inventing an answer", async () => {
    const result = await runWorkspaceChatAgent({
      scope,
      handlers: {},
      planner: async () => ({
        summary: "Senopati masih mengumpulkan konteks.",
        toolCalls: [],
        candidate: null,
        finalText: null,
        finish: false,
        clarificationRequired: false,
        clarification: null,
      }),
    });

    expect(result).toMatchObject({
      status: "budget_exhausted",
      finalText: null,
      decisionTurnCount: 5,
    });
  });

  describe("mandatory prompt optimization", () => {
    const originalPrompt = "Permintaan pengguna saat ini:\nJelaskan konsep.";
    const mandatoryOptimization = { originalPrompt };
    const candidate = {
      text: "Jelaskan konsep dalam tiga langkah dan beri satu contoh.",
      changeSummary: "Menambahkan struktur dan contoh.",
      riskSummary: "Gaya tiga langkah mungkin tidak cocok untuk semua topik.",
      strategy: "Memperjelas bentuk jawaban.",
    };

    it("executes the optimized candidate and returns only the target answer", async () => {
      const target = vi.fn(async ({ prompt }: { prompt: string }) => ({
        available: true,
        text: `Codex menjawab dengan: ${prompt}`,
      }));
      const planner = vi.fn(async () => ({
        ...completed("Prompt sudah dioptimasi."),
        candidate,
      }));

      const result = await runWorkspaceChatAgent({
        scope,
        handlers: { call_codex_target: target },
        mandatoryOptimization,
        planner,
      });

      expect(target).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(
        { prompt: candidate.text },
        expect.anything(),
      );
      expect(planner).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: "finished",
        candidate,
        noChangeRecommended: false,
        finalText: `Codex menjawab dengan: ${candidate.text}`,
        toolCallCount: 1,
        decisionTurnCount: 2,
      });
    });

    it("prefetches verified memory before optimization, captures source detail, then calls one target", async () => {
      const memory = vi.fn(async () => ({
        available: true,
        reason: null,
        resultCount: 1,
        truncated: false,
        memories: [{ internalDiagnostic: "must not be logged" }],
      }));
      const searchKnowledge = vi.fn(async () => ({
        resultCount: 1,
        chunkIds: ["101b0d10-a1bb-4dc8-a520-12b6270fb8b3"],
      }));
      const getSource = vi.fn(async () => ({
        sourceId: "source-a",
        chunkId: "101b0d10-a1bb-4dc8-a520-12b6270fb8b3",
        text: "Frozen source detail.",
      }));
      const target = vi.fn(async ({ prompt }: { prompt: string }) => ({
        available: true,
        text: `Codex answered: ${prompt}`,
      }));
      const events: unknown[] = [];
      const plannerContexts: AgentPlannerContext[] = [];
      const plannedResponses = vi
        .fn()
        .mockResolvedValueOnce({
          summary: "Saya mencari sumber terpilih.",
          toolCalls: [
            {
              name: "search_knowledge",
              arguments: { query: "konsep", limit: 5 },
            },
          ],
          candidate: null,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          clarificationRequired: false,
          clarification: null,
        })
        .mockResolvedValueOnce({
          summary: "Saya membaca satu kutipan sumber lengkap.",
          toolCalls: [
            {
              name: "get_source",
              arguments: { chunkId: "101b0d10-a1bb-4dc8-a520-12b6270fb8b3" },
            },
          ],
          candidate: null,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          clarificationRequired: false,
          clarification: null,
        })
        .mockResolvedValueOnce({
          summary: "Saya menyiapkan prompt untuk Codex.",
          toolCalls: [],
          candidate,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          clarificationRequired: false,
          clarification: null,
        });
      const planner = async (context: AgentPlannerContext) => {
        plannerContexts.push(context);
        return plannedResponses();
      };

      const result = await runWorkspaceChatAgent({
        scope: {
          ...scope,
          allowedSourceIds: new Set(["source-a"]),
          allowedChunkIds: new Set(["101b0d10-a1bb-4dc8-a520-12b6270fb8b3"]),
        },
        handlers: {
          search_verified_memory: memory,
          search_knowledge: searchKnowledge,
          get_source: getSource,
          call_codex_target: target,
        },
        mandatoryOptimization: {
          ...mandatoryOptimization,
          requireVerifiedMemorySearch: true,
        },
        planner,
        onEvent: (event) => events.push(event),
      });

      expect(memory).toHaveBeenCalledTimes(1);
      expect(memory).toHaveBeenCalledWith(
        { query: originalPrompt, limit: 5 },
        expect.objectContaining({
          scope: expect.objectContaining({ projectId: scope.projectId }),
        }),
      );
      expect(searchKnowledge).toHaveBeenCalledTimes(1);
      expect(getSource).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledTimes(1);
      expect(plannerContexts[0]?.priorToolResults[0]).toMatchObject({
        available: true,
        memories: [{ internalDiagnostic: "must not be logged" }],
      });
      expect(plannerContexts[2]?.priorToolResults[2]).toMatchObject({
        text: "Frozen source detail.",
      });
      expect(target).toHaveBeenCalledWith(
        { prompt: candidate.text },
        expect.anything(),
      );
      expect(result).toMatchObject({
        status: "finished",
        candidate,
        finalText: `Codex answered: ${candidate.text}`,
        toolCallCount: 4,
        decisionTurnCount: 4,
      });
      const memoryEvent = events.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "toolName" in event &&
          event.toolName === "search_verified_memory" &&
          "resultSummary" in event,
      );
      expect(memoryEvent).toMatchObject({
        resultSummary: {
          available: true,
          reason: null,
          resultCount: 1,
          truncated: false,
        },
      });
      expect(JSON.stringify(events)).not.toContain("must not be logged");
      expect(
        events.findIndex(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "tool.started" &&
            "toolName" in event &&
            event.toolName === "search_verified_memory",
        ),
      ).toBeLessThan(
        events.findIndex(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "agent.action" &&
            "turn" in event &&
            event.turn === 1,
        ),
      );
    });

    it("fails before optimizer egress when required memory is unavailable", async () => {
      const target = vi.fn(async () => ({ available: true, text: "target" }));
      const planner = vi.fn(async () => ({ ...completed("Siap."), candidate }));
      const memory = vi.fn(async () => ({
        available: false,
        reason: "frozen_sources_stale",
        resultCount: 0,
        truncated: false,
        memories: [],
      }));

      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: {
            search_verified_memory: memory,
            call_codex_target: target,
          },
          mandatoryOptimization: {
            ...mandatoryOptimization,
            requireVerifiedMemorySearch: true,
          },
          planner,
        }),
      ).rejects.toThrow("WORKSPACE_CHAT_VERIFIED_MEMORY_UNAVAILABLE");

      expect(memory).toHaveBeenCalledTimes(1);
      expect(planner).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
    });

    it("bounds the verified-memory query to the trimmed current prompt", async () => {
      const userPrompt = `  ${"Jelaskan konsep ini. ".repeat(160)}  `;
      const memory = vi.fn(async () => ({ available: true }));
      const target = vi.fn(async () => ({ available: true, text: "target" }));

      await runWorkspaceChatAgent({
        scope,
        handlers: { search_verified_memory: memory, call_codex_target: target },
        mandatoryOptimization: {
          originalPrompt: userPrompt,
          requireVerifiedMemorySearch: true,
        },
        planner: async () => ({ ...completed("Prompt siap."), candidate }),
      });

      expect(memory).toHaveBeenCalledWith(
        { query: userPrompt.trim().slice(0, 2_000), limit: 5 },
        expect.anything(),
      );
    });

    it("keeps required GraphRAG retrieval on the first optimizer turn after memory prefetch", async () => {
      const memory = vi.fn(async () => ({
        available: true,
        reason: "no_matching_verified_memories",
        resultCount: 0,
        truncated: false,
        memories: [],
      }));
      const graph = vi.fn(async () => ({ available: true, resultCount: 1 }));
      const target = vi.fn(async ({ prompt }: { prompt: string }) => ({
        available: true,
        text: `Target: ${prompt}`,
      }));
      const planner = vi
        .fn()
        .mockResolvedValueOnce({
          summary: "Saya mencari bukti GraphRAG terpilih.",
          toolCalls: [
            {
              name: "search_graph_entities",
              arguments: { query: "konsep", limit: 5 },
            },
          ],
          candidate: null,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          clarificationRequired: false,
          clarification: null,
        })
        .mockResolvedValueOnce({
          ...completed("Prompt siap."),
          candidate,
        });

      const result = await runWorkspaceChatAgent({
        scope,
        handlers: {
          search_verified_memory: memory,
          search_graph_entities: graph,
          call_codex_target: target,
        },
        mandatoryOptimization: {
          ...mandatoryOptimization,
          requireVerifiedMemorySearch: true,
          requireGraphSearch: true,
        },
        planner,
      });

      expect(memory).toHaveBeenCalledTimes(1);
      expect(graph).toHaveBeenCalledTimes(1);
      expect(planner).toHaveBeenCalledTimes(2);
      expect(planner.mock.calls[0]?.[0].turn).toBe(1);
      expect(planner.mock.calls[0]?.[0].priorToolResults[0]).toMatchObject({
        available: true,
        resultCount: 0,
      });
      expect(target).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: "finished",
        decisionTurnCount: 3,
      });
    });

    it("keeps the optimizer call count unchanged with or without verified-memory support", async () => {
      const runSimpleRequest = async (memoryResult?: {
        available: true;
        reason: null | "no_matching_verified_memories";
        resultCount: number;
        truncated: false;
        guidance: string;
        memories: Array<{
          task: string;
          strategy: { candidatePrompt: string };
        }>;
      }) => {
        const callOrder: string[] = [];
        const events: unknown[] = [];
        const contexts: AgentPlannerContext[] = [];
        const memory = vi.fn(async () => {
          callOrder.push("memory");
          return memoryResult;
        });
        const target = vi.fn(async ({ prompt }: { prompt: string }) => {
          callOrder.push("target");
          return { available: true, text: `Target: ${prompt}` };
        });
        const planner = vi.fn(async (context: AgentPlannerContext) => {
          callOrder.push("planner");
          contexts.push(context);
          return { ...completed("Prompt siap."), candidate };
        });
        const result = await runWorkspaceChatAgent({
          scope,
          handlers: {
            ...(memoryResult ? { search_verified_memory: memory } : {}),
            call_codex_target: target,
          },
          mandatoryOptimization: {
            ...mandatoryOptimization,
            ...(memoryResult ? { requireVerifiedMemorySearch: true } : {}),
          },
          planner,
          onEvent: (event) => events.push(event),
        });

        expect(planner).toHaveBeenCalledTimes(1);
        expect(target).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          status: "finished",
          decisionTurnCount: 2,
        });
        return {
          memoryCalls: memory.mock.calls.length,
          plannerCalls: planner.mock.calls.length,
          contexts,
          callOrder,
          events,
        };
      };

      const withoutMemory = await runSimpleRequest();
      const emptyMemory = await runSimpleRequest({
        available: true,
        reason: "no_matching_verified_memories",
        resultCount: 0,
        truncated: false,
        guidance: "No verified development memories matched.",
        memories: [],
      });
      const memoryContent = "bounded runtime candidate guidance";
      const withMemory = await runSimpleRequest({
        available: true,
        reason: null,
        resultCount: 1,
        truncated: false,
        guidance: "Use prior accepted development context as a reference.",
        memories: [
          {
            task: "A related development task.",
            strategy: { candidatePrompt: memoryContent },
          },
        ],
      });

      expect(emptyMemory.plannerCalls).toBe(withoutMemory.plannerCalls);
      expect(withMemory.plannerCalls).toBe(withoutMemory.plannerCalls);
      expect(emptyMemory.memoryCalls).toBe(1);
      expect(withMemory.memoryCalls).toBe(1);
      expect(emptyMemory.contexts[0]?.priorToolResults[0]).toMatchObject({
        available: true,
        resultCount: 0,
        memories: [],
      });
      expect(withMemory.contexts[0]?.priorToolResults[0]).toMatchObject({
        available: true,
        guidance: "Use prior accepted development context as a reference.",
        memories: [{ strategy: { candidatePrompt: memoryContent } }],
      });
      expect(withMemory.contexts[0]?.priorToolResults[0]).not.toHaveProperty(
        "modelId",
      );
      expect(withMemory.callOrder.indexOf("memory")).toBeLessThan(
        withMemory.callOrder.indexOf("planner"),
      );
      expect(emptyMemory.callOrder.indexOf("memory")).toBeLessThan(
        emptyMemory.callOrder.indexOf("planner"),
      );
      expect(JSON.stringify(withMemory.events)).not.toContain(memoryContent);
    });

    it("sends the original prompt after an explicit no-op decision", async () => {
      const target = vi.fn(async ({ prompt }: { prompt: string }) => ({
        available: true,
        text: `Target menerima ${prompt}`,
      }));
      const planner = vi.fn(async () => ({
        ...completed("Prompt sudah memadai; saya akan meneruskannya."),
        noChangeRecommended: true,
      }));

      const result = await runWorkspaceChatAgent({
        scope,
        handlers: { call_codex_target: target },
        mandatoryOptimization,
        planner,
      });

      expect(target).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(
        { prompt: originalPrompt },
        expect.anything(),
      );
      expect(result).toMatchObject({
        status: "finished",
        noChangeRecommended: true,
        finalText: `Target menerima ${originalPrompt}`,
        toolCallCount: 1,
      });
    });

    it("rejects a direct answer or optimizer-authored target prompt", async () => {
      const target = vi.fn(async () => ({ available: true, text: "target" }));
      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: { call_codex_target: target },
          mandatoryOptimization,
          planner: async () => completed("Jawaban langsung dari Senopati."),
        }),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_DECISION" });

      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: { call_codex_target: target },
          mandatoryOptimization,
          planner: async () => ({ summary: "JSON tidak lengkap" }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_DECISION" });

      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: { call_codex_target: target },
          mandatoryOptimization,
          planner: async () => ({
            summary: "Prompt disarankan.",
            noChangeRecommended: false,
            finalText: null,
            finish: false,
            clarificationRequired: false,
            clarification: null,
            candidate,
            toolCalls: [
              {
                name: "call_codex_target",
                arguments: { prompt: "Prompt lain yang dipilih Senopati." },
              },
            ],
          }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_TOOL_CALL" });

      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: { call_codex_target: target },
          mandatoryOptimization,
          planner: async () => ({
            ...completed("Tidak ada perubahan."),
            candidate: {
              ...candidate,
              text: originalPrompt,
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_DECISION" });

      expect(target).not.toHaveBeenCalled();
    });

    it("fails closed when the target is missing or returns unavailable", async () => {
      const planner = vi.fn(async () => ({
        ...completed("Prompt sudah dioptimasi."),
        candidate,
      }));

      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: {},
          mandatoryOptimization,
          planner,
        }),
      ).rejects.toThrow("WORKSPACE_CHAT_TARGET_UNAVAILABLE");
      expect(planner).not.toHaveBeenCalled();

      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: {
            call_codex_target: async () => ({
              available: false,
              status: "target_not_verified",
            }),
          },
          mandatoryOptimization,
          planner,
        }),
      ).rejects.toThrow("WORKSPACE_CHAT_TARGET_UNAVAILABLE");
    });

    it("lets an optimizer clarification pause before any target call", async () => {
      const target = vi.fn(async () => ({ available: true, text: "target" }));
      const result = await runWorkspaceChatAgent({
        scope,
        handlers: { call_codex_target: target },
        mandatoryOptimization,
        planner: async () => ({
          summary: "Senopati meminta batasan penting.",
          toolCalls: [],
          candidate: null,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          clarificationRequired: true,
          clarification: {
            question: "Apakah jawabannya untuk pemula atau ahli?",
            reasonCode: "audience",
            choices: ["Pemula", "Ahli"],
            publicContext: "Tingkat detailnya akan berbeda.",
          },
        }),
      });

      expect(result.status).toBe("clarification_required");
      expect(target).not.toHaveBeenCalled();
    });

    it("permits selected source retrieval before requiring an optimization decision", async () => {
      const target = vi.fn(async ({ prompt }: { prompt: string }) => ({
        available: true,
        text: `Target: ${prompt}`,
      }));
      const searchKnowledge = vi.fn(async () => ({ resultCount: 1 }));
      const planner = vi
        .fn()
        .mockResolvedValueOnce({
          summary: "Senopati memeriksa sumber yang dipilih.",
          toolCalls: [
            {
              name: "search_knowledge",
              arguments: { query: "konsep", sourceIds: [] },
            },
          ],
          candidate: null,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          clarificationRequired: false,
          clarification: null,
        })
        .mockResolvedValueOnce({
          ...completed("Prompt sudah dioptimasi."),
          candidate,
        });

      const result = await runWorkspaceChatAgent({
        scope,
        handlers: {
          search_knowledge: searchKnowledge,
          call_codex_target: target,
        },
        mandatoryOptimization,
        planner,
      });

      expect(searchKnowledge).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(
        { prompt: candidate.text },
        expect.anything(),
      );
      expect(planner).toHaveBeenCalledTimes(2);
      expect(result.finalText).toBe(`Target: ${candidate.text}`);
    });

    it.each([
      ["lexical", "search_knowledge"],
      ["graph", "search_graph_entities"],
    ] as const)(
      "lets Auto select the %s retrieval tool through the existing controller",
      async (_route, toolName) => {
        const target = vi.fn(async ({ prompt }: { prompt: string }) => ({
          available: true,
          text: `Target: ${prompt}`,
        }));
        const lexical = vi.fn(async () => ({ resultCount: 1 }));
        const graph = vi.fn(async () => ({ available: true, resultCount: 1 }));
        const planner = vi
          .fn()
          .mockResolvedValueOnce({
            summary: "Senopati memilih satu route pencarian.",
            toolCalls: [
              {
                name: toolName,
                arguments:
                  toolName === "search_knowledge"
                    ? { query: "kebijakan" }
                    : { query: "hubungan kebijakan", limit: 5 },
              },
            ],
            candidate: null,
            noChangeRecommended: false,
            finalText: null,
            finish: false,
            clarificationRequired: false,
            clarification: null,
          })
          .mockResolvedValueOnce({
            ...completed("Prompt sudah dioptimasi."),
            candidate,
          });

        const result = await runWorkspaceChatAgent({
          scope,
          handlers: {
            search_knowledge: lexical,
            search_graph_entities: graph,
            call_codex_target: target,
          },
          mandatoryOptimization: {
            ...mandatoryOptimization,
            autoRetrieval: true,
          },
          planner,
        });

        expect(
          toolName === "search_knowledge" ? lexical : graph,
        ).toHaveBeenCalledTimes(1);
        expect(
          toolName === "search_knowledge" ? graph : lexical,
        ).not.toHaveBeenCalled();
        expect(planner).toHaveBeenCalledTimes(2);
        expect(target).toHaveBeenCalledTimes(1);
        expect(target).toHaveBeenCalledWith(
          { prompt: candidate.text },
          expect.anything(),
        );
        expect(result.finalText).toBe(`Target: ${candidate.text}`);
      },
    );

    it("rejects an Auto decision that selects more than one retrieval route", async () => {
      const target = vi.fn(async () => ({ available: true, text: "target" }));
      await expect(
        runWorkspaceChatAgent({
          scope,
          handlers: {
            search_knowledge: async () => ({ resultCount: 1 }),
            search_graph_entities: async () => ({
              available: true,
              resultCount: 1,
            }),
            call_codex_target: target,
          },
          mandatoryOptimization: {
            ...mandatoryOptimization,
            autoRetrieval: true,
          },
          planner: async () => ({
            summary: "Senopati memilih dua route.",
            toolCalls: [
              {
                name: "search_knowledge",
                arguments: { query: "kebijakan" },
              },
              {
                name: "search_graph_entities",
                arguments: { query: "kebijakan", limit: 5 },
              },
            ],
            candidate: null,
            noChangeRecommended: false,
            finalText: null,
            finish: false,
            clarificationRequired: false,
            clarification: null,
          }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_DECISION" });
      expect(target).not.toHaveBeenCalled();
    });
  });
});
