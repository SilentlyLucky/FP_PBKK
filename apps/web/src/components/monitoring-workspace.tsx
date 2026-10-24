"use client";

import {
  Activity,
  AlertCircle,
  Clock3,
  Database,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { MonitoringLiveActivity } from "@/components/monitoring-live-activity";
import { MonitoringRequestLogs } from "@/components/monitoring-request-logs";
import { RunsPanel } from "@/components/runs-panel";
import { useProjectScope } from "@/components/project-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import styles from "./monitoring-workspace.module.css";

type MetricTotal = {
  reported: number | null;
  estimated: number | null;
  reportedRecords: number;
  estimatedRecords: number;
};

interface Distribution {
  provider: string;
  purpose: string;
  samples: number;
  median: number | null;
  p95: number | null;
}

interface MonitoringSummary {
  requests: {
    total: number;
    succeeded: number;
    failed: number;
    canceled: number;
    unknown: number;
    inProgress: number;
    byStatus: Record<string, number>;
    errorRate: number | null;
    errorRateDenominator: number;
  };
  activeRuns: { total: number; byStatus: Record<string, number> };
  tokens: {
    input: MetricTotal;
    output: MetricTotal;
    cacheRead: MetricTotal;
    cacheWrite: MetricTotal;
    cacheReadShare: number | null;
    cacheReadShareRecords: number;
    usageRecords: number;
  };
  latency: Distribution[];
  timeToFirstToken: Distribution[];
  tokensPerSecond: Distribution[];
  agentActivity: {
    eventsInRange: number;
    lastObservedAt: string | null;
    status: "observed" | "unavailable";
  };
  worker: {
    status: "observed" | "unavailable";
    lastHeartbeatAt: string | null;
    reason: string | null;
  };
}

interface SummaryResponse {
  projectId: string;
  range: { from: string; to: string; label: string };
  refreshedAt: string;
  summary: MonitoringSummary;
}

interface ProviderRecord {
  provider: string;
  role: string;
  status: "unavailable" | "configured_unverified" | "verified" | "blocked";
  requestedModel: string | null;
  responseModel: string | null;
  checkedAt: string | null;
  reason: string | null;
  capabilities: Record<string, { status: string; reason?: string | null }>;
}

interface MonitoringSnapshot {
  projectId: string;
  range: string;
  summary: SummaryResponse | null;
  summaryError: string | null;
  providers: ProviderRecord[] | null;
  providersError: string | null;
  refreshedAt: string | null;
}

const emptySnapshot: MonitoringSnapshot = {
  projectId: "",
  range: "",
  summary: null,
  summaryError: null,
  providers: null,
  providersError: null,
  refreshedAt: null,
};

async function fetchPayload<T>(
  path: string,
  unavailableMessage: string,
): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(unavailableMessage);
  return (await response.json()) as T;
}

function asError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function formatNumber(value: number | null): string {
  return value === null || !Number.isSafeInteger(value)
    ? "Tidak tersedia"
    : value.toLocaleString("id-ID");
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Tidak tersedia";
  return `${(value * 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
}

function formatTime(value: string | null): string {
  if (!value) return "Tidak tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Tidak tersedia";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function providerName(provider: string): string {
  if (provider === "campus_gateway") return "Gateway kampus";
  if (provider === "codex_app_server") return "Codex app-server";
  if (provider === "claude_cli") return "Claude CLI";
  return provider;
}

function roleName(role: string): string {
  if (role === "optimizer") return "Optimizer";
  if (role === "target") return "Target";
  if (role === "evaluator") return "Evaluator";
  if (role === "auxiliary") return "Layanan pendukung";
  return role;
}

function providerStatus(status: ProviderRecord["status"]): {
  label: string;
  variant: "success" | "warning" | "muted";
} {
  switch (status) {
    case "verified":
      return { label: "Terverifikasi", variant: "success" };
    case "configured_unverified":
      return { label: "Perlu verifikasi", variant: "warning" };
    case "blocked":
      return { label: "Diblokir", variant: "warning" };
    default:
      return { label: "Tidak tersedia", variant: "muted" };
  }
}

function capabilityLabel(status: string): string {
  if (status === "supported") return "Teramati";
  if (status === "unsupported") return "Tidak didukung";
  return "Belum diketahui";
}

function distributionName(item: Distribution): string {
  return `${providerName(item.provider)} · ${roleName(item.purpose)}`;
}

function formatMilliseconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Tidak tersedia";
  return `${Math.round(value).toLocaleString("id-ID")} md`;
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Tidak tersedia";
  return `${value.toLocaleString("id-ID", { maximumFractionDigits: 2 })} token/dtk`;
}

function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <article className={styles.metricCard}>
      <div className={styles.metricHeading}>
        <span className={styles.metricIcon} aria-hidden="true">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <strong
        className={`${styles.metricValue}${value === "Tidak tersedia" ? " " + styles.metricUnavailable : ""}`}
      >
        {value}
      </strong>
      <span className={styles.metricDetail}>{detail}</span>
    </article>
  );
}

export function MonitoringWorkspace() {
  const {
    activeProject,
    activeProjectId,
    loading: projectLoading,
  } = useProjectScope();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [range, setRange] = useState("24h");
  const refreshTimer = useRef<number | null>(null);
  const currentSnapshot =
    snapshot.projectId === activeProjectId && snapshot.range === range
      ? snapshot
      : emptySnapshot;
  const summary = currentSnapshot.summary?.summary ?? null;

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null)
      window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      setRefreshSignal((current) => current + 1);
    }, 900);
  }, []);

  useEffect(
    () => () => {
      if (refreshTimer.current !== null)
        window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!activeProjectId) return;

    let active = true;
    let fetching = false;
    const projectId = activeProjectId;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      const summaryPath = `/api/projects/${projectId}/monitoring/summary?range=${encodeURIComponent(range)}`;
      const [summaryResult, providersResult] = await Promise.allSettled([
        fetchPayload<SummaryResponse>(
          summaryPath,
          "Ringkasan telemetry tidak tersedia.",
        ),
        fetchPayload<{ providers?: ProviderRecord[] }>(
          "/api/providers",
          "Status provider tidak tersedia.",
        ),
      ]);
      if (active) {
        setSnapshot((previous) => {
          const prior =
            previous.projectId === projectId && previous.range === range
              ? previous
              : emptySnapshot;
          return {
            projectId,
            range,
            summary:
              summaryResult.status === "fulfilled"
                ? summaryResult.value
                : prior.summary,
            summaryError:
              summaryResult.status === "rejected"
                ? asError(
                    summaryResult.reason,
                    "Ringkasan telemetry tidak tersedia.",
                  )
                : null,
            providers:
              providersResult.status === "fulfilled"
                ? (providersResult.value.providers ?? [])
                : prior.providers,
            providersError:
              providersResult.status === "rejected"
                ? asError(
                    providersResult.reason,
                    "Status provider tidak tersedia.",
                  )
                : null,
            refreshedAt:
              summaryResult.status === "fulfilled"
                ? summaryResult.value.refreshedAt
                : prior.refreshedAt,
          };
        });
      }
      fetching = false;
    };

    void load();
    return () => {
      active = false;
    };
  }, [activeProjectId, range, refreshSignal]);

  useEffect(() => {
    if (!activeProjectId) return;
    const interval = window.setInterval(
      () => setRefreshSignal((current) => current + 1),
      15_000,
    );
    return () => window.clearInterval(interval);
  }, [activeProjectId, range]);

  const inputTokens = summary?.tokens.input;
  const outputTokens = summary?.tokens.output;
  const cacheRead = summary?.tokens.cacheRead;
  const cacheWrite = summary?.tokens.cacheWrite;
  const errorRate = summary?.requests.errorRate ?? null;
  const errorDenominator = summary?.requests.errorRateDenominator ?? 0;

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <div className={styles.projectStatus}>
          <Activity size={16} aria-hidden="true" />
          <span>
            {projectLoading
              ? "Memuat proyek…"
              : activeProject
                ? `Proyek aktif · ${activeProject.name}`
                : "Pilih proyek untuk memantau aktivitas"}
          </span>
        </div>
        <div className={styles.refreshControl}>
          <label className={styles.rangeControl}>
            <span className="sr-only">Rentang waktu monitoring</span>
            <select
              value={range}
              onChange={(event) => setRange(event.target.value)}
              disabled={!activeProjectId}
            >
              <option value="1h">1 jam terakhir</option>
              <option value="24h">24 jam terakhir</option>
              <option value="7d">7 hari terakhir</option>
              <option value="30d">30 hari terakhir</option>
            </select>
          </label>
          {currentSnapshot.refreshedAt ? (
            <span className={styles.refreshTime}>
              <Clock3 size={14} aria-hidden="true" />
              Diperbarui {formatTime(currentSnapshot.refreshedAt)}
            </span>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!activeProjectId}
            onClick={() => setRefreshSignal((current) => current + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            Muat ulang
          </Button>
        </div>
      </div>

      {!activeProjectId ? (
        <section className={styles.emptyState} role="status">
          <Activity size={20} aria-hidden="true" />
          <div>
            <h2>Belum ada proyek aktif</h2>
            <p>Pilih atau buat proyek dari pemilih proyek di bagian atas.</p>
          </div>
        </section>
      ) : (
        <>
          <section
            className={styles.metricGrid}
            aria-label="Ringkasan aktivitas"
          >
            <MetricCard
              label="Permintaan model"
              value={formatNumber(summary?.requests.total ?? null)}
              detail={
                summary
                  ? `${summary.requests.succeeded} berhasil · ${summary.requests.failed} gagal · ${summary.requests.canceled} dibatalkan`
                  : "Data tidak tersedia"
              }
              icon={<Activity size={17} />}
            />
            <MetricCard
              label="Run aktif"
              value={formatNumber(summary?.activeRuns.total ?? null)}
              detail="Semua status nonterminal tersimpan"
              icon={<Clock3 size={17} />}
            />
            <MetricCard
              label="Error rate"
              value={formatPercent(errorRate)}
              detail={
                errorDenominator > 0
                  ? `${summary?.requests.failed ?? 0} gagal dari ${errorDenominator} berhasil atau gagal`
                  : "Belum ada attempt terminal yang memenuhi denominator"
              }
              icon={<AlertCircle size={17} />}
            />
            <MetricCard
              label="Token input dilaporkan"
              value={formatNumber(inputTokens?.reported ?? null)}
              detail={
                inputTokens?.estimated !== null &&
                inputTokens?.estimated !== undefined
                  ? `Estimasi terpisah: ${formatNumber(inputTokens.estimated)}`
                  : "Nilai dari provider yang tersedia"
              }
              icon={<Database size={17} />}
            />
            <MetricCard
              label="Token output dilaporkan"
              value={formatNumber(outputTokens?.reported ?? null)}
              detail={
                outputTokens?.estimated !== null &&
                outputTokens?.estimated !== undefined
                  ? `Estimasi terpisah: ${formatNumber(outputTokens.estimated)}`
                  : "Nilai dari provider yang tersedia"
              }
              icon={<Database size={17} />}
            />
          </section>

          {currentSnapshot.summaryError ? (
            <p className={styles.inlineError} role="alert">
              Ringkasan telemetry tidak tersedia. {currentSnapshot.summaryError}
            </p>
          ) : null}

          <section
            className={styles.resourceGrid}
            aria-label="Kesiapan provider dan diagnostik runtime"
          >
            <section
              className={styles.panel}
              aria-labelledby="provider-health-title"
            >
              <header className={styles.panelHeader}>
                <span className={styles.panelIcon} aria-hidden="true">
                  <ShieldCheck size={17} />
                </span>
                <div>
                  <h2 id="provider-health-title">Kesiapan provider</h2>
                  <p>
                    Status provider berasal dari bukti verifikasi yang
                    tersimpan.
                  </p>
                </div>
              </header>
              {currentSnapshot.providersError ? (
                <p className={styles.inlineError} role="alert">
                  Status provider tidak tersedia. Muat ulang untuk mencoba lagi.
                </p>
              ) : currentSnapshot.providers?.length ? (
                <ul className={styles.providerList}>
                  {currentSnapshot.providers.map((provider) => {
                    const state = providerStatus(provider.status);
                    const quota = provider.capabilities.quotaReporting;
                    return (
                      <li key={`${provider.provider}:${provider.role}`}>
                        <div className={styles.providerMain}>
                          <strong>
                            {providerName(provider.provider)}
                            <span> · {roleName(provider.role)}</span>
                          </strong>
                          <span className={styles.providerModel}>
                            {provider.requestedModel ??
                              "Model belum ditentukan"}
                          </span>
                        </div>
                        <div className={styles.providerMeta}>
                          <Badge variant={state.variant}>{state.label}</Badge>
                          <span>
                            Kuota: {capabilityLabel(quota?.status ?? "unknown")}
                          </span>
                          <span>
                            Diperiksa: {formatTime(provider.checkedAt)}
                          </span>
                        </div>
                        {provider.reason ? (
                          <p className={styles.providerReason}>
                            {provider.reason}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : currentSnapshot.providers ? (
                <p className={styles.emptyCopy}>Belum ada status provider.</p>
              ) : (
                <p className={styles.emptyCopy}>Memuat status provider…</p>
              )}
              <p className={styles.panelFootnote}>
                Halaman ini hanya membaca status. Login, inference, dan
                verifikasi provider tidak dijalankan dari Monitoring.
              </p>
            </section>

            <section className={styles.panel} aria-labelledby="runtime-title">
              <header className={styles.panelHeader}>
                <span className={styles.panelIcon} aria-hidden="true">
                  <Database size={17} />
                </span>
                <div>
                  <h2 id="runtime-title">Diagnostik bertahap</h2>
                  <p>
                    Metrik hanya muncul saat data yang diperlukan tersimpan.
                  </p>
                </div>
              </header>
              {summary ? (
                <dl className={styles.runtimeFacts}>
                  <div>
                    <dt>Aktivitas agen pada rentang ini</dt>
                    <dd>
                      {summary.agentActivity.status === "observed"
                        ? `${summary.agentActivity.eventsInRange.toLocaleString("id-ID")} event tersimpan`
                        : "Tidak tersedia"}
                    </dd>
                    <small>
                      Event terakhir:{" "}
                      {formatTime(summary.agentActivity.lastObservedAt)}
                    </small>
                  </div>
                  <div>
                    <dt>Health runtime agen</dt>
                    <dd>Tidak tersedia</dd>
                    <small>
                      Ledger mencatat aktivitas run, tetapi belum menyimpan
                      heartbeat terpisah.
                    </small>
                  </div>
                  <div>
                    <dt>Worker</dt>
                    <dd>
                      {summary.worker.status === "observed"
                        ? `Heartbeat ${formatTime(summary.worker.lastHeartbeatAt)}`
                        : "Tidak tersedia"}
                    </dd>
                    <small>
                      {summary.worker.reason ?? "Heartbeat worker teramati."}
                    </small>
                  </div>
                  <div>
                    <dt>Cache input dilaporkan</dt>
                    <dd>{formatPercent(summary.tokens.cacheReadShare)}</dd>
                    <small>
                      {summary.tokens.cacheReadShareRecords > 0
                        ? `${summary.tokens.cacheReadShareRecords} record dengan input dan cache read dilaporkan bersama`
                        : "Tidak ada pasangan metrik provider yang kompatibel"}
                    </small>
                  </div>
                </dl>
              ) : (
                <p className={styles.emptyCopy}>
                  Diagnostik runtime tidak tersedia pada rentang ini.
                </p>
              )}
              <details className={styles.diagnosticDetails}>
                <summary>Lihat coverage dan durasi</summary>
                {summary ? (
                  <div className={styles.diagnosticContent}>
                    <dl className={styles.usageFacts}>
                      <div>
                        <dt>Input estimasi</dt>
                        <dd>{formatNumber(inputTokens?.estimated ?? null)}</dd>
                      </div>
                      <div>
                        <dt>Output estimasi</dt>
                        <dd>{formatNumber(outputTokens?.estimated ?? null)}</dd>
                      </div>
                      <div>
                        <dt>Cache read dilaporkan</dt>
                        <dd>{formatNumber(cacheRead?.reported ?? null)}</dd>
                      </div>
                      <div>
                        <dt>Cache write dilaporkan</dt>
                        <dd>{formatNumber(cacheWrite?.reported ?? null)}</dd>
                      </div>
                    </dl>
                    <p className={styles.panelFootnote}>
                      {summary.tokens.usageRecords.toLocaleString("id-ID")}{" "}
                      record usage pada{" "}
                      {summary.requests.total.toLocaleString("id-ID")} attempt.
                      Nilai unavailable tidak dihitung sebagai nol.
                    </p>
                    <h3>Durasi per provider dan tujuan</h3>
                    {summary.latency.length ? (
                      <ul className={styles.distributionList}>
                        {summary.latency.map((item) => (
                          <li key={`${item.provider}:${item.purpose}`}>
                            <strong>{distributionName(item)}</strong>
                            <span>
                              Median {formatMilliseconds(item.median)} · p95{" "}
                              {formatMilliseconds(item.p95)} · {item.samples}{" "}
                              sampel
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.emptyCopy}>
                        Durasi tidak tersedia tanpa pasangan waktu mulai dan
                        selesai.
                      </p>
                    )}
                    <h3>Streaming</h3>
                    <ul className={styles.distributionList}>
                      <li>
                        <strong>TTFT</strong>
                        <span>
                          {summary.timeToFirstToken.length
                            ? summary.timeToFirstToken
                                .map(
                                  (item) =>
                                    `${distributionName(item)}: ${formatMilliseconds(item.median)} median`,
                                )
                                .join(" · ")
                            : "Tidak tersedia; event first token belum tersimpan."}
                        </span>
                      </li>
                      <li>
                        <strong>Token per detik</strong>
                        <span>
                          {summary.tokensPerSecond.length
                            ? summary.tokensPerSecond
                                .map(
                                  (item) =>
                                    `${distributionName(item)}: ${formatRate(item.median)} median`,
                                )
                                .join(" · ")
                            : "Tidak tersedia; event streaming dan output token terlapor diperlukan."}
                        </span>
                      </li>
                    </ul>
                  </div>
                ) : (
                  <p className={styles.emptyCopy}>
                    Data diagnostik tidak tersedia.
                  </p>
                )}
              </details>
            </section>
          </section>

          <MonitoringLiveActivity
            projectId={activeProjectId}
            onActivity={scheduleRefresh}
          />

          <MonitoringRequestLogs
            projectId={activeProjectId}
            range={range}
            refreshSignal={refreshSignal}
          />

          <section
            className={styles.liveSection}
            aria-labelledby="live-runs-title"
          >
            <header className={styles.liveHeading}>
              <div>
                <h2 id="live-runs-title">Run aktif dan trace per run</h2>
                <p>
                  Filter run, buka event tersimpan, dan ikuti replay per
                  sequence.
                </p>
              </div>
              <Badge variant="muted">SSE dengan replay</Badge>
            </header>
            <RunsPanel mode="monitoring" />
          </section>
        </>
      )}
    </div>
  );
}
