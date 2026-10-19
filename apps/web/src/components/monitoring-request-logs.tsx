"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  createMonitoringRequestCsv,
  monitoringRequestScopeKey,
} from "@/lib/monitoring-client";
import styles from "./monitoring-request-logs.module.css";

interface RequestMetric {
  status: "reported" | "estimated" | "unknown";
  value: number | null;
}

interface MonitoringRequest {
  attemptId: string;
  runId: string;
  attemptNumber: number;
  provider: string;
  purpose: string;
  requestedModel: string;
  responseModel: string | null;
  status: string;
  remoteOutcomeKnown: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  errorCode: string | null;
  usage: {
    inputTokens: RequestMetric;
    outputTokens: RequestMetric;
    cacheReadTokens: RequestMetric;
    cacheWriteTokens: RequestMetric;
    completeness: "complete" | "partial" | "unknown" | null;
  } | null;
}

interface RequestResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  requests: MonitoringRequest[];
}

interface RequestSnapshot {
  requestKey: string;
  data: RequestResponse | null;
  error: string | null;
}

const emptySnapshot: RequestSnapshot = {
  requestKey: "",
  data: null,
  error: null,
};

const statusLabels: Record<string, string> = {
  created: "Dibuat",
  running: "Berjalan",
  succeeded: "Berhasil",
  failed: "Gagal",
  canceled: "Dibatalkan",
  unknown: "Tidak diketahui",
};

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    campus_gateway: "Gateway kampus",
    codex_app_server: "Codex app-server",
    claude_cli: "Claude CLI",
    fixture: "Fixture",
  };
  return labels[provider] ?? provider;
}

function purposeLabel(purpose: string): string {
  const labels: Record<string, string> = {
    optimizer: "Optimizer",
    target: "Target",
    evaluator: "Evaluator",
    auxiliary: "Layanan pendukung",
    graph_indexing: "Indeks Graph",
    graph_query_model: "Model query Graph",
  };
  return labels[purpose] ?? purpose;
}

function statusVariant(
  status: string,
): "success" | "warning" | "danger" | "muted" {
  if (status === "succeeded") return "success";
  if (status === "running" || status === "created") return "warning";
  if (status === "failed") return "danger";
  return "muted";
}

function formatTime(value: string | null): string {
  if (!value) return "Tidak tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Tidak tersedia";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0)
    return "Tidak tersedia";
  return value < 1_000
    ? `${Math.round(value)} md`
    : `${(value / 1_000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} dtk`;
}

function formatMilliseconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Tidak tersedia";
  return `${Math.round(value).toLocaleString("id-ID")} md`;
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Tidak tersedia";
  return `${value.toLocaleString("id-ID", { maximumFractionDigits: 2 })} token/dtk`;
}

function formatMetric(metric: RequestMetric | undefined): string {
  if (!metric || metric.status === "unknown" || metric.value === null)
    return "Tidak tersedia";
  const provenance = metric.status === "reported" ? "dilaporkan" : "estimasi";
  return `${metric.value.toLocaleString("id-ID")} (${provenance})`;
}

function exportRequestPage(
  requests: MonitoringRequest[],
  range: string,
  page: number,
): void {
  const csv = createMonitoringRequestCsv(requests);
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `promptlab-monitoring-${range}-halaman-${page}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function MonitoringRequestLogs({
  projectId,
  range,
  refreshSignal,
}: {
  projectId: string | null;
  range: string;
  refreshSignal: number;
}) {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [provider, setProvider] = useState("all");
  const [purpose, setPurpose] = useState("all");
  const [page, setPage] = useState(1);
  const requestKey = monitoringRequestScopeKey({
    projectId,
    range,
    page,
    search: debouncedSearch,
    status,
    provider,
    purpose,
  });
  const current = snapshot.requestKey === requestKey ? snapshot : emptySnapshot;
  const requestData = current.data;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const controller = new AbortController();
    const params = new URLSearchParams({
      range,
      page: String(page),
      pageSize: "20",
      status,
      provider,
      purpose,
    });
    if (debouncedSearch) params.set("search", debouncedSearch);

    void fetch(
      `/api/projects/${projectId}/monitoring/requests?${params.toString()}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as
          RequestResponse | { error?: string };
        if (!response.ok)
          throw new Error(
            "error" in result
              ? (result.error ?? "Log permintaan tidak tersedia.")
              : "Log permintaan tidak tersedia.",
          );
        if (active)
          setSnapshot({
            requestKey,
            data: result as RequestResponse,
            error: null,
          });
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setSnapshot((previous) => ({
          requestKey,
          data: previous.requestKey === requestKey ? previous.data : null,
          error:
            cause instanceof Error
              ? cause.message
              : "Log permintaan tidak tersedia.",
        }));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    projectId,
    range,
    page,
    debouncedSearch,
    status,
    provider,
    purpose,
    refreshSignal,
    requestKey,
  ]);

  return (
    <section className={styles.panel} aria-labelledby="request-logs-title">
      <header className={styles.header}>
        <div>
          <h2 id="request-logs-title">Log permintaan model</h2>
          <p>
            Satu baris per attempt provider; isi prompt dan output mentah tidak
            disertakan.
          </p>
        </div>
        <div className={styles.headerActions}>
          {requestData?.requests.length ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                exportRequestPage(requestData.requests, range, page)
              }
            >
              <Download size={14} aria-hidden="true" />
              Ekspor halaman ini
            </Button>
          ) : null}
          {requestData ? (
            <Badge variant="muted">
              {requestData.total.toLocaleString("id-ID")} permintaan
            </Badge>
          ) : null}
        </div>
      </header>

      <div
        className={styles.filters}
        role="search"
        aria-label="Filter log permintaan"
      >
        <label>
          <span>Cari ID, model, atau provider</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={120}
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">Semua status</option>
            <option value="created">Dibuat</option>
            <option value="running">Berjalan</option>
            <option value="succeeded">Berhasil</option>
            <option value="failed">Gagal</option>
            <option value="canceled">Dibatalkan</option>
            <option value="unknown">Tidak diketahui</option>
          </select>
        </label>
        <label>
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">Semua provider</option>
            <option value="campus_gateway">Gateway kampus</option>
            <option value="codex_app_server">Codex app-server</option>
            <option value="claude_cli">Claude CLI</option>
            <option value="fixture">Fixture</option>
          </select>
        </label>
        <label>
          <span>Tujuan</span>
          <select
            value={purpose}
            onChange={(event) => {
              setPurpose(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">Semua tujuan</option>
            <option value="optimizer">Optimizer</option>
            <option value="target">Target</option>
            <option value="evaluator">Evaluator</option>
            <option value="auxiliary">Layanan pendukung</option>
            <option value="graph_indexing">Indeks Graph</option>
            <option value="graph_query_model">Model query Graph</option>
          </select>
        </label>
      </div>

      {current.error ? (
        <p className={styles.error} role="alert">
          Log permintaan tidak tersedia. Periksa koneksi monitoring lalu muat
          ulang.
        </p>
      ) : null}
      {!projectId ? (
        <p className={styles.empty} role="status">
          Pilih proyek untuk melihat request yang tersimpan.
        </p>
      ) : !requestData ? (
        <p className={styles.empty} role="status">
          Memuat log permintaan…
        </p>
      ) : requestData.requests.length === 0 ? (
        <p className={styles.empty} role="status">
          {requestData.total === 0
            ? "Belum ada attempt provider pada rentang ini."
            : "Tidak ada request yang cocok dengan filter ini."}
        </p>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Log attempt model</caption>
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Request / run</th>
                  <th>Provider / tujuan</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Token</th>
                  <th>TTFT</th>
                  <th>Token/dtk</th>
                  <th>Durasi</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {requestData.requests.map((item) => (
                  <tr key={item.attemptId}>
                    <td data-label="Waktu">
                      <time dateTime={item.startedAt ?? undefined}>
                        {formatTime(item.startedAt)}
                      </time>
                    </td>
                    <td data-label="Request / run">
                      <span className={styles.mono}>
                        {item.attemptId.slice(0, 8)}
                      </span>
                      <small>Run {item.runId.slice(0, 8)}</small>
                    </td>
                    <td data-label="Provider / tujuan">
                      <strong>{providerLabel(item.provider)}</strong>
                      <small>{purposeLabel(item.purpose)}</small>
                    </td>
                    <td data-label="Model">
                      {item.responseModel ?? item.requestedModel}
                      {item.responseModel &&
                      item.responseModel !== item.requestedModel ? (
                        <small>Diminta: {item.requestedModel}</small>
                      ) : null}
                    </td>
                    <td data-label="Status">
                      <Badge variant={statusVariant(item.status)}>
                        {statusLabels[item.status] ?? item.status}
                      </Badge>
                      {item.errorCode ? (
                        <small>Kode: {item.errorCode}</small>
                      ) : null}
                    </td>
                    <td data-label="Token">
                      {formatMetric(item.usage?.inputTokens)} input
                      <small>
                        {formatMetric(item.usage?.outputTokens)} output
                      </small>
                    </td>
                    <td data-label="TTFT">
                      {formatMilliseconds(item.timeToFirstTokenMs)}
                    </td>
                    <td data-label="Token/dtk">
                      {formatRate(item.tokensPerSecond)}
                    </td>
                    <td data-label="Durasi">
                      {formatDuration(item.durationMs)}
                    </td>
                    <td data-label="Detail">
                      <details className={styles.details}>
                        <summary>Lihat</summary>
                        <dl>
                          <div>
                            <dt>ID request</dt>
                            <dd className={styles.mono}>{item.attemptId}</dd>
                          </div>
                          <div>
                            <dt>ID run · attempt</dt>
                            <dd className={styles.mono}>
                              {item.runId} · {item.attemptNumber}
                            </dd>
                          </div>
                          <div>
                            <dt>Outcome remote</dt>
                            <dd>
                              {item.remoteOutcomeKnown
                                ? "Diketahui"
                                : "Belum diketahui"}
                            </dd>
                          </div>
                          <div>
                            <dt>Cache read</dt>
                            <dd>{formatMetric(item.usage?.cacheReadTokens)}</dd>
                          </div>
                          <div>
                            <dt>Cache write</dt>
                            <dd>
                              {formatMetric(item.usage?.cacheWriteTokens)}
                            </dd>
                          </div>
                          <div>
                            <dt>Kelengkapan usage</dt>
                            <dd>
                              {item.usage?.completeness ?? "Tidak tersedia"}
                            </dd>
                          </div>
                          <div>
                            <dt>Mulai · selesai</dt>
                            <dd>
                              {formatTime(item.startedAt)} ·{" "}
                              {formatTime(item.finishedAt)}
                            </dd>
                          </div>
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className={styles.pagination}>
            <span>
              Halaman {requestData.page} dari{" "}
              {Math.max(requestData.totalPages, 1)}
            </span>
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() =>
                  setPage((currentPage) => Math.max(currentPage - 1, 1))
                }
              >
                Sebelumnya
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page >= requestData.totalPages}
                onClick={() => setPage((currentPage) => currentPage + 1)}
              >
                Berikutnya
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
