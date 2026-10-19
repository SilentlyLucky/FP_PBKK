"use client";

import { useEffect, useState } from "react";

import { useProjectScope } from "@/components/project-scope";
import { RunActivityList } from "@/components/run-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { RunActivityEvent } from "@/lib/run-activity";

interface RunRow {
  id: string;
  purpose: string;
  provider: string;
  requestedModel: string;
  responseModel: string | null;
  status: string;
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: string;
}

interface TimelineEvent extends RunActivityEvent {
  id: string;
  sequence: number;
  timestamp: string;
  eventType: string;
  payload: Record<string, unknown>;
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.timestamp === "string" &&
    typeof event.eventType === "string" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
  );
}

function runPurposeLabel(purpose: string): string {
  if (purpose === "target") return "Model target";
  if (purpose === "optimizer") return "Optimasi";
  if (purpose === "evaluator") return "Evaluasi";
  if (purpose === "auxiliary") return "Layanan pendukung";
  return purpose;
}

function runProviderLabel(provider: string): string {
  if (provider === "codex_app_server") return "Codex app-server";
  if (provider === "campus_gateway") return "Gateway kampus";
  if (provider === "claude_cli") return "Claude CLI";
  return provider;
}

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "Dibuat",
    queued: "Dalam antrean",
    running: "Berjalan",
    succeeded: "Eksekusi selesai",
    failed: "Gagal",
    canceled: "Dibatalkan",
    cancel_requested: "Pembatalan diminta",
    interrupted_unknown: "Status belum diketahui",
    paused_quota: "Dijeda · kuota",
    paused_auth_required: "Dijeda · autentikasi",
    paused_awaiting_user: "Menunggu jawaban",
    paused_action_required: "Butuh tindakan",
  };
  return labels[status] ?? status;
}

function runStatusVariant(
  status: string,
): "success" | "warning" | "danger" | "muted" {
  if (status === "succeeded") return "success";
  if (
    status.startsWith("paused_") ||
    ["queued", "running", "cancel_requested"].includes(status)
  )
    return "warning";
  if (["failed", "interrupted_unknown"].includes(status)) return "danger";
  return "muted";
}

function formatRunTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Waktu tidak tersedia"
    : new Intl.DateTimeFormat("id-ID", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
}

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
  "experiment.created",
  "experiment.decision",
  "run.completed",
  "run.failed",
];

type RunsPanelMode = "runs" | "monitoring";

export function RunsPanel({ mode = "runs" }: { mode?: RunsPanelMode }) {
  const { activeProjectId } = useProjectScope();
  return (
    <RunsPanelContent
      key={`${activeProjectId ?? "unselected"}:${mode}`}
      activeProjectId={activeProjectId}
      mode={mode}
    />
  );
}

function RunsPanelContent({
  activeProjectId,
  mode,
}: {
  activeProjectId: string | null;
  mode: RunsPanelMode;
}) {
  const [runSnapshot, setRunSnapshot] = useState<{
    projectId: string;
    runs: RunRow[];
    error: string | null;
  }>({ projectId: "", runs: [], error: null });
  const [selection, setSelection] = useState<{
    projectId: string;
    runId: string | null;
    revision: number;
  } | null>(null);
  const requestedRunId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("run");
  const runs =
    runSnapshot.projectId === activeProjectId ? runSnapshot.runs : [];
  const manualSelection =
    selection?.projectId === activeProjectId ? selection : null;
  const requestedRunIsAvailable = Boolean(
    activeProjectId &&
    runSnapshot.projectId === activeProjectId &&
    requestedRunId &&
    runs.some((run) => run.id === requestedRunId),
  );
  const selected = manualSelection
    ? manualSelection.runId
    : requestedRunIsAvailable
      ? requestedRunId
      : null;
  const eventKey =
    activeProjectId && selected
      ? `${activeProjectId}:${selected}:${manualSelection?.revision ?? 0}`
      : null;
  const [eventSnapshot, setEventSnapshot] = useState<{
    key: string;
    events: TimelineEvent[];
  }>({ key: "", events: [] });
  const [connectionSnapshot, setConnectionSnapshot] = useState<{
    key: string;
    state: string;
  }>({ key: "", state: "idle" });
  const [streamError, setStreamError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const selectedRun = runs.find((run) => run.id === selected) ?? null;
  const visibleRuns =
    mode === "monitoring"
      ? runs.filter((run) => {
          const normalizedSearch = search.trim().toLocaleLowerCase("id-ID");
          const matchesSearch =
            !normalizedSearch ||
            [
              run.id,
              run.purpose,
              run.provider,
              run.responseModel,
              run.requestedModel,
            ].some((value) =>
              value?.toLocaleLowerCase("id-ID").includes(normalizedSearch),
            );
          const matchesStatus =
            statusFilter === "all" ||
            (statusFilter === "active" &&
              ["queued", "running", "cancel_requested"].includes(run.status)) ||
            (statusFilter === "action" &&
              [
                "paused_auth_required",
                "paused_action_required",
                "paused_awaiting_user",
              ].includes(run.status)) ||
            (statusFilter === "quota" && run.status === "paused_quota") ||
            (statusFilter === "succeeded" && run.status === "succeeded") ||
            (statusFilter === "failed" &&
              ["failed", "interrupted_unknown"].includes(run.status)) ||
            (statusFilter === "canceled" && run.status === "canceled");
          return matchesSearch && matchesStatus;
        })
      : runs;
  const events = eventSnapshot.key === eventKey ? eventSnapshot.events : [];
  const connection = !eventKey
    ? "idle"
    : connectionSnapshot.key === eventKey
      ? connectionSnapshot.state
      : "connecting";
  const error =
    (runSnapshot.projectId === activeProjectId ? runSnapshot.error : null) ??
    (streamError?.key === eventKey ? streamError.message : null);
  const completedEvent =
    events.find((event) => event.eventType === "run.completed") ?? null;
  const optimizationCompleted =
    completedEvent?.payload.mode === "prompt_optimization";
  const completedText =
    !optimizationCompleted && typeof completedEvent?.payload.text === "string"
      ? completedEvent.payload.text
      : null;
  const canceled =
    selectedRun?.status === "canceled" ||
    events.some(
      (event) =>
        (event.eventType === "run.status" ||
          event.eventType === "run.failed") &&
        event.payload.status === "canceled",
    );
  const interruptedUnknown =
    selectedRun?.status === "interrupted_unknown" ||
    events.some(
      (event) =>
        event.eventType === "run.failed" &&
        event.payload.status === "interrupted_unknown",
    );
  const failedEvent = events.some((event) => event.eventType === "run.failed");
  const runFailed =
    !canceled &&
    !interruptedUnknown &&
    (failedEvent || selectedRun?.status === "failed");

  useEffect(() => {
    let current = true;
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    let fetching = false;
    const loadRuns = () => {
      if (fetching) return;
      fetching = true;
      fetch(`/api/projects/${projectId}/runs`, { cache: "no-store" })
        .then(async (response) => {
          const result = (await response.json()) as {
            runs?: RunRow[];
            error?: string;
          };
          if (!response.ok)
            throw new Error(result.error ?? "Run tidak dapat dimuat.");
          if (current)
            setRunSnapshot({
              projectId,
              runs: result.runs ?? [],
              error: null,
            });
        })
        .catch((cause) => {
          if (current)
            setRunSnapshot({
              projectId,
              runs: [],
              error:
                cause instanceof Error
                  ? cause.message
                  : "Run tidak dapat dimuat.",
            });
        })
        .finally(() => {
          fetching = false;
        });
    };
    loadRuns();
    const interval =
      mode === "monitoring" ? window.setInterval(loadRuns, 5_000) : null;
    return () => {
      current = false;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [activeProjectId, mode]);

  useEffect(() => {
    if (!activeProjectId || !selected || !eventKey) return;
    const streamKey = eventKey;
    const source = new EventSource(
      `/api/projects/${activeProjectId}/runs/${selected}/events`,
    );
    source.onopen = () =>
      setConnectionSnapshot({ key: streamKey, state: "connected" });
    source.onerror = () =>
      setConnectionSnapshot({
        key: streamKey,
        state:
          source.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
      });
    const append = (event: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (!isTimelineEvent(value)) throw new Error("Invalid event payload");
        const parsed = value;
        setEventSnapshot((current) => {
          const currentEvents = current.key === streamKey ? current.events : [];
          if (
            currentEvents.some(
              (existing) =>
                existing.sequence === parsed.sequence ||
                existing.id === parsed.id,
            )
          )
            return current;
          return {
            key: streamKey,
            events: [...currentEvents, parsed].sort(
              (a, b) => a.sequence - b.sequence,
            ),
          };
        });
        if (
          parsed.eventType === "run.completed" ||
          parsed.eventType === "run.failed"
        ) {
          source.close();
          setConnectionSnapshot({ key: streamKey, state: "closed" });
        }
      } catch {
        setStreamError({
          key: streamKey,
          message: "Event stream mengirim payload yang tidak dapat dibaca.",
        });
      }
    };
    source.addEventListener(
      "run.stream.ended",
      () => {
        source.close();
        setConnectionSnapshot({ key: streamKey, state: "closed" });
      },
      { once: true },
    );
    for (const name of eventNames)
      source.addEventListener(name, append as EventListener);
    return () => source.close();
  }, [activeProjectId, eventKey, selected]);

  return (
    <div className="runs-layout">
      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "monitoring" ? "Run terbaru" : "Run proyek"}
          </CardTitle>
          <CardDescription>
            {mode === "monitoring"
              ? "Cuplikan maksimal 100 run terbaru. Status diperbarui berkala; event mengikuti run yang dipilih."
              : "Riwayat tersaring pada proyek yang dipilih. API menampilkan maksimal 100 run terbaru."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
          {mode === "monitoring" ? (
            <div
              className="monitoring-run-filters"
              role="search"
              aria-label="Filter daftar run"
            >
              <label>
                <span className="helper">Cari run</span>
                <input
                  className="input"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="ID, provider, model, atau tujuan"
                />
              </label>
              <label>
                <span className="helper">Status</span>
                <select
                  className="input"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option value="all">Semua status</option>
                  <option value="active">Aktif / pembatalan diminta</option>
                  <option value="action">Butuh tindakan</option>
                  <option value="quota">Dijeda karena kuota</option>
                  <option value="succeeded">Selesai</option>
                  <option value="failed">Gagal / tidak diketahui</option>
                  <option value="canceled">Dibatalkan</option>
                </select>
              </label>
            </div>
          ) : null}
          {!activeProjectId ? (
            <div className="empty-state" role="status">
              <div>
                <p>Belum ada proyek aktif.</p>
                <p className="helper">Pilih proyek untuk melihat run.</p>
              </div>
            </div>
          ) : runSnapshot.projectId !== activeProjectId ? (
            <div className="compact-empty" role="status">
              Memuat daftar run…
            </div>
          ) : runSnapshot.error ? (
            <div className="empty-state" role="status">
              <div>
                <p>Daftar run tidak dapat dimuat.</p>
                <p className="helper">
                  Periksa koneksi backend atau muat ulang halaman.
                </p>
              </div>
            </div>
          ) : runs.length === 0 ? (
            <div className="empty-state">
              <div>
                <p>Belum ada run tersimpan.</p>
                <p className="helper">
                  Run baru akan dibuat hanya lewat aksi pengguna dan provider
                  terverifikasi.
                </p>
              </div>
            </div>
          ) : visibleRuns.length === 0 ? (
            <div className="empty-state">
              <div>
                <p>Tidak ada run yang cocok dengan filter.</p>
                <p className="helper">
                  Ubah kata kunci atau pilih status lain.
                </p>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">
                  {mode === "monitoring"
                    ? "Run terbaru yang dapat dipantau"
                    : "Riwayat model run"}
                </caption>
                <thead>
                  <tr>
                    {mode === "monitoring" ? <th>Waktu</th> : null}
                    <th>Run</th>
                    <th>Tujuan / provider</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRuns.map((run) => (
                    <tr key={run.id}>
                      {mode === "monitoring" ? (
                        <td>
                          <time dateTime={run.createdAt}>
                            {formatRunTime(run.createdAt)}
                          </time>
                        </td>
                      ) : null}
                      <td className="mono">{run.id.slice(0, 8)}</td>
                      <td>
                        {mode === "monitoring"
                          ? runPurposeLabel(run.purpose)
                          : run.purpose}
                        <br />
                        <span className="helper">
                          {mode === "monitoring"
                            ? runProviderLabel(run.provider)
                            : run.provider}
                        </span>
                      </td>
                      <td>{run.responseModel ?? run.requestedModel}</td>
                      <td>
                        <Badge
                          variant={
                            mode === "monitoring"
                              ? runStatusVariant(run.status)
                              : run.status === "succeeded"
                                ? "success"
                                : run.status.startsWith("paused")
                                  ? "warning"
                                  : "muted"
                          }
                        >
                          {mode === "monitoring"
                            ? runStatusLabel(run.status)
                            : run.status}
                        </Badge>
                        {mode === "monitoring" && run.errorCode ? (
                          <p className="helper">Kode: {run.errorCode}</p>
                        ) : mode === "runs" && run.errorSummary ? (
                          <p className="helper">{run.errorSummary}</p>
                        ) : null}
                      </td>
                      <td>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-pressed={selected === run.id}
                          onClick={() =>
                            setSelection((current) => {
                              const currentProjectSelection =
                                current?.projectId === activeProjectId
                                  ? current
                                  : null;
                              const isSelected = currentProjectSelection
                                ? currentProjectSelection.runId === run.id
                                : selected === run.id;
                              return {
                                projectId: activeProjectId ?? "",
                                runId: isSelected ? null : run.id,
                                revision:
                                  (currentProjectSelection?.revision ?? 0) + 1,
                              };
                            })
                          }
                        >
                          {selected === run.id ? "Tutup event" : "Lihat event"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {mode === "runs" ? (
        <Card>
          <CardHeader className="card-heading-row">
            <div>
              <CardTitle>
                {optimizationCompleted ? "Hasil optimasi" : "Hasil Run"}
              </CardTitle>
              <CardDescription>
                {optimizationCompleted
                  ? "Evaluasi prompt selesai. Kandidat tidak ditampilkan sebagai jawaban provider."
                  : "Jawaban dan status Run yang dipilih muncul di sini."}
              </CardDescription>
            </div>
            <Badge
              variant={
                runFailed
                  ? "warning"
                  : interruptedUnknown
                    ? "warning"
                    : canceled
                      ? "muted"
                      : completedText !== null || optimizationCompleted
                        ? "success"
                        : "muted"
              }
            >
              {!selected
                ? "Belum dipilih"
                : canceled
                  ? "Dibatalkan"
                  : interruptedUnknown
                    ? "Terhenti"
                    : runFailed
                      ? "Gagal"
                      : optimizationCompleted
                        ? "Evaluasi selesai"
                        : completedText !== null
                          ? "Selesai"
                          : "Menunggu"}
            </Badge>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <div className="compact-empty">
                Pilih Run untuk melihat jawabannya.
              </div>
            ) : canceled ? (
              <p className="helper" role="status">
                Run dibatalkan. Periksa linimasa untuk kepastian hasil provider.
              </p>
            ) : interruptedUnknown ? (
              <p className="error-message" role="status">
                Run terhenti sebelum hasil provider dapat dipastikan.
              </p>
            ) : runFailed ? (
              <p className="error-message" role="status">
                Run gagal. Periksa linimasa untuk detail.
              </p>
            ) : optimizationCompleted ? (
              <p className="helper" role="status">
                Kandidat prompt tidak disajikan sebagai jawaban provider.
              </p>
            ) : completedText !== null ? (
              completedText.length > 0 ? (
                <pre className="original-preview" aria-label="Output Run">
                  {completedText}
                </pre>
              ) : (
                <p className="helper" role="status">
                  Run selesai tanpa jawaban.
                </p>
              )
            ) : completedEvent ? (
              <p className="helper" role="status">
                Run selesai, tetapi tidak ada jawaban yang dapat ditampilkan.
              </p>
            ) : selectedRun?.status === "succeeded" ? (
              <p className="helper" role="status">
                {connection === "closed"
                  ? "Run selesai, tetapi jawabannya tidak tersedia."
                  : "Run selesai. Memuat jawaban…"}
              </p>
            ) : connection === "closed" ? (
              <p className="helper" role="status">
                Koneksi berakhir sebelum jawaban diterima.
              </p>
            ) : connection === "reconnecting" ? (
              <p className="helper" role="status">
                Menghubungkan kembali untuk memuat jawaban…
              </p>
            ) : (
              <p className="helper" role="status">
                {selectedRun?.status === "queued"
                  ? "Run sedang menunggu untuk dimulai…"
                  : selectedRun?.status === "running"
                    ? "Run sedang berjalan…"
                    : selectedRun?.status.startsWith("paused_")
                      ? "Run menunggu tindakan yang diperlukan."
                      : "Memuat Run dan menunggu jawaban…"}
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="card-heading-row">
          <div>
            <CardTitle>
              {mode === "monitoring" ? "Aktivitas run" : "Event timeline"}
            </CardTitle>
            <CardDescription>
              {mode === "monitoring"
                ? "Event tersimpan ditampilkan menurut urutan sequence. Data reconnect tidak digandakan."
                : "Sequence disimpan backend; reconnect melanjutkan dari event ID."}
            </CardDescription>
          </div>
          <Badge variant={connection === "connected" ? "success" : "muted"}>
            {mode === "monitoring"
              ? connection === "connected"
                ? "Terhubung"
                : connection === "reconnecting"
                  ? "Menghubungkan kembali"
                  : connection === "closed"
                    ? "Koneksi berakhir"
                    : connection === "connecting"
                      ? "Menghubungkan…"
                      : "Tidak aktif"
              : connection}
          </Badge>
        </CardHeader>
        <CardContent>
          {!selected ? (
            <div className="compact-empty">
              Pilih run untuk mengikuti event.
            </div>
          ) : events.length === 0 ? (
            <div className="compact-empty">Menunggu event tersimpan…</div>
          ) : (
            <RunActivityList
              events={events}
              {...(selectedRun
                ? {
                    context: {
                      provider: selectedRun.provider,
                      model:
                        selectedRun.responseModel ?? selectedRun.requestedModel,
                      purpose: selectedRun.purpose,
                    },
                  }
                : {})}
              label="Urutan aktivitas run"
            />
          )}
          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
