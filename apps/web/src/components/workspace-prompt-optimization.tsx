"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OptimizationClarificationAnsweredEventSchema,
  OptimizationClarificationRequestedEventSchema,
  OptimizationClarificationSchema,
} from "@promptlab/contracts";

import { RunActivityDescription } from "@/components/run-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  newestClarification,
  parseProjectClarifications,
  readStoredOptimizationRun,
  writeStoredOptimizationRun,
  type OptimizationClarification,
  type StoredOptimizationRun,
} from "@/lib/optimization-clarification-client";
import {
  canApplyOptimizationCandidate,
  isLegacyUnverifiedOptimizationCandidate,
  parseAnswers,
  parseOptimizationResult,
  parseUsage,
  type OptimizationAnswer,
  type OptimizationCandidate,
  type OptimizationResult,
  type OptimizationTargetSelectionEvidence,
  type OptimizationUsage,
  type UsageMetric,
} from "@/lib/optimization-result";
import {
  buildOptimizationTestCases,
  type OptimizationVerificationInput,
} from "@/lib/optimization-input";
import { buildPromptOptimizationRunRequest } from "@/lib/prompt-optimization-run-request";

interface TimelineEvent {
  id: string;
  sequence: number;
  timestamp: string;
  eventType: string;
  payload: Record<string, unknown>;
}

interface OptimizationRunSnapshot {
  key: string;
  status: string;
  events: TimelineEvent[];
  result: OptimizationResult | null;
  resultUnreadable: boolean;
  errorCode: string | null;
  errorSummary: string | null;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  streamError: string | null;
}

interface ClarificationThread {
  question: OptimizationClarification;
  answer: string | null;
  stale: boolean;
}

const eventNames = [
  "run.status",
  "agent.action",
  "tool.started",
  "tool.completed",
  "evaluation.result",
  "optimization.vote",
  "optimization.clarification.requested",
  "optimization.clarification.answered",
  "run.completed",
  "run.failed",
];

const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted_unknown",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmptyStringValue(value: unknown): string | null {
  const text = stringValue(value)?.trim();
  return text ? text : null;
}

function qualityVoteFromDecision(
  value: unknown,
): "old_better" | "new_better" | "equal" | "inconclusive" | null {
  if (value === "old_better" || value === "original_better")
    return "old_better";
  if (value === "new_better" || value === "candidate_better")
    return "new_better";
  return value === "equal" || value === "inconclusive" ? value : null;
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  const event = asRecord(value);
  return (
    typeof event?.id === "string" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.timestamp === "string" &&
    typeof event.eventType === "string" &&
    asRecord(event.payload) !== null
  );
}

function statusLabel(status: string): string {
  if (status === "queued" || status === "created") return "Menunggu";
  if (status === "running") return "Sedang berjalan";
  if (status === "cancel_requested") return "Menghentikan";
  if (status === "paused_quota") return "Menunggu layanan tersedia";
  if (status === "paused_auth_required") return "Login diperlukan";
  if (status === "succeeded") return "Selesai";
  if (status === "failed") return "Gagal";
  if (status === "canceled") return "Dibatalkan";
  if (status === "interrupted_unknown")
    return "Koneksi terputus; status belum diketahui";
  return "Menunggu pembaruan";
}

const providerTimeoutMessage = "Senopati belum menjawab dalam batas waktu.";
const providerTimeoutNextAction =
  "Untuk mencoba lagi, jalankan Run secara manual dari workspace.";

function optimizationStatusLabel(
  status: string,
  errorCode: string | null,
): string {
  return errorCode === "PROVIDER_TIMEOUT"
    ? providerTimeoutMessage
    : statusLabel(status);
}

function optimizationFailureMessage(errorCode: string | null): string {
  const messages: Record<string, string> = {
    AUTH_REQUIRED:
      "Koneksi Senopati ditolak. Periksa status koneksi Senopati di Pengaturan, lalu coba lagi.",
    PROVIDER_HTTP_ERROR:
      "Senopati tidak dapat dihubungi. Periksa koneksi dan status provider, lalu coba lagi.",
    PROVIDER_RESPONSE_INVALID:
      "Balasan Senopati tidak dapat dibaca. Coba lagi; jika berulang, periksa model Senopati di Pengaturan.",
    PROVIDER_TIMEOUT: providerTimeoutMessage,
    PROVIDER_ABORTED:
      "Permintaan ke Senopati terhenti. Periksa status Run sebelum mencoba lagi.",
    codex_not_logged_in:
      "Codex belum terhubung. Login Codex di Pengaturan, lalu coba lagi.",
    codex_subscription_required:
      "Akun Codex belum memiliki akses yang diperlukan. Periksa akun di Pengaturan.",
    codex_model_unavailable:
      "Model Codex yang dipilih tidak tersedia. Pilih model lain di Pengaturan.",
    codex_reasoning_effort_unavailable:
      "Kedalaman berpikir yang dipilih tidak tersedia untuk model ini. Ubah pilihannya lalu coba lagi.",
    codex_turn_timeout:
      "Codex melewati batas waktu saat mencoba prompt. Periksa status Run sebelum mencoba lagi.",
    codex_turn_interrupted:
      "Koneksi Codex terputus saat mencoba prompt. Periksa status Run sebelum mencoba lagi.",
    codex_turn_failed:
      "Codex tidak dapat menyelesaikan pengujian prompt. Periksa status Codex di Pengaturan, lalu coba lagi.",
    codex_output_invalid:
      "Jawaban Codex tidak dapat dibaca. Periksa model Codex di Pengaturan, lalu coba lagi.",
    codex_cli_unavailable:
      "Codex tidak tersedia. Periksa instalasi dan koneksi Codex di Pengaturan.",
    app_server_unavailable:
      "Layanan Codex tidak tersedia. Periksa koneksi Codex di Pengaturan, lalu coba lagi.",
    codex_isolation_unavailable:
      "Lingkungan aman Codex tidak tersedia. Periksa konfigurasi Codex di Pengaturan.",
    codex_policy_unverified:
      "Konfigurasi keamanan Codex belum terverifikasi. Verifikasi Codex di Pengaturan sebelum mencoba lagi.",
    OPTIMIZER_OUTPUT_INVALID:
      "Jawaban Senopati tidak sesuai format yang dapat diproses. Coba lagi; jika berulang, pilih model Senopati lain di Pengaturan.",
    OPTIMIZER_TOOL_NOT_ALLOWED:
      "Senopati meminta langkah yang tidak tersedia. Coba lagi; jika berulang, pilih model Senopati lain di Pengaturan.",
    OPTIMIZATION_TOOL_FAILED:
      "Salah satu langkah optimasi tidak dapat diselesaikan. Periksa koneksi Senopati, lalu coba Run lagi.",
    OPTIMIZATION_LIMIT_REACHED:
      "Proses mencapai batas aman untuk jumlah langkah. Coba lagi dengan contoh atau arahan yang lebih singkat.",
    CODEX_SESSION_UNAVAILABLE:
      "Sesi Codex terhenti. Periksa status Codex di Pengaturan, lalu coba lagi.",
    SENOPATI_CONNECTION_UNAVAILABLE:
      "Koneksi Senopati belum tersedia. Periksa status provider di Pengaturan, lalu coba lagi.",
    GRAPH_RETRIEVAL_FAILED:
      "Pencarian sumber gagal. Periksa sumber knowledge yang dipilih, lalu coba lagi.",
    RUN_STATUS_WATCH_FAILED:
      "Koneksi terputus sebelum status akhir diterima. Periksa status Run sebelum mencoba lagi.",
    PROMPT_OPTIMIZATION_CONFIG_INVALID:
      "Konfigurasi perbaikan prompt tidak valid. Muat ulang workspace, periksa pilihan model, lalu coba lagi.",
    PROMPT_OPTIMIZATION_FAILED:
      "Perbaikan prompt tidak dapat diselesaikan. Periksa koneksi Senopati dan Codex di Pengaturan, lalu coba lagi.",
    optimizer_auth_required:
      "Login Senopati belum tersedia. Hubungkan provider kampus di Pengaturan sebelum mencoba lagi.",
    optimizer_model_required:
      "Model Senopati belum dikonfigurasi. Pilih model optimizer di Pengaturan sebelum mencoba lagi.",
    optimizer_unverified:
      "Koneksi Senopati belum terverifikasi. Verifikasi koneksi dan model Senopati di Pengaturan sebelum mencoba lagi.",
    provider_auth_required:
      "Koneksi Codex belum tersedia. Login Codex di Pengaturan sebelum mencoba lagi.",
    provider_model_mismatch:
      "Model Codex tidak sesuai dengan koneksi tersimpan. Pilih ulang model di Pengaturan.",
    provider_unverified:
      "Koneksi Codex belum terverifikasi. Verifikasi provider di Pengaturan sebelum mencoba lagi.",
  };

  if (errorCode && Object.hasOwn(messages, errorCode)) {
    const message = messages[errorCode];
    if (message) return message;
  }
  return "Perbaikan prompt gagal. Periksa koneksi Senopati dan Codex di Pengaturan, lalu coba lagi.";
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function activityIndexLabel(event: TimelineEvent): string {
  if (typeof event.payload.modelCall === "number")
    return `Panggilan model ${event.payload.modelCall}`;
  if (typeof event.payload.turn === "number")
    return `Putaran ${event.payload.turn}`;
  return `#${event.sequence}`;
}

function answerLabel(answer: OptimizationAnswer) {
  const index = Number(answer.caseId.replace(/^(case-|example-)/, ""));
  const label =
    Number.isInteger(index) && index > 0
      ? `Contoh ${index}`
      : `Contoh ${shortId(answer.caseId)}`;
  return answer.source === "generated" ? `${label} · dibuat Senopati` : label;
}

function formatTokens(metric: UsageMetric): string {
  if (metric.value === null || metric.status === "unknown")
    return "Belum tersedia";
  const value = new Intl.NumberFormat("id-ID").format(metric.value);
  return metric.status === "estimated" ? `~${value} · perkiraan` : value;
}

function formatLatency(milliseconds: number | null): string {
  if (milliseconds === null) return "Belum tersedia";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} detik`;
}

function effortLabel(effort: string | null, fallback: string | null): string {
  const value = effort ?? fallback;
  if (!value) return "Bawaan model";
  const labels: Record<string, string> = {
    minimal: "Minimal",
    low: "Rendah",
    medium: "Sedang",
    high: "Tinggi",
    xhigh: "Sangat tinggi",
  };
  return labels[value] ?? value;
}

function combinedUsage(answers: OptimizationAnswer[]): OptimizationUsage {
  if (!answers.length) return parseUsage(null);
  const add = (select: (answer: OptimizationAnswer) => UsageMetric) => {
    const metrics = answers.map(select);
    if (metrics.some((metric) => metric.value === null))
      return { value: null, status: "unknown" as const };
    return {
      value: metrics.reduce((sum, metric) => sum + (metric.value ?? 0), 0),
      status: metrics.some((metric) => metric.status === "estimated")
        ? ("estimated" as const)
        : ("reported" as const),
    };
  };
  return {
    input: add((answer) => answer.usage.input),
    output: add((answer) => answer.usage.output),
    total: add((answer) => answer.usage.total),
  };
}

function combinedLatency(
  explicit: number | null,
  answers: OptimizationAnswer[],
): number | null {
  if (explicit !== null) return explicit;
  if (!answers.length || answers.some((answer) => answer.latencyMs === null))
    return null;
  return answers.reduce((sum, answer) => sum + (answer.latencyMs ?? 0), 0);
}

function metricChangeLabel(
  before: number | null,
  after: number | null,
  kind: "tokens" | "time",
  estimated = false,
): string {
  if (before === null || after === null || before === 0)
    return "Perbandingan belum tersedia";
  const change = ((after - before) / before) * 100;
  const rounded = Math.abs(change).toLocaleString("id-ID", {
    maximumFractionDigits: 1,
  });
  const prefix = estimated ? "Perkiraan · " : "";
  if (change === 0) return `${prefix}Sama`;
  if (kind === "tokens")
    return change < 0
      ? `${prefix}${rounded}% lebih sedikit`
      : `${prefix}${rounded}% lebih banyak`;
  return change < 0
    ? `${prefix}${rounded}% lebih cepat`
    : `${prefix}${rounded}% lebih lama`;
}

export function WorkspacePromptOptimization({
  projectId,
  promptId,
  promptVersionId,
  promptText,
  modelId,
  modelName,
  reasoningEffort,
  defaultReasoningEffort,
  optimizerModel,
  knowledgeSourceIds,
  retrievalStrategy,
  canOptimize,
  blocker,
  busy,
  onRunningChange,
  onRecoveryReadyChange,
  onCandidateApplied,
}: {
  projectId: string | null;
  promptId: string | null;
  promptVersionId: string | null;
  promptText: string;
  modelId: string;
  modelName: string | null;
  reasoningEffort: string | null;
  defaultReasoningEffort: string | null;
  optimizerModel: string | null;
  knowledgeSourceIds: string[];
  retrievalStrategy: "lexical" | "graph" | "full_context";
  canOptimize: boolean;
  blocker: string | null;
  busy: boolean;
  onRunningChange: (active: boolean) => void;
  onRecoveryReadyChange: (ready: boolean) => void;
  onCandidateApplied?: (versionId: string, version: number) => void;
  /** Applying is handled by the protected run candidate endpoint. */
  onApplyCandidate?: (
    promptId: string,
    candidate: string,
    draftVersionId: string | null,
  ) => Promise<void>;
}) {
  const [direction, setDirection] = useState("");
  const [sampleInput, setSampleInput] = useState("");
  const [modelSelection, setModelSelection] = useState<"selected" | "auto">(
    "selected",
  );
  const [effortSelection, setEffortSelection] = useState<"selected" | "auto">(
    "selected",
  );
  const [verificationInput, setVerificationInput] =
    useState<OptimizationVerificationInput>({ kind: "none" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<StoredOptimizationRun | null>(
    null,
  );
  const [recoveryState, setRecoveryState] = useState<{
    key: string;
    attempt: number;
    error: string | null;
  } | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const promptTextRef = useRef(promptText);
  const startGuard = useRef(false);
  const runningCallback = useRef(onRunningChange);
  const recoveryCallback = useRef(onRecoveryReadyChange);
  const currentRecoveryKey = `${projectId ?? "none"}:${promptId ?? "any"}:${promptVersionId ?? "any"}`;
  const recoveryMatches =
    recoveryState?.key === currentRecoveryKey &&
    recoveryState.attempt === recoveryAttempt;
  const recoveryError = recoveryMatches ? recoveryState.error : null;
  const recoveryReady =
    !projectId || (recoveryMatches && recoveryError === null);

  useEffect(() => {
    runningCallback.current = onRunningChange;
  }, [onRunningChange]);

  useEffect(() => {
    recoveryCallback.current = onRecoveryReadyChange;
  }, [onRecoveryReadyChange]);

  useEffect(() => {
    promptTextRef.current = promptText;
  }, [promptText]);

  useEffect(() => {
    const key = currentRecoveryKey;
    const attempt = recoveryAttempt;
    let current = true;

    if (!projectId) {
      recoveryCallback.current(true);
      return () => {
        current = false;
      };
    }

    recoveryCallback.current(false);

    void Promise.all([
      fetch(`/api/projects/${projectId}/clarifications`, {
        cache: "no-store",
      }),
      fetch(`/api/projects/${projectId}/runs`, { cache: "no-store" }),
    ])
      .then(async ([clarificationResponse, runsResponse]) => {
        if (!clarificationResponse.ok || !runsResponse.ok)
          throw new Error("Run aktif tidak dapat dipulihkan.");
        const [clarificationPayload, runsPayload]: unknown[] =
          await Promise.all([
            clarificationResponse.json(),
            runsResponse.json(),
          ]);
        const clarifications = parseProjectClarifications(
          clarificationPayload,
          projectId,
        ).filter((item) => item.lifecycle === "awaiting_answer");
        const runRecords = Array.isArray(asRecord(runsPayload)?.runs)
          ? (asRecord(runsPayload)?.runs as unknown[])
          : [];
        const restoredFromStorage = (() => {
          try {
            return readStoredOptimizationRun(window.localStorage, projectId);
          } catch {
            return null;
          }
        })();
        const pending = newestClarification(clarifications);
        let restored: StoredOptimizationRun | null = null;

        if (pending) {
          const saved =
            restoredFromStorage?.runId === pending.runId
              ? restoredFromStorage
              : null;
          const serverRun = runRecords
            .map(asRecord)
            .find((item) => item?.id === pending.runId);
          restored = {
            projectId,
            promptId: pending.promptId,
            promptVersionId: pending.promptVersionId,
            runId: pending.runId,
            status: stringValue(serverRun?.status) ?? "queued",
            baselinePrompt:
              saved?.baselinePrompt ??
              (pending.promptId === promptId &&
              pending.promptVersionId === promptVersionId
                ? promptTextRef.current
                : ""),
            objective: saved?.objective ?? null,
          };
        } else if (restoredFromStorage) {
          const serverRun = runRecords
            .map(asRecord)
            .find((item) => item?.id === restoredFromStorage.runId);
          if (serverRun) {
            restored = {
              ...restoredFromStorage,
              status:
                stringValue(serverRun.status) ?? restoredFromStorage.status,
            };
          }
        }

        if (!current) return;
        setActiveRun(restored);
        setRecoveryState({ key, attempt, error: null });
        recoveryCallback.current(true);
        runningCallback.current(
          restored !== null && !terminalStatuses.has(restored.status),
        );
      })
      .catch(() => {
        if (!current) return;
        setActiveRun(null);
        setRecoveryState({
          key,
          attempt,
          error:
            "Run aktif atau pertanyaan tertunda tidak dapat dimuat. Coba muat ulang status sebelum memulai Run baru.",
        });
        recoveryCallback.current(false);
        runningCallback.current(false);
      });

    return () => {
      current = false;
    };
  }, [
    currentRecoveryKey,
    projectId,
    promptId,
    promptVersionId,
    recoveryAttempt,
  ]);

  async function startOptimization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !projectId ||
      !promptId ||
      !promptVersionId ||
      !modelId ||
      !canOptimize ||
      busy ||
      starting ||
      startGuard.current ||
      !recoveryReady
    )
      return;

    const testCaseResult = buildOptimizationTestCases(
      sampleInput,
      verificationInput,
    );
    if (testCaseResult.error) {
      setStartError(testCaseResult.error);
      return;
    }

    startGuard.current = true;
    setStarting(true);
    setStartError(null);
    runningCallback.current(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildPromptOptimizationRunRequest({
            projectId,
            promptVersionId,
            requestedModel: modelId,
            reasoningEffort,
            modelSelection,
            effortSelection,
            idempotencyKey: crypto.randomUUID(),
            retrievalStrategy,
            knowledgeSourceIds,
            objective: direction,
            testCases: testCaseResult.cases,
          }),
        ),
      });
      const result = (await response.json()) as {
        run?: { id: string; status: string };
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.run?.id)
        throw new Error(
          result.message ?? result.error ?? "Run tidak dapat dimulai.",
        );
      const nextRun: StoredOptimizationRun = {
        projectId,
        promptId,
        promptVersionId,
        runId: result.run.id,
        status: result.run.status,
        baselinePrompt: promptText,
        objective: direction.trim() || null,
      };
      try {
        writeStoredOptimizationRun(window.localStorage, nextRun);
      } catch {
        /* Run monitoring also recovers from the durable project API. */
      }
      setActiveRun(nextRun);
    } catch (cause) {
      runningCallback.current(false);
      setStartError(
        cause instanceof Error ? cause.message : "Run tidak dapat dimulai.",
      );
    } finally {
      startGuard.current = false;
      setStarting(false);
    }
  }

  return (
    <Card className="workspace-optimization">
      <CardHeader>
        <div className="workspace-optimization-heading">
          <div>
            <CardTitle>Perbaiki prompt</CardTitle>
            <CardDescription>
              Senopati menelaah prompt. Codex mencoba prompt lama dan hasil
              perbaikannya; Anda yang menilai jawabannya.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="workspace-optimization-content">
        {recoveryError ? (
          <div className="optimization-recovery-error" role="alert">
            <p>{recoveryError}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRecoveryAttempt((attempt) => attempt + 1)}
            >
              Muat ulang status
            </Button>
          </div>
        ) : null}
        <div
          className="optimization-model-summary"
          aria-label="Model yang dipakai"
        >
          <p>
            <strong>Perbaikan:</strong> Senopati
            {optimizerModel ? ` · ${optimizerModel}` : ""}
          </p>
          <p>
            <strong>Model jawaban:</strong> {modelName ?? "Pilih model Codex"}
          </p>
          <p>
            <strong>Kedalaman berpikir:</strong>{" "}
            {effortLabel(reasoningEffort, defaultReasoningEffort)}
          </p>
          <p>
            <strong>Knowledge:</strong>{" "}
            {knowledgeSourceIds.length
              ? `${knowledgeSourceIds.length} sumber dipilih`
              : "Tidak ada sumber dipilih"}
          </p>
        </div>

        <form
          id="workspace-prompt-optimization-form"
          className="optimization-form"
          onSubmit={startOptimization}
        >
          <details className="optimization-options">
            <summary>Arahan atau contoh (opsional)</summary>
            <div className="optimization-options-content">
              <div className="field">
                <label htmlFor="optimization-direction">Arahan tambahan</label>
                <textarea
                  id="optimization-direction"
                  className="input optimization-objective"
                  maxLength={1_000}
                  value={direction}
                  onChange={(event) => setDirection(event.target.value)}
                  placeholder="Contoh: Buat jawaban lebih runtut tanpa mengurangi detail penting."
                  disabled={busy || starting || !recoveryReady}
                />
              </div>
              <div className="field">
                <label htmlFor="optimization-example">Contoh masukan</label>
                <textarea
                  id="optimization-example"
                  className="input optimization-test-input"
                  maxLength={4_000}
                  value={sampleInput}
                  onChange={(event) => setSampleInput(event.target.value)}
                  placeholder="Masukkan satu contoh yang mewakili penggunaan prompt."
                  disabled={busy || starting || !recoveryReady}
                />
                <p className="helper">
                  Jika dikosongkan, Senopati akan membuat contoh uji dan
                  menandainya di hasil.
                </p>
              </div>
              <div className="optimization-target-options">
                <div className="field">
                  <label htmlFor="optimization-model-selection">
                    Pemilihan model Codex
                  </label>
                  <select
                    id="optimization-model-selection"
                    className="select"
                    value={modelSelection}
                    onChange={(event) =>
                      setModelSelection(
                        event.target.value as "selected" | "auto",
                      )
                    }
                    disabled={busy || starting || !recoveryReady}
                  >
                    <option value="selected">Gunakan pilihan saya</option>
                    <option value="auto">
                      Pilih otomatis dari model tersedia
                    </option>
                  </select>
                  <p className="helper">
                    {modelSelection === "auto"
                      ? "Model yang dipilih di atas tetap menjadi pemeriksaan koneksi; hasil menampilkan model yang dipakai dan bukti katalog aktif."
                      : `Model yang dipilih di workspace dipakai persis: ${modelName ?? "belum dipilih"}.`}
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="optimization-effort-selection">
                    Mode kedalaman berpikir
                  </label>
                  <select
                    id="optimization-effort-selection"
                    className="select"
                    value={effortSelection}
                    onChange={(event) =>
                      setEffortSelection(
                        event.target.value as "selected" | "auto",
                      )
                    }
                    disabled={busy || starting || !recoveryReady}
                  >
                    <option value="selected">Gunakan pilihan saya</option>
                    <option value="auto">
                      Auto — pilih dari kemampuan model
                    </option>
                  </select>
                  <p className="helper">
                    {effortSelection === "auto"
                      ? "Worker memilih effort Auto sebelum pengujian dan hanya mengirim nilai yang didukung katalog model aktif. Hasil Run mencatat effort yang dipakai."
                      : `Pilihan saat ini: ${effortLabel(reasoningEffort, defaultReasoningEffort)}.`}
                  </p>
                </div>
              </div>
              <div className="field">
                <label htmlFor="optimization-verification-kind">
                  Pemeriksaan hasil opsional
                </label>
                <select
                  id="optimization-verification-kind"
                  className="select"
                  value={verificationInput.kind}
                  disabled={busy || starting || !recoveryReady}
                  onChange={(event) => {
                    const kind = event.target.value;
                    setVerificationInput(
                      kind === "divisibility"
                        ? {
                            kind,
                            startInclusive: "1",
                            endInclusive: "100",
                            includeDivisors: "3",
                            excludeDivisors: "",
                            expectedCount: "",
                            expectedSum: "",
                          }
                        : kind === "python_tests"
                          ? {
                              kind,
                              n: "3",
                              blocked: "",
                              expectedOutput: "",
                            }
                          : { kind: "none" },
                    );
                  }}
                >
                  <option value="none">Tidak ada</option>
                  <option value="divisibility">
                    Hitung pembagi dan jumlah
                  </option>
                  <option value="python_tests">
                    Fixture jalur grid Python
                  </option>
                </select>
                {verificationInput.kind === "divisibility" ? (
                  <div className="optimization-verification-fields">
                    <p className="helper">
                      Isi hasil yang dihitung secara independen. Jawaban target
                      harus berupa objek JSON dengan count dan sum.
                    </p>
                    <div className="optimization-target-options">
                      <div className="field">
                        <label htmlFor="verification-start">Awal rentang</label>
                        <input
                          id="verification-start"
                          className="input"
                          inputMode="numeric"
                          value={verificationInput.startInclusive}
                          onChange={(event) =>
                            setVerificationInput((current) =>
                              current.kind === "divisibility"
                                ? {
                                    ...current,
                                    startInclusive: event.target.value,
                                  }
                                : current,
                            )
                          }
                          disabled={busy || starting || !recoveryReady}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="verification-end">Akhir rentang</label>
                        <input
                          id="verification-end"
                          className="input"
                          inputMode="numeric"
                          value={verificationInput.endInclusive}
                          onChange={(event) =>
                            setVerificationInput((current) =>
                              current.kind === "divisibility"
                                ? {
                                    ...current,
                                    endInclusive: event.target.value,
                                  }
                                : current,
                            )
                          }
                          disabled={busy || starting || !recoveryReady}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="verification-includes">
                          Pembagi yang disertakan
                        </label>
                        <input
                          id="verification-includes"
                          className="input"
                          value={verificationInput.includeDivisors}
                          onChange={(event) =>
                            setVerificationInput((current) =>
                              current.kind === "divisibility"
                                ? {
                                    ...current,
                                    includeDivisors: event.target.value,
                                  }
                                : current,
                            )
                          }
                          placeholder="3, 5"
                          disabled={busy || starting || !recoveryReady}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="verification-excludes">
                          Pembagi yang dikecualikan (opsional)
                        </label>
                        <input
                          id="verification-excludes"
                          className="input"
                          value={verificationInput.excludeDivisors}
                          onChange={(event) =>
                            setVerificationInput((current) =>
                              current.kind === "divisibility"
                                ? {
                                    ...current,
                                    excludeDivisors: event.target.value,
                                  }
                                : current,
                            )
                          }
                          placeholder="7"
                          disabled={busy || starting || !recoveryReady}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="verification-count">
                          Count harapan
                        </label>
                        <input
                          id="verification-count"
                          className="input"
                          inputMode="numeric"
                          value={verificationInput.expectedCount}
                          onChange={(event) =>
                            setVerificationInput((current) =>
                              current.kind === "divisibility"
                                ? {
                                    ...current,
                                    expectedCount: event.target.value,
                                  }
                                : current,
                            )
                          }
                          disabled={busy || starting || !recoveryReady}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="verification-sum">Sum harapan</label>
                        <input
                          id="verification-sum"
                          className="input"
                          inputMode="numeric"
                          value={verificationInput.expectedSum}
                          onChange={(event) =>
                            setVerificationInput((current) =>
                              current.kind === "divisibility"
                                ? {
                                    ...current,
                                    expectedSum: event.target.value,
                                  }
                                : current,
                            )
                          }
                          disabled={busy || starting || !recoveryReady}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                {verificationInput.kind === "python_tests" ? (
                  <div className="optimization-verification-fields">
                    <p className="helper">
                      Fixture membandingkan output harapan dengan hitungan
                      referensi. Eksekusi kode kandidat tidak tersedia di
                      lingkungan aman, sehingga hasilnya akan menyatakan hal
                      itu.
                    </p>
                    <div className="field">
                      <label htmlFor="verification-grid-size">
                        Ukuran grid n
                      </label>
                      <input
                        id="verification-grid-size"
                        className="input"
                        inputMode="numeric"
                        value={verificationInput.n}
                        onChange={(event) =>
                          setVerificationInput((current) =>
                            current.kind === "python_tests"
                              ? { ...current, n: event.target.value }
                              : current,
                          )
                        }
                        disabled={busy || starting || !recoveryReady}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="verification-blocked-cells">
                        Sel terhalang (baris, kolom)
                      </label>
                      <textarea
                        id="verification-blocked-cells"
                        className="input"
                        value={verificationInput.blocked}
                        onChange={(event) =>
                          setVerificationInput((current) =>
                            current.kind === "python_tests"
                              ? { ...current, blocked: event.target.value }
                              : current,
                          )
                        }
                        placeholder="0, 1\n1, 2"
                        disabled={busy || starting || !recoveryReady}
                      />
                      <p className="helper">
                        Indeks baris dan kolom dimulai dari 0.
                      </p>
                    </div>
                    <div className="field">
                      <label htmlFor="verification-python-output">
                        Output harapan
                      </label>
                      <input
                        id="verification-python-output"
                        className="input"
                        inputMode="numeric"
                        value={verificationInput.expectedOutput}
                        onChange={(event) =>
                          setVerificationInput((current) =>
                            current.kind === "python_tests"
                              ? {
                                  ...current,
                                  expectedOutput: event.target.value,
                                }
                              : current,
                          )
                        }
                        disabled={busy || starting || !recoveryReady}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </details>

          <div className="optimization-action-row">
            {modelName ? (
              <span className="helper">
                Jawaban dicoba dengan {modelName} · kedalaman berpikir{" "}
                {effortLabel(reasoningEffort, defaultReasoningEffort)}.
              </span>
            ) : null}
          </div>
          {blocker ? (
            <div className="optimization-blocker" role="status">
              <p className="helper">{blocker}</p>
              {blocker.includes("Pengaturan") ? (
                <Button asChild type="button" variant="secondary">
                  <Link href="/settings">Buka Pengaturan</Link>
                </Button>
              ) : null}
            </div>
          ) : null}
          {startError ? (
            <p className="error-message" role="alert">
              {startError}
            </p>
          ) : null}
        </form>

        {activeRun?.projectId === projectId ? (
          <OptimizationRunMonitor
            key={`${activeRun.projectId}:${activeRun.runId}`}
            projectId={activeRun.projectId}
            promptId={activeRun.promptId}
            runId={activeRun.runId}
            initialStatus={activeRun.status}
            baselinePrompt={activeRun.baselinePrompt}
            objective={activeRun.objective}
            currentPromptId={promptId}
            currentPromptVersionId={promptVersionId}
            canApplyCandidate={
              activeRun.promptId === promptId &&
              activeRun.promptVersionId === promptVersionId
            }
            busy={busy}
            onRunningChange={onRunningChange}
            {...(onCandidateApplied ? { onCandidateApplied } : {})}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function OptimizationRunMonitor({
  projectId,
  promptId,
  runId,
  initialStatus,
  baselinePrompt,
  objective,
  currentPromptId,
  currentPromptVersionId,
  canApplyCandidate,
  busy,
  onRunningChange,
  onCandidateApplied,
}: {
  projectId: string;
  promptId: string;
  runId: string;
  initialStatus: string;
  baselinePrompt: string;
  objective: string | null;
  currentPromptId: string | null;
  currentPromptVersionId: string | null;
  canApplyCandidate: boolean;
  busy: boolean;
  onRunningChange: (active: boolean) => void;
  onCandidateApplied?: (versionId: string, version: number) => void;
}) {
  const runKey = `${projectId}:${runId}`;
  const callback = useRef(onRunningChange);
  const baselinePromptRef = useRef(baselinePrompt);
  const statusRef = useRef(initialStatus);
  useEffect(() => {
    baselinePromptRef.current = baselinePrompt;
  }, [baselinePrompt]);
  const [snapshot, setSnapshot] = useState<OptimizationRunSnapshot>({
    key: runKey,
    status: initialStatus,
    events: [],
    result: null,
    resultUnreadable: false,
    errorCode: null,
    errorSummary: null,
    connection: "connecting",
    streamError: null,
  });
  const [cancelState, setCancelState] = useState<"idle" | "sending" | "sent">(
    "idle",
  );
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [applyingCandidateId, setApplyingCandidateId] = useState<string | null>(
    null,
  );
  const [applySuccess, setApplySuccess] = useState<{
    candidateId: string;
    version: number;
    alreadyApplied: boolean;
  } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [qualityNote, setQualityNote] = useState("");
  const qualityNoteDirty = useRef(false);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [clarificationThreads, setClarificationThreads] = useState<
    ClarificationThread[]
  >([]);
  const [clarificationAnswer, setClarificationAnswer] = useState("");
  const [clarificationSubmitting, setClarificationSubmitting] = useState(false);
  const [clarificationError, setClarificationError] = useState<string | null>(
    null,
  );
  const clarificationSubmission = useRef<{
    clarificationId: string;
    answer: string;
    idempotencyKey: string;
  } | null>(null);
  const terminalNotified = useRef(false);

  useEffect(() => {
    callback.current = onRunningChange;
  }, [onRunningChange]);

  const markTerminal = useCallback(() => {
    if (terminalNotified.current) return;
    terminalNotified.current = true;
    callback.current(false);
  }, []);

  useEffect(() => {
    const source = new EventSource(
      `/api/projects/${projectId}/runs/${runId}/events`,
    );
    let stopped = false;
    const close = () => {
      stopped = true;
      source.close();
    };

    source.onopen = () =>
      setSnapshot((current) => ({ ...current, connection: "connected" }));
    source.onerror = () => {
      if (stopped) return;
      const connection =
        source.readyState === EventSource.CLOSED ? "closed" : "reconnecting";
      setSnapshot((current) => ({
        ...current,
        connection,
      }));
      if (connection === "closed" && terminalStatuses.has(statusRef.current)) {
        markTerminal();
        source.close();
      }
    };

    const append = (message: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(message.data);
        if (!isTimelineEvent(parsed))
          throw new Error("Invalid optimization event");
        const event = parsed;
        const completedResult =
          event.eventType === "run.completed"
            ? parseOptimizationResult(
                event.payload.result ?? event.payload.optimization,
                baselinePromptRef.current,
              )
            : null;
        if (!qualityNoteDirty.current) {
          if (
            event.eventType === "optimization.vote" &&
            event.payload.evidenceEligible === true
          )
            setQualityNote(stringValue(event.payload.note) ?? "");
          else if (event.eventType === "run.completed" && completedResult)
            setQualityNote(completedResult.qualityNote ?? "");
        }
        const eventStatus =
          event.eventType === "run.status"
            ? stringValue(event.payload.status)
            : null;
        if (eventStatus) statusRef.current = eventStatus;
        setSnapshot((current) => {
          if (
            current.events.some(
              (existing) =>
                existing.sequence === event.sequence ||
                existing.id === event.id,
            )
          )
            return current;

          const next: OptimizationRunSnapshot = {
            ...current,
            status:
              event.eventType === "run.status" &&
              typeof event.payload.status === "string"
                ? event.payload.status
                : current.status,
            events: [...current.events, event].sort(
              (left, right) => left.sequence - right.sequence,
            ),
          };

          if (
            event.eventType === "run.status" &&
            typeof event.payload.status === "string"
          )
            statusRef.current = event.payload.status;

          if (event.eventType === "run.completed") {
            next.status =
              typeof event.payload.status === "string"
                ? event.payload.status
                : "succeeded";
            next.result = completedResult;
            next.resultUnreadable = completedResult === null;
            statusRef.current = next.status;
          } else if (event.eventType === "run.failed") {
            next.status =
              typeof event.payload.status === "string"
                ? event.payload.status
                : "failed";
            next.errorCode =
              nonEmptyStringValue(event.payload.errorCode) ??
              nonEmptyStringValue(event.payload.reason) ??
              current.errorCode;
            next.errorSummary =
              nonEmptyStringValue(event.payload.errorSummary) ??
              current.errorSummary;
            statusRef.current = next.status;
          } else if (event.eventType === "run.status") {
            next.errorCode =
              nonEmptyStringValue(event.payload.errorCode) ??
              nonEmptyStringValue(event.payload.reason) ??
              current.errorCode;
          } else if (
            event.eventType === "optimization.vote" &&
            event.payload.evidenceEligible === true &&
            next.result
          ) {
            next.result = {
              ...next.result,
              qualityVote: qualityVoteFromDecision(event.payload.decision),
              qualityNote: stringValue(event.payload.note),
            };
          }
          return next;
        });

        if (event.eventType === "optimization.clarification.requested") {
          const question =
            OptimizationClarificationRequestedEventSchema.safeParse(
              event.payload,
            );
          if (question.success) {
            const parsedQuestion = OptimizationClarificationSchema.safeParse({
              ...question.data,
              id: event.id,
              projectId,
              runId,
              createdAt: event.timestamp,
              lifecycle: "awaiting_answer",
            });
            if (parsedQuestion.success) {
              setClarificationThreads((current) =>
                current.some(
                  (item) => item.question.id === parsedQuestion.data.id,
                )
                  ? current
                  : [
                      ...current,
                      {
                        question: parsedQuestion.data,
                        answer: null,
                        stale: false,
                      },
                    ],
              );
            }
          }
        }
        if (event.eventType === "optimization.clarification.answered") {
          const answer = OptimizationClarificationAnsweredEventSchema.safeParse(
            event.payload,
          );
          if (answer.success) {
            setClarificationThreads((current) =>
              current.map((item) =>
                item.question.id === answer.data.clarificationId
                  ? { ...item, answer: answer.data.answer, stale: false }
                  : item,
              ),
            );
            if (
              clarificationSubmission.current?.clarificationId ===
              answer.data.clarificationId
            ) {
              clarificationSubmission.current = null;
              setClarificationAnswer("");
              setClarificationError(null);
            }
          }
        }

        const persistedStatus =
          event.eventType === "run.completed"
            ? "succeeded"
            : event.eventType === "run.failed"
              ? "failed"
              : eventStatus;
        if (persistedStatus) {
          try {
            const saved = readStoredOptimizationRun(
              window.localStorage,
              projectId,
            );
            if (saved?.runId === runId)
              writeStoredOptimizationRun(window.localStorage, {
                ...saved,
                status: persistedStatus,
              });
          } catch {
            /* The project API remains the durable recovery source. */
          }
        }

        if (event.eventType === "run.completed") markTerminal();

        const closeAfterEvent =
          event.eventType === "run.failed" ||
          (event.eventType === "run.status" &&
            eventStatus !== null &&
            terminalStatuses.has(eventStatus) &&
            eventStatus !== "succeeded");
        if (closeAfterEvent) {
          markTerminal();
          close();
          setSnapshot((current) => ({ ...current, connection: "closed" }));
        }
      } catch {
        setSnapshot((current) => ({
          ...current,
          streamError: "Event optimasi tidak dapat dibaca.",
        }));
      }
    };

    for (const eventName of eventNames)
      source.addEventListener(eventName, append as EventListener);
    return () => {
      stopped = true;
      source.close();
    };
  }, [markTerminal, projectId, runId, runKey]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${projectId}/runs`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload: unknown = await response.json();
        const result = asRecord(payload);
        if (!Array.isArray(result?.runs)) return;
        const run = result.runs
          .map(asRecord)
          .find((candidate) => candidate?.id === runId);
        if (!run) return;
        const errorCode = nonEmptyStringValue(run.errorCode);
        const errorSummary = nonEmptyStringValue(run.errorSummary);
        if (!active || (!errorCode && !errorSummary)) return;
        setSnapshot((current) =>
          current.key !== runKey
            ? current
            : {
                ...current,
                errorCode: errorCode ?? current.errorCode,
                errorSummary: errorSummary ?? current.errorSummary,
              },
        );
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [projectId, runId, runKey]);

  const current = snapshot.key === runKey ? snapshot : null;
  const activeStatus = current?.status ?? initialStatus;
  const pendingClarification =
    [...clarificationThreads]
      .reverse()
      .find((item) => item.answer === null && !item.stale)?.question ?? null;
  const terminal = terminalStatuses.has(activeStatus);
  const failed =
    activeStatus === "failed" || activeStatus === "interrupted_unknown";
  const badgeVariant =
    activeStatus === "succeeded"
      ? "success"
      : failed || activeStatus === "canceled"
        ? "warning"
        : "muted";
  const relevantEvents = (current?.events ?? []).filter((event) =>
    [
      "run.status",
      "agent.action",
      "tool.started",
      "tool.completed",
      "evaluation.result",
      "optimization.vote",
      "run.failed",
    ].includes(event.eventType),
  );
  const hasFailureEvent = relevantEvents.some(
    (event) => event.eventType === "run.failed",
  );

  async function requestCancel() {
    if (terminal || cancelState !== "idle") return;
    setCancelState("sending");
    setCancelError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/runs/${runId}/cancel`,
        { method: "POST" },
      );
      const result = (await response.json()) as {
        run?: { status?: string };
        status?: string;
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          result.message ?? result.error ?? "Permintaan pembatalan ditolak.",
        );
      const nextStatus =
        result.run?.status ?? result.status ?? "cancel_requested";
      statusRef.current = nextStatus;
      setCancelState("sent");
      setSnapshot((current) => ({
        ...current,
        status: nextStatus,
      }));
      if (terminalStatuses.has(nextStatus)) markTerminal();
    } catch (cause) {
      setCancelState("idle");
      setCancelError(
        cause instanceof Error
          ? cause.message
          : "Permintaan pembatalan tidak dapat dikirim.",
      );
    }
  }

  async function applyCandidate(candidate: OptimizationCandidate) {
    if (
      !current?.result ||
      !canApplyOptimizationCandidate({
        runId,
        resultStatus: current.result.status,
        candidate,
      }) ||
      !canApplyCandidate ||
      busy
    ) {
      return;
    }
    setApplyingCandidateId(candidate.id);
    setApplySuccess(null);
    setApplyError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/runs/${runId}/candidates/${candidate.id}/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            promptId,
            draftVersionId: candidate.draftVersionId,
          }),
        },
      );
      const payload = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(
          nonEmptyStringValue(payload?.message) ??
            "Kandidat tidak dapat diterapkan sebagai versi aktif.",
        );
      }
      const appliedPrompt = asRecord(payload?.prompt);
      if (
        appliedPrompt?.id !== promptId ||
        typeof appliedPrompt.currentVersionId !== "string" ||
        typeof appliedPrompt.version !== "number"
      ) {
        throw new Error("Server tidak mengonfirmasi versi prompt yang aktif.");
      }
      setApplySuccess({
        candidateId: candidate.id,
        version: appliedPrompt.version,
        alreadyApplied: payload?.alreadyApplied === true,
      });
      onCandidateApplied?.(
        appliedPrompt.currentVersionId,
        appliedPrompt.version,
      );
    } catch (cause) {
      setApplyError(
        cause instanceof Error
          ? cause.message
          : "Kandidat tidak dapat disimpan sebagai versi baru.",
      );
    } finally {
      setApplyingCandidateId(null);
    }
  }

  async function saveQualityVote(
    vote: "old_better" | "new_better" | "equal" | "inconclusive",
  ) {
    const candidateId = current?.result?.selectedCandidate?.id;
    if (!current?.result || !candidateId || qualityBusy) return;
    setQualityBusy(true);
    setQualityError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/runs/${runId}/quality`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidateId,
            decision:
              vote === "old_better"
                ? "original_better"
                : vote === "new_better"
                  ? "candidate_better"
                  : vote === "equal"
                    ? "equal"
                    : "inconclusive",
            note: qualityNote.trim(),
          }),
        },
      );
      const result = (await response.json()) as {
        vote?: { decision?: string };
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          result.message ?? result.error ?? "Penilaian belum tersimpan.",
        );
      const savedVote = qualityVoteFromDecision(result.vote?.decision) ?? vote;
      setSnapshot((snapshot) =>
        snapshot.key === runKey && snapshot.result
          ? {
              ...snapshot,
              result: {
                ...snapshot.result,
                qualityVote: savedVote,
                qualityNote: qualityNote.trim() || null,
              },
            }
          : snapshot,
      );
      setQualityNote(qualityNote.trim());
      qualityNoteDirty.current = false;
    } catch (cause) {
      setQualityError(
        cause instanceof Error ? cause.message : "Penilaian belum tersimpan.",
      );
    } finally {
      setQualityBusy(false);
    }
  }

  async function refreshClarification(clarificationId: string) {
    const response = await fetch(`/api/projects/${projectId}/clarifications`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Status pertanyaan tidak dapat dimuat.");
    const payload: unknown = await response.json();
    const pending = parseProjectClarifications(payload, projectId).find(
      (item) => item.id === clarificationId && item.runId === runId,
    );
    setClarificationThreads((current) =>
      current.map((item) =>
        item.question.id === clarificationId
          ? {
              ...item,
              question: pending ?? item.question,
              stale: pending === undefined,
            }
          : item,
      ),
    );
    return pending !== undefined;
  }

  async function submitClarification(
    event: React.FormEvent<HTMLFormElement>,
    question: OptimizationClarification,
  ) {
    event.preventDefault();
    const answer = clarificationAnswer.trim();
    if (
      !answer ||
      clarificationSubmitting ||
      question.lifecycle !== "awaiting_answer"
    )
      return;
    const previous = clarificationSubmission.current;
    const idempotencyKey =
      previous?.clarificationId === question.id && previous.answer === answer
        ? previous.idempotencyKey
        : crypto.randomUUID();
    clarificationSubmission.current = {
      clarificationId: question.id,
      answer,
      idempotencyKey,
    };
    setClarificationSubmitting(true);
    setClarificationError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/runs/${runId}/clarifications/${question.id}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer, idempotencyKey }),
        },
      );
      const result = (await response.json()) as {
        resumed?: boolean;
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.resumed) {
        if (response.status === 409) {
          let stillPending = false;
          try {
            stillPending = await refreshClarification(question.id);
          } catch {
            /* Preserve the original conflict and allow a retry. */
          }
          if (!stillPending)
            setClarificationThreads((current) =>
              current.map((item) =>
                item.question.id === question.id
                  ? { ...item, stale: true }
                  : item,
              ),
            );
          clarificationSubmission.current = null;
          throw new Error(
            "Pertanyaan ini sudah berubah atau dijawab. Muat ulang status untuk melihat percakapan terbaru.",
          );
        }
        throw new Error(
          result.message ?? result.error ?? "Jawaban belum dapat dikirim.",
        );
      }
      setClarificationThreads((current) =>
        current.map((item) =>
          item.question.id === question.id
            ? { ...item, answer, stale: false }
            : item,
        ),
      );
      setClarificationAnswer("");
      setClarificationError(null);
      clarificationSubmission.current = null;
    } catch (cause) {
      setClarificationError(
        cause instanceof Error ? cause.message : "Jawaban belum dapat dikirim.",
      );
    } finally {
      setClarificationSubmitting(false);
    }
  }

  return (
    <section
      className="optimization-run"
      aria-labelledby={`optimization-run-${runId}`}
    >
      <header className="optimization-run-heading">
        <div>
          <h3 id={`optimization-run-${runId}`}>Yang sedang dilakukan</h3>
          <p className="helper">
            Ringkasan langkah, alat yang dipakai, dan hasilnya. Catatan
            penalaran internal model tidak ditampilkan.
          </p>
          {objective ? (
            <p className="optimization-run-objective">
              <strong>Arahan Anda:</strong> {objective}
            </p>
          ) : null}
        </div>
        <Badge variant={badgeVariant}>
          {optimizationStatusLabel(activeStatus, current?.errorCode ?? null)}
        </Badge>
      </header>

      {!terminal ? (
        <div className="optimization-run-controls">
          <span className="helper">
            {activeStatus === "cancel_requested"
              ? "Permintaan berhenti dikirim; menunggu konfirmasi."
              : activeStatus.startsWith("paused_")
                ? "Proses menunggu provider."
                : "Proses berjalan. Prompt lama tetap aman."}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void requestCancel()}
            disabled={
              cancelState !== "idle" || activeStatus === "cancel_requested"
            }
          >
            {cancelState === "sending" ? "Menghentikan…" : "Hentikan"}
          </Button>
        </div>
      ) : null}

      {cancelError ? (
        <p className="error-message" role="alert">
          {cancelError}
        </p>
      ) : null}
      {current?.streamError ? (
        <p className="error-message" role="alert">
          {current.streamError}
        </p>
      ) : null}

      <ol className="optimization-timeline" aria-live="polite">
        {relevantEvents.map((event) => (
          <OptimizationTimelineItem key={event.sequence} event={event} />
        ))}
        {relevantEvents.length === 0 ? (
          <li className="optimization-timeline-empty">
            <span className="optimization-event-marker" aria-hidden="true" />
            <div>
              <strong>
                {failed || current?.errorSummary
                  ? optimizationStatusLabel(
                      activeStatus,
                      current?.errorCode ?? null,
                    )
                  : current?.connection === "reconnecting"
                    ? "Menghubungkan kembali"
                    : current?.connection === "closed"
                      ? "Koneksi berakhir sebelum aktivitas diterima"
                      : "Membaca prompt dan konteks"}
              </strong>
              <p className="helper">
                {failed || current?.errorSummary
                  ? "Lihat pesan status di bawah untuk langkah berikutnya."
                  : current?.connection === "reconnecting"
                    ? "Mencoba menyambungkan kembali. Aktivitas akan muncul saat tersambung."
                    : current?.connection === "closed"
                      ? "Tidak ada aktivitas yang diterima sebelum koneksi berakhir."
                      : "Senopati akan mulai membaca prompt dan konteks."}
              </p>
            </div>
          </li>
        ) : null}
      </ol>

      {clarificationThreads.length ? (
        <section
          className="optimization-conversation"
          aria-labelledby={`optimization-conversation-${runId}`}
        >
          <h4 id={`optimization-conversation-${runId}`}>Percakapan</h4>
          <div className="optimization-conversation-list">
            {clarificationThreads.map((thread) => (
              <article
                className="optimization-conversation-turn"
                key={thread.question.id}
              >
                <div className="optimization-question-message">
                  <strong>PromptLab bertanya</strong>
                  <p>{thread.question.question}</p>
                  {thread.question.publicContext ? (
                    <p className="helper">{thread.question.publicContext}</p>
                  ) : null}
                </div>
                {thread.question.choices.length ? (
                  <div
                    className="optimization-clarification-choices"
                    role="group"
                    aria-label="Pilihan jawaban"
                  >
                    {thread.question.choices.map((choice) => (
                      <Button
                        type="button"
                        key={choice}
                        size="sm"
                        variant="secondary"
                        disabled={
                          thread.answer !== null ||
                          thread.stale ||
                          clarificationSubmitting
                        }
                        onClick={() => setClarificationAnswer(choice)}
                      >
                        {choice}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {thread.answer !== null ? (
                  <div className="optimization-user-message">
                    <strong>Anda</strong>
                    <p>{thread.answer}</p>
                  </div>
                ) : null}
                {thread.stale ? (
                  <div
                    className="optimization-clarification-stale"
                    role="status"
                  >
                    <p>
                      Pertanyaan ini sudah tidak menunggu jawaban. Muat ulang
                      statusnya untuk melanjutkan percakapan terbaru.
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void refreshClarification(thread.question.id).catch(
                          () =>
                            setClarificationError(
                              "Status pertanyaan tidak dapat dimuat. Coba lagi.",
                            ),
                        )
                      }
                    >
                      Muat ulang pertanyaan
                    </Button>
                  </div>
                ) : null}
                {thread.answer === null &&
                !thread.stale &&
                thread.question.lifecycle === "awaiting_answer" ? (
                  <form
                    className="optimization-clarification-form"
                    onSubmit={(event) =>
                      void submitClarification(event, thread.question)
                    }
                  >
                    <div className="field">
                      <label htmlFor={`optimization-clarification-${runId}`}>
                        Jawaban Anda
                      </label>
                      <textarea
                        id={`optimization-clarification-${runId}`}
                        className="input optimization-clarification-input"
                        value={clarificationAnswer}
                        onChange={(event) =>
                          setClarificationAnswer(event.target.value)
                        }
                        maxLength={2_000}
                        required
                        disabled={clarificationSubmitting}
                        aria-describedby={`optimization-clarification-help-${runId}`}
                      />
                    </div>
                    <p
                      id={`optimization-clarification-help-${runId}`}
                      className="helper"
                    >
                      Run ini menunggu jawaban. Model, kedalaman berpikir, dan
                      versi prompt tetap sama.
                    </p>
                    {clarificationError ? (
                      <p className="error-message" role="alert">
                        {clarificationError}
                      </p>
                    ) : null}
                    <Button
                      type="submit"
                      disabled={
                        clarificationSubmitting || !clarificationAnswer.trim()
                      }
                    >
                      {clarificationSubmitting
                        ? "Mengirim jawaban…"
                        : "Kirim jawaban"}
                    </Button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
          {pendingClarification === null &&
          clarificationThreads.some(
            (item) => item.answer !== null && !item.stale,
          ) ? (
            <p className="helper" role="status">
              Jawaban tersimpan. Run yang sama dilanjutkan dengan setelan dan
              konteks yang sama.
            </p>
          ) : null}
        </section>
      ) : null}

      {(failed || current?.errorSummary) && !hasFailureEvent ? (
        <div className="error-message" role="status">
          <p>
            {current?.errorCode === "PROVIDER_TIMEOUT"
              ? providerTimeoutMessage
              : (current?.errorSummary ??
                optimizationFailureMessage(current?.errorCode ?? null))}
          </p>
          <p className="helper">Prompt lama tetap tersimpan.</p>
          {current?.errorCode === "PROVIDER_TIMEOUT" ? (
            <p className="helper">{providerTimeoutNextAction}</p>
          ) : null}
          {current?.errorCode ? (
            <details className="optimization-error-detail">
              <summary>Lihat rincian</summary>
              <code>{current.errorCode}</code>
            </details>
          ) : null}
        </div>
      ) : null}

      {activeStatus === "canceled" ? (
        <p className="helper" role="status">
          Proses dihentikan. Prompt lama tetap tersimpan.
        </p>
      ) : null}

      {activeStatus === "succeeded" && current?.result ? (
        <OptimizationResults
          runId={runId}
          result={current.result}
          baselinePrompt={baselinePrompt}
          canApplyCandidate={canApplyCandidate}
          currentPromptId={currentPromptId}
          currentPromptVersionId={currentPromptVersionId}
          qualityBusy={qualityBusy}
          qualityNote={qualityNote}
          qualityError={qualityError}
          onQualityNoteChange={(note) => {
            qualityNoteDirty.current = true;
            setQualityNote(note);
          }}
          onQualityVote={saveQualityVote}
          busy={busy}
          applyingCandidateId={applyingCandidateId}
          applySuccess={applySuccess}
          applyError={applyError}
          onApply={applyCandidate}
        />
      ) : null}
      {activeStatus === "succeeded" && current?.resultUnreadable ? (
        <p className="error-message" role="status">
          Run selesai, tetapi ringkasan hasil optimasi tidak sesuai kontrak yang
          dapat dibaca.
        </p>
      ) : null}
      {activeStatus === "succeeded" &&
      !current?.result &&
      !current?.resultUnreadable ? (
        <p className="helper" role="status">
          Run selesai. Menunggu ringkasan hasil optimasi…
        </p>
      ) : null}
    </section>
  );
}

function OptimizationTimelineItem({ event }: { event: TimelineEvent }) {
  const payload = event.payload;

  if (event.eventType === "run.failed") {
    return (
      <li className="optimization-timeline-item">
        <span className="optimization-event-marker" aria-hidden="true" />
        <div className="optimization-event-body">
          <span className="helper mono">{activityIndexLabel(event)}</span>
          <RunActivityDescription event={event} />
        </div>
      </li>
    );
  }

  if (event.eventType === "agent.action") {
    return (
      <li className="optimization-timeline-item">
        <span className="optimization-event-marker" aria-hidden="true" />
        <div className="optimization-event-body">
          <span className="helper mono">{activityIndexLabel(event)}</span>
          <RunActivityDescription event={event} />
        </div>
      </li>
    );
  }

  if (
    event.eventType === "tool.started" ||
    event.eventType === "tool.completed"
  ) {
    return (
      <li className="optimization-timeline-item optimization-tool-event">
        <span className="optimization-event-marker" aria-hidden="true" />
        <div className="optimization-event-body">
          <span className="helper mono">{activityIndexLabel(event)}</span>
          <RunActivityDescription event={event} />
        </div>
      </li>
    );
  }

  if (event.eventType === "evaluation.result") {
    const subject = stringValue(payload.subject);
    const answers = parseAnswers(payload.caseResults ?? [payload]);
    return (
      <li className="optimization-timeline-item optimization-evaluation-event">
        <span className="optimization-event-marker" aria-hidden="true" />
        <div className="optimization-event-body">
          <div className="optimization-event-title">
            <strong>
              {subject === "candidate"
                ? "Mencoba prompt baru"
                : "Mencoba prompt lama"}
              {answers.length ? ` · ${answers.length} contoh` : ""}
            </strong>
          </div>
          {answers.map((answer) => (
            <details
              className="optimization-event-detail"
              key={`${answer.caseId}:${answer.text.slice(0, 24)}`}
            >
              <summary>{answerLabel(answer)} · Lihat jawaban</summary>
              {answer.input ? (
                <p className="optimization-event-input">
                  <strong>Masukan:</strong> {answer.input}
                </p>
              ) : null}
              <div className="optimization-usage-row">
                <span>Token masuk: {formatTokens(answer.usage.input)}</span>
                <span>Token keluar: {formatTokens(answer.usage.output)}</span>
                <span>Waktu jawab: {formatLatency(answer.latencyMs)}</span>
              </div>
              <pre>{answer.text}</pre>
            </details>
          ))}
        </div>
      </li>
    );
  }

  if (event.eventType === "optimization.vote") {
    const vote = qualityVoteFromDecision(payload.decision);
    const label =
      vote === "old_better"
        ? "Anda menilai jawaban prompt lama lebih baik."
        : vote === "new_better"
          ? "Anda menilai jawaban prompt baru lebih baik."
          : vote === "equal"
            ? "Anda menilai kedua jawaban setara."
            : "Penilaian jawaban tersimpan.";
    return (
      <li className="optimization-timeline-item">
        <span className="optimization-event-marker" aria-hidden="true" />
        <div className="optimization-event-body">
          <div className="optimization-event-title">
            <strong>Penilaian Anda</strong>
          </div>
          <p>{label}</p>
          {payload.evidenceEligible === true ? null : (
            <p className="helper">
              Keputusan ini tersimpan, tetapi bukti evaluasinya belum
              terverifikasi.
            </p>
          )}
        </div>
      </li>
    );
  }

  const status = stringValue(payload.status);
  return (
    <li className="optimization-timeline-item">
      <span className="optimization-event-marker" aria-hidden="true" />
      <div className="optimization-event-body">
        <div className="optimization-event-title">
          <strong>{status ? statusLabel(status) : "Pembaruan status"}</strong>
          <span className="helper mono">{activityIndexLabel(event)}</span>
        </div>
      </div>
    </li>
  );
}

function targetModeLabel(mode: "selected" | "auto"): string {
  return mode === "auto" ? "Otomatis" : "Pilihan pengguna";
}

function effortResolutionLabel(resolution: string): string {
  switch (resolution) {
    case "explicit":
      return "pilihan eksplisit";
    case "advertised_default":
      return "bawaan model yang didukung";
    case "first_advertised_supported":
      return "effort pertama yang didukung";
    case "unsupported_recommendation_fallback":
      return "rekomendasi tidak didukung; memakai effort katalog";
    case "model_specific_auto_policy":
      return "kebijakan Auto model";
    case "provider_default":
      return "bawaan provider";
    case "task_aware_recommendation":
      return "rekomendasi tugas yang didukung";
    default:
      return resolution;
  }
}

function TargetSelectionReport({
  evidence,
}: {
  evidence: OptimizationTargetSelectionEvidence;
}) {
  const capabilities = evidence.modelCapabilities;
  const effort =
    evidence.resolvedReasoningEffort ??
    evidence.sentReasoningEffort ??
    "Bawaan model/provider";
  return (
    <section
      className="optimization-target-report"
      aria-labelledby="optimization-target-title"
    >
      <div>
        <h4 id="optimization-target-title">Model dan kemampuan yang dipakai</h4>
        <p className="helper">
          {evidence.selectionReason ??
            "Pilihan ditentukan dari bukti katalog Codex aktif saat Run dimulai."}
        </p>
      </div>
      <dl className="optimization-target-facts">
        <div>
          <dt>Mode model</dt>
          <dd>{targetModeLabel(evidence.selection.model)}</dd>
        </div>
        <div>
          <dt>Model koneksi yang diminta</dt>
          <dd>{evidence.requestedModel}</dd>
        </div>
        <div>
          <dt>Model yang dipakai</dt>
          <dd>
            {capabilities.displayName || evidence.resolvedModel} ·{" "}
            {evidence.resolvedModel}
          </dd>
        </div>
        <div>
          <dt>Mode kedalaman</dt>
          <dd>{targetModeLabel(evidence.selection.reasoningEffort)}</dd>
        </div>
        <div>
          <dt>Kedalaman yang diminta</dt>
          <dd>{evidence.requestedReasoningEffort ?? "Bawaan model"}</dd>
        </div>
        <div>
          <dt>Kedalaman yang dipakai</dt>
          <dd>{effort}</dd>
        </div>
        <div>
          <dt>Kedalaman yang didukung</dt>
          <dd>
            {capabilities.supportedReasoningEfforts.length
              ? capabilities.supportedReasoningEfforts.join(", ")
              : "Tidak diumumkan oleh katalog"}
          </dd>
        </div>
        <div>
          <dt>Sumber bukti</dt>
          <dd>{evidence.capabilitySource}</dd>
        </div>
        <div>
          <dt>Diamati</dt>
          <dd>{new Date(evidence.observedAt).toLocaleString("id-ID")}</dd>
        </div>
      </dl>
      <p className="helper">
        Resolusi: model {evidence.modelResolution}; kedalaman{" "}
        {effortResolutionLabel(evidence.effortResolution)}
        {evidence.modelCatalogPosition !== null &&
        evidence.modelCatalogCount !== null
          ? ` · posisi ${evidence.modelCatalogPosition + 1} dari ${evidence.modelCatalogCount}`
          : ""}
        {capabilities.defaultReasoningEffort
          ? ` · bawaan model ${capabilities.defaultReasoningEffort}`
          : ""}
        {capabilities.inputModalities.length
          ? ` · input ${capabilities.inputModalities.join(", ")}`
          : ""}
      </p>
    </section>
  );
}

function verificationStatusLabel(status: unknown): string {
  if (status === "passed") return "Lolos pemeriksaan";
  if (status === "failed") return "Tidak cocok dengan hasil harapan";
  if (status === "invalid_fixture") return "Fixture perlu diperbaiki";
  if (status === "unavailable") return "Pemeriksaan tidak tersedia";
  return "Status pemeriksaan tidak diketahui";
}

function verificationReasonLabel(reason: unknown): string | null {
  const labels: Record<string, string> = {
    expected_values_do_not_match_exact_reference:
      "Nilai harapan tidak cocok dengan hitungan referensi.",
    target_answer_missing: "Jawaban target belum tersedia.",
    answer_must_be_a_json_object_with_exact_count_and_sum:
      "Jawaban harus berupa objek JSON dengan count dan sum yang tepat.",
    answer_does_not_match_expected_values:
      "Nilai jawaban berbeda dari nilai harapan.",
    verified_isolated_python_runner_unavailable:
      "Kode kandidat tidak dijalankan karena runner Python terisolasi belum tersedia.",
  };
  return typeof reason === "string" ? (labels[reason] ?? null) : null;
}

function OptimizationVerification({ answer }: { answer: OptimizationAnswer }) {
  const evidence = answer.verificationEvidence;
  if (!answer.verification && !evidence) {
    return (
      <p className="optimization-verification helper">
        Pemeriksaan deterministik tidak dikonfigurasi.
      </p>
    );
  }
  if (!evidence) {
    return (
      <p className="optimization-verification helper">
        Bukti pemeriksaan belum tersedia.
      </p>
    );
  }
  const kind = stringValue(evidence.kind);
  const status = stringValue(evidence.status);
  const reason = verificationReasonLabel(evidence.reasonCode);
  const expected = asRecord(evidence.expected);
  const reference = asRecord(evidence.reference);
  const actual = asRecord(evidence.actual);
  const execution = asRecord(evidence.execution);
  const fixtures = Array.isArray(evidence.fixtures)
    ? evidence.fixtures.map(asRecord).filter((fixture) => fixture !== null)
    : [];
  return (
    <div
      className="optimization-verification"
      aria-label="Hasil pemeriksaan deterministik"
    >
      <strong>{verificationStatusLabel(status)}</strong>
      {kind === "divisibility" ? (
        <dl className="optimization-verification-values">
          <div>
            <dt>Harapan</dt>
            <dd>
              count {stringValue(expected?.count) ?? "—"} · sum{" "}
              {stringValue(expected?.sum) ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Referensi</dt>
            <dd>
              count {stringValue(reference?.count) ?? "—"} · sum{" "}
              {stringValue(reference?.sum) ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Jawaban</dt>
            <dd>
              count {stringValue(actual?.count) ?? "—"} · sum{" "}
              {stringValue(actual?.sum) ?? "—"}
            </dd>
          </div>
        </dl>
      ) : null}
      {kind === "python_tests" ? (
        <>
          <p className="helper">
            Eksekusi kandidat:{" "}
            {stringValue(execution?.status) === "unavailable"
              ? "tidak tersedia"
              : "status tidak diketahui"}
            .
          </p>
          {fixtures.length ? (
            <ul className="optimization-verification-fixtures">
              {fixtures.map((fixture, index) => (
                <li key={stringValue(fixture?.id) ?? index}>
                  Fixture {stringValue(fixture?.id) ?? index + 1}: harapan{" "}
                  {stringValue(fixture?.expectedOutput) ?? "—"} · referensi{" "}
                  {stringValue(fixture?.referenceOutput) ?? "—"} ·{" "}
                  {fixture?.expectedMatchesReference === true
                    ? "cocok"
                    : "tidak cocok"}
                </li>
              ))}
            </ul>
          ) : null}
          {verificationReasonLabel(execution?.reasonCode) ? (
            <p className="helper">
              {verificationReasonLabel(execution?.reasonCode)}
            </p>
          ) : null}
        </>
      ) : null}
      {reason ? <p className="helper">{reason}</p> : null}
    </div>
  );
}

function optimizationOutcomeLabel(outcome: string | null): string {
  switch (outcome) {
    case "candidate_ready":
      return "siap ditinjau";
    case "incomplete":
      return "belum lengkap";
    case "no_change_recommended":
      return "tidak perlu perubahan";
    case "candidate_rejected":
      return "ditolak";
    case "clarification_required":
      return "menunggu klarifikasi";
    default:
      return "belum diketahui";
  }
}

function optimizationResultMessage(
  status: string | null,
  hasReviewableCandidate: boolean,
): string {
  if (status === "candidate_ready") {
    return hasReviewableCandidate
      ? "Kedua prompt dicoba dengan model, kedalaman berpikir, dan contoh yang sama. Kualitasnya Anda yang menilai."
      : "Kandidat siap tidak dapat dipastikan dari riwayat revisi ini.";
  }
  if (status === "no_change_recommended") {
    return "Tidak ada perubahan yang disarankan. Prompt lama tetap digunakan.";
  }
  if (status === "candidate_rejected") {
    return "Kandidat terbaru ditolak. Prompt lama tetap digunakan.";
  }
  if (status === "incomplete") {
    return "Pengujian belum lengkap. Angka atau jawaban yang belum tersedia ditampilkan apa adanya.";
  }
  if (status === "clarification_required") {
    return "Perbaikan menunggu klarifikasi. Prompt lama tetap digunakan.";
  }
  return "Hasil optimasi tersimpan. Prompt lama tetap digunakan sampai kandidat siap ditinjau.";
}

function emptyCandidateMessage(
  status: string | null,
  selectionConsistent: boolean,
): string {
  if (!selectionConsistent) {
    return "Prompt baru tidak ditampilkan karena pemilihan revisi tidak konsisten.";
  }
  if (status === "incomplete") {
    return "Belum ada prompt baru yang siap dibandingkan.";
  }
  if (status === "no_change_recommended") {
    return "Tidak ada perubahan yang disarankan. Prompt lama tetap digunakan.";
  }
  if (status === "candidate_rejected") {
    return "Kandidat terbaru ditolak. Prompt lama tetap digunakan.";
  }
  if (status === "clarification_required") {
    return "Perbaikan menunggu klarifikasi. Prompt lama tetap digunakan.";
  }
  return "Belum ada kandidat siap untuk dibandingkan.";
}

function OptimizationResults({
  runId,
  result,
  baselinePrompt,
  canApplyCandidate,
  currentPromptId,
  currentPromptVersionId,
  busy,
  applyingCandidateId,
  applySuccess,
  applyError,
  qualityBusy,
  qualityNote,
  qualityError,
  onQualityNoteChange,
  onApply,
  onQualityVote,
}: {
  runId: string;
  result: OptimizationResult;
  baselinePrompt: string;
  canApplyCandidate: boolean;
  currentPromptId: string | null;
  currentPromptVersionId: string | null;
  busy: boolean;
  applyingCandidateId: string | null;
  applySuccess: {
    candidateId: string;
    version: number;
    alreadyApplied: boolean;
  } | null;
  applyError: string | null;
  qualityBusy: boolean;
  qualityNote: string;
  qualityError: string | null;
  onQualityNoteChange: (note: string) => void;
  onApply: (candidate: OptimizationCandidate) => Promise<void>;
  onQualityVote: (
    vote: "old_better" | "new_better" | "equal" | "inconclusive",
  ) => void;
}) {
  const candidate = result.selectedCandidate;
  const candidateEvidenceEligible = Boolean(candidate?.evidenceEligible);
  const latestCandidate = result.candidates.at(-1) ?? null;
  const oldUsage =
    result.baseline.usage.total.value !== null
      ? result.baseline.usage
      : combinedUsage(result.baseline.answers);
  const newUsage =
    candidate && candidate.usage.total.value !== null
      ? candidate.usage
      : combinedUsage(candidate?.answers ?? []);
  const oldLatency = combinedLatency(
    result.baseline.latencyMs,
    result.baseline.answers,
  );
  const newLatency = candidate
    ? combinedLatency(candidate.latencyMs, candidate.answers)
    : null;
  const answerIds = Array.from(
    new Set([
      ...result.baseline.answers.map((answer) => answer.caseId),
      ...(candidate?.answers.map((answer) => answer.caseId) ?? []),
    ]),
  );
  const candidateCanBeUsed =
    candidate !== null &&
    canApplyOptimizationCandidate({
      runId,
      resultStatus: result.status,
      candidate,
    });
  const legacyCandidate = candidate
    ? isLegacyUnverifiedOptimizationCandidate({ runId, candidate })
    : false;
  const qualityVote = result.qualityVote;

  return (
    <section
      className="optimization-results"
      aria-labelledby="optimization-results-title"
    >
      <header className="optimization-results-heading">
        <div>
          <h3 id="optimization-results-title">Perbandingan hasil</h3>
          <p className="helper">
            {result.selectionConsistent
              ? optimizationResultMessage(result.status, candidate !== null)
              : "Riwayat revisi tidak konsisten. Kandidat tidak dapat dinilai atau diterapkan."}
          </p>
        </div>
      </header>

      {!result.selectionConsistent ? (
        <p className="error-message" role="status">
          Pemilihan revisi tidak cocok dengan riwayat yang diterima. Penilaian
          dan penerapan kandidat dinonaktifkan.
        </p>
      ) : null}

      {candidate ? (
        <div className="optimization-candidate-status" aria-live="polite">
          {legacyCandidate ? (
            <p className="error-message" role="status">
              Riwayat optimasi lama ini belum membuktikan bahwa draft yang diuji
              sama dengan versi yang tersimpan. Jawaban hitungnya salah dan
              contoh kode melanggar batas memori; draft{" "}
              b5b6b3f5-7d3e-423f-8fdd-be1023e03949 belum teruji dan tidak dapat
              diterapkan.
            </p>
          ) : null}
          <p className="helper">
            Hasil revisi: {optimizationOutcomeLabel(candidate.outcome)}. Status
            pengujian:{" "}
            {candidate.testingStatus === "ready"
              ? "siap"
              : candidate.testingStatus === "rejected"
                ? "ditolak"
                : candidate.testingStatus === "incomplete"
                  ? "belum lengkap"
                  : "bukti tidak tersedia"}
            .{" "}
            {candidate.evidenceBoundToPrompt
              ? "Jawaban dan pemeriksaan terikat pada teks prompt yang ditampilkan."
              : "Jawaban dan pemeriksaan tidak ditampilkan karena kecocokan teks prompt belum terbukti."}
          </p>
        </div>
      ) : null}

      {latestCandidate && latestCandidate.id !== candidate?.id ? (
        <div className="optimization-candidate-status" role="status">
          <p>
            <strong>
              Revisi terbaru:{" "}
              {optimizationOutcomeLabel(latestCandidate.outcome)}.
            </strong>
          </p>
          {latestCandidate.changeSummary ? (
            <p className="optimization-change-summary">
              {latestCandidate.changeSummary}
            </p>
          ) : null}
          {latestCandidate.riskSummary ? (
            <p className="helper">
              Perlu diperiksa: {latestCandidate.riskSummary}
            </p>
          ) : null}
          <details>
            <summary>Tampilkan prompt revisi terbaru</summary>
            <pre className="optimization-prompt-preview">
              {latestCandidate.prompt}
            </pre>
          </details>
        </div>
      ) : null}

      {result.candidates.length > 0 &&
      (result.candidates.length > 1 || candidate === null) ? (
        <details className="optimization-revision-history">
          <summary>Riwayat revisi ({result.candidates.length})</summary>
          <ol>
            {result.candidates.map((revision, index) => (
              <li key={`${revision.id}:${index}`}>
                <strong>
                  Revisi {index + 1}:{" "}
                  {optimizationOutcomeLabel(revision.outcome)}
                </strong>
                {revision.id === candidate?.id ? (
                  <span> · dipilih untuk ditinjau</span>
                ) : null}
                {revision.id === latestCandidate?.id ? (
                  <span> · terbaru</span>
                ) : null}
                {revision.changeSummary ? (
                  <p className="optimization-change-summary">
                    {revision.changeSummary}
                  </p>
                ) : null}
                {revision.riskSummary ? (
                  <p className="helper">
                    Perlu diperiksa: {revision.riskSummary}
                  </p>
                ) : null}
                <details>
                  <summary>Tampilkan prompt revisi</summary>
                  <pre className="optimization-prompt-preview">
                    {revision.prompt}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <div className="optimization-metrics-grid">
        <article className="optimization-metric-card">
          <h4>Total token</h4>
          <p>
            <span>Prompt lama</span>
            <strong>{formatTokens(oldUsage.total)}</strong>
          </p>
          <p>
            <span>Prompt baru</span>
            <strong>{formatTokens(newUsage.total)}</strong>
          </p>
          <span className="helper">
            {metricChangeLabel(
              oldUsage.total.value,
              newUsage.total.value,
              "tokens",
              oldUsage.total.status === "estimated" ||
                newUsage.total.status === "estimated",
            )}
          </span>
        </article>
        <article className="optimization-metric-card">
          <h4>Waktu menjawab</h4>
          <p>
            <span>Prompt lama</span>
            <strong>{formatLatency(oldLatency)}</strong>
          </p>
          <p>
            <span>Prompt baru</span>
            <strong>{formatLatency(newLatency)}</strong>
          </p>
          <span className="helper">
            {metricChangeLabel(oldLatency, newLatency, "time")}
          </span>
        </article>
      </div>

      <div className="optimization-overhead">
        <div>
          <h4>Waktu dan token untuk perbaikan</h4>
          <p className="helper">
            Total waktu perbaikan di luar waktu untuk mencoba jawaban. Waktu
            panggilan Senopati ditampilkan terpisah.
          </p>
        </div>
        <div className="optimization-usage-row">
          <span>
            Senopati
            {result.optimizer.model ? ` · ${result.optimizer.model}` : ""}
          </span>
          <span>Token masuk: {formatTokens(result.optimizer.usage.input)}</span>
          <span>
            Token keluar: {formatTokens(result.optimizer.usage.output)}
          </span>
          <span>
            Waktu perbaikan: {formatLatency(result.optimizationOverheadMs)}
          </span>
          <span>
            Waktu panggilan Senopati:{" "}
            {formatLatency(result.optimizer.elapsedMs)}
          </span>
          {result.optimizer.calls !== null ? (
            <span>{result.optimizer.calls} permintaan</span>
          ) : null}
        </div>
      </div>

      {result.targetSelection ? (
        <TargetSelectionReport evidence={result.targetSelection} />
      ) : null}

      <div className="optimization-prompt-comparison">
        <article className="optimization-prompt-card">
          <h4>Prompt lama</h4>
          <pre className="optimization-prompt-preview">
            {result.baseline.prompt || baselinePrompt}
          </pre>
        </article>
        {candidate ? (
          <article className="optimization-prompt-card">
            <h4>Prompt baru</h4>
            {candidate.changeSummary ? (
              <p className="optimization-change-summary">
                {candidate.changeSummary}
              </p>
            ) : null}
            {candidate.riskSummary ? (
              <p className="helper">Perlu diperiksa: {candidate.riskSummary}</p>
            ) : null}
            <pre className="optimization-prompt-preview">
              {candidate.prompt}
            </pre>
          </article>
        ) : (
          <article className="optimization-prompt-card">
            <h4>Prompt baru</h4>
            <p className="helper">
              {emptyCandidateMessage(result.status, result.selectionConsistent)}
            </p>
          </article>
        )}
      </div>

      {answerIds.length ? (
        <section
          className="optimization-answer-comparison"
          aria-labelledby="optimization-answers-title"
        >
          <h4 id="optimization-answers-title">
            Jawaban untuk masukan yang sama
          </h4>
          <div className="optimization-answer-list">
            {answerIds.map((caseId) => {
              const oldAnswer = result.baseline.answers.find(
                (answer) => answer.caseId === caseId,
              );
              const newAnswer = candidate?.answers.find(
                (answer) => answer.caseId === caseId,
              );
              const example = oldAnswer ?? newAnswer;
              if (!example) return null;
              return (
                <article className="optimization-answer-pair" key={caseId}>
                  <header className="optimization-event-title">
                    <strong>{answerLabel(example)}</strong>
                  </header>
                  {example.input ? (
                    <p className="optimization-example-input">
                      <strong>Masukan:</strong> {example.input}
                    </p>
                  ) : null}
                  <div className="optimization-answer-columns">
                    <article className="optimization-answer-column">
                      <h5>Jawaban prompt lama</h5>
                      {oldAnswer ? (
                        <>
                          <pre>{oldAnswer.text}</pre>
                          <div className="optimization-usage-row">
                            <span>
                              Token masuk: {formatTokens(oldAnswer.usage.input)}
                            </span>
                            <span>
                              Token keluar:{" "}
                              {formatTokens(oldAnswer.usage.output)}
                            </span>
                            <span>
                              Waktu: {formatLatency(oldAnswer.latencyMs)}
                            </span>
                          </div>
                          <OptimizationVerification answer={oldAnswer} />
                        </>
                      ) : (
                        <p className="helper">Jawaban belum tersedia.</p>
                      )}
                    </article>
                    <article className="optimization-answer-column">
                      <h5>Jawaban prompt baru</h5>
                      {newAnswer ? (
                        <>
                          <pre>{newAnswer.text}</pre>
                          <div className="optimization-usage-row">
                            <span>
                              Token masuk: {formatTokens(newAnswer.usage.input)}
                            </span>
                            <span>
                              Token keluar:{" "}
                              {formatTokens(newAnswer.usage.output)}
                            </span>
                            <span>
                              Waktu: {formatLatency(newAnswer.latencyMs)}
                            </span>
                          </div>
                          <OptimizationVerification answer={newAnswer} />
                        </>
                      ) : (
                        <p className="helper">Jawaban belum tersedia.</p>
                      )}
                    </article>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {candidate ? (
        <div className="optimization-quality-vote">
          <div>
            <h4>Jawaban mana yang lebih baik?</h4>
            <p className="helper">
              Pilihan dan catatan Anda membantu perbaikan berikutnya di proyek
              ini.
            </p>
          </div>
          <div className="field">
            <label htmlFor={`optimization-quality-note-${candidate.id}`}>
              Catatan untuk perbaikan berikutnya (opsional)
            </label>
            <textarea
              id={`optimization-quality-note-${candidate.id}`}
              className="input optimization-quality-note"
              maxLength={500}
              value={qualityNote}
              disabled={qualityBusy || !candidateEvidenceEligible}
              onChange={(event) => onQualityNoteChange(event.target.value)}
              placeholder="Contoh: Pertahankan istilah teknis dan hindari pembuka yang panjang."
              aria-describedby={`optimization-quality-note-help-${candidate.id}`}
            />
            <span
              id={`optimization-quality-note-help-${candidate.id}`}
              className="helper"
            >
              Disimpan sebagai umpan balik tertulis, tanpa diubah menjadi skor.
            </span>
          </div>
          {!candidateEvidenceEligible ? (
            <p className="helper" role="status">
              Penilaian belum dapat disimpan karena bukti kandidat belum
              terverifikasi oleh server.
            </p>
          ) : null}
          <div
            className="optimization-vote-buttons"
            role="group"
            aria-label="Nilai kualitas jawaban"
          >
            <Button
              type="button"
              variant={qualityVote === "old_better" ? "default" : "secondary"}
              aria-pressed={qualityVote === "old_better"}
              disabled={qualityBusy || !candidateEvidenceEligible}
              onClick={() => onQualityVote("old_better")}
            >
              Prompt lama lebih baik
            </Button>
            <Button
              type="button"
              variant={qualityVote === "new_better" ? "default" : "secondary"}
              aria-pressed={qualityVote === "new_better"}
              disabled={qualityBusy || !candidateEvidenceEligible}
              onClick={() => onQualityVote("new_better")}
            >
              Prompt baru lebih baik
            </Button>
            <Button
              type="button"
              variant={qualityVote === "equal" ? "default" : "secondary"}
              aria-pressed={qualityVote === "equal"}
              disabled={qualityBusy || !candidateEvidenceEligible}
              onClick={() => onQualityVote("equal")}
            >
              Setara
            </Button>
            <Button
              type="button"
              variant={qualityVote === "inconclusive" ? "default" : "secondary"}
              aria-pressed={qualityVote === "inconclusive"}
              disabled={qualityBusy || !candidateEvidenceEligible}
              onClick={() => onQualityVote("inconclusive")}
            >
              Belum cukup bukti
            </Button>
          </div>
          {qualityBusy ? (
            <p className="helper" role="status">
              Menyimpan penilaian…
            </p>
          ) : null}
          {qualityVote && !qualityBusy ? (
            <p className="helper" role="status">
              Penilaian tersimpan.
            </p>
          ) : null}
          {qualityError ? (
            <p className="error-message" role="alert">
              {qualityError}
            </p>
          ) : null}
        </div>
      ) : null}

      {candidate ? (
        <div className="optimization-apply-row">
          <Button
            type="button"
            onClick={() => void onApply(candidate)}
            disabled={
              !candidateCanBeUsed ||
              !canApplyCandidate ||
              busy ||
              applyingCandidateId !== null ||
              applySuccess?.candidateId === candidate.id
            }
          >
            {applySuccess?.candidateId === candidate.id
              ? "Prompt sudah aktif"
              : applyingCandidateId === candidate.id
                ? "Menyimpan…"
                : "Gunakan prompt ini"}
          </Button>
          <span className="helper">
            {applySuccess?.candidateId === candidate.id
              ? `${applySuccess.alreadyApplied ? "Prompt ini sudah aktif" : "Prompt ini aktif"} sebagai versi v${applySuccess.version}.`
              : legacyCandidate
                ? "Riwayat ini memuat draft yang belum teruji dan tidak dapat diterapkan."
                : !candidateCanBeUsed
                  ? "Hanya kandidat siap dengan bukti untuk teks yang sama dan draft tersimpan yang dapat diterapkan."
                  : canApplyCandidate
                    ? "Versi aktif tidak berubah sampai Anda memilih tombol ini."
                    : currentPromptId && currentPromptVersionId
                      ? "Kandidat ini berasal dari versi prompt lain. Pilih prompt asal untuk menyimpannya sebagai versi baru."
                      : "Pilih prompt asal sebelum menyimpan kandidat sebagai versi baru."}
          </span>
          {candidate.invariantsPreserved === false ? (
            <p className="error-message" role="status">
              Perbaikan mengubah aturan penting. Prompt ini belum bisa
              digunakan.
            </p>
          ) : candidate.invariantsPreserved === null ? (
            <p className="helper">
              Periksa prompt dan jawaban sebelum menggunakannya.
            </p>
          ) : null}
        </div>
      ) : null}
      {applyError ? (
        <p className="error-message" role="alert">
          {applyError}
        </p>
      ) : null}
    </section>
  );
}
