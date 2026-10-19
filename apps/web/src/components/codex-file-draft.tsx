"use client";

import { LoaderCircle, ShieldAlert, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { WorkspaceRunResult } from "@/components/workspace-run-result";
import { Button } from "@/components/ui/button";
import type { WorkspaceRunCreateRequest } from "@/lib/workspace-conversations";
import {
  classifyCodexDraftRunCreation,
  clearCodexFileDraftActiveRun,
  clearCodexFileDraftPendingRun,
  compareCodexFileDraftContexts,
  composeCodexFileDraftPrompt,
  loadCodexFileDraftActiveRun,
  loadCodexFileDraftPendingRun,
  MAX_CODEX_FILE_DRAFT_INPUT_BYTES,
  MAX_CODEX_FILE_DRAFT_TASK_CHARACTERS,
  saveCodexFileDraftActiveRun,
  saveCodexFileDraftPendingRun,
  validateCodexFileDraftRetry,
  validateCodexFileDraftRequest,
  validateCodexFileDraftResult,
  type CodexFileDraftActiveRun as StoredActiveDraftRun,
  type CodexFileDraftContext,
  type CodexFileDraftPendingRun,
} from "@/lib/codex-file-draft";

import styles from "./codex-file-draft.module.css";

export interface CodexFileDraftRunRecord {
  projectId: string;
  id: string;
  promptVersionId: string;
  promptText: string;
  promptName: string;
  requestedModel: string;
  status: string;
  createdAt: string;
}

export interface CodexDraftTarget {
  state: "loading" | "available" | "unavailable";
  modelId: string | null;
  reasoningEffort?: string;
  message: string | null;
}

export interface CodexDraftOptimizer {
  state: "loading" | "available" | "unavailable";
  modelId: string | null;
  message: string | null;
}

interface ActiveDraftRun {
  id: string;
  status: string;
  context: CodexFileDraftContext;
  request: WorkspaceRunCreateRequest;
}

interface CodexFileDraftProps {
  context: CodexFileDraftContext;
  fileText: string;
  target: CodexDraftTarget;
  optimizer: CodexDraftOptimizer;
  onAnswer: (answer: string, context: CodexFileDraftContext) => boolean;
  onInputLockChange: (locked: boolean) => void;
  onPromptSaved: () => void;
  onRunCreated: (run: CodexFileDraftRunRecord) => void;
  onRunStatusChange: (projectId: string, runId: string, status: string) => void;
}

const promptName = "Draf teks file lokal dengan Codex";

function storageKey(projectId: string): string {
  return "promptlab.codex-file-draft.pending.v1:" + projectId;
}

function activeStorageKey(projectId: string): string {
  return "promptlab.codex-file-draft.active.v1:" + projectId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  return isRecord(payload) ? payload : {};
}

function responseMessage(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  return fallback;
}

function isActiveRun(status: string): boolean {
  return ["created", "queued", "running", "cancel_requested"].includes(status);
}

function isKnownFinalRun(status: string): boolean {
  return ["succeeded", "failed", "canceled"].includes(status);
}

function blockMessage(reason: string): string {
  switch (reason) {
    case "task_optimization_consent_required":
      return "Setujui pengiriman teks tugas saja ke Senopati untuk optimasi.";
    case "optimizer_unavailable":
      return "Senopati belum terverifikasi. Hubungkan Senopati di Pengaturan sebelum membuat draf.";
    case "sharing_consent_required":
      return "Setujui pengiriman isi file ke Codex sebelum membuat draf.";
    case "retention_consent_required":
      return "Setujui penyimpanan tugas dan isi file di riwayat proyek sebelum membuat draf.";
    case "empty_task":
      return "Tulis tugas singkat untuk Codex terlebih dahulu.";
    case "task_too_large":
      return (
        "Tugas melebihi " +
        MAX_CODEX_FILE_DRAFT_TASK_CHARACTERS.toLocaleString("id-ID") +
        " karakter. Ringkas tugas lalu coba lagi."
      );
    case "missing_snapshot_hash":
      return "Versi file belum memiliki hash yang dapat diverifikasi. Muat ulang file sebelum membuat draf.";
    case "input_too_large":
      return (
        "Isi file melebihi " +
        MAX_CODEX_FILE_DRAFT_INPUT_BYTES / 1024 +
        " KiB. Tidak ada teks yang dikirim."
      );
    case "prompt_too_large":
      return "Prompt lengkap melebihi batas penyimpanan proyek. Tidak ada teks yang dipotong atau dikirim.";
    case "grant_expired":
      return "Izin baca atau tulis berakhir. Muat ulang file dan minta izin baru.";
    case "project_changed":
      return "Proyek berubah saat Codex menjawab. Hasil lama tidak dimasukkan ke editor.";
    case "file_changed":
      return "File berubah saat Codex menjawab. Hasil lama tidak dimasukkan ke editor.";
    case "snapshot_changed":
      return "Snapshot file berubah saat Codex menjawab. Hasil lama tidak dimasukkan ke editor.";
    case "grant_changed":
      return "Izin lokal berubah saat Codex menjawab. Hasil tidak dimasukkan ke editor.";
    case "answer_too_large":
      return "Jawaban Codex melebihi 128 KiB dan tidak dimasukkan ke editor.";
    case "target_unavailable":
      return "Target Codex belum terverifikasi. Periksa koneksi dan model sebelum memeriksa ulang run.";
    case "target_changed":
      return "Target Codex berubah sejak run dibuat. Periksa target sebelum mengirim ulang run yang sama.";
    default:
      return "Hasil Codex tidak dapat dipakai untuk snapshot ini.";
  }
}

export function CodexFileDraft({
  context,
  fileText,
  target,
  optimizer,
  onAnswer,
  onInputLockChange,
  onPromptSaved,
  onRunCreated,
  onRunStatusChange,
}: CodexFileDraftProps) {
  const [task, setTask] = useState("");
  const [taskOptimizationConsent, setTaskOptimizationConsent] =
    useState(false);
  const [sharingConsent, setSharingConsent] = useState(false);
  const [retentionConsent, setRetentionConsent] = useState(false);
  const [pending, setPending] = useState<CodexFileDraftPendingRun | null>(null);
  const [pendingBlocked, setPendingBlocked] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [state, setState] = useState<
    | "idle"
    | "preparing"
    | "creating_run"
    | "unconfirmed"
    | "running"
    | "done"
    | "failed"
  >("idle");
  const [activeRun, setActiveRun] = useState<ActiveDraftRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [resolving, setResolving] = useState(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const submittedPendingRef = useRef<CodexFileDraftPendingRun | null>(null);
  const onAnswerRef = useRef(onAnswer);
  const onInputLockChangeRef = useRef(onInputLockChange);
  const onPromptSavedRef = useRef(onPromptSaved);
  const onRunCreatedRef = useRef(onRunCreated);
  const onRunStatusChangeRef = useRef(onRunStatusChange);
  const currentContextRef = useRef(context);
  const currentTargetRef = useRef(target);
  const currentOptimizerRef = useRef(optimizer);
  const taskOptimizationConsentRef = useRef(taskOptimizationConsent);
  const sharingConsentRef = useRef(sharingConsent);
  const retentionConsentRef = useRef(retentionConsent);
  currentContextRef.current = context;
  currentTargetRef.current = target;
  currentOptimizerRef.current = optimizer;
  taskOptimizationConsentRef.current = taskOptimizationConsent;
  sharingConsentRef.current = sharingConsent;
  retentionConsentRef.current = retentionConsent;
  const currentTaskCharacters = Array.from(task).length;
  const fileBytes = new TextEncoder().encode(fileText).byteLength;
  const inputTooLarge = fileBytes > MAX_CODEX_FILE_DRAFT_INPUT_BYTES;
  const hasUnresolvedCreation = pending !== null || pendingBlocked;
  const runActive = activeRun !== null && isActiveRun(activeRun.status);
  const runNeedsReview =
    activeRun !== null &&
    !isActiveRun(activeRun.status) &&
    !isKnownFinalRun(activeRun.status);

  const setInputLocked = useCallback((locked: boolean) => {
    onInputLockChangeRef.current(locked);
  }, []);

  useEffect(() => {
    onAnswerRef.current = onAnswer;
    onInputLockChangeRef.current = onInputLockChange;
    onPromptSavedRef.current = onPromptSaved;
    onRunCreatedRef.current = onRunCreated;
    onRunStatusChangeRef.current = onRunStatusChange;
  }, [
    onAnswer,
    onInputLockChange,
    onPromptSaved,
    onRunCreated,
    onRunStatusChange,
  ]);

  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      try {
        const stored = loadCodexFileDraftPendingRun(
          window.sessionStorage,
          storageKey(context.projectId),
          context.projectId,
        );
        const active = loadCodexFileDraftActiveRun(
          window.sessionStorage,
          activeStorageKey(context.projectId),
          context.projectId,
        );
        setPending(stored.value);
        setPendingBlocked(stored.blocked || active.blocked);
        if (stored.value || stored.blocked || active.blocked) {
          setState("unconfirmed");
          setError(
            "Pembuatan run sebelumnya belum dapat dipastikan. Periksa status run yang sama sebelum membuat draf baru.",
          );
          setInputLocked(true);
        } else if (active.value) {
          const recovered: ActiveDraftRun = {
            id: active.value.runId,
            status: active.value.status,
            context: active.value.context,
            request: active.value.request,
          };
          setActiveRun(recovered);
          if (isKnownFinalRun(recovered.status)) {
            setState(
              recovered.status === "succeeded" ||
                recovered.status === "canceled"
                ? "done"
                : "failed",
            );
            if (recovered.status === "canceled") {
              setNotice(
                "Run ditandai batal. Status tersebut tidak memastikan apakah pekerjaan remote sudah berhenti.",
              );
            }
            clearCodexFileDraftActiveRun(
              window.sessionStorage,
              activeStorageKey(context.projectId),
            );
          } else {
            setState(isActiveRun(recovered.status) ? "running" : "unconfirmed");
            if (recovered.status === "interrupted_unknown") {
              setError(
                "Hasil run belum diketahui. Periksa run tersimpan sebelum mencoba draf lain.",
              );
            }
            setInputLocked(true);
          }
        }
      } catch {
        setPendingBlocked(true);
        setError(
          "Status draf sebelumnya tidak dapat dibaca dari penyimpanan sesi. Muat ulang browser dan periksa riwayat run sebelum membuat draf baru.",
        );
        setInputLocked(true);
      } finally {
        setStorageReady(true);
      }
    });
    return () => {
      current = false;
    };
  }, [context.projectId, setInputLocked]);

  useEffect(
    () => () => {
      requestControllerRef.current?.abort();
    },
    [],
  );

  function persistPending(value: CodexFileDraftPendingRun): boolean {
    const projectId = value.request.projectId;
    if (
      !saveCodexFileDraftPendingRun(
        window.sessionStorage,
        storageKey(projectId),
        value,
      )
    ) {
      return false;
    }
    if (currentContextRef.current.projectId === projectId) {
      setPending(value);
      setPendingBlocked(false);
    }
    return true;
  }

  function clearPending(projectId = context.projectId): boolean {
    if (
      !clearCodexFileDraftPendingRun(
        window.sessionStorage,
        storageKey(projectId),
      )
    ) {
      if (currentContextRef.current.projectId === projectId) {
        setPendingBlocked(true);
      }
      return false;
    }
    if (currentContextRef.current.projectId === projectId) {
      setPending(null);
      setPendingBlocked(false);
    }
    return true;
  }

  function persistActiveRun(active: ActiveDraftRun): boolean {
    const stored: StoredActiveDraftRun = {
      version: 1,
      context: active.context,
      request: active.request,
      runId: active.id,
      status: active.status,
    };
    return saveCodexFileDraftActiveRun(
      window.sessionStorage,
      activeStorageKey(active.request.projectId),
      stored,
    );
  }

  function clearActiveRun(projectId: string): boolean {
    return clearCodexFileDraftActiveRun(
      window.sessionStorage,
      activeStorageKey(projectId),
    );
  }

  function recordRun(
    run: Record<string, unknown>,
    savedRequest: WorkspaceRunCreateRequest,
    promptText: string,
    runContext: CodexFileDraftContext,
  ): ActiveDraftRun | null {
    if (typeof run.id !== "string") return null;
    const status = typeof run.status === "string" ? run.status : "created";
    onRunCreatedRef.current({
      projectId: savedRequest.projectId,
      id: run.id,
      promptVersionId: savedRequest.promptVersionId,
      promptText,
      promptName,
      requestedModel: savedRequest.requestedModel,
      status,
      createdAt: new Date().toISOString(),
    });
    const active = {
      id: run.id,
      status,
      context: runContext,
      request: savedRequest,
    };
    setActiveRun(active);
    onRunStatusChangeRef.current(savedRequest.projectId, run.id, status);
    return active;
  }

  async function startDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      optimizer.state !== "available" ||
      !optimizer.modelId ||
      !taskOptimizationConsent
    ) {
      setError(
        !taskOptimizationConsent
          ? blockMessage("task_optimization_consent_required")
          : optimizer.message ??
              blockMessage("optimizer_unavailable"),
      );
      return;
    }
    if (target.state !== "available" || !target.modelId) {
      setError(
        target.message ??
          "Target Codex belum terverifikasi. Periksa Pengaturan.",
      );
      return;
    }
    if (
      hasUnresolvedCreation ||
      state === "preparing" ||
      runActive ||
      runNeedsReview
    ) {
      return;
    }
    if (!storageReady) {
      setError("Memeriksa status draf sebelumnya. Coba lagi sebentar.");
      return;
    }

    const blocker = validateCodexFileDraftRequest({
      task,
      fileText,
      context,
      taskOptimizationConsent,
      optimizerReady:
        optimizer.state === "available" && Boolean(optimizer.modelId),
      sharingConsent,
      retentionConsent,
    });
    if (blocker) {
      setError(blockMessage(blocker));
      return;
    }
    if (!navigator.locks) {
      setError(
        "Browser ini tidak menyediakan kunci lintas-tab. Buka Workspace di browser yang mendukung Web Locks sebelum membuat draf.",
      );
      return;
    }

    const capturedContext = { ...context };
    const promptText = composeCodexFileDraftPrompt({ task, fileText });
    const controller = new AbortController();
    submittedPendingRef.current = null;
    requestControllerRef.current = controller;
    setError(null);
    setNotice(null);
    setState("preparing");
    setInputLocked(true);
    try {
      await navigator.locks.request(
        "promptlab-workspace-send:" + context.projectId,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            setState("failed");
            setError(
              "Workspace sedang mengirim pesan di tab lain. Tunggu lalu coba lagi.",
            );
            setInputLocked(false);
            return;
          }

          const promptResponse = await fetch(
            "/api/projects/" +
              encodeURIComponent(context.projectId) +
              "/prompts",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: promptName,
                text: promptText,
                invariants: [],
              }),
              cache: "no-store",
              signal: controller.signal,
            },
          );
          const promptPayload = await readJson(promptResponse);
          const savedPrompt = isRecord(promptPayload.prompt)
            ? promptPayload.prompt
            : null;
          if (
            !promptResponse.ok ||
            !savedPrompt ||
            typeof savedPrompt.id !== "string" ||
            typeof savedPrompt.currentVersionId !== "string"
          ) {
            throw new Error(
              responseMessage(
                promptPayload,
                "Permintaan draf tidak dapat disimpan di riwayat proyek.",
              ),
            );
          }
          onPromptSavedRef.current();

          const request: WorkspaceRunCreateRequest = {
            projectId: context.projectId,
            promptVersionId: savedPrompt.currentVersionId,
            provider: "codex_app_server",
            requestedModel: target.modelId!,
            purpose: "target",
            intent: "workspace_file_draft",
            ...(target.reasoningEffort
              ? { reasoningEffort: target.reasoningEffort }
              : {}),
            idempotencyKey: crypto.randomUUID(),
            retrieval: { strategy: "lexical", sourceIds: [] },
            workspaceFileDraft: {
              format: "promptlab-workspace-file-draft-run-v1",
              path: capturedContext.path,
              snapshotHash: capturedContext.snapshotHash!,
              readGrantId: capturedContext.readGrantId,
              writeGrantId: capturedContext.writeGrantId,
              taskOptimizationConsent: true,
            },
          };
          const pendingRun: CodexFileDraftPendingRun = {
            version: 1,
            context: capturedContext,
            request,
          };
          if (!persistPending(pendingRun)) {
            setState("failed");
            setError(
              "Status run tidak dapat disimpan untuk pemulihan. Tidak ada run yang dikirim; periksa penyimpanan sesi browser.",
            );
            setInputLocked(false);
            return;
          }
          submittedPendingRef.current = pendingRun;

          setState("creating_run");
          const runResponse = await fetch(
            "/api/projects/" + encodeURIComponent(context.projectId) + "/runs",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              cache: "no-store",
              signal: controller.signal,
            },
          );
          const runPayload = await readJson(runResponse);
          const run = isRecord(runPayload.run) ? runPayload.run : null;
          const classification = classifyCodexDraftRunCreation({
            ok: runResponse.ok,
            status: runResponse.status,
            error:
              typeof runPayload.error === "string" ? runPayload.error : null,
            runId: typeof run?.id === "string" ? run.id : null,
          });
          if (classification === "accepted" && run) {
            acceptResolvedRun(run, pendingRun, promptText);
            return;
          }
          if (classification === "confirmed_absent") {
            if (!clearPending(request.projectId)) {
              setState("unconfirmed");
              setError(
                "Server memastikan run belum dibuat, tetapi kunci pemulihannya tidak dapat dibersihkan. Periksa status run yang sama sebelum melanjutkan.",
              );
              setInputLocked(true);
              return;
            }
            setState("failed");
            setError(
              responseMessage(runPayload, "Run draf tidak dapat dibuat."),
            );
            setInputLocked(false);
            return;
          }
          setState("unconfirmed");
          setError(
            responseMessage(
              runPayload,
              "Status pembuatan run belum dapat dipastikan.",
            ) +
              " Gunakan pemeriksaan status untuk melanjutkan dengan kunci yang sama.",
          );
          setInputLocked(true);
        },
      );
    } catch (cause) {
      const submittedPending =
        submittedPendingRef.current as CodexFileDraftPendingRun | null;
      if (submittedPending) {
        if (
          currentContextRef.current.projectId ===
          submittedPending.request.projectId
        ) {
          setPending(submittedPending);
          setPendingBlocked(false);
        }
        setState("unconfirmed");
        setError(
          controller.signal.aborted
            ? "Permintaan berhenti menunggu di browser. Status run tetap perlu diperiksa dengan kunci yang sama."
            : "Respons pembuatan run tidak diterima. Status run tetap perlu diperiksa dengan kunci yang sama.",
        );
        setInputLocked(true);
        return;
      }
      if (controller.signal.aborted) {
        setState("failed");
        setError("Persiapan draf dihentikan; tidak ada hasil yang dimasukkan.");
        setInputLocked(false);
        return;
      }
      setState("failed");
      setError(
        cause instanceof Error
          ? cause.message
          : "Draf Codex tidak dapat dimulai.",
      );
      setInputLocked(Boolean(pending || pendingBlocked || activeRun));
    } finally {
      submittedPendingRef.current = null;
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }

  function acceptResolvedRun(
    run: Record<string, unknown>,
    saved: CodexFileDraftPendingRun,
    promptText: string,
  ) {
    const active = recordRun(run, saved.request, promptText, saved.context);
    if (!active) {
      setState("unconfirmed");
      setError("Respons status run tidak menyertakan ID run yang valid.");
      setInputLocked(true);
      return;
    }
    if (!isKnownFinalRun(active.status) && !persistActiveRun(active)) {
      if (currentContextRef.current.projectId === saved.request.projectId) {
        setPending(saved);
        setPendingBlocked(false);
      }
      setState("unconfirmed");
      setError(
        "Run ditemukan, tetapi status aktifnya tidak dapat disimpan. Kunci yang sama tetap dipakai untuk pemulihan.",
      );
      setInputLocked(true);
      return;
    }
    if (isKnownFinalRun(active.status)) {
      clearActiveRun(saved.request.projectId);
    }
    if (!clearPending(saved.request.projectId)) {
      setState("unconfirmed");
      setError(
        "Run ditemukan, tetapi status pemulihannya tidak dapat dibersihkan. Periksa run yang sama sebelum membuat draf lain.",
      );
      setInputLocked(true);
      return;
    }
    setResolving(false);
    setTaskOptimizationConsent(false);
    setSharingConsent(false);
    setRetentionConsent(false);
    const contextReason = compareCodexFileDraftContexts(
      saved.context,
      currentContextRef.current,
    );
    if (contextReason) {
      setError(blockMessage(contextReason));
      setNotice(
        "Run lama tetap tercatat di riwayat proyek. Jawabannya tidak akan dimasukkan ke file yang sedang dipilih.",
      );
    } else {
      setError(null);
      setNotice(null);
    }
    if (isActiveRun(active.status)) {
      setState("running");
      setInputLocked(true);
      return;
    }
    if (isKnownFinalRun(active.status)) {
      if (active.status === "succeeded") {
        setState("done");
      } else if (active.status === "canceled") {
        setState("done");
        setNotice(
          "Run ditandai batal. Status tersebut tidak memastikan apakah pekerjaan remote sudah berhenti.",
        );
      } else {
        setState("failed");
        if (!contextReason) {
          setError("Run Codex gagal. Teks editor tidak diubah.");
        }
      }
      setInputLocked(false);
      return;
    }
    setState("unconfirmed");
    setError(
      active.status === "interrupted_unknown"
        ? "Hasil run belum diketahui. Periksa run tersimpan sebelum mencoba draf lain."
        : "Run memerlukan tindakan. Periksa statusnya di riwayat run proyek.",
    );
    setInputLocked(true);
  }

  async function reconcilePendingRun() {
    if (!pending || resolving || !navigator.locks) return;
    setResolving(true);
    setError(null);
    setNotice(null);
    try {
      await navigator.locks.request(
        "promptlab-workspace-send:" + pending.request.projectId,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            throw new Error(
              "Workspace sedang mengirim pesan di tab lain. Status run belum diperiksa.",
            );
          }
          const runsUrl =
            "/api/projects/" +
            encodeURIComponent(pending.request.projectId) +
            "/runs";
          let response = await fetch(
            runsUrl +
              "?idempotencyKey=" +
              encodeURIComponent(pending.request.idempotencyKey),
            { cache: "no-store" },
          );
          let payload = await readJson(response);
          let retried = false;
          if (response.status === 404 && payload.error === "RUN_NOT_FOUND") {
            const retryBlocker = validateCodexFileDraftRetry({
              captured: pending.context,
              current: currentContextRef.current,
              request: pending.request,
              target: currentTargetRef.current,
              taskOptimizationConsent: taskOptimizationConsentRef.current,
              optimizerReady:
                currentOptimizerRef.current.state === "available" &&
                Boolean(currentOptimizerRef.current.modelId),
              sharingConsent: sharingConsentRef.current,
              retentionConsent: retentionConsentRef.current,
            });
            if (retryBlocker) {
              throw new Error(
                blockMessage(retryBlocker) +
                  " Run yang sama tetap terkunci dan tidak dikirim ulang.",
              );
            }
            response = await fetch(runsUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(pending.request),
              cache: "no-store",
            });
            payload = await readJson(response);
            retried = true;
          }
          const run = isRecord(payload.run) ? payload.run : null;
          if (response.ok && run && typeof run.id === "string") {
            const promptText =
              typeof run.promptText === "string"
                ? run.promptText
                : "Prompt draf tersimpan di riwayat proyek.";
            acceptResolvedRun(run, pending, promptText);
            return;
          }
          const classification = classifyCodexDraftRunCreation({
            ok: response.ok,
            status: response.status,
            error: typeof payload.error === "string" ? payload.error : null,
            runId: typeof run?.id === "string" ? run.id : null,
          });
          if (retried && classification === "confirmed_absent") {
            if (!clearPending(pending.request.projectId)) {
              throw new Error(
                "Server memastikan run belum dibuat, tetapi kunci pemulihannya tidak dapat dibersihkan.",
              );
            }
            clearActiveRun(pending.request.projectId);
            setState("failed");
            setError(
              "Server memastikan run belum dibuat. Periksa tugas dan persetujuan sebelum mencoba draf baru.",
            );
            setInputLocked(false);
            return;
          }
          throw new Error(
            responseMessage(
              payload,
              "Status run belum dapat dipastikan. Kunci yang sama tetap disimpan.",
            ),
          );
        },
      );
    } catch (cause) {
      setState("unconfirmed");
      setError(
        cause instanceof Error
          ? cause.message
          : "Status run belum dapat dipastikan. Kunci yang sama tetap disimpan.",
      );
      setInputLocked(true);
    } finally {
      setResolving(false);
    }
  }

  async function cancelRun() {
    if (!activeRun || !isActiveRun(activeRun.status) || canceling) return;
    setCanceling(true);
    setError(null);
    try {
      const response = await fetch(
        "/api/projects/" +
          encodeURIComponent(activeRun.request.projectId) +
          "/runs/" +
          encodeURIComponent(activeRun.id) +
          "/cancel",
        { method: "POST", cache: "no-store" },
      );
      const payload = await readJson(response);
      const status = typeof payload.status === "string" ? payload.status : null;
      if (!response.ok || !status) {
        throw new Error(responseMessage(payload, "Pembatalan belum tercatat."));
      }
      const updated = { ...activeRun, status };
      setActiveRun(updated);
      if (isKnownFinalRun(status)) {
        clearActiveRun(activeRun.request.projectId);
      } else {
        persistActiveRun(updated);
      }
      onRunStatusChangeRef.current(
        activeRun.context.projectId,
        activeRun.id,
        status,
      );
      if (status === "canceled") {
        setState("done");
        setNotice(
          payload.remoteOutcomeKnown === true
            ? "Run ditandai batal."
            : "Run ditandai batal, tetapi hasil remote belum diketahui dan pekerjaan remote mungkin masih berjalan.",
        );
        setInputLocked(false);
      } else if (status === "failed") {
        setState("failed");
        setError("Run Codex gagal. Teks editor tidak diubah.");
        setInputLocked(false);
      } else if (status === "succeeded") {
        setState("done");
        setInputLocked(false);
      } else if (isActiveRun(status)) {
        setState("running");
        setNotice(
          "Permintaan pembatalan tercatat. Status ini belum memastikan pekerjaan remote sudah berhenti.",
        );
        setInputLocked(true);
      } else {
        setState("unconfirmed");
        setError(
          status === "interrupted_unknown"
            ? "Hasil run belum diketahui. Periksa run tersimpan sebelum mencoba draf lain."
            : "Run memerlukan tindakan. Periksa statusnya di riwayat run proyek.",
        );
        setInputLocked(true);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Status pembatalan belum dapat dipastikan.",
      );
    } finally {
      setCanceling(false);
    }
  }

  function handleStatusChange(runId: string, status: string) {
    const updated = activeRun?.id === runId ? { ...activeRun, status } : null;
    if (updated) {
      setActiveRun(updated);
      if (isKnownFinalRun(status)) {
        clearActiveRun(updated.request.projectId);
      } else {
        persistActiveRun(updated);
      }
    }
    onRunStatusChangeRef.current(
      activeRun?.request.projectId ?? context.projectId,
      runId,
      status,
    );
    if (status === "succeeded") {
      setState("done");
      setInputLocked(false);
      return;
    }
    if (status === "canceled") {
      setState("done");
      setNotice(
        "Run ditandai batal, tetapi hasil remote belum diketahui dan pekerjaan remote mungkin masih berjalan.",
      );
      setInputLocked(false);
      return;
    }
    if (status === "failed") {
      setState("failed");
      setError("Run Codex gagal. Teks editor tidak diubah.");
      setInputLocked(false);
      return;
    }
    if (isActiveRun(status)) {
      setState("running");
      setInputLocked(true);
      return;
    }
    setState("unconfirmed");
    setError(
      status === "interrupted_unknown"
        ? "Hasil run belum diketahui. Periksa run tersimpan sebelum mencoba draf lain."
        : status.startsWith("paused_")
          ? "Run memerlukan tindakan. Periksa statusnya di riwayat run proyek."
          : "Status run belum diketahui. Periksa run tersimpan sebelum mencoba draf lain.",
    );
    setInputLocked(true);
  }

  function handleCompleted(answer: string) {
    const capturedContext = activeRun?.context;
    if (!capturedContext) return;
    clearActiveRun(activeRun.request.projectId);
    setActiveRun((current) =>
      current?.id === activeRun.id
        ? { ...current, status: "succeeded" }
        : current,
    );
    const reason = validateCodexFileDraftResult({
      answer,
      captured: capturedContext,
      current: currentContextRef.current,
    });
    if (reason) {
      setState("failed");
      setError(blockMessage(reason));
      setInputLocked(false);
      return;
    }
    if (!onAnswerRef.current(answer, capturedContext)) {
      setState("failed");
      setError(
        "Konteks editor berubah sebelum hasil diterapkan. Muat ulang file dan periksa teks yang sudah ada.",
      );
      setInputLocked(false);
      return;
    }
    setState("done");
    setError(null);
    setNotice(
      "Draf Codex masuk ke editor. Periksa dan edit teksnya sebelum membuat usulan diff.",
    );
    setInputLocked(false);
  }

  const targetUnavailable = target.state !== "available" || !target.modelId;
  const optimizerUnavailable =
    optimizer.state !== "available" || !optimizer.modelId;
  const unresolved = hasUnresolvedCreation || runNeedsReview;
  const controlsDisabled =
    targetUnavailable ||
    optimizerUnavailable ||
    unresolved ||
    !storageReady ||
    state === "preparing" ||
    state === "creating_run" ||
    runActive ||
    runNeedsReview ||
    state === "done";
  const canReconfirmRecoveryConsent =
    pending !== null &&
    !pendingBlocked &&
    storageReady &&
    validateCodexFileDraftRetry({
      captured: pending.context,
      current: context,
      request: pending.request,
      target,
      taskOptimizationConsent: true,
      optimizerReady: true,
      sharingConsent: true,
      retentionConsent: true,
    }) === null;
  const consentControlsDisabled = canReconfirmRecoveryConsent
    ? resolving
    : controlsDisabled;
  const requestBlocker = !context.snapshotHash
    ? "missing_snapshot_hash"
    : inputTooLarge
      ? "input_too_large"
      : null;

  return (
    <section className={styles.panel} aria-labelledby="codex-file-draft-title">
      <div className={styles.heading}>
        <div className={styles.mark} aria-hidden="true">
          <Sparkles size={17} />
        </div>
        <div>
          <h4 id="codex-file-draft-title">Draf teks dengan Codex</h4>
          <p>Codex menyiapkan teks untuk editor. Anda tetap meninjau diff.</p>
        </div>
      </div>

      <div className={styles.disclosure}>
        <p>
          Senopati menerima teks tugas saja untuk optimasi; isi file tidak
          dikirim kepadanya. Setelah optimasi, tugas dan snapshot file terpilih
          dikirim ke target Codex terverifikasi. Teks tugas dan file disimpan
          dalam riwayat prompt dan run proyek.
        </p>
        <ul>
          <li>Teks file diperlakukan sebagai data tidak tepercaya.</li>
          <li>Tidak ada sumber pencarian atau file lain yang dikirim.</li>
          <li>Codex tidak mendapat akses file atau perintah.</li>
        </ul>
      </div>

      {target.state === "loading" ? (
        <p className={styles.status} role="status">
          <LoaderCircle aria-hidden="true" size={15} /> Memeriksa target Codex…
        </p>
      ) : null}
      {targetUnavailable && target.state !== "loading" ? (
        <div className={styles.unavailable} role="status">
          <ShieldAlert aria-hidden="true" size={16} />
          <p>
            {target.message ??
              "Target Codex belum terverifikasi. Periksa koneksi dan model di Pengaturan."}
          </p>
        </div>
      ) : null}
      {optimizer.state === "loading" ? (
        <p className={styles.status} role="status">
          <LoaderCircle aria-hidden="true" size={15} /> Memeriksa Senopati…
        </p>
      ) : null}
      {optimizerUnavailable && optimizer.state !== "loading" ? (
        <div className={styles.unavailable} role="status">
          <ShieldAlert aria-hidden="true" size={16} />
          <p>
            {optimizer.message ??
              "Senopati belum terverifikasi. Periksa koneksi dan model di Pengaturan."}
          </p>
        </div>
      ) : null}
      {requestBlocker ? (
        <p className={styles.feedback} role="status">
          {blockMessage(requestBlocker)}
        </p>
      ) : null}

      <form
        className={styles.form}
        onSubmit={(event) => void startDraft(event)}
      >
        <label htmlFor="codex-file-draft-task">Tugas untuk Codex</label>
        <textarea
          id="codex-file-draft-task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          aria-describedby="codex-file-draft-task-help"
          disabled={controlsDisabled}
          rows={3}
        />
        <p id="codex-file-draft-task-help" className={styles.hint}>
          Maksimal{" "}
          {MAX_CODEX_FILE_DRAFT_TASK_CHARACTERS.toLocaleString("id-ID")}{" "}
          karakter · {currentTaskCharacters.toLocaleString("id-ID")} karakter ·
          file {fileBytes.toLocaleString("id-ID")} byte
        </p>

        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={taskOptimizationConsent}
            onChange={(event) =>
              setTaskOptimizationConsent(event.target.checked)
            }
            disabled={consentControlsDisabled}
          />
          <span>
            Saya setuju mengirim teks tugas saja ke Senopati untuk optimasi.
          </span>
        </label>
        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={sharingConsent}
            onChange={(event) => setSharingConsent(event.target.checked)}
            disabled={consentControlsDisabled}
          />
          <span>Saya setuju mengirim teks file terpilih ke Codex.</span>
        </label>
        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={retentionConsent}
            onChange={(event) => setRetentionConsent(event.target.checked)}
            disabled={consentControlsDisabled}
          />
          <span>
            Saya setuju tugas dan teks file disimpan dalam riwayat proyek.
          </span>
        </label>

        {error ? (
          <p className={styles.feedback} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.success} role="status" aria-live="polite">
            {notice}
          </p>
        ) : null}

        {hasUnresolvedCreation ? (
          <Button
            type="button"
            onClick={() => void reconcilePendingRun()}
            disabled={resolving || !pending}
          >
            {resolving ? (
              <LoaderCircle
                className={styles.spin}
                aria-hidden="true"
                size={15}
              />
            ) : null}
            {resolving ? "Memeriksa run…" : "Periksa status run yang sama"}
          </Button>
        ) : runNeedsReview ? (
          <p className={styles.status} role="status">
            Periksa run tersimpan sebelum membuat draf baru. Hasil run ini belum
            dapat dipastikan.
          </p>
        ) : runActive && activeRun ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => void cancelRun()}
            disabled={canceling || activeRun.status === "cancel_requested"}
          >
            {canceling ? "Mengirim pembatalan…" : "Minta pembatalan"}
          </Button>
        ) : state === "preparing" || state === "creating_run" ? (
          <p className={styles.status} role="status" aria-live="polite">
            <LoaderCircle
              className={styles.spin}
              aria-hidden="true"
              size={15}
            />
            {state === "preparing"
              ? "Menyimpan tugas ke riwayat proyek…"
              : "Membuat run Codex…"}
          </p>
        ) : state !== "done" && !targetUnavailable ? (
          <Button
            type="submit"
            disabled={
              controlsDisabled ||
              Boolean(requestBlocker) ||
              !taskOptimizationConsent ||
              !sharingConsent ||
              !retentionConsent
            }
          >
            Draf dengan Codex
          </Button>
        ) : null}
      </form>

      {activeRun ? (
        <div className={styles.run} aria-label="Status run draf">
          <WorkspaceRunResult
            key={activeRun.request.projectId + ":" + activeRun.id}
            projectId={activeRun.request.projectId}
            runId={activeRun.id}
            initialStatus={activeRun.status}
            providerLabel="Codex"
            focusOnMount={false}
            displayAnswer={false}
            onCompleted={handleCompleted}
            onStatusChange={(status) =>
              handleStatusChange(activeRun.id, status)
            }
          />
        </div>
      ) : null}
    </section>
  );
}
