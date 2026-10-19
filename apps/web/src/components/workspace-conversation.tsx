"use client";

import type { ProviderConnectionState } from "@promptlab/contracts";
import {
  ArrowUpRight,
  BookOpenText,
  ChevronDown,
  Clock3,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useProjectScope } from "@/components/project-scope";
import { LocalFileReview } from "@/components/local-file-review";
import { LocalSourceBrowser } from "@/components/local-source-browser";
import { WorkspaceRunResult } from "@/components/workspace-run-result";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildConversationPrompt,
  getActiveConversationSnapshot as readActiveConversationSnapshot,
  getConversationsSnapshot,
  isConversationTurnBlocking,
  mergeWorkspaceConversationLists,
  mergeWorkspaceConversationTurns,
  MAX_WORKSPACE_MESSAGE_CHARACTERS,
  readConversations,
  subscribeWorkspaceStorage,
  writeActiveConversation,
  writeConversations,
  type WorkspaceConversation,
  type WorkspacePreference,
  type WorkspaceProvider,
  type WorkspaceRetrievalStrategy,
  type WorkspaceRunCreateRequest,
  type WorkspaceTurn,
} from "@/lib/workspace-conversations";
import { validateConversationSourceSelection } from "@/lib/workspace-conversation-consent";

import styles from "./workspace-conversation.module.css";

interface ProviderPayload {
  providers?: ProviderConnectionState[];
  codexModels?: Array<{
    id: string;
    displayName: string;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
  }>;
}

interface ProviderSnapshot {
  projectId: string;
  providers: ProviderConnectionState[];
  codexModels: NonNullable<ProviderPayload["codexModels"]>;
  error: string | null;
}

interface KnowledgeSource {
  id: string;
  displayName: string;
  sourceKind: string;
  permission: "local_only" | "campus_indexer_allowed";
  deleted: boolean;
  eligible: boolean;
  version: number | null;
  versionId: string | null;
  extractStatus: string;
  chunkCount: number;
}

interface SourceSnapshot {
  projectId: string;
  sources: KnowledgeSource[];
  error: string | null;
}

const emptyWorkspaceConversations: WorkspaceConversation[] = [];
const emptyProviderConnections: ProviderConnectionState[] = [];
const emptyCodexModels: NonNullable<ProviderPayload["codexModels"]> = [];
const emptyKnowledgeSources: KnowledgeSource[] = [];
const getServerConversationsSnapshot = () => emptyWorkspaceConversations;
const getServerActiveConversationSnapshot = () => null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  return isRecord(payload) ? payload : {};
}

function responseError(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  return fallback;
}

function providerLabel(provider: WorkspaceProvider): string {
  return provider === "codex_app_server" ? "Codex" : "Senopati";
}

function thinkingEffortLabel(effort: string): string {
  switch (effort) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Rendah";
    case "medium":
      return "Seimbang";
    case "high":
      return "Mendalam";
    case "xhigh":
      return "Sangat tinggi";
    case "max":
      return "Maksimal";
    default:
      return effort.replace(/[_-]+/gu, " ");
  }
}

function shortText(value: string, length = 56): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > length
    ? `${normalized.slice(0, length - 1)}…`
    : normalized || "Percakapan baru";
}

function newConversation(
  preference: WorkspacePreference,
  sourceIds: string[],
  reasoningEffort: string | null = null,
  reasoningEffortMode: "selected" | "auto" = "selected",
  retrievalStrategy: WorkspaceRetrievalStrategy = "auto",
): WorkspaceConversation {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "Percakapan baru",
    updatedAt: now,
    preference,
    reasoningEffort,
    reasoningEffortMode,
    retrievalStrategy,
    sourceIds,
    promptId: null,
    promptVersionId: null,
    turns: [],
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Waktu tidak tersedia";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusText(status: string): string {
  if (status === "created") return "Run dibuat";
  if (status === "queued") return "Menunggu worker";
  if (status === "running") return "Berjalan";
  if (status === "cancel_requested") return "Pembatalan sedang diproses";
  if (status === "succeeded") return "Eksekusi selesai";
  if (status === "failed" || status === "preparation_failed") return "Gagal";
  if (status === "canceled") return "Dibatalkan";
  if (status === "interrupted_unknown") return "Hasil remote belum diketahui";
  if (status === "run_creation_unconfirmed") return "Run belum dikonfirmasi";
  if (status.startsWith("paused_")) return "Perlu tindakan";
  if (status === "saving_prompt") return "Menyimpan permintaan";
  if (status === "creating_run") return "Membuat run";
  if (status === "preparing") return "Menyiapkan permintaan";
  return status;
}

export function WorkspaceConversation() {
  const { activeProject, activeProjectId } = useProjectScope();
  const [providerSnapshot, setProviderSnapshot] =
    useState<ProviderSnapshot | null>(null);
  const [sourceSnapshot, setSourceSnapshot] = useState<SourceSnapshot | null>(
    null,
  );
  const [historyStorageError, setHistoryStorageError] = useState(false);
  const [historyOverride, setHistoryOverride] = useState<{
    projectId: string;
    conversations: WorkspaceConversation[];
  } | null>(null);
  const [activeConversationOverride, setActiveConversationOverride] = useState<{
    projectId: string;
    conversationId: string | null;
  } | null>(null);
  const subscribeToStorage = useCallback(
    (listener: () => void) =>
      activeProjectId
        ? subscribeWorkspaceStorage(activeProjectId, listener)
        : () => {},
    [activeProjectId],
  );
  const getConversationSnapshot = useCallback(
    () => getConversationsSnapshot(window.localStorage, activeProjectId),
    [activeProjectId],
  );
  const getActiveConversationIdSnapshot = useCallback(
    () => readActiveConversationSnapshot(window.localStorage, activeProjectId),
    [activeProjectId],
  );
  const storedConversations = useSyncExternalStore(
    subscribeToStorage,
    getConversationSnapshot,
    getServerConversationsSnapshot,
  );
  const conversations =
    historyOverride?.projectId === activeProjectId
      ? historyOverride.conversations
      : storedConversations;
  const storedActiveConversationId = useSyncExternalStore(
    subscribeToStorage,
    getActiveConversationIdSnapshot,
    getServerActiveConversationSnapshot,
  );
  const activeConversationId =
    activeConversationOverride?.projectId === activeProjectId
      ? activeConversationOverride.conversationId
      : storedActiveConversationId;
  const [newConversationSettings, setNewConversationSettings] = useState<{
    projectId: string | null;
    preference: WorkspacePreference;
    reasoningEffort: string | null;
    reasoningEffortMode: "selected" | "auto";
    retrievalStrategy: WorkspaceRetrievalStrategy;
    sourceIds: string[];
  }>({
    projectId: null,
    preference: "balanced",
    reasoningEffort: null,
    reasoningEffortMode: "selected",
    retrievalStrategy: "auto",
    sourceIds: [],
  });
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [reconcilingTurnId, setReconcilingTurnId] = useState<string | null>(
    null,
  );
  const [cancelingTurnId, setCancelingTurnId] = useState<string | null>(null);
  const [conversationRunError, setConversationRunError] = useState<
    string | null
  >(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const composerRef = useRef<HTMLFormElement>(null);

  const currentProviderSnapshot =
    providerSnapshot?.projectId === activeProjectId ? providerSnapshot : null;
  const currentSourceSnapshot =
    sourceSnapshot?.projectId === activeProjectId ? sourceSnapshot : null;
  const providers =
    currentProviderSnapshot?.providers ?? emptyProviderConnections;
  const codexModels = currentProviderSnapshot?.codexModels ?? emptyCodexModels;
  const sources = currentSourceSnapshot?.sources ?? emptyKnowledgeSources;
  const providerError = currentProviderSnapshot?.error ?? null;
  const sourceError = currentSourceSnapshot?.error ?? null;
  const providerLoading = Boolean(activeProjectId) && !currentProviderSnapshot;
  const sourceLoading = Boolean(activeProjectId) && !currentSourceSnapshot;
  const activeConversation =
    conversations.find((item) => item.id === activeConversationId) ?? null;
  const pendingSettings =
    newConversationSettings.projectId === activeProjectId
      ? newConversationSettings
      : {
          projectId: activeProjectId,
          preference: "balanced" as const,
          reasoningEffort: null,
          reasoningEffortMode: "selected" as const,
          retrievalStrategy: "auto" as const,
          sourceIds: [],
        };
  const preference =
    activeConversation?.preference ?? pendingSettings.preference;
  const selectedSourceIds =
    activeConversation?.sourceIds ?? pendingSettings.sourceIds;
  const selectedRetrievalStrategy =
    activeConversation?.retrievalStrategy ?? pendingSettings.retrievalStrategy;
  const sourceSnapshotState = sourceLoading
    ? "loading"
    : sourceError
      ? "failed"
      : "ready";
  const selectedSourceValidation = validateConversationSourceSelection(
    selectedSourceIds,
    sources,
    sourceSnapshotState,
  );
  const blockingTurn =
    activeConversation?.turns.find((turn) =>
      isConversationTurnBlocking(turn.status),
    ) ?? null;
  const selectedProviderModel = codexModels.find(
    (model) =>
      model.id ===
      providers.find(
        (provider) =>
          provider.provider === "codex_app_server" &&
          provider.role === "target" &&
          provider.status === "verified",
      )?.requestedModel,
  );
  const supportedThinkingEfforts =
    selectedProviderModel?.supportedReasoningEfforts ?? [];
  const savedThinkingEffort =
    activeConversation?.reasoningEffort ?? pendingSettings.reasoningEffort;
  const selectedThinkingEffortMode =
    activeConversation?.reasoningEffortMode ??
    pendingSettings.reasoningEffortMode;
  const selectedThinkingEffort =
    selectedThinkingEffortMode !== "auto" && savedThinkingEffort
      ? savedThinkingEffort
      : "";
  const selectedThinkingEffortUnavailable =
    selectedThinkingEffort &&
    !supportedThinkingEfforts.includes(selectedThinkingEffort)
      ? selectedThinkingEffort
      : null;
  const selectedThinkingValue =
    selectedThinkingEffortMode === "auto" ? "auto" : selectedThinkingEffort;
  const defaultThinkingEffort =
    selectedProviderModel?.defaultReasoningEffort &&
    supportedThinkingEfforts.includes(
      selectedProviderModel.defaultReasoningEffort,
    )
      ? selectedProviderModel.defaultReasoningEffort
      : undefined;
  const codexTarget = providers.find(
    (provider) =>
      provider.provider === "codex_app_server" && provider.role === "target",
  );
  const campusOptimizer = providers.find(
    (provider) =>
      provider.provider === "campus_gateway" && provider.role === "optimizer",
  );
  const codexModel = codexModels.find(
    (model) => model.id === codexTarget?.requestedModel,
  );
  const senopatiReady =
    campusOptimizer?.status === "verified" &&
    Boolean(campusOptimizer.requestedModel);
  const codexTargetReady =
    codexTarget?.status === "verified" &&
    Boolean(codexTarget.requestedModel) &&
    Boolean(codexModel);
  const activeSources = sources.filter(
    (source) => !source.deleted && source.eligible && source.versionId,
  );
  useEffect(() => {
    if (!activeProjectId) return;

    const controller = new AbortController();
    let current = true;
    const projectId = activeProjectId;

    void fetch(`/api/providers?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await readResponse(response);
        if (!response.ok)
          throw new Error(responseError(payload, "Provider tidak tersedia."));
        if (!current) return;
        const data = payload as ProviderPayload;
        setProviderSnapshot({
          projectId,
          providers: data.providers ?? [],
          codexModels: data.codexModels ?? [],
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (current && !controller.signal.aborted) {
          setProviderSnapshot({
            projectId,
            providers: [],
            codexModels: [],
            error:
              cause instanceof Error
                ? cause.message
                : "Status provider tidak tersedia.",
          });
        }
      });

    void fetch(`/api/projects/${activeProjectId}/knowledge`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await readResponse(response);
        if (!response.ok)
          throw new Error(
            responseError(payload, "Daftar sumber tidak tersedia."),
          );
        if (current) {
          setSourceSnapshot({
            projectId,
            sources: Array.isArray(payload.sources)
              ? (payload.sources as KnowledgeSource[])
              : [],
            error: null,
          });
        }
      })
      .catch((cause: unknown) => {
        if (current && !controller.signal.aborted) {
          setSourceSnapshot({
            projectId,
            sources: [],
            error:
              cause instanceof Error
                ? cause.message
                : "Daftar sumber tidak tersedia.",
          });
        }
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [activeProjectId]);

  function setActiveConversationId(conversationId: string | null) {
    if (!activeProjectId) return;
    try {
      writeActiveConversation(
        window.localStorage,
        activeProjectId,
        conversationId,
      );
      setActiveConversationOverride(null);
    } catch {
      setActiveConversationOverride({
        projectId: activeProjectId,
        conversationId,
      });
      setHistoryStorageError(true);
    }
  }

  function commitConversation(
    conversation: WorkspaceConversation,
    projectId = activeProjectId,
  ) {
    if (!projectId) return;
    try {
      const stored = readConversations(window.localStorage, projectId);
      const current =
        historyOverride?.projectId === projectId
          ? mergeWorkspaceConversationLists(
              stored,
              historyOverride.conversations,
            )
          : stored;
      const currentConversation = current.find(
        (item) => item.id === conversation.id,
      );
      const mergedConversation = mergeWorkspaceConversationTurns(
        currentConversation ?? null,
        conversation,
      );
      const exists = current.some((item) => item.id === conversation.id);
      const next = exists
        ? current.map((item) =>
            item.id === conversation.id ? mergedConversation : item,
          )
        : [mergedConversation, ...current];
      const sorted = next.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      writeConversations(window.localStorage, projectId, sorted);
      if (projectId === activeProjectId) {
        setHistoryOverride(null);
        setHistoryStorageError(false);
      }
    } catch {
      const stored = readConversations(window.localStorage, projectId);
      const current =
        historyOverride?.projectId === projectId
          ? mergeWorkspaceConversationLists(
              stored,
              historyOverride.conversations,
            )
          : stored;
      const currentConversation = current.find(
        (item) => item.id === conversation.id,
      );
      const mergedConversation = mergeWorkspaceConversationTurns(
        currentConversation ?? null,
        conversation,
      );
      const exists = current.some((item) => item.id === conversation.id);
      const next = exists
        ? current.map((item) =>
            item.id === conversation.id ? mergedConversation : item,
          )
        : [mergedConversation, ...current];
      if (projectId === activeProjectId) {
        setHistoryOverride({
          projectId,
          conversations: next.sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          ),
        });
        setHistoryStorageError(true);
      }
    }
    if (projectId === activeProjectId) {
      setActiveConversationId(conversation.id);
      setHistoryOpen(false);
    }
  }

  function updateTurn(
    conversationId: string,
    turnId: string,
    update: Partial<WorkspaceTurn>,
    projectId = activeProjectId,
  ) {
    if (!projectId) return;
    const updatedAt = new Date().toISOString();
    const stored = readConversations(window.localStorage, projectId);
    const current =
      historyOverride?.projectId === projectId
        ? mergeWorkspaceConversationLists(stored, historyOverride.conversations)
        : stored;
    const updated = current.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            updatedAt,
            turns: conversation.turns.map((turn) =>
              turn.id === turnId ? { ...turn, ...update, updatedAt } : turn,
            ),
          }
        : conversation,
    );
    try {
      writeConversations(window.localStorage, projectId, updated);
      if (projectId === activeProjectId) {
        setHistoryOverride(null);
        setHistoryStorageError(false);
      }
    } catch {
      if (projectId === activeProjectId) {
        setHistoryOverride({ projectId, conversations: updated });
        setHistoryStorageError(true);
      }
    }
  }

  function updatePreference(value: WorkspacePreference) {
    if (activeConversation) {
      commitConversation({
        ...activeConversation,
        preference: value,
        updatedAt: new Date().toISOString(),
      });
    } else {
      setNewConversationSettings({
        projectId: activeProjectId,
        preference: value,
        reasoningEffort: pendingSettings.reasoningEffort,
        reasoningEffortMode: pendingSettings.reasoningEffortMode,
        retrievalStrategy: selectedRetrievalStrategy,
        sourceIds: selectedSourceIds,
      });
    }
  }

  function updateThinkingEffort(value: string) {
    const mode = value === "auto" ? "auto" : "selected";
    const effort = mode === "auto" ? null : value || null;
    if (activeConversation) {
      commitConversation({
        ...activeConversation,
        reasoningEffort: effort,
        reasoningEffortMode: mode,
        updatedAt: new Date().toISOString(),
      });
    } else {
      setNewConversationSettings({
        projectId: activeProjectId,
        preference,
        reasoningEffort: effort,
        reasoningEffortMode: mode,
        retrievalStrategy: selectedRetrievalStrategy,
        sourceIds: selectedSourceIds,
      });
    }
  }

  function updateRetrievalStrategy(value: string) {
    if (
      value !== "auto" &&
      value !== "lexical" &&
      value !== "hybrid" &&
      value !== "graph" &&
      value !== "full_context"
    ) {
      return;
    }
    const strategy: WorkspaceRetrievalStrategy = value;
    if (activeConversation) {
      commitConversation({
        ...activeConversation,
        retrievalStrategy: strategy,
        updatedAt: new Date().toISOString(),
      });
    } else {
      setNewConversationSettings({
        projectId: activeProjectId,
        preference,
        reasoningEffort: pendingSettings.reasoningEffort,
        reasoningEffortMode: pendingSettings.reasoningEffortMode,
        retrievalStrategy: strategy,
        sourceIds: selectedSourceIds,
      });
    }
  }

  function updateSources(sourceIds: string[]) {
    const validation = validateConversationSourceSelection(
      [...new Set(sourceIds)].slice(0, 20),
      sources,
      sourceSnapshotState,
    );
    if (validation.issues.length) {
      setSendError(
        "Pilihan sumber yang izinnya belum dapat dipastikan tidak disimpan. Hapus pilihan bermasalah atau muat ulang sumber.",
      );
      return;
    }
    const unique = validation.allowedSourceIds;
    setSendError(null);
    if (activeConversation) {
      commitConversation({
        ...activeConversation,
        sourceIds: unique,
        updatedAt: new Date().toISOString(),
      });
    } else {
      setNewConversationSettings({
        projectId: activeProjectId,
        preference,
        reasoningEffort: pendingSettings.reasoningEffort,
        reasoningEffortMode: pendingSettings.reasoningEffortMode,
        retrievalStrategy: selectedRetrievalStrategy,
        sourceIds: unique,
      });
    }
  }

  function startNewConversation() {
    if (!activeProjectId) return;
    const conversation = newConversation("balanced", []);
    setNewConversationSettings({
      projectId: activeProjectId,
      preference: "balanced",
      reasoningEffort: null,
      reasoningEffortMode: "selected",
      retrievalStrategy: "auto",
      sourceIds: [],
    });
    commitConversation(conversation);
    setDraft("");
    setSendError(null);
    setConversationRunError(null);
  }

  function selectConversation(conversation: WorkspaceConversation) {
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setSendError(null);
    setConversationRunError(null);
  }

  async function refreshSourcesForSend(projectId: string) {
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/knowledge`,
        { cache: "no-store" },
      );
      const payload = await readResponse(response);
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Daftar sumber tidak tersedia."),
        );
      }
      if (!Array.isArray(payload.sources)) {
        throw new Error("Daftar sumber tidak dapat diverifikasi.");
      }
      const latestSources = payload.sources as KnowledgeSource[];
      setSourceSnapshot({ projectId, sources: latestSources, error: null });
      return latestSources;
    } catch (cause) {
      const detail =
        cause instanceof Error
          ? cause.message
          : "Daftar sumber tidak dapat diverifikasi.";
      setSourceSnapshot((previous) => ({
        projectId,
        sources: previous?.projectId === projectId ? previous.sources : [],
        error: detail,
      }));
      throw new Error(
        `Izin sumber terbaru tidak dapat diverifikasi. Tidak ada sumber yang dikirim. ${detail}`,
      );
    }
  }

  async function cancelConversationRun(turn: WorkspaceTurn) {
    if (
      !activeProjectId ||
      !activeConversation ||
      !turn.runId ||
      !["queued", "running", "cancel_requested"].includes(turn.status)
    ) {
      return;
    }
    const conversationId = activeConversation.id;
    setCancelingTurnId(turn.id);
    setConversationRunError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/runs/${encodeURIComponent(turn.runId)}/cancel`,
        { method: "POST", cache: "no-store" },
      );
      const payload = await readResponse(response);
      const status = typeof payload.status === "string" ? payload.status : null;
      if (!response.ok || !status) {
        throw new Error(responseError(payload, "Run tidak dapat dibatalkan."));
      }
      updateTurn(conversationId, turn.id, { status });
      if (payload.canceled !== true && isConversationTurnBlocking(status)) {
        setConversationRunError(
          "Run masih aktif. Periksa statusnya atau coba batalkan kembali.",
        );
      }
    } catch (cause) {
      setConversationRunError(
        cause instanceof Error
          ? cause.message
          : "Run tidak dapat dibatalkan. Periksa status run sebelum melanjutkan.",
      );
    } finally {
      setCancelingTurnId(null);
    }
  }

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userText = draft.trim();
    if (
      !userText ||
      !activeProjectId ||
      !senopatiReady ||
      !codexTargetReady ||
      sendingRef.current
    )
      return;
    if (userText.length > MAX_WORKSPACE_MESSAGE_CHARACTERS) {
      setSendError(
        "Pesan dibatasi " +
          MAX_WORKSPACE_MESSAGE_CHARACTERS.toLocaleString("id-ID") +
          " karakter.",
      );
      return;
    }
    if (historyStorageError) {
      setSendError(
        "Riwayat percakapan tidak dapat disimpan di browser ini. Pulihkan penyimpanan lokal sebelum mengirim.",
      );
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    setConversationRunError(null);
    let conversationWithTurn: WorkspaceConversation | null = null;
    let turnId: string | null = null;
    const sendFailureContext: {
      conversationWithTurn: WorkspaceConversation | null;
      turnId: string | null;
    } = { conversationWithTurn: null, turnId: null };
    let pendingRunRequest: WorkspaceRunCreateRequest | null = null;
    let runPostStarted = false;
    let runCreationConfirmedAbsent = false;

    try {
      if (!navigator.locks) {
        setSendError(
          "Browser ini tidak menyediakan kunci lintas-tab. Buka Workspace di browser yang mendukung Web Locks sebelum mengirim.",
        );
        return;
      }
      await navigator.locks.request(
        "promptlab-workspace-send:" + activeProjectId,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            setSendError(
              "Workspace sedang mengirim pesan di tab lain. Tunggu, lalu periksa riwayat percakapan.",
            );
            return;
          }

          const latestConversations = readConversations(
            window.localStorage,
            activeProjectId,
          );
          const latestActiveId = readActiveConversationSnapshot(
            window.localStorage,
            activeProjectId,
          );
          const latestConversation = latestActiveId
            ? latestConversations.find((item) => item.id === latestActiveId)
            : null;
          const latestBlockingTurn = latestConversation?.turns.find((turn) =>
            isConversationTurnBlocking(turn.status),
          );
          if (latestBlockingTurn) {
            setSendError(
              latestBlockingTurn.status === "interrupted_unknown" ||
                latestBlockingTurn.status === "run_creation_unconfirmed"
                ? "Hasil run sebelumnya belum dapat dipastikan. Periksa run sebelum melanjutkan percakapan ini."
                : "Tunggu jawaban sebelumnya selesai atau batalkan run yang masih aktif sebelum mengirim pesan berikutnya.",
            );
            return;
          }

          const current =
            latestConversation ??
            (activeConversation?.id === latestActiveId
              ? activeConversation
              : null) ??
            newConversation(
              preference,
              selectedSourceIds,
              savedThinkingEffort,
              selectedThinkingEffortMode,
              selectedRetrievalStrategy,
            );
          const sourceIdsForRun = [...current.sourceIds];
          if (selectedSourceValidation.issues.length) {
            setSendError(
              "Pilihan sumber tidak memiliki izin berbagi yang dapat diverifikasi. Hapus pilihan bermasalah sebelum mengirim.",
            );
            return;
          }
          if (sourceIdsForRun.length) {
            const latestSources = await refreshSourcesForSend(activeProjectId);
            const latestValidation = validateConversationSourceSelection(
              sourceIdsForRun,
              latestSources,
              "ready",
            );
            if (latestValidation.issues.length) {
              setSendError(
                "Izin atau kesiapan salah satu sumber berubah. Tidak ada run yang dibuat. Hapus pilihan bermasalah lalu coba lagi.",
              );
              return;
            }
          }

          const previousPromptTurn = [...current.turns]
            .reverse()
            .find((turn) => turn.promptId && turn.promptVersionId);
          const promptId = previousPromptTurn?.promptId ?? current.promptId;
          const parentVersionId =
            previousPromptTurn?.promptVersionId ?? current.promptVersionId;
          const promptText = buildConversationPrompt({
            preference: current.preference ?? preference,
            priorTurns: current.turns,
            currentMessage: userText,
          });
          const createdAt = new Date().toISOString();
          turnId = crypto.randomUUID();
          const turn: WorkspaceTurn = {
            id: turnId,
            userText,
            assistantText: null,
            runId: null,
            status: "preparing",
            promptId: null,
            promptVersionId: null,
            promptText,
            provider: "campus_gateway",
            requestedModel: campusOptimizer?.requestedModel ?? null,
            runCreateRequest: null,
            sourceIds: sourceIdsForRun,
            createdAt,
            updatedAt: createdAt,
          };
          conversationWithTurn = {
            ...current,
            title:
              current.turns.length === 0 && current.title === "Percakapan baru"
                ? shortText(userText, 52)
                : current.title,
            updatedAt: createdAt,
            sourceIds: sourceIdsForRun,
            turns: [...current.turns, turn],
          };
          sendFailureContext.conversationWithTurn = conversationWithTurn;
          sendFailureContext.turnId = turnId;
          commitConversation(conversationWithTurn);
          setDraft("");

          const promptResponse = await fetch(
            "/api/projects/" +
              encodeURIComponent(activeProjectId) +
              "/workspace/prompts",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                promptId,
                name:
                  current.title === "Percakapan baru"
                    ? shortText(userText, 120)
                    : current.title,
                text: promptText,
                parentVersionId,
              }),
            },
          );
          const promptPayload = await readResponse(promptResponse);
          const savedPrompt = isRecord(promptPayload.prompt)
            ? promptPayload.prompt
            : null;
          if (
            !promptResponse.ok ||
            !savedPrompt ||
            typeof savedPrompt.id !== "string" ||
            typeof savedPrompt.versionId !== "string"
          ) {
            throw new Error(
              responseError(
                promptPayload,
                "Snapshot prompt percakapan tidak dapat disimpan.",
              ),
            );
          }

          const updatedTurn: WorkspaceTurn = {
            ...turn,
            status: "creating_run",
            promptId: savedPrompt.id,
            promptVersionId: savedPrompt.versionId,
          };
          const updatedConversation: WorkspaceConversation = {
            ...conversationWithTurn,
            promptId: savedPrompt.id,
            promptVersionId: savedPrompt.versionId,
            turns: conversationWithTurn.turns.map((item) =>
              item.id === turnId ? updatedTurn : item,
            ),
          };
          commitConversation(updatedConversation);
          const targetReasoningEffort =
            selectedThinkingEffortMode !== "auto" && selectedThinkingEffort
              ? selectedThinkingEffort
              : selectedThinkingEffortMode === "auto"
                ? null
                : (defaultThinkingEffort ?? null);
          pendingRunRequest = {
            projectId: activeProjectId,
            promptVersionId: savedPrompt.versionId,
            provider: "campus_gateway",
            requestedModel: campusOptimizer!.requestedModel!,
            purpose: "optimizer",
            intent: "workspace_chat",
            idempotencyKey: crypto.randomUUID(),
            retrieval: {
              strategy: current.retrievalStrategy ?? "auto",
              sourceIds: sourceIdsForRun,
            },
            workspaceChat: {
              format: "promptlab-workspace-chat-v1",
              target: codexTargetReady
                ? {
                    requestedModel: codexTarget!.requestedModel!,
                    reasoningEffort: targetReasoningEffort,
                    reasoningEffortMode: selectedThinkingEffortMode,
                  }
                : null,
            },
          };
          updateTurn(updatedConversation.id, turnId, {
            status: "run_creation_unconfirmed",
            runCreateRequest: pendingRunRequest,
          });
          runPostStarted = true;
          const runResponse = await fetch(
            "/api/projects/" + encodeURIComponent(activeProjectId) + "/runs",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(pendingRunRequest),
            },
          );
          const runPayload = await readResponse(runResponse);
          const createdRun = isRecord(runPayload.run) ? runPayload.run : null;
          if (!runResponse.ok || typeof createdRun?.id !== "string") {
            if (
              sourceIdsForRun.length &&
              (runPayload.error === "RETRIEVAL_SOURCE_PERMISSION_REQUIRED" ||
                runPayload.error === "RETRIEVAL_SOURCE_NOT_FOUND")
            ) {
              await refreshSourcesForSend(activeProjectId).catch(
                () => undefined,
              );
            }
            if (
              !runResponse.ok &&
              runResponse.status >= 400 &&
              runResponse.status < 500 &&
              runPayload.error !== "IDEMPOTENCY_KEY_CONFLICT"
            ) {
              runCreationConfirmedAbsent = true;
            }
            throw new Error(
              responseError(runPayload, "Run tidak dapat dibuat."),
            );
          }
          updateTurn(updatedConversation.id, turnId, {
            runId: createdRun.id,
            status:
              typeof createdRun.status === "string"
                ? createdRun.status
                : "created",
            runCreateRequest: null,
          });
        },
      );
    } catch (cause) {
      if (
        sendFailureContext.conversationWithTurn &&
        sendFailureContext.turnId
      ) {
        updateTurn(
          sendFailureContext.conversationWithTurn.id,
          sendFailureContext.turnId,
          {
            status:
              runPostStarted && !runCreationConfirmedAbsent
                ? "run_creation_unconfirmed"
                : "preparation_failed",
            runCreateRequest:
              runPostStarted && !runCreationConfirmedAbsent
                ? pendingRunRequest
                : null,
          },
        );
      }
      setSendError(
        cause instanceof Error ? cause.message : "Pesan tidak dapat dikirim.",
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
      composerRef.current?.querySelector("textarea")?.focus();
    }
  }

  async function reconcilePendingRun(
    conversationId: string,
    turn: WorkspaceTurn,
  ) {
    const runRequest = turn.runCreateRequest;
    if (
      !runRequest ||
      runRequest.projectId !== activeProjectId ||
      reconcilingTurnId === turn.id
    ) {
      return;
    }
    setReconcilingTurnId(turn.id);
    setConversationRunError(null);
    try {
      const runsUrl =
        "/api/projects/" + encodeURIComponent(runRequest.projectId) + "/runs";
      let response = await fetch(
        runsUrl +
          "?idempotencyKey=" +
          encodeURIComponent(runRequest.idempotencyKey),
        { cache: "no-store" },
      );
      let payload = await readResponse(response);
      if (response.status === 404 && payload.error === "RUN_NOT_FOUND") {
        response = await fetch(runsUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(runRequest),
        });
        payload = await readResponse(response);
      }
      const run = isRecord(payload.run) ? payload.run : null;
      if (!response.ok || typeof run?.id !== "string") {
        throw new Error(
          responseError(
            payload,
            "Status run belum dapat dipastikan. Percakapan tetap terkunci; coba periksa kembali nanti.",
          ),
        );
      }
      updateTurn(
        conversationId,
        turn.id,
        {
          runId: run.id,
          status: typeof run.status === "string" ? run.status : "created",
          runCreateRequest: null,
        },
        runRequest.projectId,
      );
    } catch (cause) {
      if (activeProjectId === runRequest.projectId) {
        setConversationRunError(
          cause instanceof Error
            ? cause.message
            : "Status run belum dapat dipastikan.",
        );
      }
    } finally {
      setReconcilingTurnId((current) => (current === turn.id ? null : current));
    }
  }

  const blockingTurnMessage = !blockingTurn
    ? null
    : blockingTurn.status === "interrupted_unknown"
      ? "Status remote belum dapat dipastikan. Periksa aktivitas run sebelum melanjutkan percakapan ini."
      : blockingTurn.status === "run_creation_unconfirmed"
        ? "Respons pembuatan run belum dapat dipastikan. Follow-up ditahan sampai run yang sama ditemukan atau statusnya dipastikan."
        : blockingTurn.status.startsWith("paused_")
          ? "Run memerlukan tindakan sebelum percakapan dilanjutkan. Periksa status provider atau aktivitas run."
          : "Jawaban sebelumnya " +
            statusText(blockingTurn.status).toLowerCase() +
            ". Follow-up ditahan agar konteks percakapan tetap berurutan.";
  const sortedConversations = [...conversations].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const composerDisabled =
    !activeProjectId ||
    sending ||
    Boolean(blockingTurn) ||
    !senopatiReady ||
    !codexTargetReady ||
    selectedSourceValidation.issues.length > 0;

  async function onLocalSourceImported(sourceId?: string) {
    if (!activeProjectId) return;
    const latestSources = await refreshSourcesForSend(activeProjectId);
    if (!sourceId) return;
    const nextIds = [...new Set([...selectedSourceIds, sourceId])].slice(0, 20);
    const validation = validateConversationSourceSelection(
      nextIds,
      latestSources,
      "ready",
    );
    if (validation.issues.length) {
      setSendError(
        "File sudah diimpor, tetapi izin berbagi belum dapat diverifikasi. Pilih sumber secara manual setelah daftar dimuat ulang.",
      );
      return;
    }
    const now = new Date().toISOString();
    if (activeConversation) {
      commitConversation({
        ...activeConversation,
        sourceIds: validation.allowedSourceIds,
        updatedAt: now,
      });
    } else {
      setNewConversationSettings({
        projectId: activeProjectId,
        preference,
        reasoningEffort: pendingSettings.reasoningEffort,
        reasoningEffortMode: pendingSettings.reasoningEffortMode,
        retrievalStrategy: selectedRetrievalStrategy,
        sourceIds: validation.allowedSourceIds,
      });
    }
  }

  return (
    <section className={styles.page} aria-labelledby="workspace-title">
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>Ruang kerja utama</p>
          <h1 id="workspace-title">Workspace</h1>
          <p className={styles.subtitle}>
            Setiap pesan dioptimasi Senopati lalu otomatis dijalankan Codex.
            Versi prompt tersimpan tidak diaktifkan otomatis.
          </p>
        </div>
        <div className={styles.headingActions}>
          <Button
            type="button"
            variant="secondary"
            className={styles.mobileHistoryButton}
            aria-expanded={historyOpen}
            aria-controls="workspace-history"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <Clock3 aria-hidden="true" size={16} />
            Riwayat
          </Button>
          <Button
            type="button"
            onClick={startNewConversation}
            disabled={!activeProjectId}
          >
            <MessageSquarePlus aria-hidden="true" size={16} />
            Percakapan baru
          </Button>
        </div>
      </div>

      <div
        className={
          styles.layout + (historyOpen ? " " + styles.historyVisible : "")
        }
      >
        <aside
          id="workspace-history"
          className={styles.historyPanel}
          aria-label="Riwayat percakapan"
        >
          <div className={styles.historyHeader}>
            <div>
              <h2>Percakapan</h2>
              <p>{activeProject?.name ?? "Pilih proyek dari header"}</p>
            </div>
          </div>
          <div className={styles.historyList}>
            {sortedConversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                className={
                  styles.historyItem +
                  (conversation.id === activeConversationId
                    ? " " + styles.historyItemActive
                    : "")
                }
                aria-current={
                  conversation.id === activeConversationId ? "page" : undefined
                }
                onClick={() => selectConversation(conversation)}
              >
                <MessageSquarePlus aria-hidden="true" size={16} />
                <span className={styles.historyItemCopy}>
                  <strong>{conversation.title}</strong>
                  <small>{formatDate(conversation.updatedAt)}</small>
                </span>
              </button>
            ))}
            {!sortedConversations.length ? (
              <p className={styles.historyEmpty}>
                Belum ada percakapan di browser ini.
              </p>
            ) : null}
          </div>
          <p className={styles.historyFootnote}>
            Riwayat percakapan dan pengaturan tersimpan di browser ini. Riwayat
            ini tidak disinkronkan ke server.
          </p>
        </aside>

        <div className={styles.chatPanel} data-testid="workspace-chat-panel">
          <header className={styles.chatHeader}>
            <div>
              <h2>{activeConversation?.title ?? "Percakapan baru"}</h2>
              <p>
                {activeProject?.name ?? "Pilih atau buat proyek untuk memulai"}
              </p>
            </div>
            <div className={styles.chatHeaderStatus}>
              {providerLoading ? (
                <Badge variant="muted">Memeriksa koneksi Senopati</Badge>
              ) : senopatiReady ? (
                <Badge variant="success">Senopati siap</Badge>
              ) : (
                <Badge variant="warning">Senopati tidak tersedia</Badge>
              )}
            </div>
          </header>

          <div
            className={styles.messageScroll}
            data-testid="workspace-message-scroll"
          >
            {!activeProjectId ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon} aria-hidden="true">
                  <MessageSquarePlus size={20} />
                </div>
                <h3>Pilih proyek untuk mulai</h3>
                <p>
                  Workspace menggunakan proyek di bagian atas. Buat proyek
                  melalui tombol tambah di header.
                </p>
              </div>
            ) : null}

            {activeProjectId && !activeConversation?.turns.length ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon} aria-hidden="true">
                  <Sparkles size={20} />
                </div>
                <h3>Mulai dari satu permintaan</h3>
                <p>
                  Senopati mengoptimasi setiap prompt sebelum Codex menjawab.
                  Tambahkan file hanya jika pesan membutuhkan konteks dokumen.
                </p>
                {providerError ? (
                  <p className={styles.unavailableText} role="status">
                    Status provider tidak dapat dimuat: {providerError}
                  </p>
                ) : null}
              </div>
            ) : null}

            {activeConversation?.turns.map((turn, turnIndex) => (
              <article className={styles.exchange} key={turn.id}>
                <div className={styles.userMessage}>
                  <p className={styles.messageLabel}>Anda</p>
                  <p className={styles.userText}>{turn.userText}</p>
                  <time>{formatDate(turn.createdAt)}</time>
                </div>

                {turn.runId && activeProjectId ? (
                  <WorkspaceRunResult
                    key={activeProjectId + ":" + turn.runId}
                    projectId={activeProjectId}
                    runId={turn.runId}
                    initialStatus={turn.status}
                    providerLabel={
                      turn.provider ? providerLabel(turn.provider) : "Senopati"
                    }
                    focusOnMount={false}
                    chatPresentation
                    userPrompt={turn.userText}
                    conversationContextPrompts={activeConversation.turns
                      .slice(Math.max(0, turnIndex - 8), turnIndex)
                      .map((priorTurn) => priorTurn.userText)}
                    onCompleted={(assistantText) =>
                      updateTurn(activeConversation.id, turn.id, {
                        assistantText,
                        status: "succeeded",
                      })
                    }
                    onStatusChange={(status) =>
                      updateTurn(activeConversation.id, turn.id, { status })
                    }
                  />
                ) : turn.status === "preparing" ||
                  turn.status === "creating_run" ||
                  turn.status === "run_creation_unconfirmed" ? (
                  <p
                    className={styles.pendingMessage}
                    role="status"
                    aria-live="polite"
                  >
                    <LoaderCircle
                      className={styles.spin}
                      aria-hidden="true"
                      size={15}
                    />{" "}
                    {statusText(turn.status)}
                  </p>
                ) : turn.status === "preparation_failed" ? (
                  <div className={styles.messageError} role="alert">
                    Pesan ini belum menjadi run backend. Periksa kesalahan di
                    composer lalu coba lagi.
                  </div>
                ) : turn.status === "canceled" ? (
                  <p className={styles.pendingMessage} role="status">
                    Run dibatalkan. Anda dapat melanjutkan percakapan.
                  </p>
                ) : null}
              </article>
            ))}
          </div>

          {providerError && activeProjectId ? (
            <div className={styles.inlineUnavailable} role="status">
              <ShieldAlert aria-hidden="true" size={17} />
              <span>Status koneksi provider gagal dimuat.</span>
              <Button asChild variant="secondary" size="sm">
                <Link href="/settings">
                  Buka Pengaturan
                  <ArrowUpRight aria-hidden="true" size={14} />
                </Link>
              </Button>
            </div>
          ) : null}
          {!providerError &&
          !providerLoading &&
          activeProjectId &&
          (!senopatiReady || !codexTargetReady) ? (
            <div className={styles.inlineUnavailable} role="status">
              <ShieldAlert aria-hidden="true" size={17} />
              <span>
                {!senopatiReady && !codexTargetReady
                  ? "Hubungkan Senopati dan Codex untuk mulai."
                  : !senopatiReady
                    ? "Senopati perlu diverifikasi untuk mengoptimasi prompt."
                    : "Codex perlu terverifikasi untuk menjawab pesan."}
              </span>
              {!senopatiReady ? (
                <Button asChild variant="secondary" size="sm">
                  <Link href="/settings">
                    Atur Senopati
                    <ArrowUpRight aria-hidden="true" size={14} />
                  </Link>
                </Button>
              ) : null}
              {!codexTargetReady ? (
                <Button asChild variant="secondary" size="sm">
                  <Link href="/settings">
                    Hubungkan Codex
                    <ArrowUpRight aria-hidden="true" size={14} />
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}

          {blockingTurn ? (
            <div className={styles.runGate} role="status" aria-live="polite">
              <p>{blockingTurnMessage}</p>
              {blockingTurn.status === "run_creation_unconfirmed" &&
              blockingTurn.runCreateRequest ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={reconcilingTurnId === blockingTurn.id}
                  onClick={() =>
                    void reconcilePendingRun(
                      activeConversation!.id,
                      blockingTurn,
                    )
                  }
                >
                  {reconcilingTurnId === blockingTurn.id
                    ? "Memeriksa run…"
                    : "Periksa atau temukan run"}
                </Button>
              ) : null}
              {blockingTurn.runId &&
              ["queued", "running", "cancel_requested"].includes(
                blockingTurn.status,
              ) ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cancelingTurnId === blockingTurn.id}
                  onClick={() => void cancelConversationRun(blockingTurn)}
                >
                  {cancelingTurnId === blockingTurn.id
                    ? "Membatalkan run…"
                    : blockingTurn.status === "cancel_requested"
                      ? "Periksa pembatalan"
                      : "Batalkan run"}
                </Button>
              ) : null}
              {blockingTurn.runId &&
              blockingTurn.status === "interrupted_unknown" ? (
                <Link
                  className="workspace-result-link"
                  href={"/runs?run=" + encodeURIComponent(blockingTurn.runId)}
                >
                  Periksa aktivitas run
                </Link>
              ) : null}
            </div>
          ) : null}
          {conversationRunError ? (
            <p className={styles.composerError} role="alert">
              {conversationRunError}
            </p>
          ) : null}

          <form
            ref={composerRef}
            className={styles.composer}
            id="workspace-composer"
            onSubmit={(event) => void submitMessage(event)}
          >
            <label className={styles.composerLabel} htmlFor="workspace-message">
              Pesan
            </label>
            <textarea
              id="workspace-message"
              value={draft}
              maxLength={MAX_WORKSPACE_MESSAGE_CHARACTERS}
              placeholder="Ketik pesan untuk dioptimasi Senopati…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  composerRef.current?.requestSubmit();
                }
              }}
              disabled={
                sending ||
                !activeProjectId ||
                !senopatiReady ||
                !codexTargetReady
              }
              aria-describedby="workspace-composer-help"
            />

            <div className={styles.composerControls}>
              <div className={styles.controlGroup}>
                <span>Pengarah</span>
                <p className={styles.automaticThinking}>Senopati</p>
              </div>
              <div className={styles.controlGroup}>
                <label htmlFor="workspace-preference">Gaya jawaban</label>
                <select
                  id="workspace-preference"
                  value={preference}
                  disabled={
                    sending || selectedSourceValidation.issues.length > 0
                  }
                  onChange={(event) =>
                    updatePreference(event.target.value as WorkspacePreference)
                  }
                >
                  <option value="quality">Teliti</option>
                  <option value="balanced">Seimbang</option>
                  <option value="efficiency">Ringkas</option>
                </select>
              </div>

              {codexTargetReady &&
              (supportedThinkingEfforts.length > 0 ||
                selectedThinkingEffortUnavailable) ? (
                <div className={styles.controlGroup}>
                  <label htmlFor="workspace-thinking">Thinking Codex</label>
                  <select
                    id="workspace-thinking"
                    value={selectedThinkingValue}
                    disabled={sending}
                    onChange={(event) =>
                      updateThinkingEffort(event.target.value)
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="">
                      Standar
                      {defaultThinkingEffort
                        ? " · " + thinkingEffortLabel(defaultThinkingEffort)
                        : ""}
                    </option>
                    {selectedThinkingEffortUnavailable ? (
                      <option
                        value={selectedThinkingEffortUnavailable}
                        disabled
                      >
                        {thinkingEffortLabel(selectedThinkingEffortUnavailable)}
                        {" · tidak didukung model saat ini"}
                      </option>
                    ) : null}
                    {supportedThinkingEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {thinkingEffortLabel(effort)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className={styles.controlGroup}>
                <details className={styles.contextPicker}>
                  <summary>
                    <BookOpenText aria-hidden="true" size={15} />
                    Sumber
                    {selectedSourceIds.length
                      ? " · " + selectedSourceIds.length
                      : ""}
                  </summary>
                  <div className={styles.contextOptions}>
                    {activeSources.length ? (
                      <details className={styles.retrievalPicker}>
                        <summary>
                          Mode pencarian ·{" "}
                          {selectedRetrievalStrategy === "auto"
                            ? "Auto"
                            : selectedRetrievalStrategy === "lexical"
                              ? "Leksikal"
                              : selectedRetrievalStrategy === "hybrid"
                                ? "Hybrid"
                                : selectedRetrievalStrategy === "graph"
                                  ? "GraphRAG"
                                  : "Konteks penuh"}
                          <ChevronDown
                            className={styles.retrievalChevron}
                            aria-hidden="true"
                            size={14}
                          />
                        </summary>
                        <div className={styles.retrievalOptions}>
                          <label className={styles.retrievalControl}>
                            <span>Mode pencarian</span>
                            <select
                              value={selectedRetrievalStrategy}
                              disabled={sending}
                              onChange={(event) =>
                                updateRetrievalStrategy(event.target.value)
                              }
                            >
                              <option value="auto">Auto</option>
                              <option value="lexical">Leksikal</option>
                              <option value="hybrid">Hybrid</option>
                              <option value="graph">GraphRAG</option>
                              <option value="full_context">
                                Konteks sumber penuh
                              </option>
                            </select>
                          </label>
                          {selectedRetrievalStrategy === "graph" ? (
                            <p className={styles.contextNotice}>
                              GraphRAG perlu snapshot aktif.
                            </p>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                    {sourceLoading ? (
                      <p className={styles.contextNotice}>
                        Memuat sumber proyek…
                      </p>
                    ) : sourceError ? (
                      <div className={styles.sourceEmpty} role="status">
                        <p>Sumber gagal dimuat.</p>
                        <Button asChild variant="secondary" size="sm">
                          <Link href="/sources">
                            Buka Sumber
                            <ArrowUpRight aria-hidden="true" size={14} />
                          </Link>
                        </Button>
                      </div>
                    ) : activeSources.length ? (
                      activeSources.map((source) => {
                        const canSendSource =
                          source.permission === "campus_indexer_allowed";
                        return (
                          <label
                            key={source.id}
                            className={styles.sourceOption}
                            htmlFor={"workspace-source-" + source.id}
                          >
                            <input
                              id={"workspace-source-" + source.id}
                              type="checkbox"
                              checked={selectedSourceIds.includes(source.id)}
                              disabled={
                                sending ||
                                (!canSendSource &&
                                  !selectedSourceIds.includes(source.id)) ||
                                selectedSourceValidation.issues.length > 0
                              }
                              onChange={(change) =>
                                updateSources(
                                  change.target.checked
                                    ? [...selectedSourceIds, source.id]
                                    : selectedSourceIds.filter(
                                        (id) => id !== source.id,
                                      ),
                                )
                              }
                            />
                            <span>
                              <strong>{source.displayName}</strong>
                              <small>
                                {source.permission === "campus_indexer_allowed"
                                  ? "Versi " +
                                    (source.version ?? "tidak tersedia") +
                                    " · siap dipilih"
                                  : "Izin saat ini hanya lokal; dokumen tidak dikirim ke Senopati"}
                              </small>
                            </span>
                          </label>
                        );
                      })
                    ) : (
                      <div className={styles.sourceEmpty}>
                        <p>Belum ada sumber aktif.</p>
                        <Button asChild variant="secondary" size="sm">
                          <Link href="/sources">
                            Tambah sumber
                            <ArrowUpRight aria-hidden="true" size={14} />
                          </Link>
                        </Button>
                      </div>
                    )}
                    {selectedSourceValidation.issues.length ? (
                      <div className={styles.sourceIssues} role="status">
                        <p>
                          Sebagian pilihan belum dapat dikirim. Periksa ulang
                          izin dan kesiapan sumber.
                        </p>
                        <ul>
                          {selectedSourceValidation.issues.map((issue) => (
                            <li key={issue.id}>
                              <strong>{issue.displayName}</strong>
                              <span>{issue.reason}</span>
                            </li>
                          ))}
                        </ul>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={sending}
                          onClick={() => {
                            const issueIds = new Set(
                              selectedSourceValidation.issues.map(
                                (issue) => issue.id,
                              ),
                            );
                            updateSources(
                              selectedSourceIds.filter(
                                (id) => !issueIds.has(id),
                              ),
                            );
                          }}
                        >
                          Hapus pilihan bermasalah
                        </Button>
                        {sourceSnapshotState === "failed" && activeProjectId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={sending}
                            onClick={() =>
                              void refreshSourcesForSend(activeProjectId)
                                .then(() => setSendError(null))
                                .catch((cause: unknown) =>
                                  setSendError(
                                    cause instanceof Error
                                      ? cause.message
                                      : "Izin sumber belum dapat diperiksa ulang.",
                                  ),
                                )
                            }
                          >
                            Coba periksa ulang izin
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {selectedSourceIds.length &&
                    !selectedSourceValidation.issues.length ? (
                      <p className={styles.egressNotice}>
                        Sumber terpilih dikirim ke Codex sebagai konteks setelah
                        izin diverifikasi.
                      </p>
                    ) : null}
                  </div>
                </details>
              </div>
            </div>

            <details className={styles.folderPicker}>
              <summary>
                <FolderOpen aria-hidden="true" size={15} />
                Folder dan file
              </summary>
              <div className={styles.folderPickerBody}>
                <p>
                  PromptLab hanya membaca folder setelah Anda mengizinkannya.
                  File tidak diunggah otomatis; impor sendiri jika ingin
                  menjadikannya sumber.
                </p>
                <LocalSourceBrowser onImported={onLocalSourceImported} />
              </div>
            </details>

            {sendError ? (
              <p className={styles.composerError} role="alert">
                {sendError}
              </p>
            ) : null}
            {historyStorageError ? (
              <p className={styles.composerError} role="status">
                Riwayat percakapan tidak dapat disimpan di browser ini. Run
                backend tetap tercatat terpisah untuk Monitoring.
              </p>
            ) : null}
            <div className={styles.composerFooter}>
              <p id="workspace-composer-help">
                Enter kirim · Shift + Enter baris baru · Maks.{" "}
                {MAX_WORKSPACE_MESSAGE_CHARACTERS.toLocaleString("id-ID")}{" "}
                karakter
              </p>
              <Button
                type="submit"
                disabled={composerDisabled || !draft.trim()}
              >
                {sending ? (
                  <LoaderCircle
                    className={styles.spin}
                    aria-hidden="true"
                    size={16}
                  />
                ) : (
                  <Send aria-hidden="true" size={16} />
                )}
                {sending ? "Mengirim…" : "Kirim"}
              </Button>
            </div>
          </form>
          <details className={styles.folderPicker}>
            <summary>
              <FolderOpen aria-hidden="true" size={15} />
              Tinjau file, usulkan, dan jalankan tes
            </summary>
            <div className={styles.folderPickerBody}>
              <p>
                Usulan dapat diuji pada snapshot baseline dan kandidat sebelum
                Anda menerapkannya. File proyek asli tidak diubah oleh evaluasi.
              </p>
              <LocalFileReview
                projectId={activeProjectId}
                codexTarget={{
                  state: providerLoading
                    ? "loading"
                    : codexTargetReady
                      ? "available"
                      : "unavailable",
                  modelId: codexTarget?.requestedModel ?? null,
                  ...(selectedThinkingEffort
                    ? { reasoningEffort: selectedThinkingEffort }
                    : {}),
                  message: providerError,
                }}
                codexOptimizer={{
                  state: providerLoading
                    ? "loading"
                    : senopatiReady
                      ? "available"
                      : "unavailable",
                  modelId: campusOptimizer?.requestedModel ?? null,
                  message: providerError,
                }}
              />
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
