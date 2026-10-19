import { describe, expect, it } from "vitest";

import {
  activeConversationStorageKey,
  buildConversationPrompt,
  conversationsStorageKey,
  isConversationTurnBlocking,
  mergeWorkspaceConversationTurns,
  readConversations,
  writeConversations,
  type ConversationStorage,
  type WorkspaceConversation,
  type WorkspaceTurn,
} from "./workspace-conversations.js";

function memoryStorage(): ConversationStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("workspace conversation storage", () => {
  it("keeps conversation history scoped to one project", () => {
    const storage = memoryStorage();
    const conversation: WorkspaceConversation = {
      id: "conversation-1",
      title: "Dokumentasi API",
      updatedAt: "2026-10-16T10:00:00.000Z",
      preference: "balanced",
      sourceIds: [],
      promptId: null,
      promptVersionId: null,
      turns: [],
    };

    writeConversations(storage, "project-a", [conversation]);

    expect(readConversations(storage, "project-a")).toEqual([
      { ...conversation, reasoningEffort: null, retrievalStrategy: "auto" },
    ]);
    expect(readConversations(storage, "project-b")).toEqual([]);
    expect(conversationsStorageKey("project-a")).not.toBe(
      activeConversationStorageKey("project-a"),
    );
  });

  it("recovers safely from malformed local history", () => {
    const storage = memoryStorage();
    storage.setItem(conversationsStorageKey("project-a"), "{");

    expect(readConversations(storage, "project-a")).toEqual([]);
  });

  it("persists Auto effort with a pending request for idempotent replay", () => {
    const storage = memoryStorage();
    const conversation = makeConversation([
      makeTurn({
        id: "turn-auto",
        status: "run_creation_unconfirmed",
        runCreateRequest: {
          projectId: "project-a",
          promptVersionId: "version-auto",
          provider: "campus_gateway",
          requestedModel: "senopati-fixture",
          purpose: "optimizer",
          intent: "workspace_chat",
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: {
              requestedModel: "gpt-6-luna",
              reasoningEffort: null,
              reasoningEffortMode: "auto",
            },
          },
          idempotencyKey: "auto-effort-replay-1",
          retrieval: { strategy: "lexical", sourceIds: [] },
        },
      }),
    ]);
    conversation.reasoningEffortMode = "auto";
    writeConversations(storage, "project-a", [conversation]);

    const reloaded = readConversations(storage, "project-a")[0];
    expect(reloaded?.reasoningEffortMode).toBe("auto");
    expect(reloaded?.turns[0]?.runCreateRequest).toMatchObject({
      workspaceChat: {
        target: {
          requestedModel: "gpt-6-luna",
          reasoningEffortMode: "auto",
          reasoningEffort: null,
        },
      },
      idempotencyKey: "auto-effort-replay-1",
    });
  });

  it("preserves a full-context retrieval request when replaying a pending run", () => {
    const storage = memoryStorage();
    const conversation = makeConversation([
      makeTurn({
        id: "turn-full-context",
        status: "run_creation_unconfirmed",
        runCreateRequest: {
          projectId: "project-a",
          promptVersionId: "version-full-context",
          provider: "campus_gateway",
          requestedModel: "senopati-fixture",
          purpose: "optimizer",
          intent: "workspace_chat",
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: null,
          },
          idempotencyKey: "full-context-replay-1",
          retrieval: { strategy: "full_context", sourceIds: ["source-a"] },
        },
      }),
    ]);

    writeConversations(storage, "project-a", [conversation]);

    expect(
      readConversations(storage, "project-a")[0]?.turns[0]?.runCreateRequest
        ?.retrieval,
    ).toEqual({ strategy: "full_context", sourceIds: ["source-a"] });
  });

  it("round-trips Auto retrieval for conversation settings and idempotent replay", () => {
    const storage = memoryStorage();
    const conversation = makeConversation([
      makeTurn({
        id: "turn-auto-retrieval",
        status: "run_creation_unconfirmed",
        runCreateRequest: {
          projectId: "project-a",
          promptVersionId: "version-auto-retrieval",
          provider: "campus_gateway",
          requestedModel: "senopati-fixture",
          purpose: "optimizer",
          intent: "workspace_chat",
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: null,
          },
          idempotencyKey: "auto-retrieval-replay-1",
          retrieval: { strategy: "auto", sourceIds: ["source-a"] },
        },
      }),
    ]);
    conversation.retrievalStrategy = "auto";
    writeConversations(storage, "project-a", [conversation]);

    expect(readConversations(storage, "project-a")[0]).toMatchObject({
      retrievalStrategy: "auto",
      turns: [
        {
          runCreateRequest: {
            idempotencyKey: "auto-retrieval-replay-1",
            retrieval: { strategy: "auto", sourceIds: ["source-a"] },
          },
        },
      ],
    });
  });

  it("round-trips Hybrid retrieval for conversation settings and idempotent replay", () => {
    const storage = memoryStorage();
    const conversation = makeConversation([
      makeTurn({
        id: "turn-hybrid-retrieval",
        status: "run_creation_unconfirmed",
        runCreateRequest: {
          projectId: "project-a",
          promptVersionId: "version-hybrid-retrieval",
          provider: "campus_gateway",
          requestedModel: "senopati-fixture",
          purpose: "optimizer",
          intent: "workspace_chat",
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: null,
          },
          idempotencyKey: "hybrid-retrieval-replay-1",
          retrieval: { strategy: "hybrid", sourceIds: ["source-a"] },
        },
      }),
    ]);
    conversation.retrievalStrategy = "hybrid";
    writeConversations(storage, "project-a", [conversation]);

    expect(readConversations(storage, "project-a")[0]).toMatchObject({
      retrievalStrategy: "hybrid",
      turns: [
        {
          runCreateRequest: {
            idempotencyKey: "hybrid-retrieval-replay-1",
            retrieval: { strategy: "hybrid", sourceIds: ["source-a"] },
          },
        },
      ],
    });
  });

  it("keeps a manually selected effort mode through reload", () => {
    const storage = memoryStorage();
    const conversation = makeConversation([]);
    conversation.reasoningEffort = "high";
    conversation.reasoningEffortMode = "selected";
    writeConversations(storage, "project-a", [conversation]);

    expect(readConversations(storage, "project-a")[0]).toMatchObject({
      reasoningEffort: "high",
      reasoningEffortMode: "selected",
    });
  });
});

describe("workspace prompt composition", () => {
  it("includes the selected preference and only real prior assistant output", () => {
    const prompt = buildConversationPrompt({
      preference: "efficiency",
      currentMessage: "Buat ringkasan.",
      priorTurns: [
        {
          id: "turn-1",
          userText: "Jelaskan modul ini.",
          assistantText: "Modul mengelola autentikasi.",
          runId: "run-1",
          status: "succeeded",
          promptId: null,
          promptVersionId: null,
          promptText: null,
          provider: "codex_app_server",
          requestedModel: "model-a",
          runCreateRequest: null,
          sourceIds: [],
          createdAt: "2026-10-16T10:00:00.000Z",
        },
        {
          id: "turn-2",
          userText: "Lanjutkan.",
          assistantText: null,
          runId: null,
          status: "creating",
          promptId: null,
          promptVersionId: null,
          promptText: null,
          provider: null,
          requestedModel: null,
          runCreateRequest: null,
          sourceIds: [],
          createdAt: "2026-10-16T10:01:00.000Z",
        },
      ],
    });

    expect(prompt).toContain("Preferensi jawaban:");
    expect(prompt).toContain("Modul mengelola autentikasi.");
    expect(prompt).toContain("Permintaan pengguna saat ini:\nBuat ringkasan.");
    expect(prompt).not.toContain("Asisten: null");
  });

  it("preserves the complete current request and system envelope with oversized history", () => {
    const currentMessage = `Permintaan penting ${"isi-panjang".repeat(2_200)}`;
    const prompt = buildConversationPrompt({
      preference: "quality",
      currentMessage,
      priorTurns: [
        makeTurn({
          userText: "Riwayat lama",
          assistantText: `Keluaran lama ${"konteks-lama ".repeat(2_200)}`,
        }),
      ],
    });

    expect(prompt).toContain("Preferensi jawaban:");
    expect(prompt).toContain(
      `Permintaan pengguna saat ini:\n${currentMessage}`,
    );
    expect(prompt.endsWith(currentMessage)).toBe(true);
    expect(prompt).not.toContain("Keluaran lama");
  });

  it("budgets history from the nearest turn backward and keeps complete turn blocks", () => {
    const prompt = buildConversationPrompt({
      preference: "balanced",
      currentMessage: "Lanjutkan dari sini.",
      priorTurns: [
        makeTurn({
          userText: "Riwayat lama yang terlalu besar",
          assistantText: `Isi lama ${"konteks-lama ".repeat(2_300)}`,
        }),
        makeTurn({
          userText: "PERTANYAAN-SEBELUMNYA",
          assistantText: "JAWABAN-SEBELUMNYA",
        }),
        makeTurn({
          userText: "PERTANYAAN-TERDEKAT",
          assistantText: "JAWABAN-TERDEKAT",
        }),
      ],
    });

    expect(prompt).not.toContain("Riwayat lama yang terlalu besar");
    expect(prompt).toContain("PERTANYAAN-SEBELUMNYA");
    expect(prompt).toContain("PERTANYAAN-TERDEKAT");
    expect(prompt.indexOf("PERTANYAAN-SEBELUMNYA")).toBeLessThan(
      prompt.indexOf("PERTANYAAN-TERDEKAT"),
    );
    expect(prompt.indexOf("JAWABAN-TERDEKAT")).toBeLessThan(
      prompt.indexOf("Permintaan pengguna saat ini:"),
    );
  });
});

describe("conversation follow-up gating", () => {
  it("blocks pending or action-required turns, then releases failed and canceled terminal turns", () => {
    expect(isConversationTurnBlocking("preparing")).toBe(true);
    expect(isConversationTurnBlocking("creating_run")).toBe(true);
    expect(isConversationTurnBlocking("queued")).toBe(true);
    expect(isConversationTurnBlocking("running")).toBe(true);
    expect(isConversationTurnBlocking("paused_auth_required")).toBe(true);
    expect(isConversationTurnBlocking("interrupted_unknown")).toBe(true);
    expect(isConversationTurnBlocking("run_creation_unconfirmed")).toBe(true);
    expect(isConversationTurnBlocking("succeeded")).toBe(false);
    expect(isConversationTurnBlocking("failed")).toBe(false);
    expect(isConversationTurnBlocking("preparation_failed")).toBe(false);
    expect(isConversationTurnBlocking("canceled")).toBe(false);
  });

  it("merges turns from a stale tab snapshot and keeps the newest turn state", () => {
    const current = makeConversation([
      makeTurn({
        id: "turn-a",
        status: "running",
        updatedAt: "2026-10-16T10:02:00.000Z",
      }),
    ]);
    const stale = makeConversation([
      makeTurn({ id: "turn-a", status: "queued" }),
      makeTurn({
        id: "turn-b",
        status: "run_creation_unconfirmed",
        runId: null,
        runCreateRequest: {
          projectId: "project-a",
          promptVersionId: "version-b",
          provider: "campus_gateway",
          requestedModel: "senopati-fixture",
          purpose: "optimizer",
          intent: "workspace_chat",
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: null,
          },
          idempotencyKey: "key-b",
          retrieval: { strategy: "lexical", sourceIds: [] },
        },
      }),
    ]);

    const merged = mergeWorkspaceConversationTurns(current, stale);

    expect(merged.turns.map((turn) => turn.id)).toEqual(["turn-a", "turn-b"]);
    expect(merged.turns[0]?.status).toBe("running");
    expect(merged.turns[1]?.runCreateRequest?.idempotencyKey).toBe("key-b");

    const storage = memoryStorage();
    writeConversations(storage, "project-a", [merged]);
    expect(
      readConversations(storage, "project-a")[0]?.turns[1]?.runCreateRequest,
    ).toEqual(stale.turns[1]?.runCreateRequest);
  });
});

function makeTurn(overrides: Partial<WorkspaceTurn> = {}): WorkspaceTurn {
  return {
    id: "turn-fixture",
    userText: "Pertanyaan fixture",
    assistantText: "Jawaban fixture",
    runId: "run-fixture",
    status: "succeeded",
    promptId: null,
    promptVersionId: null,
    promptText: null,
    provider: "codex_app_server",
    requestedModel: "model-fixture",
    runCreateRequest: null,
    sourceIds: [],
    createdAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

function makeConversation(turns: WorkspaceTurn[]): WorkspaceConversation {
  return {
    id: "conversation-1",
    title: "Fixture",
    updatedAt: "2026-10-16T10:00:00.000Z",
    preference: "balanced",
    sourceIds: [],
    promptId: null,
    promptVersionId: null,
    turns,
  };
}
