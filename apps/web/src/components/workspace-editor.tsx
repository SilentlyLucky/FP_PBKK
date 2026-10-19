"use client";

import { Save, Send, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useProjectScope } from "@/components/project-scope";
import { WorkspacePromptOptimization } from "@/components/workspace-prompt-optimization";
import { WorkspaceRunResult } from "@/components/workspace-run-result";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ProviderConnectionState } from "@promptlab/contracts";

interface PromptSummary {
  id: string;
  name: string;
  currentVersionId: string | null;
  version: number | null;
  text: string | null;
  invariants: string[];
}

interface PromptVersionSummary {
  id: string;
  version: number;
  parentVersionId: string | null;
  createdAt: string;
}

interface ProviderListResponse {
  providers?: ProviderConnectionState[];
  codexModels?: Array<{
    id: string;
    displayName: string;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
  }>;
  outcome?: string;
  message?: string;
}

interface KnowledgeSourceSummary {
  id: string;
  displayName: string;
  permission: "local_only" | "campus_indexer_allowed";
  deleted: boolean;
  eligible: boolean;
  version: number | null;
  chunkCount: number;
}

interface RetrievalPreview {
  requestedStrategy: "lexical" | "graph" | "full_context";
  strategyUsed: "lexical" | "graph" | "full_context";
  snapshotId: string | null;
  traceId: string;
  seeds: Array<{ id: string; label: string; entityType: string }>;
  paths: Array<{ entityIds: string[]; predicates: string[]; labels: string[] }>;
  evidence: Array<{
    id: string;
    quote: string;
    documentName: string;
    documentVersion: number;
    chunkId: string;
    extractorModel?: string | null;
  }>;
  estimatedContextTokens: number;
  fallbackReason: string | null;
  clipping: Record<string, unknown>;
  elapsedMs: number;
}

function reasoningEffortLabel(effort: string): string {
  const labels: Record<string, string> = {
    minimal: "Minimal",
    low: "Rendah",
    medium: "Sedang",
    high: "Tinggi",
    xhigh: "Sangat tinggi",
    max: "Maksimal",
  };
  return labels[effort] ?? effort;
}

export function WorkspaceEditor() {
  const { activeProject, activeProjectId } = useProjectScope();
  const [promptList, setPromptList] = useState<{
    projectId: string | null;
    prompts: PromptSummary[];
    selectedPromptId: string | null;
  }>({ projectId: null, prompts: [], selectedPromptId: null });
  const prompts =
    promptList.projectId === activeProjectId ? promptList.prompts : [];
  const selectedPromptId =
    promptList.projectId === activeProjectId
      ? promptList.selectedPromptId
      : null;
  const [versionSnapshot, setVersionSnapshot] = useState<{
    key: string;
    versions: PromptVersionSummary[];
  }>({ key: "", versions: [] });
  const [newPromptNames, setNewPromptNames] = useState<Record<string, string>>(
    {},
  );
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState<{
    projectId: string | null;
    sources: KnowledgeSourceSummary[];
    status: "loading" | "ready" | "error" | "empty";
  }>({ projectId: null, sources: [], status: "empty" });
  const [sourceSelections, setSourceSelections] = useState<
    Record<string, string[]>
  >({});
  const [retrievalStrategy, setRetrievalStrategy] = useState<
    "lexical" | "graph" | "full_context"
  >("lexical");
  const [retrievalQuery, setRetrievalQuery] = useState("");
  const [retrievalPreview, setRetrievalPreview] = useState<{
    projectId: string;
    result: RetrievalPreview;
  } | null>(null);
  const [retrievalBusy, setRetrievalBusy] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [invariantValues, setInvariantValues] = useState<
    Record<string, string>
  >({});
  const [targetProvider, setTargetProvider] =
    useState<ProviderConnectionState | null>(null);
  const [selectedCodexModel, setSelectedCodexModel] = useState("");
  const [codexModels, setCodexModels] = useState<
    NonNullable<ProviderListResponse["codexModels"]>
  >([]);
  const [reasoningEffortsByModel, setReasoningEffortsByModel] = useState<
    Record<string, string>
  >({});
  const [reasoningEffortModesByModel, setReasoningEffortModesByModel] =
    useState<Record<string, "selected" | "auto">>({});
  const [campusOptimizer, setCampusOptimizer] =
    useState<ProviderConnectionState | null>(null);
  const [optimizationRunning, setOptimizationRunning] = useState(false);
  const [optimizationRecoveryReady, setOptimizationRecoveryReady] =
    useState(false);
  const [busyAction, setBusyAction] = useState<
    "save" | "run" | "verify" | "restore" | null
  >(null);
  const busy = busyAction !== null || optimizationRunning;
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [createdRun, setCreatedRun] = useState<{
    projectId: string;
    runId: string;
    status: string;
  } | null>(null);

  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) ?? null;
  const effectiveSelectedCodexModel = codexModels.some(
    (model) => model.id === selectedCodexModel,
  )
    ? selectedCodexModel
    : targetProvider?.requestedModel &&
        codexModels.some((model) => model.id === targetProvider.requestedModel)
      ? targetProvider.requestedModel
      : (codexModels[0]?.id ?? "");
  const projectKey = activeProjectId ?? "unselected";
  const draftKey = `${projectKey}:${selectedPromptId ?? "new"}`;
  const versionKey =
    activeProjectId && selectedPromptId
      ? `${activeProjectId}:${selectedPromptId}`
      : "";
  const versions =
    versionSnapshot.key === versionKey ? versionSnapshot.versions : [];
  const knowledgeSources =
    knowledgeSnapshot.projectId === activeProjectId
      ? knowledgeSnapshot.sources
      : [];
  const knowledgeStatus =
    knowledgeSnapshot.projectId === activeProjectId
      ? knowledgeSnapshot.status
      : activeProjectId
        ? "loading"
        : "empty";
  const currentSources = knowledgeSources.filter(
    (source) => !source.deleted && source.eligible,
  );
  const currentSourceIds = currentSources
    .slice(0, 20)
    .map((source) => source.id);
  const rememberedSourceIds = sourceSelections[projectKey];
  const selectedSourceIds = rememberedSourceIds
    ? rememberedSourceIds
        .filter((id) => currentSourceIds.includes(id))
        .slice(0, 20)
    : [];
  const localOnlySelectedCount = selectedSourceIds.filter(
    (id) =>
      knowledgeSources.find((source) => source.id === id)?.permission ===
      "local_only",
  ).length;
  const campusOnlySelectedCount =
    selectedSourceIds.length - localOnlySelectedCount;
  const activeRetrievalPreview =
    retrievalPreview?.projectId === activeProjectId
      ? retrievalPreview.result
      : null;
  const name = newPromptNames[projectKey] ?? "Prompt baru";
  const targetModel = codexModels.find(
    (model) => model.id === effectiveSelectedCodexModel,
  );
  const selectedModelVerified = Boolean(
    targetProvider?.status === "verified" &&
    targetProvider.requestedModel === effectiveSelectedCodexModel,
  );
  const supportedReasoningEfforts =
    targetModel?.supportedReasoningEfforts ?? [];
  const selectedReasoningEffort = targetModel
    ? (reasoningEffortsByModel[targetModel.id] ?? "")
    : "";
  const selectedReasoningEffortMode = targetModel
    ? (reasoningEffortModesByModel[targetModel.id] ?? "selected")
    : "selected";
  const selectedReasoningEffortUnavailable =
    selectedReasoningEffortMode === "selected" &&
    selectedReasoningEffort &&
    !supportedReasoningEfforts.includes(selectedReasoningEffort)
      ? selectedReasoningEffort
      : null;
  const draft = draftValues[draftKey] ?? selectedPrompt?.text ?? "";
  const invariantText =
    invariantValues[draftKey] ?? selectedPrompt?.invariants.join("\n") ?? "";

  function setName(value: string) {
    setNewPromptNames((current) => ({ ...current, [projectKey]: value }));
  }

  function setDraft(value: string) {
    setDraftValues((current) => ({ ...current, [draftKey]: value }));
  }

  function setInvariantText(value: string) {
    setInvariantValues((current) => ({ ...current, [draftKey]: value }));
  }

  function selectPrompt(promptId: string | null) {
    setPromptList((current) => ({
      projectId: activeProjectId,
      prompts: current.projectId === activeProjectId ? current.prompts : [],
      selectedPromptId: promptId,
    }));
    setError(null);
    setMessage(null);
  }
  const draftInvariants = invariantText
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const savedPromptMatchesDraft = Boolean(
    selectedPrompt?.currentVersionId &&
    selectedPrompt.text === draft &&
    selectedPrompt.invariants.length === draftInvariants.length &&
    selectedPrompt.invariants.every(
      (invariant, index) => invariant === draftInvariants[index],
    ),
  );
  const promptBlockers: string[] = [];
  if (!activeProjectId) {
    promptBlockers.push("Pilih atau buat proyek terlebih dahulu.");
  }
  if (!draft.trim()) {
    promptBlockers.push("Tulis prompt terlebih dahulu.");
  }
  if (!selectedPrompt?.currentVersionId) {
    promptBlockers.push("Simpan prompt sebagai versi pertama sebelum run.");
  } else if (!savedPromptMatchesDraft) {
    promptBlockers.push(
      "Perubahan prompt atau invarian belum tersimpan. Simpan versi baru sebelum run.",
    );
  }

  const providerBlocker = !targetProvider
    ? "Status Codex belum termuat. Muat ulang Workspace atau buka Pengaturan."
    : codexModels.length === 0
      ? "Login Codex di Pengaturan untuk memuat pilihan model."
      : !targetModel
        ? "Pilih model Codex untuk run ini."
        : !selectedModelVerified
          ? `Verifikasi ${targetModel.displayName} sebelum menjalankan.`
          : null;
  const runBlockers = providerBlocker
    ? [...promptBlockers, providerBlocker]
    : promptBlockers;
  const canRun = runBlockers.length === 0;
  const optimizerBlocker = !campusOptimizer
    ? "Koneksi Senopati belum terbaca. Muat ulang Workspace atau buka Pengaturan."
    : campusOptimizer.status !== "verified"
      ? "Koneksi Senopati belum siap. Periksa koneksinya di Pengaturan sebelum menjalankan perbaikan."
      : null;
  const optimizationBlockers = optimizerBlocker
    ? [...runBlockers, optimizerBlocker]
    : runBlockers;
  const canOptimize = canRun && optimizerBlocker === null;
  const optimizationNextStep = !activeProjectId
    ? "Pilih atau buat proyek dari menu di bagian atas."
    : !draft.trim()
      ? "Tulis instruksi untuk Codex di atas."
      : !selectedPrompt?.currentVersionId
        ? "Simpan prompt untuk melanjutkan."
        : !savedPromptMatchesDraft
          ? "Simpan perubahan prompt sebelum menjalankan."
          : providerBlocker
            ? codexModels.length === 0
              ? "Login Codex di Pengaturan agar model tersedia."
              : targetModel
                ? `Verifikasi ${targetModel.displayName} untuk run ini.`
                : "Pilih model Codex untuk run ini."
            : optimizerBlocker
              ? optimizerBlocker
              : !optimizationRecoveryReady
                ? "Memeriksa run aktif dan pertanyaan yang menunggu jawaban."
                : "Senopati siap memperbaiki prompt dan Codex siap mengujinya.";

  const refreshPrompts = useCallback(async () => {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    const response = await fetch(`/api/projects/${projectId}/prompts`, {
      cache: "no-store",
    });
    const result = (await response.json()) as {
      prompts?: PromptSummary[];
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error ?? "Prompt tidak dapat dimuat.");
    const next = result.prompts ?? [];
    setPromptList((current) => {
      const currentId =
        current.projectId === projectId ? current.selectedPromptId : null;
      return {
        projectId,
        prompts: next,
        selectedPromptId: next.some((prompt) => prompt.id === currentId)
          ? currentId
          : (next[0]?.id ?? null),
      };
    });
  }, [activeProjectId]);

  useEffect(() => {
    let current = true;
    if (activeProjectId) {
      const projectId = activeProjectId;
      fetch(`/api/projects/${projectId}/prompts`, { cache: "no-store" })
        .then(async (response) => {
          const result = (await response.json()) as {
            prompts?: PromptSummary[];
            error?: string;
          };
          if (!response.ok)
            throw new Error(result.error ?? "Prompt tidak dapat dimuat.");
          return result.prompts ?? [];
        })
        .then((next) => {
          if (!current) return;
          setPromptList((currentList) => {
            const currentId =
              currentList.projectId === projectId
                ? currentList.selectedPromptId
                : null;
            return {
              projectId,
              prompts: next,
              selectedPromptId: next.some((prompt) => prompt.id === currentId)
                ? currentId
                : (next[0]?.id ?? null),
            };
          });
        })
        .catch((cause) => {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Prompt tidak dapat dimuat.",
            );
        });
    }
    const providerUrl = activeProjectId
      ? `/api/providers?projectId=${encodeURIComponent(activeProjectId)}`
      : "/api/providers";
    fetch(providerUrl, { cache: "no-store" })
      .then(async (response) =>
        response.ok ? (response.json() as Promise<ProviderListResponse>) : null,
      )
      .then((result) => {
        if (current) {
          setTargetProvider(
            result?.providers?.find(
              (item) => item.provider === "codex_app_server",
            ) ?? null,
          );
          setCodexModels(result?.codexModels ?? []);
        }
        if (current)
          setCampusOptimizer(
            result?.providers?.find(
              (item) => item.provider === "campus_gateway",
            ) ?? null,
          );
      })
      .catch(() => {
        if (current) {
          setTargetProvider(null);
          setCodexModels([]);
          setCampusOptimizer(null);
        }
      });
    if (activeProjectId) {
      const projectId = activeProjectId;
      fetch(`/api/projects/${projectId}/knowledge`, { cache: "no-store" })
        .then(async (response) => {
          const result = (await response.json()) as {
            sources?: KnowledgeSourceSummary[];
            error?: string;
          };
          if (!response.ok)
            throw new Error(
              result.error ?? "Sumber knowledge tidak dapat dimuat.",
            );
          return result.sources ?? [];
        })
        .then((sources) => {
          if (current)
            setKnowledgeSnapshot({ projectId, sources, status: "ready" });
        })
        .catch(() => {
          if (current)
            setKnowledgeSnapshot({ projectId, sources: [], status: "error" });
        });
    }
    return () => {
      current = false;
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!versionKey || !activeProjectId || !selectedPromptId) return;
    let active = true;
    const key = versionKey;
    fetch(
      `/api/projects/${activeProjectId}/prompts/${selectedPromptId}/versions`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          versions?: PromptVersionSummary[];
        };
        if (response.ok && active)
          setVersionSnapshot({ key, versions: result.versions ?? [] });
      })
      .catch(() => {
        if (active) setVersionSnapshot({ key, versions: [] });
      });
    return () => {
      active = false;
    };
  }, [
    activeProjectId,
    selectedPromptId,
    selectedPrompt?.currentVersionId,
    versionKey,
  ]);

  async function savePrompt(
    textOverride?: string,
    parentVersionIdOverride?: string,
  ): Promise<boolean> {
    if (!activeProjectId) {
      setError("Pilih atau buat proyek terlebih dahulu.");
      return false;
    }
    const textToSave = textOverride ?? draft;
    if (!textToSave.trim()) {
      setError("Prompt kosong tidak dapat disimpan.");
      return false;
    }
    setBusyAction("save");
    setError(null);
    setMessage(null);
    const invariants = invariantText
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    try {
      const targetUrl = selectedPrompt
        ? `/api/projects/${activeProjectId}/prompts/${selectedPrompt.id}/versions`
        : `/api/projects/${activeProjectId}/prompts`;
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          selectedPrompt
            ? {
                text: textToSave,
                invariants,
                parentVersionId:
                  parentVersionIdOverride ?? selectedPrompt.currentVersionId,
              }
            : {
                name: name.trim() || "Prompt baru",
                text: textToSave,
                invariants,
              },
        ),
      });
      const result = (await response.json()) as {
        prompt?: PromptSummary;
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Versi prompt tidak dapat disimpan.");
      if (textOverride !== undefined) setDraft(textToSave);
      await refreshPrompts();
      if (result.prompt) selectPrompt(result.prompt.id);
      setMessage(
        textOverride !== undefined
          ? "Kandidat disimpan sebagai versi prompt baru."
          : "Versi tersimpan sebagai catatan baru.",
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Versi prompt tidak dapat disimpan.",
      );
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function runPrompt() {
    if (
      !activeProjectId ||
      !selectedPrompt?.currentVersionId ||
      !canOptimize ||
      !targetModel ||
      !selectedModelVerified ||
      !campusOptimizer?.requestedModel
    ) {
      setError(
        `Run belum tersedia: ${optimizationBlockers.join(" ") || "periksa proyek, prompt, dan koneksi Senopati."}`,
      );
      return;
    }
    setBusyAction("run");
    setError(null);
    setMessage(null);
    setCreatedRun(null);
    try {
      const response = await fetch(`/api/projects/${activeProjectId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          promptVersionId: selectedPrompt.currentVersionId,
          provider: "campus_gateway",
          requestedModel: campusOptimizer.requestedModel,
          purpose: "optimizer",
          intent: "workspace_chat",
          idempotencyKey: crypto.randomUUID(),
          retrieval: {
            strategy: retrievalStrategy,
            sourceIds: selectedSourceIds,
          },
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: {
              requestedModel: effectiveSelectedCodexModel,
              reasoningEffort:
                selectedReasoningEffortMode === "auto"
                  ? null
                  : selectedReasoningEffort || null,
              reasoningEffortMode: selectedReasoningEffortMode,
            },
          },
        }),
      });
      const result = (await response.json()) as {
        run?: { id: string; status: string };
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          result.message ?? result.error ?? "Run tidak dapat dibuat.",
        );
      if (result.run?.id)
        setCreatedRun({
          projectId: activeProjectId,
          runId: result.run.id,
          status: result.run.status,
        });
      setMessage(
        result.run
          ? "Run dibuat. Jawaban akan tampil otomatis di Optimasi."
          : "Run dibuat.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Run tidak dapat dibuat.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function verifySelectedCodexModel() {
    if (!effectiveSelectedCodexModel || !targetModel || busy) return;
    setBusyAction("verify");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "codex-verify",
          model: effectiveSelectedCodexModel,
        }),
      });
      const result = (await response.json()) as ProviderListResponse;
      const codexProvider = result.providers?.find(
        (item) => item.provider === "codex_app_server",
      );
      if (codexProvider) setTargetProvider(codexProvider);
      if (result.codexModels) setCodexModels(result.codexModels);
      if (!response.ok || result.outcome !== "verified") {
        throw new Error(
          result.message ?? "Model Codex belum berhasil diverifikasi.",
        );
      }
      setMessage(`${targetModel.displayName} siap dipakai untuk run.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Model Codex tidak dapat diverifikasi.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  function toggleSource(sourceId: string, checked: boolean) {
    setSourceSelections((current) => {
      const previous = current[projectKey] ?? [];
      const next = checked
        ? [...new Set([...previous, sourceId])].slice(0, 20)
        : previous.filter((id) => id !== sourceId);
      return { ...current, [projectKey]: next };
    });
    setRetrievalPreview(null);
  }

  async function previewKnowledgeRetrieval() {
    if (!activeProjectId) {
      setRetrievalError("Pilih proyek terlebih dahulu.");
      return;
    }
    if (!retrievalQuery.trim()) {
      setRetrievalError("Masukkan pertanyaan untuk pratinjau retrieval.");
      return;
    }
    setRetrievalBusy(true);
    setRetrievalError(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/graph/retrieval`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: retrievalQuery,
            strategy: retrievalStrategy,
            sourceIds: selectedSourceIds,
          }),
        },
      );
      const result = (await response.json()) as {
        retrieval?: RetrievalPreview;
        message?: string;
        error?: string;
      };
      if (!response.ok || !result.retrieval) {
        throw new Error(
          result.message ?? result.error ?? "Retrieval preview gagal.",
        );
      }
      setRetrievalPreview({
        projectId: activeProjectId,
        result: result.retrieval,
      });
    } catch (cause) {
      setRetrievalError(
        cause instanceof Error ? cause.message : "Retrieval preview gagal.",
      );
    } finally {
      setRetrievalBusy(false);
    }
  }

  async function restoreVersion(versionId: string) {
    if (!activeProjectId || !selectedPrompt) return;
    setBusyAction("restore");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/prompts/${selectedPrompt.id}/rollback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ versionId }),
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error ?? "Rollback tidak dapat dibuat.");
      setDraftValues((current) => {
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      setInvariantValues((current) => {
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      await refreshPrompts();
      setMessage(
        "Rollback dibuat sebagai versi baru; seluruh versi sebelumnya tetap tersimpan.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Rollback tidak dapat dibuat.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  function handleEditorKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      event.key !== "Enter" ||
      (!event.ctrlKey && !event.metaKey) ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    const optimizationForm = document.getElementById(
      "workspace-prompt-optimization-form",
    ) as HTMLFormElement | null;
    optimizationForm?.requestSubmit();
  }

  return (
    <div className="workspace-grid">
      <Card id="prompt-studio">
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle>Instruksi untuk Codex</CardTitle>
              <CardDescription>
                Tulis instruksi, simpan, lalu jalankan. Prompt tersimpan dapat
                dipakai lagi.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="editor-content">
          {prompts.length ? (
            <details className="workspace-disclosure prompt-library">
              <summary>
                {selectedPrompt
                  ? `Prompt tersimpan: ${selectedPrompt.name}${selectedPrompt.version ? ` · v${selectedPrompt.version}` : ""}`
                  : "Pilih prompt tersimpan"}
              </summary>
              <div className="workspace-disclosure-body">
                <div className="field">
                  <label htmlFor="prompt-select">Pilih prompt</label>
                  <select
                    id="prompt-select"
                    className="select"
                    value={selectedPromptId ?? ""}
                    onChange={(event) =>
                      selectPrompt(event.target.value || null)
                    }
                  >
                    <option value="">Buat prompt baru</option>
                    {prompts.map((prompt) => (
                      <option key={prompt.id} value={prompt.id}>
                        {prompt.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </details>
          ) : null}
          {!selectedPrompt ? (
            <div className="field">
              <label htmlFor="prompt-name">Nama prompt</label>
              <input
                id="prompt-name"
                className="input"
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Prompt baru"
              />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="prompt-text">Tugas yang ingin Codex kerjakan</label>
            <textarea
              id="prompt-text"
              className="textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              maxLength={100_000}
              placeholder="Tulis instruksi dengan bahasa sehari-hari…"
            />
          </div>
          <details className="workspace-disclosure">
            <summary>Aturan tambahan (opsional)</summary>
            <div className="workspace-disclosure-body">
              <div className="field">
                <label htmlFor="prompt-invariants">
                  Aturan yang harus selalu diikuti
                  <span className="helper">(satu per baris)</span>
                </label>
                <textarea
                  id="prompt-invariants"
                  className="input invariants-input"
                  value={invariantText}
                  onChange={(event) => setInvariantText(event.target.value)}
                  maxLength={20_000}
                  placeholder="Contoh: Jangan mengarang sumber"
                />
              </div>
            </div>
          </details>
          <details className="workspace-disclosure">
            <summary>
              {selectedSourceIds.length
                ? `Gunakan knowledge proyek · ${selectedSourceIds.length} sumber dipilih`
                : "Gunakan knowledge proyek (opsional)"}
            </summary>
            <section
              className="workspace-context workspace-disclosure-body"
              aria-labelledby="workspace-context-title"
            >
              <div>
                <h2 id="workspace-context-title">
                  Tambahkan konteks dari proyek
                </h2>
                <p className="helper">
                  Pilih sumber yang ingin disertakan. Teks sumber terpilih akan
                  ikut dikirim ke Codex saat dijalankan.
                </p>
              </div>
              <div className="workspace-context-grid">
                <div className="field">
                  <label htmlFor="retrieval-strategy">Strategi retrieval</label>
                  <select
                    id="retrieval-strategy"
                    className="select"
                    value={retrievalStrategy}
                    onChange={(event) => {
                      setRetrievalStrategy(
                        event.target.value as typeof retrievalStrategy,
                      );
                      setRetrievalPreview(null);
                    }}
                  >
                    <option value="lexical">Lexical search</option>
                    <option value="graph">GraphRAG · maksimal 2 hop</option>
                    <option value="full_context">
                      Full context · dibatasi
                    </option>
                  </select>
                </div>
                <fieldset className="source-selection">
                  <legend>Pilih sumber knowledge</legend>
                  {currentSources.length ? (
                    currentSources.slice(0, 20).map((source) => (
                      <label className="source-choice" key={source.id}>
                        <input
                          type="checkbox"
                          checked={selectedSourceIds.includes(source.id)}
                          onChange={(event) =>
                            toggleSource(source.id, event.target.checked)
                          }
                        />
                        <span>
                          <span className="source-choice-name">
                            {source.displayName}
                          </span>
                          <span className="helper">
                            v{source.version} · {source.chunkCount} chunk ·{" "}
                            {source.permission === "campus_indexer_allowed"
                              ? "izin Campus Gateway saja; bukan izin provider lain"
                              : "local-only; untuk preview lokal"}
                          </span>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="helper">
                      {knowledgeStatus === "loading"
                        ? "Memuat sumber proyek…"
                        : knowledgeStatus === "error"
                          ? "Sumber knowledge belum dapat dimuat. Coba muat ulang halaman."
                          : activeProjectId
                            ? "Belum ada sumber siap pakai. Tambahkan sumber di halaman Knowledge."
                            : "Pilih proyek dari menu di bagian atas terlebih dahulu."}
                    </p>
                  )}
                </fieldset>
              </div>
              {localOnlySelectedCount ? (
                <p className="helper" role="status">
                  {localOnlySelectedCount} sumber local-only terpilih tetap
                  tersedia untuk preview lokal. Jangan sertakan sumber ini dalam
                  run ke provider.
                </p>
              ) : null}
              {campusOnlySelectedCount ? (
                <p className="helper" role="status">
                  Izin Campus pada {campusOnlySelectedCount} sumber hanya
                  berlaku untuk Campus Gateway; izin ini tidak mengizinkan
                  pengiriman ke target Codex.
                </p>
              ) : null}
              {currentSources.length && !selectedSourceIds.length ? (
                <p className="helper" role="status">
                  Tidak ada sumber dipilih. Codex akan berjalan tanpa konteks
                  dari knowledge.
                </p>
              ) : null}
              <details className="workspace-disclosure-nested">
                <summary>Pratinjau bukti sebelum run (opsional)</summary>
                <div className="workspace-disclosure-body">
                  <div className="field">
                    <label htmlFor="retrieval-query">
                      Pertanyaan untuk pratinjau
                    </label>
                    <textarea
                      id="retrieval-query"
                      className="input context-query"
                      value={retrievalQuery}
                      onChange={(event) =>
                        setRetrievalQuery(event.target.value)
                      }
                      maxLength={2_000}
                      placeholder="Contoh: Tim mana yang memantau queue pada Service Checkout?"
                    />
                  </div>
                  <div className="form-row">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        retrievalBusy ||
                        !activeProjectId ||
                        !retrievalQuery.trim()
                      }
                      onClick={() => void previewKnowledgeRetrieval()}
                    >
                      {retrievalBusy ? "Mencari bukti…" : "Pratinjau retrieval"}
                    </Button>
                    <Link className="helper knowledge-link" href="/knowledge">
                      Kelola Knowledge
                    </Link>
                  </div>
                  {retrievalError ? (
                    <p className="error-message" role="alert">
                      {retrievalError}
                    </p>
                  ) : null}
                  {activeRetrievalPreview ? (
                    <section
                      className="retrieval-result"
                      aria-label="Hasil pratinjau retrieval"
                    >
                      <div className="retrieval-result-heading">
                        <strong>
                          {activeRetrievalPreview.strategyUsed === "graph"
                            ? "Graph evidence terpilih"
                            : activeRetrievalPreview.strategyUsed ===
                                "full_context"
                              ? "Full context terpilih"
                              : "Lexical evidence terpilih"}
                        </strong>
                        <span className="helper">
                          {activeRetrievalPreview.estimatedContextTokens} token
                          perkiraan · {activeRetrievalPreview.elapsedMs} ms
                        </span>
                      </div>
                      <dl className="retrieval-facts">
                        <div>
                          <dt>Snapshot</dt>
                          <dd className="mono">
                            {activeRetrievalPreview.snapshotId ??
                              "Fallback lexical"}
                          </dd>
                        </div>
                        <div>
                          <dt>Paths</dt>
                          <dd>{activeRetrievalPreview.paths.length}</dd>
                        </div>
                        <div>
                          <dt>Trace</dt>
                          <dd className="mono">
                            {activeRetrievalPreview.traceId}
                          </dd>
                        </div>
                      </dl>
                      {activeRetrievalPreview.fallbackReason ? (
                        <p className="helper">
                          Fallback: {activeRetrievalPreview.fallbackReason}
                        </p>
                      ) : null}
                      {activeRetrievalPreview.evidence.length ? (
                        <ol className="retrieval-evidence-list">
                          {activeRetrievalPreview.evidence.map((item) => (
                            <li key={item.id}>
                              <blockquote>{item.quote}</blockquote>
                              <p className="helper">
                                {item.documentName} · v{item.documentVersion} ·
                                chunk {item.chunkId.slice(0, 8)}
                                {item.extractorModel
                                  ? ` · ${item.extractorModel}`
                                  : ""}
                              </p>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="helper">
                          Tidak ada chunk sumber yang cocok.
                        </p>
                      )}
                    </section>
                  ) : null}
                </div>
              </details>
            </section>
          </details>
          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="success-message" role="status">
              {message}
            </p>
          ) : null}
          <div className="workspace-model-options">
            <div className="field">
              <label htmlFor="codex-model">Model Codex</label>
              <select
                id="codex-model"
                className="select"
                value={effectiveSelectedCodexModel}
                disabled={!codexModels.length || busy}
                onChange={(event) => {
                  const modelId = event.target.value;
                  setSelectedCodexModel(modelId);
                  setReasoningEffortsByModel((current) => ({
                    ...current,
                    [modelId]: "",
                  }));
                  setReasoningEffortModesByModel((current) => ({
                    ...current,
                    [modelId]: "selected",
                  }));
                  setError(null);
                  setMessage(null);
                }}
              >
                {codexModels.length ? null : (
                  <option value="">Login Codex untuk memuat model</option>
                )}
                {codexModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
              {!codexModels.length ? (
                <p className="helper">
                  <Link className="knowledge-link" href="/settings">
                    Login Codex di Pengaturan
                  </Link>
                </p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="reasoning-effort">Kedalaman berpikir</label>
              {targetModel ? (
                <>
                  <select
                    id="reasoning-effort"
                    className="select"
                    value={
                      selectedReasoningEffortMode === "auto"
                        ? "auto"
                        : selectedReasoningEffort
                    }
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      setReasoningEffortModesByModel((current) => ({
                        ...current,
                        [targetModel.id]:
                          value === "auto" ? "auto" : "selected",
                      }));
                      if (value !== "auto") {
                        setReasoningEffortsByModel((current) => ({
                          ...current,
                          [targetModel.id]: value,
                        }));
                      }
                    }}
                  >
                    <option value="auto">Auto</option>
                    <option value="">
                      Bawaan model
                      {targetModel.defaultReasoningEffort
                        ? ` (${reasoningEffortLabel(targetModel.defaultReasoningEffort)})`
                        : ""}
                    </option>
                    {selectedReasoningEffortUnavailable ? (
                      <option
                        value={selectedReasoningEffortUnavailable}
                        disabled
                      >
                        {reasoningEffortLabel(
                          selectedReasoningEffortUnavailable,
                        )}
                        {" (tidak didukung model saat ini)"}
                      </option>
                    ) : null}
                    {supportedReasoningEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {reasoningEffortLabel(effort)}
                      </option>
                    ))}
                  </select>
                  <p className="helper">
                    {selectedReasoningEffortUnavailable
                      ? `Pilihan ${reasoningEffortLabel(selectedReasoningEffortUnavailable)} tidak lagi didukung katalog model aktif. Pilihan akan dikirim apa adanya dan worker akan menolak run sebelum Codex dipanggil.`
                      : supportedReasoningEfforts.length === 0 &&
                          selectedReasoningEffortMode === "auto"
                        ? "Auto dipilih, tetapi katalog model aktif tidak mengumumkan tingkat usaha. Worker akan menolak run sebelum Codex dipanggil."
                        : selectedReasoningEffortMode === "auto"
                          ? "Auto memakai rekomendasi tugas yang divalidasi terhadap kemampuan live. GPT-6 Luna memakai Maksimal."
                          : "Pilihan mengikuti model terpilih."}
                  </p>
                </>
              ) : (
                <p className="helper">
                  Pilih model Codex untuk melihat pilihan yang tersedia.
                </p>
              )}
            </div>
          </div>
          {targetModel ? (
            <div className="workspace-model-status">
              <Badge variant={selectedModelVerified ? "success" : "warning"}>
                {selectedModelVerified ? "Model siap" : "Perlu verifikasi"}
              </Badge>
              {!selectedModelVerified ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void verifySelectedCodexModel()}
                  disabled={busy}
                >
                  {busyAction === "verify"
                    ? "Memverifikasi…"
                    : `Verifikasi ${targetModel.displayName}`}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="editor-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void savePrompt()}
              disabled={
                busy ||
                !draft.trim() ||
                Boolean(selectedPrompt && savedPromptMatchesDraft)
              }
            >
              <Save aria-hidden="true" size={15} />
              {busyAction === "save"
                ? "Menyimpan…"
                : selectedPrompt
                  ? savedPromptMatchesDraft
                    ? "Prompt tersimpan"
                    : "Simpan perubahan"
                  : "Simpan prompt"}
            </Button>
            <Button
              type="submit"
              form="workspace-prompt-optimization-form"
              disabled={
                !canOptimize ||
                !optimizationRecoveryReady ||
                busy ||
                !draft.trim()
              }
              aria-describedby="workspace-run-status"
            >
              <Send aria-hidden="true" size={15} />
              {optimizationRunning ? "Memproses perbaikan…" : "Run"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void runPrompt()}
              disabled={!canRun || busy || !draft.trim()}
            >
              Coba tanpa perbaikan
            </Button>
          </div>
          <p id="workspace-run-status" className="helper" role="status">
            {optimizationRunning
              ? "Perbaikan prompt dan pengujian jawaban sedang berjalan."
              : busyAction === "run"
                ? "Menyiapkan run tanpa perbaikan."
                : busyAction === "verify"
                  ? "Verifikasi model sedang berjalan."
                  : busyAction === "save"
                    ? "Prompt sedang disimpan."
                    : busyAction === "restore"
                      ? "Versi prompt sedang dipulihkan."
                      : optimizationNextStep}{" "}
            {providerBlocker &&
            activeProjectId &&
            selectedPrompt?.currentVersionId &&
            savedPromptMatchesDraft &&
            targetModel ? (
              <Link className="knowledge-link" href="/settings">
                Buka Pengaturan Codex
              </Link>
            ) : null}
          </p>
          {createdRun?.projectId === activeProjectId ? (
            <WorkspaceRunResult
              key={`${createdRun.projectId}:${createdRun.runId}`}
              projectId={createdRun.projectId}
              runId={createdRun.runId}
              initialStatus={createdRun.status}
            />
          ) : null}
          <WorkspacePromptOptimization
            projectId={activeProjectId}
            promptId={selectedPrompt?.id ?? null}
            promptVersionId={selectedPrompt?.currentVersionId ?? null}
            promptText={draft}
            modelId={effectiveSelectedCodexModel}
            modelName={targetModel?.displayName ?? null}
            reasoningEffort={selectedReasoningEffort || null}
            defaultReasoningEffort={targetModel?.defaultReasoningEffort ?? null}
            optimizerModel={campusOptimizer?.requestedModel ?? null}
            knowledgeSourceIds={selectedSourceIds}
            retrievalStrategy={retrievalStrategy}
            canOptimize={canOptimize}
            blocker={
              optimizationBlockers.length > 0
                ? optimizationBlockers.join(" ")
                : null
            }
            busy={busy}
            onRunningChange={setOptimizationRunning}
            onRecoveryReadyChange={setOptimizationRecoveryReady}
            onApplyCandidate={async (promptId, candidate, draftVersionId) => {
              if (!selectedPrompt || selectedPrompt.id !== promptId) {
                throw new Error(
                  "Pilih prompt asal sebelum menggunakan hasil perbaikan.",
                );
              }
              const saved = await savePrompt(
                candidate,
                draftVersionId ?? undefined,
              );
              if (!saved)
                throw new Error("Kandidat belum tersimpan sebagai versi baru.");
            }}
          />
        </CardContent>
      </Card>

      <details className="workspace-disclosure workspace-history">
        <summary>Riwayat prompt dan status provider</summary>
        <aside
          className="workspace-inspector stack workspace-disclosure-body"
          aria-label="Riwayat prompt dan status provider"
        >
          <Card>
            <CardHeader>
              <CardTitle>
                {selectedPrompt ? "Riwayat versi" : "Riwayat prompt"}
              </CardTitle>
              <CardDescription>
                {activeProject
                  ? `Proyek: ${activeProject.name}`
                  : "Pilih proyek dari header untuk mulai menyimpan prompt."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {selectedPrompt ? (
                <>
                  <div className="inspector-fact">
                    <span>Versi aktif</span>
                    <span className="mono">
                      {selectedPrompt.version
                        ? `v${selectedPrompt.version}`
                        : "Tidak tersedia"}
                    </span>
                  </div>
                  <div className="divider" />
                  <p className="panel-label history-title">Riwayat versi</p>
                  <ol className="version-list">
                    {versions.map((version) => (
                      <li key={version.id}>
                        <span className="mono">v{version.version}</span>
                        {version.id === selectedPrompt.currentVersionId ? (
                          <Badge variant="success">Aktif</Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => void restoreVersion(version.id)}
                          >
                            Pulihkan sebagai versi baru
                          </Button>
                        )}
                      </li>
                    ))}
                    {versions.length === 0 ? (
                      <li className="helper">Riwayat tidak tersedia.</li>
                    ) : null}
                  </ol>
                  <div className="divider" />
                  <p className="panel-label" style={{ marginTop: 16 }}>
                    Versi original
                  </p>
                  <pre className="original-preview">
                    {selectedPrompt.text || "Konten versi tidak tersedia."}
                  </pre>
                </>
              ) : (
                <div className="empty-state">
                  <div>
                    <ShieldAlert aria-hidden="true" size={20} />
                    <p>Belum ada prompt tersimpan.</p>
                    <p className="helper">
                      Prompt yang disimpan akan muncul di sini.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Provider target</CardTitle>
              <CardDescription>
                Status akun dan model yang menjalankan prompt.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="status-line">
                <Badge variant={canRun ? "success" : "warning"}>
                  {targetProvider?.status ?? "unavailable"}
                </Badge>
                <span>
                  {targetProvider?.requestedModel ??
                    "Model efektif belum diverifikasi"}
                </span>
              </div>
              <p className="helper" style={{ marginTop: 12 }}>
                {targetProvider?.reason ?? "Codex target belum diverifikasi."}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Optimizer kampus</CardTitle>
              <CardDescription>
                Gateway kampus menangani optimasi dan indexing; ia bukan
                provider target.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="status-line">
                <Badge variant="muted">
                  {campusOptimizer?.status ?? "unavailable"}
                </Badge>
                <span>
                  {campusOptimizer?.requestedModel ??
                    "Model belum dikonfigurasi"}
                </span>
              </div>
              <p className="helper" style={{ marginTop: 12 }}>
                {campusOptimizer?.reason ??
                  "Gateway kampus belum diverifikasi."}
              </p>
            </CardContent>
          </Card>
        </aside>
      </details>
    </div>
  );
}
