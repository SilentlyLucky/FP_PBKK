"use client";

import type { ProviderConnectionState } from "@promptlab/contracts";
import {
  ArrowUp,
  ArrowUpRight,
  Clock3,
  Ellipsis,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  PanelRight,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { useProjectScope } from "@/components/project-scope";
import { LocalFileReview } from "@/components/local-file-review";
import { LocalSourceBrowser } from "@/components/local-source-browser";
import { useSidebar } from "@/components/sidebar-slot";
import {
  ComposerChoicePill,
  type ComposerChoiceOption,
} from "@/components/workspace-composer-controls";
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
  parseWorkspaceConversation,
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
  semanticReadiness?: {
    status: "ready" | "partial" | "stale" | "not_indexed" | "blocked";
  } | null;
}

interface SourceSnapshot {
  projectId: string;
  sources: KnowledgeSource[];
  error: string | null;
}

interface ConversationHistorySnapshot {
  projectId: string;
  status: "loading" | "ready" | "error";
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

function conversationCollectionUrl(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/workspace/conversations`;
}

function conversationRecordUrl(
  projectId: string,
  conversationId: string,
): string {
  return `${conversationCollectionUrl(projectId)}/${encodeURIComponent(conversationId)}`;
}

const preferenceOptions: ComposerChoiceOption[] = [
  { value: "efficiency", label: "Ringkas" },
  { value: "balanced", label: "Seimbang" },
  { value: "quality", label: "Mendalam" },
];

const THINKING_STANDARD_VALUE = "__standar__";

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

function conversationDateGroup(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sebelumnya";

  const dayStart = (candidate: Date) =>
    new Date(
      candidate.getFullYear(),
      candidate.getMonth(),
      candidate.getDate(),
    ).getTime();
  const elapsedDays = Math.floor((dayStart(now) - dayStart(date)) / 86_400_000);
  if (elapsedDays <= 0) return "Hari ini";
  if (elapsedDays === 1) return "Kemarin";
  if (elapsedDays < 7) return "7 hari terakhir";
  return "Sebelumnya";
}

function conversationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(
    "id-ID",
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short" },
  ).format(date);
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
  const [conversationHistorySnapshot, setConversationHistorySnapshot] =
    useState<ConversationHistorySnapshot | null>(null);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [deletingConversationId, setDeletingConversationId] = useState<
    string | null
  >(null);
  const [historyActionError, setHistoryActionError] = useState<string | null>(
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
  const draftRevisionRef = useRef(0);
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
  const {
    slot: sidebarSlot,
    mobileOpen: historyOpen,
    setMobileOpen: setHistoryOpen,
  } = useSidebar();
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [workspaceAccessOpen, setWorkspaceAccessOpen] = useState(false);
  const [fileReviewOpen, setFileReviewOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const composerRef = useRef<HTMLFormElement>(null);
  const conversationWriteQueueRef = useRef(new Map<string, Promise<void>>());
  const deletedConversationIdsRef = useRef(new Set<string>());

  function updateDraft(value: string) {
    draftRevisionRef.current += 1;
    setDraft(value);
  }

  useEffect(() => {
    const contextBreakpoint = window.matchMedia("(max-width: 1360px)");
    const updateContextVisibility = () =>
      setContextPanelOpen(!contextBreakpoint.matches);
    updateContextVisibility();
    contextBreakpoint.addEventListener("change", updateContextVisibility);
    return () =>
      contextBreakpoint.removeEventListener("change", updateContextVisibility);
  }, []);

  useEffect(() => {
    const textarea = composerRef.current?.querySelector("textarea");
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [draft]);

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
  const conversationHistoryStatus = !activeProjectId
    ? "ready"
    : conversationHistorySnapshot?.projectId === activeProjectId
      ? conversationHistorySnapshot.status
      : "loading";
  const conversationHistoryError =
    conversationHistorySnapshot?.projectId === activeProjectId
      ? conversationHistorySnapshot.error
      : null;
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
  const thinkingOptions: ComposerChoiceOption[] = [
    { value: "auto", label: "Otomatis" },
    {
      value: THINKING_STANDARD_VALUE,
      label: `Standar${
        defaultThinkingEffort
          ? ` · ${thinkingEffortLabel(defaultThinkingEffort)}`
          : ""
      }`,
    },
    ...(selectedThinkingEffortUnavailable
      ? [
          {
            value: selectedThinkingEffortUnavailable,
            label: `${thinkingEffortLabel(selectedThinkingEffortUnavailable)} · tidak didukung model saat ini`,
            disabled: true,
          },
        ]
      : []),
    ...supportedThinkingEfforts.map((effort) => ({
      value: effort,
      label: thinkingEffortLabel(effort),
    })),
  ];
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
  const hybridRetrievalReady =
    selectedSourceIds.length > 0 &&
    selectedSourceIds.every((sourceId) => {
      const source = activeSources.find(
        (candidate) => candidate.id === sourceId,
      );
      return ["ready", "partial"].includes(
        source?.semanticReadiness?.status ?? "",
      );
    });
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

  useEffect(() => {
    if (!activeProjectId) return;

    const controller = new AbortController();
    let current = true;
    const projectId = activeProjectId;
    setConversationHistorySnapshot({
      projectId,
      status: "loading",
      error: null,
    });

    void (async () => {
      const response = await fetch(conversationCollectionUrl(projectId), {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await readResponse(response);
      if (!response.ok || !Array.isArray(payload.conversations)) {
        throw new Error(
          responseError(payload, "Riwayat percakapan tidak dapat dimuat."),
        );
      }
      const stored = payload.conversations.map(parseWorkspaceConversation);
      if (stored.some((conversation) => conversation === null)) {
        throw new Error("Sebagian riwayat percakapan tidak dapat dibaca.");
      }
      const remoteConversations = stored.filter(
        (conversation): conversation is WorkspaceConversation =>
          conversation !== null,
      );
      for (const conversation of remoteConversations) {
        deletedConversationIdsRef.current.delete(
          `${projectId}:${conversation.id}`,
        );
      }
      const localConversations = readConversations(
        window.localStorage,
        projectId,
      ).filter(
        (conversation) =>
          !deletedConversationIdsRef.current.has(
            `${projectId}:${conversation.id}`,
          ),
      );
      const mergedConversations = mergeWorkspaceConversationLists(
        remoteConversations,
        localConversations,
      ).slice(0, 100);

      const migrationResponse = await fetch(
        conversationCollectionUrl(projectId),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversations: mergedConversations }),
          signal: controller.signal,
        },
      );
      const migrationPayload = await readResponse(migrationResponse);
      if (!migrationResponse.ok) {
        throw new Error(
          responseError(
            migrationPayload,
            "Riwayat percakapan tidak dapat disimpan ke database.",
          ),
        );
      }
      if (!current) return;

      try {
        writeConversations(window.localStorage, projectId, mergedConversations);
        setHistoryOverride(null);
        setHistoryStorageError(false);
      } catch {
        setHistoryOverride({
          projectId,
          conversations: mergedConversations,
        });
        setHistoryStorageError(true);
      }

      const savedActiveId = readActiveConversationSnapshot(
        window.localStorage,
        projectId,
      );
      const restoredActiveId = mergedConversations.some(
        (conversation) => conversation.id === savedActiveId,
      )
        ? savedActiveId
        : (mergedConversations[0]?.id ?? null);
      setActiveConversationId(restoredActiveId);
      setConversationHistorySnapshot({
        projectId,
        status: "ready",
        error: null,
      });
      setHistoryActionError(null);
    })().catch((cause: unknown) => {
      if (!current || controller.signal.aborted) return;
      setConversationHistorySnapshot({
        projectId,
        status: "error",
        error:
          cause instanceof Error
            ? cause.message
            : "Riwayat percakapan tidak dapat dimuat.",
      });
    });

    return () => {
      current = false;
      controller.abort();
    };
  }, [activeProjectId, historyReloadKey]);

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

  function queueConversationSave(
    projectId: string,
    conversation: WorkspaceConversation,
  ): Promise<void> {
    const key = `${projectId}:${conversation.id}`;
    const previous = conversationWriteQueueRef.current.get(key);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (deletedConversationIdsRef.current.has(key)) return;
        const response = await fetch(
          conversationRecordUrl(projectId, conversation.id),
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(conversation),
          },
        );
        const payload = await readResponse(response);
        if (!response.ok) {
          throw new Error(
            responseError(
              payload,
              "Riwayat percakapan tidak dapat disimpan ke database.",
            ),
          );
        }
        if (activeProjectId === projectId) {
          setConversationHistorySnapshot({
            projectId,
            status: "ready",
            error: null,
          });
        }
      })
      .catch((cause: unknown) => {
        if (
          activeProjectId === projectId &&
          !deletedConversationIdsRef.current.has(key)
        ) {
          setConversationHistorySnapshot({
            projectId,
            status: "error",
            error:
              cause instanceof Error
                ? cause.message
                : "Riwayat percakapan tidak dapat disimpan ke database.",
          });
        }
        throw cause;
      });
    const tracked = operation.finally(() => {
      if (conversationWriteQueueRef.current.get(key) === tracked) {
        conversationWriteQueueRef.current.delete(key);
      }
    });
    conversationWriteQueueRef.current.set(key, tracked);
    return tracked;
  }

  async function commitConversation(
    conversation: WorkspaceConversation,
    projectId = activeProjectId,
  ): Promise<boolean> {
    if (!projectId) return false;
    const stored = readConversations(window.localStorage, projectId);
    const current =
      historyOverride?.projectId === projectId
        ? mergeWorkspaceConversationLists(stored, historyOverride.conversations)
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
    try {
      writeConversations(window.localStorage, projectId, sorted);
      if (projectId === activeProjectId) {
        setHistoryOverride(null);
        setHistoryStorageError(false);
      }
    } catch {
      if (projectId === activeProjectId) {
        setHistoryOverride({
          projectId,
          conversations: sorted,
        });
        setHistoryStorageError(true);
      }
    }
    if (projectId === activeProjectId) {
      setActiveConversationId(conversation.id);
      setHistoryOpen(false);
    }
    try {
      await queueConversationSave(projectId, mergedConversation);
      return true;
    } catch {
      return false;
    }
  }

  function updateTurn(
    conversationId: string,
    turnId: string,
    update: Partial<WorkspaceTurn>,
    projectId = activeProjectId,
  ): Promise<boolean> {
    if (!projectId) return Promise.resolve(false);
    const updatedAt = new Date().toISOString();
    const stored = readConversations(window.localStorage, projectId);
    const current =
      historyOverride?.projectId === projectId
        ? mergeWorkspaceConversationLists(stored, historyOverride.conversations)
        : stored;
    const currentTurn = current
      .find((conversation) => conversation.id === conversationId)
      ?.turns.find((turn) => turn.id === turnId);
    if (!currentTurn) return Promise.resolve(false);
    const updateKeys = Object.keys(update) as (keyof WorkspaceTurn)[];
    if (updateKeys.every((key) => Object.is(currentTurn[key], update[key]))) {
      return Promise.resolve(true);
    }
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
    const updatedConversation = updated.find(
      (conversation) => conversation.id === conversationId,
    );
    if (!updatedConversation) return Promise.resolve(false);
    return queueConversationSave(projectId, updatedConversation)
      .then(() => true)
      .catch(() => false);
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
      [...new Set(sourceIds)],
      sources,
      sourceSnapshotState,
    );
    if (validation.issues.length) {
      setSendError(
        "Pilihan sumber yang belum siap tidak disimpan. Hapus pilihan bermasalah atau muat ulang daftar sumber.",
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
    if (!activeProjectId || conversationHistoryStatus !== "ready") return;
    const conversation = newConversation("balanced", []);
    setNewConversationSettings({
      projectId: activeProjectId,
      preference: "balanced",
      reasoningEffort: null,
      reasoningEffortMode: "selected",
      retrievalStrategy: "auto",
      sourceIds: [],
    });
    void commitConversation(conversation);
    updateDraft("");
    setSendError(null);
    setConversationRunError(null);
  }

  async function deleteConversation(conversation: WorkspaceConversation) {
    const projectId = activeProjectId;
    if (!projectId || conversationHistoryStatus !== "ready") return;
    const confirmed = window.confirm(
      `Hapus “${conversation.title}” beserta pesan, snapshot prompt, dan aktivitas run terkait dari database? Tindakan ini tidak dapat dibatalkan.`,
    );
    if (!confirmed) return;

    const key = `${projectId}:${conversation.id}`;
    deletedConversationIdsRef.current.add(key);
    setDeletingConversationId(conversation.id);
    setHistoryActionError(null);
    setConversationHistorySnapshot({
      projectId,
      status: "loading",
      error: null,
    });
    try {
      await conversationWriteQueueRef.current.get(key)?.catch(() => undefined);
      const response = await fetch(
        conversationRecordUrl(projectId, conversation.id),
        { method: "DELETE" },
      );
      if (response.status === 409) {
        const payload = await readResponse(response);
        deletedConversationIdsRef.current.delete(key);
        setHistoryActionError(
          responseError(payload, "Percakapan belum dapat dihapus."),
        );
        setConversationHistorySnapshot({
          projectId,
          status: "ready",
          error: null,
        });
        return;
      }
      if (!response.ok) {
        const payload = await readResponse(response);
        throw new Error(
          responseError(payload, "Percakapan tidak dapat dihapus."),
        );
      }

      const stored = readConversations(window.localStorage, projectId);
      const current =
        historyOverride?.projectId === projectId
          ? mergeWorkspaceConversationLists(
              stored,
              historyOverride.conversations,
            )
          : stored;
      const remaining = current.filter((item) => item.id !== conversation.id);
      try {
        writeConversations(window.localStorage, projectId, remaining);
        setHistoryOverride(null);
        setHistoryStorageError(false);
      } catch {
        setHistoryOverride({ projectId, conversations: remaining });
        setHistoryStorageError(true);
      }

      if (activeConversationId === conversation.id) {
        setActiveConversationId(null);
        updateDraft("");
        setSendError(null);
        setConversationRunError(null);
      }
      setConversationHistorySnapshot({
        projectId,
        status: "ready",
        error: null,
      });
    } catch (cause) {
      setConversationHistorySnapshot({
        projectId,
        status: "error",
        error:
          cause instanceof Error
            ? cause.message
            : "Percakapan tidak dapat dihapus.",
      });
    } finally {
      setDeletingConversationId(null);
    }
  }

  function selectConversation(conversation: WorkspaceConversation) {
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setSendError(null);
    setConversationRunError(null);
    setHistoryActionError(null);
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
        `Status sumber terbaru tidak dapat diperiksa. Tidak ada sumber yang dikirim. ${detail}`,
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
    const submittedDraftRevision = draftRevisionRef.current;
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
    if (conversationHistoryStatus !== "ready") {
      setSendError(
        conversationHistoryStatus === "loading"
          ? "Tunggu sampai riwayat percakapan selesai dimuat sebelum mengirim."
          : (conversationHistoryError ??
              "Riwayat percakapan tidak tersedia. Muat ulang riwayat sebelum mengirim."),
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
              "Pilihan sumber belum siap digunakan. Hapus pilihan bermasalah sebelum mengirim.",
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
                "Status salah satu sumber berubah. Tidak ada run yang dibuat. Hapus pilihan bermasalah lalu coba lagi.",
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
          if (!(await commitConversation(conversationWithTurn))) {
            throw new Error(
              "Pesan belum dikirim karena riwayat tidak dapat disimpan ke database.",
            );
          }
          if (draftRevisionRef.current === submittedDraftRevision) {
            updateDraft("");
          }

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
          if (!(await commitConversation(updatedConversation))) {
            throw new Error(
              "Prompt belum dijalankan karena riwayat tidak dapat disimpan ke database.",
            );
          }
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
          if (
            !(await updateTurn(updatedConversation.id, turnId, {
              status: "run_creation_unconfirmed",
              runCreateRequest: pendingRunRequest,
            }))
          ) {
            throw new Error(
              "Run belum dibuat karena status percakapan gagal disimpan.",
            );
          }
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
          if (
            !(await updateTurn(updatedConversation.id, turnId, {
              runId: createdRun.id,
              status:
                typeof createdRun.status === "string"
                  ? createdRun.status
                  : "created",
              runCreateRequest: null,
            }))
          ) {
            throw new Error(
              "Run sudah dibuat, tetapi tautannya ke riwayat chat gagal disimpan. Periksa aktivitas run sebelum mencoba lagi.",
            );
          }
        },
      );
    } catch (cause) {
      if (
        sendFailureContext.conversationWithTurn &&
        sendFailureContext.turnId
      ) {
        void updateTurn(
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
  const normalizedConversationSearch = conversationSearch
    .trim()
    .toLocaleLowerCase("id-ID");
  const filteredConversations = sortedConversations.filter((conversation) => {
    if (!normalizedConversationSearch) return true;
    return (
      conversation.title
        .toLocaleLowerCase("id-ID")
        .includes(normalizedConversationSearch) ||
      conversation.turns.some((turn) =>
        turn.userText
          .toLocaleLowerCase("id-ID")
          .includes(normalizedConversationSearch),
      )
    );
  });
  const conversationGroups = [
    "Hari ini",
    "Kemarin",
    "7 hari terakhir",
    "Sebelumnya",
  ].map((label) => ({
    label,
    conversations: filteredConversations.filter(
      (conversation) => conversationDateGroup(conversation.updatedAt) === label,
    ),
  }));
  const unavailableSources = sources.filter(
    (source) => !source.deleted && (!source.eligible || !source.versionId),
  );
  const selectedSourceChips = selectedSourceIds
    .map((sourceId) => sources.find((source) => source.id === sourceId))
    .filter((source): source is (typeof sources)[number] => Boolean(source));
  const isEmptyChat =
    Boolean(activeProjectId) &&
    conversationHistoryStatus === "ready" &&
    !activeConversation?.turns.length;

  function openSourceContext() {
    setContextPanelOpen(true);
    window.requestAnimationFrame(() =>
      document
        .getElementById("workspace-context-sources")
        ?.scrollIntoView({ block: "start" }),
    );
  }

  const composerDisabled =
    !activeProjectId ||
    conversationHistoryStatus !== "ready" ||
    sending ||
    Boolean(blockingTurn) ||
    !senopatiReady ||
    !codexTargetReady ||
    selectedSourceValidation.issues.length > 0;

  async function onLocalSourceImported(sourceId?: string) {
    if (!activeProjectId) return;
    const latestSources = await refreshSourcesForSend(activeProjectId);
    if (!sourceId) return;
    const nextIds = [...new Set([...selectedSourceIds, sourceId])];
    const validation = validateConversationSourceSelection(
      nextIds,
      latestSources,
      "ready",
    );
    if (validation.issues.length) {
      setSendError(
        "File sudah diimpor, tetapi status sumber belum siap. Pilih sumber secara manual setelah daftar dimuat ulang.",
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
    <section className={styles.page} aria-label="Workspace">
      <div
        className={
          styles.layout + (contextPanelOpen ? " " + styles.contextVisible : "")
        }
      >
        {sidebarSlot
          ? createPortal(
              <aside
                id="workspace-history"
                className={styles.historyPanel}
                aria-label="Riwayat percakapan"
              >
                <div className={styles.historyHeader}>
                  <Button
                    type="button"
                    variant="secondary"
                    className={styles.newConversationButton}
                    onClick={startNewConversation}
                    disabled={
                      !activeProjectId || conversationHistoryStatus !== "ready"
                    }
                  >
                    <MessageSquarePlus aria-hidden="true" size={16} />
                    Percakapan baru
                  </Button>
                  <label
                    className={styles.historySearch}
                    htmlFor="conversation-search"
                  >
                    <Search aria-hidden="true" size={16} />
                    <span className="sr-only">Cari percakapan</span>
                    <input
                      id="conversation-search"
                      type="search"
                      value={conversationSearch}
                      placeholder="Cari percakapan…"
                      onChange={(event) =>
                        setConversationSearch(event.target.value)
                      }
                    />
                  </label>
                </div>
                <div className={styles.historyList}>
                  {conversationHistoryStatus === "ready" &&
                  historyActionError ? (
                    <p className={styles.historyActionError} role="alert">
                      {historyActionError}
                    </p>
                  ) : null}
                  {conversationHistoryStatus === "loading" ? (
                    <p className={styles.historyLoading} role="status">
                      <LoaderCircle
                        className={styles.spin}
                        aria-hidden="true"
                        size={15}
                      />
                      Memuat riwayat percakapan…
                    </p>
                  ) : null}
                  {conversationHistoryStatus === "error" ? (
                    <div className={styles.historyError} role="alert">
                      <p>
                        {conversationHistoryError ??
                          "Riwayat percakapan tidak dapat dimuat."}
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setHistoryReloadKey((value) => value + 1)
                        }
                      >
                        Coba lagi
                      </Button>
                    </div>
                  ) : null}
                  {conversationHistoryStatus === "ready"
                    ? conversationGroups.map((group) =>
                        group.conversations.length ? (
                          <section
                            className={styles.historyGroup}
                            key={group.label}
                            aria-label={group.label}
                          >
                            <h2>{group.label}</h2>
                            {group.conversations.map((conversation) => (
                              <div
                                className={styles.historyItemRow}
                                key={conversation.id}
                              >
                                <button
                                  type="button"
                                  className={
                                    styles.historyItem +
                                    (conversation.id === activeConversationId
                                      ? " " + styles.historyItemActive
                                      : "")
                                  }
                                  aria-current={
                                    conversation.id === activeConversationId
                                      ? "page"
                                      : undefined
                                  }
                                  title={conversation.title}
                                  onClick={() =>
                                    selectConversation(conversation)
                                  }
                                >
                                  <span className={styles.historyItemCopy}>
                                    <strong>{conversation.title}</strong>
                                    <small>
                                      {shortText(
                                        conversation.turns.at(-1)?.userText ??
                                          "Belum ada pesan",
                                        58,
                                      )}
                                    </small>
                                  </span>
                                  <time dateTime={conversation.updatedAt}>
                                    {conversationTime(conversation.updatedAt)}
                                  </time>
                                </button>
                                <details className={styles.historyActions}>
                                  <summary
                                    aria-label={`Tindakan untuk ${conversation.title}`}
                                    title="Tindakan percakapan"
                                  >
                                    <Ellipsis aria-hidden="true" size={17} />
                                  </summary>
                                  <div>
                                    <button
                                      type="button"
                                      disabled={deletingConversationId !== null}
                                      onClick={() =>
                                        void deleteConversation(conversation)
                                      }
                                    >
                                      {deletingConversationId ===
                                      conversation.id ? (
                                        <LoaderCircle
                                          className={styles.spin}
                                          aria-hidden="true"
                                          size={15}
                                        />
                                      ) : (
                                        <Trash2 aria-hidden="true" size={15} />
                                      )}
                                      Hapus percakapan
                                    </button>
                                  </div>
                                </details>
                              </div>
                            ))}
                          </section>
                        ) : null,
                      )
                    : null}
                  {conversationHistoryStatus === "ready" &&
                  !sortedConversations.length ? (
                    <p className={styles.historyEmpty}>Belum ada percakapan.</p>
                  ) : null}
                  {conversationHistoryStatus === "ready" &&
                  sortedConversations.length > 0 &&
                  !filteredConversations.length ? (
                    <p className={styles.historyEmpty}>
                      Tidak ada percakapan yang cocok dengan pencarian.
                    </p>
                  ) : null}
                </div>
              </aside>,
              sidebarSlot,
            )
          : null}

        <div className={styles.chatPanel} data-testid="workspace-chat-panel">
          <header className={styles.chatHeader}>
            <div className={styles.chatTitle}>
              <h1 id="workspace-title">Workspace</h1>
              <p className={styles.chatMeta}>
                {activeProject?.name ?? "Pilih atau buat proyek untuk memulai"}
                {selectedSourceIds.length
                  ? ` · ${selectedSourceIds.length} sumber dipilih`
                  : ""}
              </p>
              <span className={styles.crumbSep} aria-hidden="true">
                /
              </span>
              <h2>{activeConversation?.title ?? "Percakapan baru"}</h2>
            </div>
            <div className={styles.chatHeaderActions}>
              <Button
                type="button"
                variant="ghost"
                className={styles.mobileHistoryButton}
                aria-expanded={historyOpen}
                aria-controls="workspace-history"
                onClick={() => setHistoryOpen(!historyOpen)}
              >
                <Clock3 aria-hidden="true" size={16} />
                <span className={styles.buttonLabel}>Riwayat</span>
              </Button>
              <span className={styles.chatHeaderStatus}>
                {providerLoading ? (
                  <Badge variant="muted">Memeriksa Senopati</Badge>
                ) : senopatiReady ? (
                  <Badge variant="success">Senopati siap</Badge>
                ) : (
                  <Badge variant="warning">Senopati tidak tersedia</Badge>
                )}
              </span>
              <Button
                type="button"
                variant="secondary"
                aria-expanded={contextPanelOpen}
                aria-controls="workspace-context"
                onClick={() => setContextPanelOpen((open) => !open)}
              >
                <PanelRight aria-hidden="true" size={16} />
                <span className={styles.buttonLabel}>Konteks</span>
              </Button>
            </div>
          </header>

          <div
            className={`${styles.chatBody}${isEmptyChat ? " " + styles.chatBodyEmpty : ""}`}
          >
            <div
              className={styles.messageScroll}
              data-testid="workspace-message-scroll"
            >
              {!activeProjectId ? (
                <div className={styles.emptyState}>
                  <h3>Pilih proyek untuk mulai</h3>
                  <p>
                    Pilih atau buat proyek di bagian atas untuk memulai
                    percakapan.
                  </p>
                </div>
              ) : null}

              {activeProjectId &&
              conversationHistoryStatus === "ready" &&
              !activeConversation?.turns.length ? (
                <div className={`${styles.emptyState} ${styles.emptyGreeting}`}>
                  <h3>Apa yang ingin Anda kerjakan?</h3>
                  <p>
                    Tulis pertanyaan atau tugas. PromptLab akan membantu
                    mengoptimalkan dan menjalankannya.
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
                    <time dateTime={turn.createdAt}>
                      {formatDate(turn.createdAt)}
                    </time>
                  </div>

                  {turn.runId &&
                  activeProjectId &&
                  conversationHistoryStatus !== "loading" ? (
                    <WorkspaceRunResult
                      key={activeProjectId + ":" + turn.runId}
                      projectId={activeProjectId}
                      runId={turn.runId}
                      initialStatus={turn.status}
                      providerLabel="Codex"
                      focusOnMount={false}
                      chatPresentation
                      userPrompt={turn.userText}
                      initialAnswer={turn.assistantText}
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
                  ) : turn.runId && conversationHistoryStatus === "loading" ? (
                    <p
                      className={styles.pendingMessage}
                      role="status"
                      aria-live="polite"
                    >
                      Memuat jawaban tersimpan…
                    </p>
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

            <div className={styles.composerDock}>
              <form
                ref={composerRef}
                className={styles.composer}
                id="workspace-composer"
                onSubmit={(event) => void submitMessage(event)}
              >
                <label className="sr-only" htmlFor="workspace-message">
                  Pesan
                </label>
                {selectedSourceChips.length ? (
                  <div className={styles.sourceChips}>
                    {selectedSourceChips.map((source) => (
                      <span className={styles.chip} key={source.id}>
                        <span>{source.displayName}</span>
                        <button
                          type="button"
                          className={styles.chipRemove}
                          aria-label={`Lepas ${source.displayName}`}
                          disabled={
                            sending ||
                            conversationHistoryStatus !== "ready" ||
                            selectedSourceValidation.issues.length > 0
                          }
                          onClick={() =>
                            updateSources(
                              selectedSourceIds.filter(
                                (id) => id !== source.id,
                              ),
                            )
                          }
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <textarea
                  id="workspace-message"
                  value={draft}
                  maxLength={MAX_WORKSPACE_MESSAGE_CHARACTERS}
                  placeholder="Ketik pesan Anda…"
                  onChange={(event) => updateDraft(event.target.value)}
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
                    conversationHistoryStatus !== "ready" ||
                    !senopatiReady ||
                    !codexTargetReady
                  }
                  aria-describedby="workspace-composer-help"
                />
                {sendError ? (
                  <p className={styles.composerError} role="alert">
                    {sendError}
                  </p>
                ) : null}
                {historyStorageError ? (
                  <p className={styles.composerError} role="status">
                    Salinan browser tidak tersimpan. Riwayat utama tetap
                    disimpan di database aplikasi.
                  </p>
                ) : null}
                <div className={styles.composerBar}>
                  <button
                    type="button"
                    className={styles.plusButton}
                    aria-label={
                      selectedSourceIds.length
                        ? `Sumber · ${selectedSourceIds.length}`
                        : "Sumber"
                    }
                    title="Sumber"
                    aria-controls="workspace-context"
                    aria-expanded={contextPanelOpen}
                    onClick={openSourceContext}
                  >
                    <Plus aria-hidden="true" size={18} />
                  </button>
                  <ComposerChoicePill
                    id="workspace-preference"
                    name="Gaya jawaban"
                    value={preference}
                    disabled={
                      sending ||
                      conversationHistoryStatus !== "ready" ||
                      selectedSourceValidation.issues.length > 0
                    }
                    options={preferenceOptions}
                    onValueChange={(value) =>
                      updatePreference(value as WorkspacePreference)
                    }
                  />
                  {codexTargetReady &&
                  (supportedThinkingEfforts.length > 0 ||
                    selectedThinkingEffortUnavailable) ? (
                    <ComposerChoicePill
                      id="workspace-thinking"
                      name="Reasoning effort Codex"
                      visibleName="Thinking"
                      value={
                        selectedThinkingValue === ""
                          ? THINKING_STANDARD_VALUE
                          : selectedThinkingValue
                      }
                      disabled={
                        sending || conversationHistoryStatus !== "ready"
                      }
                      describedBy="workspace-thinking-help"
                      options={thinkingOptions}
                      onValueChange={(value) =>
                        updateThinkingEffort(
                          value === THINKING_STANDARD_VALUE ? "" : value,
                        )
                      }
                    />
                  ) : null}
                  <span className={styles.composerSpacer} />
                  <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={composerDisabled || !draft.trim()}
                    aria-label={sending ? "Mengirim pesan" : "Kirim pesan"}
                  >
                    {sending ? (
                      <LoaderCircle
                        className={styles.spin}
                        aria-hidden="true"
                        size={17}
                      />
                    ) : (
                      <ArrowUp aria-hidden="true" size={17} strokeWidth={2.2} />
                    )}
                  </button>
                </div>
              </form>
              <p id="workspace-composer-help" className={styles.composerHelp}>
                Enter kirim · Shift + Enter baris baru · Maks.{" "}
                {MAX_WORKSPACE_MESSAGE_CHARACTERS.toLocaleString("id-ID")}{" "}
                karakter
              </p>
            </div>
          </div>
        </div>

        <aside
          id="workspace-context"
          className={styles.contextPanel}
          aria-label="Konteks percakapan"
          aria-hidden={!contextPanelOpen}
        >
          <header className={styles.contextHeader}>
            <div>
              <h2>Konteks</h2>
              <p>{activeProject?.name ?? "Pilih proyek"}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={styles.contextClose}
              aria-label="Tutup panel konteks"
              onClick={() => setContextPanelOpen(false)}
            >
              <X aria-hidden="true" size={17} />
            </Button>
          </header>
          <div className={styles.contextScroll}>
            <section
              id="workspace-context-sources"
              className={styles.contextSection}
            >
              <div className={styles.contextSectionHeading}>
                <h3>Sumber proyek</h3>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/sources">Kelola</Link>
                </Button>
              </div>
              {sourceLoading ? (
                <p className={styles.contextNotice} role="status">
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
                <div className={styles.contextSourceList}>
                  {activeSources.map((source) => {
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
                            conversationHistoryStatus !== "ready" ||
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
                            Versi {source.version ?? "tidak tersedia"} · siap
                            dipilih
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.sourceEmpty}>
                  <p>Belum ada sumber yang siap dipilih.</p>
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/sources">
                      Tambah sumber
                      <ArrowUpRight aria-hidden="true" size={14} />
                    </Link>
                  </Button>
                </div>
              )}
              {unavailableSources.length ? (
                <div className={styles.unavailableSources}>
                  <p>Belum siap</p>
                  {unavailableSources.map((source) => (
                    <small key={source.id}>
                      {source.displayName} · {source.extractStatus}
                    </small>
                  ))}
                </div>
              ) : null}
              {selectedSourceValidation.issues.length ? (
                <div className={styles.sourceIssues} role="status">
                  <p>
                    Pilihan ini belum dapat digunakan. Periksa status sumber
                    sebelum mengirim pesan.
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
                    disabled={sending || conversationHistoryStatus !== "ready"}
                    onClick={() => {
                      const issueIds = new Set(
                        selectedSourceValidation.issues.map(
                          (issue) => issue.id,
                        ),
                      );
                      updateSources(
                        selectedSourceIds.filter((id) => !issueIds.has(id)),
                      );
                    }}
                  >
                    Hapus pilihan bermasalah
                  </Button>
                  {sourceSnapshotState === "failed" && activeProjectId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={
                        sending || conversationHistoryStatus !== "ready"
                      }
                      onClick={() =>
                        void refreshSourcesForSend(activeProjectId)
                          .then(() => setSendError(null))
                          .catch((cause: unknown) =>
                            setSendError(
                              cause instanceof Error
                                ? cause.message
                                : "Daftar sumber belum dapat dimuat ulang.",
                            ),
                          )
                      }
                    >
                      Muat ulang daftar sumber
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className={styles.contextSection}>
              <h3>Mode retrieval</h3>
              <label className={styles.retrievalControl}>
                <span>Strategi</span>
                <select
                  value={selectedRetrievalStrategy}
                  disabled={
                    sending ||
                    conversationHistoryStatus !== "ready" ||
                    activeSources.length === 0
                  }
                  onChange={(event) =>
                    updateRetrievalStrategy(event.target.value)
                  }
                >
                  <option value="auto">Otomatis · Senopati memilih</option>
                  <option value="lexical">Leksikal</option>
                  <option value="graph">GraphRAG</option>
                  {hybridRetrievalReady ||
                  selectedRetrievalStrategy === "hybrid" ? (
                    <option value="hybrid" disabled={!hybridRetrievalReady}>
                      Hybrid
                      {!hybridRetrievalReady
                        ? " · indeks embedding tidak siap"
                        : ""}
                    </option>
                  ) : null}
                  <option value="full_context">Konteks sumber penuh</option>
                </select>
              </label>
              <p className={styles.contextNotice}>
                Strategi dan rute fallback aktual dicatat di detail run.
              </p>
              {selectedSourceIds.length > 0 && !hybridRetrievalReady ? (
                <p className={styles.contextNotice}>
                  Hybrid tersedia setelah indeks embedding siap untuk sumber
                  yang dipilih.
                </p>
              ) : null}
              {selectedRetrievalStrategy === "graph" ? (
                <p className={styles.contextNotice}>
                  GraphRAG memerlukan snapshot aktif untuk sumber pilihan.
                </p>
              ) : null}
            </section>

            <section className={styles.contextSection}>
              <h3>Akses & alat</h3>
              <details
                className={styles.folderPicker}
                onToggle={(event) =>
                  setWorkspaceAccessOpen(event.currentTarget.open)
                }
              >
                <summary>
                  <FolderOpen aria-hidden="true" size={15} />
                  Baca file workspace
                </summary>
                <div className={styles.folderPickerBody}>
                  <p>
                    Folder hanya dapat dibaca setelah akses proyek diberikan.
                    File tidak diimpor otomatis.
                  </p>
                  {workspaceAccessOpen ? (
                    <LocalSourceBrowser onImported={onLocalSourceImported} />
                  ) : null}
                </div>
              </details>
              <details
                className={styles.folderPicker}
                onToggle={(event) =>
                  setFileReviewOpen(event.currentTarget.open)
                }
              >
                <summary>
                  <FolderOpen aria-hidden="true" size={15} />
                  Tinjau usulan file
                </summary>
                <div className={styles.folderPickerBody}>
                  <p>
                    Usulan dapat diuji pada snapshot sebelum Anda menyetujui
                    perubahan.
                  </p>
                  {fileReviewOpen ? (
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
                  ) : null}
                </div>
              </details>
            </section>

            <section className={styles.contextSection}>
              <h3>Model & Effort</h3>
              <div className={styles.modelSummary}>
                <span className={styles.statusDot} aria-hidden="true" />
                <span>
                  <strong>{codexModel?.displayName ?? "Codex target"}</strong>
                  <small>
                    {codexTargetReady
                      ? "Target tersedia di Pengaturan"
                      : "Target belum terverifikasi"}
                  </small>
                </span>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/settings" aria-label="Atur model target">
                    Atur
                  </Link>
                </Button>
              </div>
              {codexTargetReady && supportedThinkingEfforts.length > 0 ? (
                <p
                  id="workspace-thinking-help"
                  className={styles.contextNotice}
                >
                  Tingkat usaha berpikir mengatur seberapa banyak model
                  melakukan penalaran; penalaran internal tetap tidak
                  ditampilkan.
                </p>
              ) : null}
            </section>
          </div>
        </aside>
      </div>
    </section>
  );
}
