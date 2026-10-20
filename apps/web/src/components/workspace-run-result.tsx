"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RunActivityList } from "@/components/run-activity";
import { WorkspaceMessage } from "@/components/workspace-message";
import { describeRunActivity, type RunActivityEvent } from "@/lib/run-activity";
import { formatAssistantTextForDisplay } from "@/lib/workspace-message-content";
import styles from "./workspace-run-result.module.css";

interface RunEvent extends RunActivityEvent {
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
}

interface RunResultSnapshot {
  key: string;
  status: string;
  text: string | null;
  completed: boolean;
  failed: boolean;
  errorCode: string | null;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  activityEvents: RunEvent[];
  recommendation: WorkspaceChatRecommendation | null;
  workspaceChatOutcome: string | null;
  optimizationEvidenceStatus: string | null;
  retrievalStrategy: string | null;
  effectiveRetrievalStrategy: string | null;
  retrievalReason: string | null;
  retrievalEvidenceStatus: string | null;
  retrievalEvidence: WorkspaceGraphEvidence[];
  retrievalTraceIds: string[];
  graphSnapshotId: string | null;
}

interface WorkspaceChatRecommendation {
  text: string;
  changeSummary: string;
  riskSummary: string;
}

interface WorkspaceGraphEvidence {
  evidenceId: string;
  kind: "graph" | "chunk";
  quote: string;
  documentId: string;
  documentName: string;
  sourcePermission: string;
  sourceRef: string | null;
  documentVersionId: string;
  documentVersion: number;
  sourceChecksum: string;
  chunkId: string | null;
  pageNumber: number | null;
  traceId: string;
}

const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted_unknown",
]);

const eventNames = [
  "run.status",
  "run.enqueue",
  "agent.action",
  "agent.finished",
  "tool.started",
  "tool.completed",
  "candidate.proposed",
  "output.delta",
  "usage.snapshot",
  "quota.snapshot",
  "evaluation.result",
  "optimization.clarification.requested",
  "optimization.clarification.answered",
  "optimization.vote",
  "run.completed",
  "run.failed",
];

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.eventType === "string" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
  );
}

function statusLabel(status: string, completed: boolean, failed: boolean) {
  if (completed) return "Selesai";
  if (status === "interrupted_unknown") return "Terhenti";
  if (failed || status === "failed") return "Gagal";
  if (status.startsWith("paused_")) return "Perlu tindakan";
  if (status === "queued") return "Menunggu";
  if (status === "running") return "Sedang menjawab";
  if (status === "canceled") return "Dibatalkan";
  return "Memuat";
}

function retrievalReasonLabel(reason: string): string {
  switch (reason) {
    case "workspace_target_preflight":
      return "server menyiapkan bukti sumber sebelum Codex dijalankan";
    case "senopati_selected_lexical":
      return "Senopati memilih pencarian leksikal";
    case "senopati_selected_hybrid":
      return "Senopati memilih retrieval hybrid";
    case "senopati_selected_graph":
      return "Senopati memilih GraphRAG";
    case "senopati_skipped_retrieval":
      return "Senopati tidak memerlukan pencarian sumber";
    case "auto_graph_unavailable_at_enqueue":
      return "snapshot GraphRAG tidak tersedia saat run dibuat; Auto memakai retrieval hybrid jika embedding siap, lalu leksikal";
    case "auto_graph_unavailable_at_worker_preflight":
      return "snapshot GraphRAG tidak lagi tersedia saat run dimulai; Auto memakai retrieval hybrid jika embedding siap, lalu leksikal";
    case "auto_graph_unavailable_during_retrieval":
      return "snapshot berubah; Auto beralih ke retrieval hybrid, dengan fallback leksikal bila embedding tidak tersedia";
    case "no_sources_selected":
      return "tidak ada sumber yang dipilih";
    default:
      return "alasan tidak tersedia";
  }
}

function isTerminal(status: string) {
  return terminalStatuses.has(status) || status.startsWith("paused_");
}

function parseWorkspaceRetrievalEvidence(
  value: unknown,
  fallbackKind: "graph" | "chunk" = "graph",
): WorkspaceGraphEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const evidence = item as Record<string, unknown>;
    if (
      typeof evidence.evidenceId !== "string" ||
      typeof evidence.quote !== "string" ||
      typeof evidence.documentId !== "string" ||
      typeof evidence.documentName !== "string" ||
      typeof evidence.documentVersionId !== "string" ||
      typeof evidence.documentVersion !== "number" ||
      typeof evidence.sourceChecksum !== "string" ||
      typeof evidence.traceId !== "string"
    ) {
      return [];
    }
    return [
      {
        evidenceId: evidence.evidenceId,
        kind:
          evidence.kind === "graph" || evidence.kind === "chunk"
            ? evidence.kind
            : fallbackKind,
        quote: evidence.quote,
        documentId: evidence.documentId,
        documentName: evidence.documentName,
        sourcePermission:
          typeof evidence.sourcePermission === "string"
            ? evidence.sourcePermission
            : "local_only",
        sourceRef:
          typeof evidence.sourceRef === "string" ? evidence.sourceRef : null,
        documentVersionId: evidence.documentVersionId,
        documentVersion: evidence.documentVersion,
        sourceChecksum: evidence.sourceChecksum,
        chunkId: typeof evidence.chunkId === "string" ? evidence.chunkId : null,
        pageNumber:
          typeof evidence.pageNumber === "number" ? evidence.pageNumber : null,
        traceId: evidence.traceId,
      },
    ];
  });
}

export function WorkspaceRunResult({
  projectId,
  runId,
  initialStatus,
  providerLabel = "Codex",
  focusOnMount = true,
  displayAnswer = true,
  chatPresentation = false,
  userPrompt = "",
  initialAnswer = null,
  conversationContextPrompts = [],
  onCompleted,
  onStatusChange,
}: {
  projectId: string;
  runId: string;
  initialStatus: string;
  providerLabel?: string;
  focusOnMount?: boolean;
  displayAnswer?: boolean;
  chatPresentation?: boolean;
  userPrompt?: string;
  initialAnswer?: string | null;
  conversationContextPrompts?: readonly string[];
  onCompleted?: (text: string) => void;
  onStatusChange?: (status: string) => void;
}) {
  const runKey = `${projectId}:${runId}`;
  const headingRef = useRef<HTMLDivElement>(null);
  const onCompletedRef = useRef(onCompleted);
  const onStatusChangeRef = useRef(onStatusChange);
  const userPromptRef = useRef(userPrompt);
  const conversationContextPromptsRef = useRef(conversationContextPrompts);
  const [snapshot, setSnapshot] = useState<RunResultSnapshot>({
    key: "",
    status: initialStatus,
    text: null,
    completed: false,
    failed: false,
    errorCode: null,
    connection: "connecting",
    activityEvents: [],
    recommendation: null,
    workspaceChatOutcome: null,
    optimizationEvidenceStatus: null,
    retrievalStrategy: null,
    effectiveRetrievalStrategy: null,
    retrievalReason: null,
    retrievalEvidenceStatus: null,
    retrievalEvidence: [],
    retrievalTraceIds: [],
    graphSnapshotId: null,
  });
  const runSnapshot =
    snapshot.key === runKey
      ? snapshot
      : {
          key: runKey,
          status: initialStatus,
          text: null,
          completed: false,
          failed: false,
          errorCode: null,
          connection: "connecting" as const,
          activityEvents: [],
          recommendation: null,
          workspaceChatOutcome: null,
          optimizationEvidenceStatus: null,
          retrievalStrategy: null,
          effectiveRetrievalStrategy: null,
          retrievalReason: null,
          retrievalEvidenceStatus: null,
          retrievalEvidence: [],
          retrievalTraceIds: [],
          graphSnapshotId: null,
        };
  const current =
    initialAnswer && !runSnapshot.completed
      ? {
          ...runSnapshot,
          status: "succeeded",
          text: initialAnswer,
          completed: true,
          failed: false,
        }
      : runSnapshot;
  const label = statusLabel(current.status, current.completed, current.failed);
  const terminal =
    isTerminal(current.status) || current.completed || current.failed;

  useEffect(() => {
    onCompletedRef.current = onCompleted;
    onStatusChangeRef.current = onStatusChange;
    userPromptRef.current = userPrompt;
    conversationContextPromptsRef.current = conversationContextPrompts;
  }, [onCompleted, onStatusChange, userPrompt, conversationContextPrompts]);

  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
    const replayMode =
      initialAnswer !== null && isTerminal(initialStatus)
        ? "?snapshot=completed"
        : "";
    const source = new EventSource(
      `/api/projects/${projectId}/runs/${runId}/events${replayMode}`,
    );
    let lastSequence = 0;
    let stopped = false;

    const closeAfterTerminal = () => {
      stopped = true;
      source.close();
      setSnapshot((previous) => {
        const base = previous.key === runKey ? previous : current;
        return { ...base, connection: "closed" };
      });
    };

    source.onopen = () => {
      setSnapshot((previous) => {
        const base = previous.key === runKey ? previous : current;
        return { ...base, connection: "connected" };
      });
    };
    source.onerror = () => {
      if (stopped) return;
      setSnapshot((previous) => {
        const base = previous.key === runKey ? previous : current;
        return {
          ...base,
          connection:
            source.readyState === EventSource.CLOSED
              ? "closed"
              : "reconnecting",
        };
      });
    };

    const onMessage = (message: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(message.data);
        if (!isRunEvent(value) || value.sequence <= lastSequence) return;
        lastSequence = value.sequence;
        const event = value;
        const payload = event.payload;
        const workspaceChat =
          event.eventType === "run.completed" &&
          typeof payload.workspaceChat === "object" &&
          payload.workspaceChat !== null &&
          !Array.isArray(payload.workspaceChat)
            ? (payload.workspaceChat as Record<string, unknown>)
            : null;
        const workspaceChatOutcome =
          typeof workspaceChat?.outcome === "string"
            ? workspaceChat.outcome
            : null;
        const optimizationEvidenceStatus =
          typeof workspaceChat?.optimizationEvidenceStatus === "string"
            ? workspaceChat.optimizationEvidenceStatus
            : null;
        const retrievalStrategy =
          typeof workspaceChat?.retrievalStrategy === "string"
            ? workspaceChat.retrievalStrategy
            : null;
        const effectiveRetrievalStrategy =
          typeof workspaceChat?.effectiveRetrievalStrategy === "string"
            ? workspaceChat.effectiveRetrievalStrategy
            : null;
        const retrievalReason =
          typeof workspaceChat?.retrievalReason === "string"
            ? workspaceChat.retrievalReason
            : null;
        const graphSnapshotId =
          typeof workspaceChat?.graphSnapshotId === "string"
            ? workspaceChat.graphSnapshotId
            : null;
        const graphEvidenceStatus =
          typeof workspaceChat?.graphEvidenceStatus === "string"
            ? workspaceChat.graphEvidenceStatus
            : null;
        const retrievalEvidenceStatus =
          typeof workspaceChat?.retrievalEvidenceStatus === "string"
            ? workspaceChat.retrievalEvidenceStatus
            : graphEvidenceStatus;
        const retrievalEvidence = parseWorkspaceRetrievalEvidence(
          workspaceChat?.retrievalEvidence,
          effectiveRetrievalStrategy === "graph" ? "graph" : "chunk",
        );
        const legacyGraphEvidence = parseWorkspaceRetrievalEvidence(
          workspaceChat?.graphEvidence,
        );
        const selectedRetrievalEvidence = retrievalEvidence.length
          ? retrievalEvidence
          : legacyGraphEvidence;
        const retrievalTraceIds = Array.isArray(
          workspaceChat?.retrievalTraceIds,
        )
          ? workspaceChat.retrievalTraceIds.filter(
              (traceId): traceId is string => typeof traceId === "string",
            )
          : [...new Set(selectedRetrievalEvidence.map((item) => item.traceId))];
        const rawRecommendation = workspaceChat?.recommendation;
        let recommendation: WorkspaceChatRecommendation | null = null;
        if (
          typeof rawRecommendation === "object" &&
          rawRecommendation !== null &&
          !Array.isArray(rawRecommendation)
        ) {
          const candidate = rawRecommendation as Record<string, unknown>;
          if (
            typeof candidate.text === "string" &&
            typeof candidate.changeSummary === "string" &&
            typeof candidate.riskSummary === "string"
          ) {
            recommendation = {
              text: candidate.text,
              changeSummary: candidate.changeSummary,
              riskSummary: candidate.riskSummary,
            };
          }
        }
        setSnapshot((previous) => {
          const base = previous.key === runKey ? previous : current;
          return {
            ...base,
            activityEvents: [...base.activityEvents, event].slice(-32),
            recommendation: recommendation ?? base.recommendation,
            workspaceChatOutcome:
              workspaceChatOutcome ?? base.workspaceChatOutcome,
            optimizationEvidenceStatus:
              optimizationEvidenceStatus ?? base.optimizationEvidenceStatus,
            retrievalStrategy: retrievalStrategy ?? base.retrievalStrategy,
            effectiveRetrievalStrategy:
              effectiveRetrievalStrategy ?? base.effectiveRetrievalStrategy,
            retrievalReason: retrievalReason ?? base.retrievalReason,
            graphSnapshotId: graphSnapshotId ?? base.graphSnapshotId,
            retrievalEvidenceStatus:
              retrievalEvidenceStatus ?? base.retrievalEvidenceStatus,
            retrievalEvidence:
              retrievalStrategy !== null
                ? selectedRetrievalEvidence
                : base.retrievalEvidence,
            retrievalTraceIds:
              retrievalStrategy !== null
                ? retrievalTraceIds
                : base.retrievalTraceIds,
          };
        });
        const nextStatus =
          typeof payload.status === "string" ? payload.status : null;
        const answerText =
          event.eventType === "run.completed" &&
          typeof payload.text === "string"
            ? formatAssistantTextForDisplay(
                payload.text,
                userPromptRef.current,
                conversationContextPromptsRef.current,
              )
            : null;

        if (
          nextStatus &&
          (!isTerminal(initialStatus) || isTerminal(nextStatus))
        ) {
          onStatusChangeRef.current?.(nextStatus);
        }
        if (
          event.eventType === "run.completed" &&
          answerText !== null &&
          !initialAnswer
        ) {
          onCompletedRef.current?.(answerText);
        }

        setSnapshot((previous) => {
          const base = previous.key === runKey ? previous : current;
          if (event.eventType === "run.completed") {
            return {
              ...base,
              status: nextStatus ?? "succeeded",
              text: answerText ?? "",
              completed: true,
              failed: false,
            };
          }
          if (event.eventType === "run.failed") {
            return {
              ...base,
              status: nextStatus ?? "failed",
              failed: nextStatus !== "interrupted_unknown",
              errorCode:
                typeof payload.errorCode === "string"
                  ? payload.errorCode
                  : null,
            };
          }
          if (nextStatus === "failed") {
            return {
              ...base,
              status: nextStatus,
              failed: true,
              errorCode:
                typeof payload.errorCode === "string"
                  ? payload.errorCode
                  : base.errorCode,
            };
          }
          const reason =
            typeof payload.reason === "string" ? payload.reason : null;
          const errorCode =
            typeof payload.errorCode === "string" ? payload.errorCode : reason;
          return {
            ...base,
            status: nextStatus ?? base.status,
            errorCode:
              nextStatus?.startsWith("paused_") && errorCode
                ? errorCode
                : base.errorCode,
          };
        });

        if (
          event.eventType === "run.completed" ||
          event.eventType === "run.failed" ||
          (event.eventType === "run.status" &&
            nextStatus !== null &&
            isTerminal(nextStatus))
        ) {
          closeAfterTerminal();
        }
      } catch {
        setSnapshot((previous) => {
          const base = previous.key === runKey ? previous : current;
          return { ...base, connection: "reconnecting" };
        });
      }
    };

    for (const eventName of eventNames)
      source.addEventListener(eventName, onMessage as EventListener);

    return () => {
      stopped = true;
      source.close();
    };
    // The run key identifies the event stream; a keyed remount resets replay state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOnMount, projectId, runId, runKey]);

  const needsAttention =
    current.failed ||
    current.status === "interrupted_unknown" ||
    current.status.startsWith("paused_");
  const badgeVariant = current.completed
    ? "success"
    : needsAttention
      ? "warning"
      : "muted";

  const latestWorkEvent = [...current.activityEvents]
    .reverse()
    .find((event) =>
      ["agent.action", "tool.started", "tool.completed"].includes(
        event.eventType,
      ),
    );
  const latestWork =
    latestWorkEvent &&
    ["agent.action", "tool.started"].includes(latestWorkEvent.eventType)
      ? describeRunActivity(latestWorkEvent, { providerLabel })
      : null;
  const chatAnswerLabel =
    current.workspaceChatOutcome === "clarification_required"
      ? "Klarifikasi Senopati"
      : "Jawaban Codex";

  if (chatPresentation) {
    return (
      <section
        className={styles.chatAnswer}
        aria-label={chatAnswerLabel}
        data-state={
          current.failed ? "failed" : current.completed ? "complete" : "working"
        }
      >
        <div className={styles.chatAnswerHeading}>
          <strong>
            {current.workspaceChatOutcome === "clarification_required"
              ? "Senopati"
              : providerLabel}
          </strong>
          <span>
            {current.completed
              ? current.workspaceChatOutcome === "clarification_required"
                ? "Klarifikasi"
                : "Jawaban"
              : label}
          </span>
        </div>
        {current.completed && displayAnswer ? (
          current.text ? (
            <WorkspaceMessage
              content={current.text}
              className={styles.chatAnswerContent}
            />
          ) : (
            <p className="helper" role="status">
              Run selesai, tetapi belum ada teks jawaban.
            </p>
          )
        ) : current.completed ? (
          <p className="helper" role="status">
            Jawaban diterima dari {providerLabel}.
          </p>
        ) : current.status === "interrupted_unknown" ? (
          <p className="error-message" role="status">
            Koneksi terputus sebelum jawaban dapat dipastikan. Periksa aktivitas
            sebelum mencoba lagi.
          </p>
        ) : current.failed || current.status === "failed" ? (
          <div>
            <p className="error-message" role="status">
              Saya belum dapat menyelesaikan jawaban ini. Coba lagi setelah
              memeriksa koneksi provider.
            </p>
          </div>
        ) : current.status.startsWith("paused_") ? (
          <p className="helper" role="status">
            Provider memerlukan tindakan sebelum dapat menjawab. Periksa
            pengaturan koneksi.
          </p>
        ) : current.connection === "reconnecting" ? (
          <p className="helper" role="status">
            Koneksi jawaban terputus. Sedang menyambungkan kembali…
          </p>
        ) : current.connection === "closed" && terminal ? (
          <p className="helper" role="status">
            Jawaban belum tersedia. Buka aktivitas untuk memeriksa statusnya.
          </p>
        ) : current.status === "queued" ? (
          <p
            className={styles.chatAnswerPending}
            role="status"
            aria-live="polite"
          >
            Menunggu giliran…
          </p>
        ) : (
          <p
            className={styles.chatAnswerPending}
            role="status"
            aria-live="polite"
          >
            Sedang menyiapkan jawaban…
          </p>
        )}

        {current.workspaceChatOutcome === "no_change_recommended" ? (
          <p className="helper" role="status">
            Senopati menilai prompt sudah memadai; prompt asli otomatis dikirim
            ke Codex. Prompt ini belum dinilai pada contoh uji.
          </p>
        ) : null}

        {current.optimizationEvidenceStatus === "rewrite_unscored" ? (
          <p className="helper" role="status">
            Prompt ini disusun ulang oleh Senopati dan dikirim ke Codex apa
            adanya. Belum ada penilaian pada contoh uji.
          </p>
        ) : null}

        {latestWork && !terminal ? (
          <div className={styles.chatActionSummary}>
            <strong>{latestWork.title}</strong>
            <p>{latestWork.summary}</p>
          </div>
        ) : null}

        {current.recommendation ? (
          <section
            className={styles.chatRecommendation}
            aria-label="Prompt hasil susunan Senopati yang dikirim ke Codex"
          >
            <div>
              <strong>Prompt hasil susunan Senopati · dikirim ke Codex</strong>
              <p>{current.recommendation.changeSummary}</p>
              <p>Risiko: {current.recommendation.riskSummary}</p>
            </div>
            <pre>{current.recommendation.text}</pre>
          </section>
        ) : null}

        {current.retrievalEvidenceStatus &&
        current.retrievalEvidenceStatus !== "not_requested" ? (
          <section
            className={styles.chatGraphEvidence}
            aria-label={
              current.effectiveRetrievalStrategy === "graph"
                ? "Bukti GraphRAG yang disertakan ke Codex"
                : "Bukti sumber yang disertakan ke Codex"
            }
          >
            <div>
              <strong>
                {current.effectiveRetrievalStrategy === "graph"
                  ? "Bukti GraphRAG yang disertakan ke Codex"
                  : "Bukti sumber yang disertakan ke Codex"}
              </strong>
              <p>
                Diminta {current.retrievalStrategy ?? "tidak tersedia"}
                {current.effectiveRetrievalStrategy
                  ? ` · dipakai ${current.effectiveRetrievalStrategy}`
                  : " · rute aktual tidak tersedia"}
                {current.retrievalReason
                  ? ` · ${retrievalReasonLabel(current.retrievalReason)}`
                  : ""}
                {current.graphSnapshotId
                  ? ` · Snapshot ${current.graphSnapshotId}`
                  : ""}
                {current.retrievalEvidenceStatus === "evidence_included"
                  ? ` · ${current.retrievalEvidence.length} kutipan sumber digunakan`
                  : current.retrievalEvidenceStatus === "no_evidence_found"
                    ? " · tidak ada kutipan yang cocok"
                    : current.retrievalEvidenceStatus === "retrieval_not_run"
                      ? " · pencarian belum dijalankan"
                      : " · bukti tidak tersedia"}
              </p>
            </div>
            {current.retrievalTraceIds.length ? (
              <p>Trace: {current.retrievalTraceIds.join(", ")}</p>
            ) : null}
            {current.retrievalEvidence.length ? (
              <ul>
                {current.retrievalEvidence.map((evidence) => (
                  <li key={evidence.evidenceId}>
                    <div className={styles.chatGraphEvidenceSource}>
                      <strong>{evidence.documentName}</strong>
                      <span>
                        {evidence.kind === "graph" ? "GraphRAG" : "RAG"} · Izin
                        berbagi terverifikasi · Versi {evidence.documentVersion}{" "}
                        · {evidence.documentVersionId}
                      </span>
                      <span>Checksum {evidence.sourceChecksum}</span>
                      {evidence.chunkId ? (
                        <span>Chunk {evidence.chunkId}</span>
                      ) : null}
                      <span>Trace {evidence.traceId}</span>
                    </div>
                    <blockquote>{evidence.quote}</blockquote>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {current.activityEvents.length || current.errorCode ? (
          <details className={styles.chatActivity}>
            <summary>Detail kegiatan</summary>
            <div className={styles.activityContent}>
              {current.errorCode ? (
                <section className={styles.failureDetails}>
                  <h3>Detail kegagalan</h3>
                  <code>{current.errorCode}</code>
                </section>
              ) : null}
              {current.activityEvents.length ? (
                <RunActivityList
                  events={current.activityEvents}
                  context={{ providerLabel }}
                  label="Aktivitas percakapan"
                  maxEvents={8}
                />
              ) : null}
            </div>
          </details>
        ) : null}

        <div className={styles.chatAnswerActions}>
          <Link
            className="workspace-result-link"
            href={`/runs?run=${encodeURIComponent(runId)}`}
          >
            Lihat aktivitas lengkap
          </Link>
          {needsAttention && current.status.startsWith("paused_") ? (
            <Link className="workspace-result-link" href="/settings">
              Periksa koneksi
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <Card className="workspace-run-result">
      <CardHeader className="card-heading-row">
        <div>
          <div
            ref={headingRef}
            role="group"
            aria-label={`Jawaban ${providerLabel}`}
            tabIndex={-1}
          >
            <CardTitle>Jawaban {providerLabel}</CardTitle>
          </div>
          <CardDescription>
            Status dan hasil berasal dari run yang tersimpan.
          </CardDescription>
        </div>
        <Badge variant={badgeVariant}>{label}</Badge>
      </CardHeader>
      <CardContent>
        {current.completed && displayAnswer ? (
          current.text ? (
            <div
              role="region"
              className="workspace-run-answer"
              aria-label="Jawaban hasil prompt"
              aria-live="polite"
            >
              {current.text}
            </div>
          ) : (
            <p className="helper" role="status">
              Run selesai, tetapi tidak ada teks jawaban yang diterima.
            </p>
          )
        ) : current.completed ? (
          <p className="helper" role="status">
            Jawaban diterima dari {providerLabel}.
          </p>
        ) : current.status === "interrupted_unknown" ? (
          <p className="error-message" role="status">
            Run terhenti sebelum hasil remote dapat dipastikan. Periksa detail
            run sebelum mencoba lagi.
          </p>
        ) : current.failed || current.status === "failed" ? (
          <div>
            <p className="error-message" role="status">
              Run gagal. Periksa status di detail run sebelum mencoba lagi.
            </p>
          </div>
        ) : current.status.startsWith("paused_") ? (
          <p className="helper" role="status">
            {providerLabel} memerlukan tindakan sebelum run dapat berjalan.
            Periksa koneksi provider atau detail run.
          </p>
        ) : current.connection === "reconnecting" ? (
          <p className="helper" role="status">
            Koneksi hasil terputus. Sedang mencoba memuat jawaban kembali…
          </p>
        ) : current.connection === "closed" && terminal ? (
          <p className="helper" role="status">
            Run selesai, tetapi jawabannya tidak tersedia. Buka detail run untuk
            memeriksa statusnya.
          </p>
        ) : current.status === "queued" ? (
          <p className="helper" role="status" aria-live="polite">
            Run dibuat. Menunggu Codex mulai menjawab…
          </p>
        ) : (
          <p className="helper" role="status" aria-live="polite">
            Codex sedang menyiapkan jawaban…
          </p>
        )}
        {current.activityEvents.length || current.errorCode ? (
          <details className={styles.activity}>
            <summary>Detail kegiatan</summary>
            <div className={styles.activityContent}>
              {current.errorCode ? (
                <section className={styles.failureDetails}>
                  <h3>Detail kegagalan</h3>
                  <code>{current.errorCode}</code>
                </section>
              ) : null}
              {current.activityEvents.length ? (
                <RunActivityList
                  events={current.activityEvents}
                  context={{ providerLabel }}
                  label="Urutan aktivitas terbaru"
                  maxEvents={5}
                />
              ) : null}
            </div>
          </details>
        ) : null}
        <div className="workspace-run-result-actions">
          {current.status.startsWith("paused_") ? (
            <Link className="knowledge-link" href="/settings">
              Buka Pengaturan
            </Link>
          ) : null}
          <Link
            className="workspace-result-link"
            href={`/runs?run=${encodeURIComponent(runId)}`}
          >
            Buka detail run
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
