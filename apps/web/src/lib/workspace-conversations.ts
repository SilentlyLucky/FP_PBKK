import { RunPurposeSchema } from "@promptlab/contracts";
import type { RunPurpose } from "@promptlab/contracts";

export type WorkspacePreference = "quality" | "balanced" | "efficiency";
export type WorkspaceRetrievalStrategy =
  "auto" | "lexical" | "hybrid" | "graph" | "full_context";

export type WorkspaceProvider = "campus_gateway" | "codex_app_server";

export interface WorkspaceRunCreateRequest {
  projectId: string;
  promptVersionId: string;
  provider: WorkspaceProvider;
  requestedModel: string;
  purpose: RunPurpose;
  intent:
    | "workspace_chat"
    | "prompt_optimization"
    | "controlled_evaluation"
    | "workspace_file_draft";
  reasoningEffort?: string;
  workspaceChat?: {
    format: "promptlab-workspace-chat-v1";
    target: {
      requestedModel: string;
      reasoningEffort: string | null;
      reasoningEffortMode?: "selected" | "auto";
    } | null;
  };
  workspaceFileDraft?: {
    format: "promptlab-workspace-file-draft-run-v1";
    path: string;
    snapshotHash: string;
    readGrantId: string;
    writeGrantId: string;
    taskOptimizationConsent: true;
  };
  idempotencyKey: string;
  retrieval: { strategy: WorkspaceRetrievalStrategy; sourceIds: string[] };
}

export const MAX_WORKSPACE_MESSAGE_CHARACTERS = 10_000;
const MAX_CONVERSATION_PROMPT_CHARACTERS = 24_000;

export interface WorkspaceTurn {
  id: string;
  userText: string;
  assistantText: string | null;
  runId: string | null;
  status: string;
  promptId: string | null;
  promptVersionId: string | null;
  promptText: string | null;
  provider: WorkspaceProvider | null;
  requestedModel: string | null;
  runCreateRequest: WorkspaceRunCreateRequest | null;
  sourceIds: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface WorkspaceConversation {
  id: string;
  title: string;
  updatedAt: string;
  preference: WorkspacePreference;
  reasoningEffort?: string | null;
  reasoningEffortMode?: "selected" | "auto";
  retrievalStrategy?: WorkspaceRetrievalStrategy;
  sourceIds: string[];
  promptId: string | null;
  promptVersionId: string | null;
  turns: WorkspaceTurn[];
}

export type ConversationStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

const emptyConversations: WorkspaceConversation[] = [];
const conversationCache = new WeakMap<
  object,
  Map<string, { raw: string | null; value: WorkspaceConversation[] }>
>();
const projectListeners = new Map<string, Set<() => void>>();

const preferenceInstructions: Record<WorkspacePreference, string> = {
  quality:
    "Utamakan ketepatan, kelengkapan, dan kepatuhan pada semua batasan. Nyatakan dengan jelas bila informasi belum cukup.",
  balanced:
    "Seimbangkan kelengkapan dan keringkasan. Pertahankan semua batasan dan jelaskan bila informasi belum cukup.",
  efficiency:
    "Jawab dengan ringkas dan hindari detail yang tidak diperlukan, sambil mempertahankan ketepatan dan semua batasan.",
};

export function conversationsStorageKey(projectId: string): string {
  return `promptlab.workspace.conversations.v1:${projectId}`;
}

export function activeConversationStorageKey(projectId: string): string {
  return `promptlab.workspace.active.v1:${projectId}`;
}

export function preferenceInstruction(preference: WorkspacePreference): string {
  return preferenceInstructions[preference];
}

/**
 * Preparation, queued, running, and unknown run states still have no answer to
 * include in a follow-up. Interrupted runs are terminal at the backend but
 * unresolved for the conversation, so require the user to inspect that run.
 * Paused runs also wait for the action exposed by their run details.
 */
export function isConversationTurnBlocking(status: string): boolean {
  return !(
    status === "succeeded" ||
    status === "failed" ||
    status === "preparation_failed" ||
    status === "canceled"
  );
}

export function buildConversationPrompt(input: {
  preference: WorkspacePreference;
  priorTurns: WorkspaceTurn[];
  currentMessage: string;
}): string {
  const systemEnvelope = [
    `Preferensi jawaban: ${preferenceInstruction(input.preference)}`,
    'Jawab dengan bahasa manusia yang alami. Jangan bungkus jawaban biasa sebagai objek JSON seperti {"answer":"..."}. Gunakan Markdown yang sesuai: code fence berlabel untuk kode dan notasi LaTeX $...$ atau $$...$$ untuk matematika. Jika pengguna meminta JSON dengan jelas, berikan JSON yang valid.',
    "Jangan tampilkan penalaran internal. Berikan jawaban, hasil kerja, dan ringkasan singkat yang berguna.",
  ].join("\n");
  const currentRequest = `Permintaan pengguna saat ini:\n${input.currentMessage.trim()}`;
  const recentTurns = input.priorTurns.slice(-8);
  const historyHeading = "Riwayat percakapan terbaru:\n";
  const sectionSeparator = "\n\n";
  const availableHistoryCharacters = Math.max(
    0,
    MAX_CONVERSATION_PROMPT_CHARACTERS -
      systemEnvelope.length -
      currentRequest.length -
      sectionSeparator.length * 2 -
      historyHeading.length,
  );
  const newestHistory: string[] = [];
  let usedHistoryCharacters = 0;

  for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
    const turn = recentTurns[index];
    if (!turn) continue;
    const turnLines = [`Pengguna: ${turn.userText.trim()}`];
    if (turn.assistantText?.trim()) {
      turnLines.push(`Asisten: ${turn.assistantText.trim()}`);
    }
    const block = turnLines.join("\n");
    const separatorCharacters = newestHistory.length
      ? sectionSeparator.length
      : 0;
    if (
      usedHistoryCharacters + separatorCharacters + block.length >
      availableHistoryCharacters
    ) {
      break;
    }
    newestHistory.unshift(block);
    usedHistoryCharacters += separatorCharacters + block.length;
  }

  const historySection = newestHistory.length
    ? `${historyHeading}${newestHistory.join(sectionSeparator)}`
    : null;
  return [systemEnvelope, historySection, currentRequest]
    .filter((section): section is string => section !== null)
    .join(sectionSeparator);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRunCreateRequest(
  value: unknown,
): WorkspaceRunCreateRequest | null {
  if (!isRecord(value) || !isRecord(value.retrieval)) return null;
  const sourceIds = value.retrieval.sourceIds;
  const workspaceChat = value.workspaceChat;
  const intent = value.intent ?? (workspaceChat ? "workspace_chat" : null);
  const validWorkspaceChat =
    isRecord(workspaceChat) &&
    Object.keys(workspaceChat).every((key) =>
      ["format", "target"].includes(key),
    ) &&
    workspaceChat.format === "promptlab-workspace-chat-v1" &&
    (workspaceChat.target === null ||
      (isRecord(workspaceChat.target) &&
        Object.keys(workspaceChat.target).every((key) =>
          ["requestedModel", "reasoningEffort", "reasoningEffortMode"].includes(
            key,
          ),
        ) &&
        typeof workspaceChat.target.requestedModel === "string" &&
        (typeof workspaceChat.target.reasoningEffort === "string" ||
          workspaceChat.target.reasoningEffort === null) &&
        (workspaceChat.target.reasoningEffortMode === undefined ||
          workspaceChat.target.reasoningEffortMode === "selected" ||
          workspaceChat.target.reasoningEffortMode === "auto") &&
        (workspaceChat.target.reasoningEffortMode !== "auto" ||
          workspaceChat.target.reasoningEffort === null)));
  if (
    typeof value.projectId !== "string" ||
    typeof value.promptVersionId !== "string" ||
    (value.provider !== "campus_gateway" &&
      value.provider !== "codex_app_server") ||
    typeof value.requestedModel !== "string" ||
    !RunPurposeSchema.safeParse(value.purpose).success ||
    intent !== "workspace_chat" ||
    typeof value.idempotencyKey !== "string" ||
    (value.retrieval.strategy !== "auto" &&
      value.retrieval.strategy !== "lexical" &&
      value.retrieval.strategy !== "hybrid" &&
      value.retrieval.strategy !== "graph" &&
      value.retrieval.strategy !== "full_context") ||
    !Array.isArray(sourceIds) ||
    sourceIds.length > 20 ||
    sourceIds.some((sourceId) => typeof sourceId !== "string") ||
    !validWorkspaceChat ||
    (value.reasoningEffort !== undefined &&
      typeof value.reasoningEffort !== "string")
  ) {
    return null;
  }
  return {
    projectId: value.projectId,
    promptVersionId: value.promptVersionId,
    provider: value.provider,
    requestedModel: value.requestedModel,
    purpose: value.purpose as RunPurpose,
    intent: "workspace_chat",
    ...(typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    ...(isRecord(workspaceChat)
      ? {
          workspaceChat: {
            format: "promptlab-workspace-chat-v1" as const,
            target: isRecord(workspaceChat.target)
              ? {
                  requestedModel: workspaceChat.target.requestedModel as string,
                  reasoningEffort: workspaceChat.target.reasoningEffort as
                    string | null,
                  ...(workspaceChat.target.reasoningEffortMode === "selected" ||
                  workspaceChat.target.reasoningEffortMode === "auto"
                    ? {
                        reasoningEffortMode:
                          workspaceChat.target.reasoningEffortMode,
                      }
                    : {}),
                }
              : null,
          },
        }
      : {}),
    idempotencyKey: value.idempotencyKey,
    retrieval: {
      strategy: value.retrieval.strategy,
      sourceIds: [...sourceIds],
    },
  };
}

function parseTurn(value: unknown): WorkspaceTurn | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.userText !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.sourceIds)
  ) {
    return null;
  }

  const provider =
    value.provider === "campus_gateway" || value.provider === "codex_app_server"
      ? value.provider
      : null;
  const updatedAt = stringOrNull(value.updatedAt);
  return {
    id: value.id,
    userText: value.userText.slice(0, 10_000),
    assistantText: stringOrNull(value.assistantText)?.slice(0, 100_000) ?? null,
    runId: stringOrNull(value.runId),
    status: value.status.slice(0, 80),
    promptId: stringOrNull(value.promptId),
    promptVersionId: stringOrNull(value.promptVersionId),
    promptText: stringOrNull(value.promptText)?.slice(0, 100_000) ?? null,
    provider,
    requestedModel: stringOrNull(value.requestedModel),
    runCreateRequest: parseRunCreateRequest(value.runCreateRequest),
    sourceIds: value.sourceIds.filter(
      (sourceId): sourceId is string => typeof sourceId === "string",
    ),
    createdAt: value.createdAt,
    ...(updatedAt === null ? {} : { updatedAt }),
  };
}

/** Merge a stale tab snapshot without dropping turns committed by another tab. */
export function mergeWorkspaceConversationTurns(
  current: WorkspaceConversation | null,
  incoming: WorkspaceConversation,
): WorkspaceConversation {
  if (!current || current.id !== incoming.id) return incoming;

  const merged = new Map(current.turns.map((turn) => [turn.id, turn]));
  for (const turn of incoming.turns) {
    const existing = merged.get(turn.id);
    const existingAt = Date.parse(
      existing?.updatedAt ?? existing?.createdAt ?? "",
    );
    const incomingAt = Date.parse(turn.updatedAt ?? turn.createdAt);
    if (!existing || !Number.isFinite(existingAt) || incomingAt >= existingAt) {
      merged.set(turn.id, turn);
    }
  }
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  const latestConversation =
    Number.isFinite(currentUpdatedAt) &&
    (!Number.isFinite(incomingUpdatedAt) ||
      currentUpdatedAt > incomingUpdatedAt)
      ? current
      : incoming;

  return {
    ...latestConversation,
    turns: [...merged.values()]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(-40),
  };
}

export function mergeWorkspaceConversationLists(
  current: readonly WorkspaceConversation[],
  incoming: readonly WorkspaceConversation[],
): WorkspaceConversation[] {
  const merged = new Map(
    current.map((conversation) => [conversation.id, conversation]),
  );
  for (const conversation of incoming) {
    merged.set(
      conversation.id,
      mergeWorkspaceConversationTurns(
        merged.get(conversation.id) ?? null,
        conversation,
      ),
    );
  }
  return [...merged.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function parseConversation(value: unknown): WorkspaceConversation | null {
  if (!isRecord(value) || !Array.isArray(value.turns)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.sourceIds)
  ) {
    return null;
  }

  const turns = value.turns
    .map(parseTurn)
    .filter((turn): turn is WorkspaceTurn => turn !== null)
    .slice(-40);
  const preference: WorkspacePreference =
    value.preference === "quality" || value.preference === "efficiency"
      ? value.preference
      : "balanced";

  return {
    id: value.id,
    title: value.title.slice(0, 120),
    updatedAt: value.updatedAt,
    preference,
    reasoningEffort: stringOrNull(value.reasoningEffort),
    ...(value.reasoningEffortMode === "selected" ||
    value.reasoningEffortMode === "auto"
      ? { reasoningEffortMode: value.reasoningEffortMode }
      : {}),
    retrievalStrategy:
      value.retrievalStrategy === "lexical" ||
      value.retrievalStrategy === "hybrid" ||
      value.retrievalStrategy === "graph" ||
      value.retrievalStrategy === "full_context"
        ? value.retrievalStrategy
        : "auto",
    sourceIds: value.sourceIds.filter(
      (sourceId): sourceId is string => typeof sourceId === "string",
    ),
    promptId: stringOrNull(value.promptId),
    promptVersionId: stringOrNull(value.promptVersionId),
    turns,
  };
}

export function readConversations(
  storage: ConversationStorage,
  projectId: string,
): WorkspaceConversation[] {
  try {
    const raw = storage.getItem(conversationsStorageKey(projectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseConversation)
      .filter(
        (conversation): conversation is WorkspaceConversation =>
          conversation !== null,
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function writeConversations(
  storage: ConversationStorage,
  projectId: string,
  conversations: WorkspaceConversation[],
): void {
  const bounded = conversations.slice(0, 100);
  const raw = JSON.stringify(bounded);
  storage.setItem(conversationsStorageKey(projectId), raw);
  getCache(storage).set(projectId, { raw, value: bounded });
  notifyProjectListeners(projectId);
}

function getCache(
  storage: ConversationStorage,
): Map<string, { raw: string | null; value: WorkspaceConversation[] }> {
  let cache = conversationCache.get(storage);
  if (!cache) {
    cache = new Map();
    conversationCache.set(storage, cache);
  }
  return cache;
}

function notifyProjectListeners(projectId: string): void {
  projectListeners.get(projectId)?.forEach((listener) => listener());
}

export function subscribeWorkspaceStorage(
  projectId: string,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listeners = projectListeners.get(projectId) ?? new Set<() => void>();
  listeners.add(listener);
  projectListeners.set(projectId, listeners);

  const onStorage = (event: StorageEvent) => {
    if (
      event.key === conversationsStorageKey(projectId) ||
      event.key === activeConversationStorageKey(projectId)
    ) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener("storage", onStorage);
    listeners.delete(listener);
    if (!listeners.size) projectListeners.delete(projectId);
  };
}

export function getConversationsSnapshot(
  storage: ConversationStorage,
  projectId: string | null,
): WorkspaceConversation[] {
  if (!projectId) return emptyConversations;
  try {
    const raw = storage.getItem(conversationsStorageKey(projectId));
    const cache = getCache(storage);
    const previous = cache.get(projectId);
    if (previous?.raw === raw) return previous.value;
    if (!raw) {
      cache.set(projectId, { raw, value: emptyConversations });
      return emptyConversations;
    }
    const parsed: unknown = JSON.parse(raw);
    const value = Array.isArray(parsed)
      ? parsed
          .map(parseConversation)
          .filter(
            (conversation): conversation is WorkspaceConversation =>
              conversation !== null,
          )
          .slice(0, 100)
      : emptyConversations;
    cache.set(projectId, { raw, value });
    return value;
  } catch {
    return emptyConversations;
  }
}

export function getActiveConversationSnapshot(
  storage: ConversationStorage,
  projectId: string | null,
): string | null {
  if (!projectId) return null;
  try {
    return storage.getItem(activeConversationStorageKey(projectId)) || null;
  } catch {
    return null;
  }
}

export function writeActiveConversation(
  storage: ConversationStorage,
  projectId: string,
  conversationId: string | null,
): void {
  const key = activeConversationStorageKey(projectId);
  if (conversationId) storage.setItem(key, conversationId);
  else if (storage.removeItem) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, "");
  }
  notifyProjectListeners(projectId);
}
