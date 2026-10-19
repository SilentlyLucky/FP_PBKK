"use client";

import {
  ArrowDownUp,
  Beaker,
  FileText,
  History,
  RefreshCw,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useProjectScope } from "@/components/project-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import styles from "./history-workspace.module.css";

interface RunRecord {
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

interface PromptRecord {
  id: string;
  name: string;
  currentVersionId: string | null;
  version: number | null;
  text: string | null;
  invariants: string[] | null;
}

interface PromptVersionRecord {
  id: string;
  version: number;
  parentVersionId: string | null;
  text: string;
  invariants: string[];
  createdAt: string;
}

interface ExperimentRecord {
  experimentId: string;
  runId: string;
  status: string;
  errorSummary: string | null;
  metadata: {
    datasetName: string;
    datasetVersion: string;
    caseId: string;
    promptId: string;
    promptVersionId: string;
    promptName: string;
    promptVersion: number;
    requestedModel: string;
    reasoningEffort: string | null;
    retrieval: { strategy: string; sourceIds: string[] };
  };
  createdAt: string;
  decision: "accepted" | "rejected" | "inconclusive" | null;
  decisionNote: string | null;
  decidedAt: string | null;
}

interface OptimizationVoteEvent {
  id: string;
  sequence: number;
  timestamp: string;
  eventType: "optimization.vote";
  payload: {
    candidateId: string;
    decision: "original_better" | "candidate_better" | "equal" | "inconclusive";
    note: string;
    evidenceEligible: boolean;
  };
}

interface HistorySnapshot {
  projectId: string;
  runs: RunRecord[] | null;
  prompts: PromptRecord[] | null;
  versions: Record<string, PromptVersionRecord[]>;
  versionErrors: Record<string, string>;
  experiments: ExperimentRecord[] | null;
  runsError: string | null;
  promptsError: string | null;
  experimentsError: string | null;
  refreshedAt: string | null;
}

type HistoryKind = "run" | "version" | "prompt" | "experiment";

interface HistoryItem {
  id: string;
  kind: HistoryKind;
  title: string;
  subtitle: string;
  status: string;
  model: string | null;
  createdAt: string | null;
  searchable: string;
  run?: RunRecord;
  prompt?: PromptRecord;
  version?: PromptVersionRecord;
  experiment?: ExperimentRecord;
}

const emptySnapshot: HistorySnapshot = {
  projectId: "",
  runs: null,
  prompts: null,
  versions: {},
  versionErrors: {},
  experiments: null,
  runsError: null,
  promptsError: null,
  experimentsError: null,
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

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function providerLabel(provider: string): string {
  if (provider === "codex_app_server") return "Codex app-server";
  if (provider === "campus_gateway") return "Gateway kampus";
  if (provider === "claude_cli") return "Claude CLI";
  return provider;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "Dibuat",
    queued: "Dalam antrean",
    running: "Berjalan",
    succeeded: "Eksekusi selesai",
    failed: "Gagal",
    canceled: "Dibatalkan",
    cancel_requested: "Pembatalan diminta",
    interrupted_unknown: "Terhenti · status belum diketahui",
    paused_quota: "Dijeda · kuota",
    paused_auth_required: "Dijeda · autentikasi",
    paused_awaiting_user: "Menunggu jawaban",
    paused_action_required: "Butuh tindakan",
    accepted: "Diterima",
    rejected: "Ditolak",
    inconclusive: "Belum meyakinkan",
    active: "Versi aktif",
    historical: "Versi lama",
    unavailable: "Tidak tersedia",
  };
  return labels[status] ?? status;
}

function statusVariant(
  status: string,
): "success" | "warning" | "danger" | "muted" {
  if (["succeeded", "accepted", "active"].includes(status)) return "success";
  if (
    [
      "queued",
      "running",
      "cancel_requested",
      "paused_quota",
      "paused_auth_required",
      "paused_awaiting_user",
      "paused_action_required",
      "inconclusive",
    ].includes(status)
  ) {
    return "warning";
  }
  if (["failed", "rejected", "interrupted_unknown"].includes(status))
    return "danger";
  return "muted";
}

function formatTime(value: string | null): string {
  if (!value) return "Waktu tidak dicatat";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Waktu tidak tersedia";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function buildItems(snapshot: HistorySnapshot): HistoryItem[] {
  const prompts = snapshot.prompts ?? [];
  const experiments = snapshot.experiments ?? [];
  const experimentRunIds = new Set(experiments.map((item) => item.runId));
  const items: HistoryItem[] = [];

  for (const run of snapshot.runs ?? []) {
    if (experimentRunIds.has(run.id)) continue;
    const model = run.responseModel ?? run.requestedModel;
    items.push({
      id: `run:${run.id}`,
      kind: "run",
      title:
        run.purpose === "target" ? "Run model target" : `Run ${run.purpose}`,
      subtitle: `${providerLabel(run.provider)} · ${model}`,
      status: run.status,
      model,
      createdAt: run.createdAt,
      searchable: `${run.id} ${run.purpose} ${run.provider} ${model} ${run.errorSummary ?? ""}`,
      run,
    });
  }

  for (const prompt of prompts) {
    const versions = snapshot.versions[prompt.id] ?? [];
    if (versions.length) {
      for (const version of versions) {
        const current = version.id === prompt.currentVersionId;
        items.push({
          id: `version:${version.id}`,
          kind: "version",
          title: prompt.name,
          subtitle: `Versi ${version.version}`,
          status: current ? "active" : "historical",
          model: null,
          createdAt: version.createdAt,
          searchable: `${prompt.name} ${version.version} ${version.text}`,
          prompt,
          version,
        });
      }
    } else if (prompt.currentVersionId || prompt.text) {
      items.push({
        id: `prompt:${prompt.id}`,
        kind: "prompt",
        title: prompt.name,
        subtitle:
          prompt.version === null
            ? "Versi saat ini · waktu tidak tersedia"
            : `Versi ${prompt.version} · waktu tidak tersedia`,
        status: prompt.currentVersionId ? "active" : "unavailable",
        model: null,
        createdAt: null,
        searchable: `${prompt.name} ${prompt.text ?? ""}`,
        prompt,
      });
    }
  }

  const allVersions = Object.values(snapshot.versions).flat();
  for (const experiment of experiments) {
    const prompt = prompts.find(
      (item) => item.id === experiment.metadata.promptId,
    );
    const promptVersion = allVersions.find(
      (version) => version.id === experiment.metadata.promptVersionId,
    );
    const status = experiment.decision ?? experiment.status;
    items.push({
      id: `experiment:${experiment.experimentId}`,
      kind: "experiment",
      title: experiment.metadata.promptName || "Eksperimen prompt",
      subtitle: `${experiment.metadata.datasetName} · ${experiment.metadata.caseId}`,
      status,
      model: experiment.metadata.requestedModel,
      createdAt: experiment.decidedAt ?? experiment.createdAt,
      searchable: [
        experiment.experimentId,
        experiment.metadata.promptName,
        experiment.metadata.datasetName,
        experiment.metadata.caseId,
        experiment.metadata.requestedModel,
        experiment.decisionNote ?? "",
      ].join(" "),
      ...(prompt ? { prompt } : {}),
      ...(promptVersion ? { version: promptVersion } : {}),
      experiment,
    });
  }

  return items.sort((left, right) => {
    const leftTime = left.createdAt
      ? Date.parse(left.createdAt)
      : Number.NEGATIVE_INFINITY;
    const rightTime = right.createdAt
      ? Date.parse(right.createdAt)
      : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime;
  });
}

function kindLabel(kind: HistoryKind): string {
  if (kind === "run") return "Run";
  if (kind === "version" || kind === "prompt") return "Prompt";
  return "Eksperimen";
}

function kindIcon(kind: HistoryKind) {
  if (kind === "run") return <History size={17} aria-hidden="true" />;
  if (kind === "experiment") return <Beaker size={17} aria-hidden="true" />;
  return <FileText size={17} aria-hidden="true" />;
}

function voteDecisionLabel(
  decision: OptimizationVoteEvent["payload"]["decision"],
): string {
  if (decision === "original_better") return "Prompt awal lebih baik";
  if (decision === "candidate_better") return "Kandidat lebih baik";
  if (decision === "inconclusive") return "Belum cukup bukti";
  return "Setara";
}

function RunVoteHistory({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    events: OptimizationVoteEvent[];
    status: "connecting" | "connected" | "reconnecting" | "closed";
    completionSeen: boolean;
    completedText: string | null;
  }>({
    key: "",
    events: [],
    status: "connecting",
    completionSeen: false,
    completedText: null,
  });
  const key = `${projectId}:${runId}`;
  const current =
    snapshot.key === key
      ? snapshot
      : {
          key,
          events: [],
          status: "connecting" as const,
          completionSeen: false,
          completedText: null,
        };

  useEffect(() => {
    const source = new EventSource(
      `/api/projects/${projectId}/runs/${runId}/events`,
    );
    let active = true;
    source.onopen = () => {
      if (active)
        setSnapshot((value) => ({ ...value, key, status: "connected" }));
    };
    source.onerror = () => {
      if (active)
        setSnapshot((value) => ({
          ...value,
          key,
          status:
            source.readyState === EventSource.CLOSED
              ? "closed"
              : "reconnecting",
        }));
    };
    source.addEventListener("optimization.vote", ((
      message: MessageEvent<string>,
    ) => {
      try {
        const value: unknown = JSON.parse(message.data);
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return;
        const event = value as Record<string, unknown>;
        if (
          typeof event.id !== "string" ||
          !Number.isSafeInteger(event.sequence) ||
          typeof event.timestamp !== "string" ||
          typeof event.payload !== "object" ||
          event.payload === null ||
          Array.isArray(event.payload)
        ) {
          return;
        }
        const payload = event.payload as Record<string, unknown>;
        if (
          typeof payload.candidateId !== "string" ||
          ![
            "original_better",
            "candidate_better",
            "equal",
            "inconclusive",
          ].includes(
            String(payload.decision),
          )
        ) {
          return;
        }
        const vote: OptimizationVoteEvent = {
          id: event.id,
          sequence: event.sequence as number,
          timestamp: event.timestamp,
          eventType: "optimization.vote",
          payload: {
            candidateId: payload.candidateId,
            decision:
              payload.decision as OptimizationVoteEvent["payload"]["decision"],
            note: typeof payload.note === "string" ? payload.note : "",
            evidenceEligible: payload.evidenceEligible === true,
          },
        };
        if (!active) return;
        setSnapshot((previous) => {
          const events = previous.key === key ? previous.events : [];
          if (
            events.some(
              (item) => item.id === vote.id || item.sequence === vote.sequence,
            )
          )
            return previous;
          return {
            key,
            events: [...events, vote].sort(
              (left, right) => left.sequence - right.sequence,
            ),
            status: previous.status,
            completionSeen: previous.completionSeen,
            completedText: previous.completedText,
          };
        });
      } catch {
        // Ignore malformed events while keeping the persisted stream available.
      }
    }) as EventListener);
    source.addEventListener("run.completed", ((
      message: MessageEvent<string>,
    ) => {
      try {
        const value: unknown = JSON.parse(message.data);
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          return;
        }
        const envelope = value as Record<string, unknown>;
        if (
          typeof envelope.payload !== "object" ||
          envelope.payload === null ||
          Array.isArray(envelope.payload)
        ) {
          return;
        }
        const payload = envelope.payload as Record<string, unknown>;
        if (!active) return;
        setSnapshot((previous) => ({
          ...previous,
          key,
          completionSeen: true,
          completedText: typeof payload.text === "string" ? payload.text : null,
        }));
      } catch {
        // Keep the rest of the event history if a completion payload is malformed.
      }
    }) as EventListener);
    return () => {
      active = false;
      source.close();
    };
  }, [key, projectId, runId]);

  return (
    <section
      className={styles.decisionEvents}
      aria-label="Keputusan optimasi dan hasil run tersimpan"
    >
      <div className={styles.decisionEventsHeading}>
        <h3>Keputusan optimasi</h3>
        <span>
          {current?.status === "connected"
            ? "Stream terhubung"
            : current?.status === "reconnecting"
              ? "Menghubungkan kembali"
              : current?.status === "closed"
                ? "Stream berakhir"
                : "Memuat event tersimpan…"}
        </span>
      </div>
      {current?.events.length ? (
        <ol className={styles.decisionList}>
          {current.events.map((event) => (
            <li key={event.sequence}>
              <div className={styles.decisionItemHeading}>
                <strong>{voteDecisionLabel(event.payload.decision)}</strong>
                <time dateTime={event.timestamp}>
                  {formatTime(event.timestamp)}
                </time>
              </div>
              <span className={styles.mono}>
                Kandidat {event.payload.candidateId.slice(0, 8)}
              </span>
              <span className={styles.detailNote}>
                {event.payload.evidenceEligible
                  ? "Bukti evaluasi terikat"
                  : "Keputusan lama atau bukti belum terverifikasi"}
              </span>
              {event.payload.note ? <p>{event.payload.note}</p> : null}
            </li>
          ))}
        </ol>
      ) : current?.status === "closed" ? (
        <p className={styles.detailNote}>
          Tidak ada event keputusan optimasi yang tersedia untuk run ini.
        </p>
      ) : current?.status === "reconnecting" ? (
        <p className={styles.detailNote}>
          Stream keputusan sedang mencoba tersambung kembali.
        </p>
      ) : (
        <p className={styles.detailNote}>
          Memuat keputusan tersimpan dari stream run…
        </p>
      )}
      {current?.completionSeen ? (
        <div className={styles.runOutput}>
          <h3>Hasil tersimpan</h3>
          {current.completedText === null ? (
            <p>Event run selesai, tetapi tidak menyertakan teks jawaban.</p>
          ) : current.completedText.length ? (
            <pre>{current.completedText}</pre>
          ) : (
            <p>Run selesai tanpa teks jawaban.</p>
          )}
        </div>
      ) : current?.status === "closed" ? (
        <p className={styles.detailNote}>
          Event hasil run tidak tersedia dari stream tersimpan.
        </p>
      ) : null}
    </section>
  );
}

function HistoryDetail({
  item,
  projectId,
}: {
  item: HistoryItem;
  projectId: string;
}) {
  if (item.run) {
    return (
      <>
        <div className={styles.detailTitle}>
          <div>
            <span className={styles.detailEyebrow}>Run tersimpan</span>
            <h2>{item.title}</h2>
            <p className={styles.mono}>{item.run.id}</p>
          </div>
          <Badge variant={statusVariant(item.status)}>
            {statusLabel(item.status)}
          </Badge>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Waktu</dt>
            <dd>{formatTime(item.run.createdAt)}</dd>
          </div>
          <div>
            <dt>Tujuan</dt>
            <dd>{item.run.purpose}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{providerLabel(item.run.provider)}</dd>
          </div>
          <div>
            <dt>Model diminta</dt>
            <dd className={styles.mono}>
              {item.run.requestedModel || "Tidak tercatat"}
            </dd>
          </div>
          <div>
            <dt>Model respons</dt>
            <dd className={styles.mono}>
              {item.run.responseModel ?? "Tidak dilaporkan"}
            </dd>
          </div>
          <div>
            <dt>Versi prompt</dt>
            <dd>Ringkasan run API tidak menyediakan ID versi prompt.</dd>
          </div>
          {item.run.errorCode ? (
            <div>
              <dt>Kode error</dt>
              <dd className={styles.mono}>{item.run.errorCode}</dd>
            </div>
          ) : null}
        </dl>
        {item.run.errorSummary ? (
          <p className={styles.detailNote}>{item.run.errorSummary}</p>
        ) : null}
        <RunVoteHistory projectId={projectId} runId={item.run.id} />
        <div className={styles.detailActions}>
          <Link
            className={styles.primaryLink}
            href={`/runs?run=${encodeURIComponent(item.run.id)}`}
          >
            Buka run dan event
          </Link>
        </div>
      </>
    );
  }

  if (item.experiment) {
    const experiment = item.experiment;
    return (
      <>
        <div className={styles.detailTitle}>
          <div>
            <span className={styles.detailEyebrow}>Eksperimen tersimpan</span>
            <h2>{experiment.metadata.promptName}</h2>
            <p>
              {experiment.metadata.datasetName} · {experiment.metadata.caseId}
            </p>
          </div>
          <Badge variant={statusVariant(item.status)}>
            {statusLabel(item.status)}
          </Badge>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Status run</dt>
            <dd>{statusLabel(experiment.status)}</dd>
          </div>
          <div>
            <dt>Keputusan</dt>
            <dd>
              {experiment.decision
                ? statusLabel(experiment.decision)
                : "Belum ada keputusan"}
            </dd>
          </div>
          <div>
            <dt>Waktu keputusan</dt>
            <dd>{formatTime(experiment.decidedAt)}</dd>
          </div>
          <div>
            <dt>Model / effort</dt>
            <dd>
              <span className={styles.mono}>
                {experiment.metadata.requestedModel}
              </span>
              {experiment.metadata.reasoningEffort
                ? ` · ${experiment.metadata.reasoningEffort}`
                : " · effort tidak dicatat"}
            </dd>
          </div>
          <div>
            <dt>Versi prompt diuji</dt>
            <dd>
              {experiment.metadata.promptName} · v
              {experiment.metadata.promptVersion}
              {item.version
                ? ` · ${item.version.id.slice(0, 8)}`
                : " · detail versi tidak tersedia"}
            </dd>
          </div>
          <div>
            <dt>Pengambilan konteks</dt>
            <dd>{experiment.metadata.retrieval.strategy}</dd>
          </div>
        </dl>
        {experiment.decisionNote ? (
          <div className={styles.decisionNote}>
            <strong>Catatan keputusan</strong>
            <p>{experiment.decisionNote}</p>
          </div>
        ) : experiment.decision ? (
          <p className={styles.detailNote}>
            Keputusan tersimpan tanpa catatan.
          </p>
        ) : (
          <p className={styles.detailNote}>
            Belum ada keputusan yang tersimpan untuk eksperimen ini.
          </p>
        )}
        {experiment.errorSummary ? (
          <p className={styles.errorNote}>{experiment.errorSummary}</p>
        ) : null}
        <RunVoteHistory projectId={projectId} runId={experiment.runId} />
        <div className={styles.detailActions}>
          <Link className={styles.primaryLink} href="/experiments">
            Buka pengujian
          </Link>
          <Link
            className={styles.secondaryLink}
            href={`/runs?run=${encodeURIComponent(experiment.runId)}`}
          >
            Lihat event run
          </Link>
        </div>
      </>
    );
  }

  const version = item.version;
  const prompt = item.prompt;
  const versionText = version?.text ?? prompt?.text ?? null;
  const invariants = version?.invariants ?? prompt?.invariants ?? [];
  return (
    <>
      <div className={styles.detailTitle}>
        <div>
          <span className={styles.detailEyebrow}>
            {version ? "Versi prompt tersimpan" : "Prompt tersimpan"}
          </span>
          <h2>{item.title}</h2>
          <p>
            {version
              ? `Versi ${version.version} · ${formatTime(version.createdAt)}`
              : item.subtitle}
          </p>
        </div>
        <Badge variant={statusVariant(item.status)}>
          {statusLabel(item.status)}
        </Badge>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Prompt ID</dt>
          <dd className={styles.mono}>{prompt?.id ?? "Tidak tersedia"}</dd>
        </div>
        <div>
          <dt>Versi</dt>
          <dd>{version?.version ?? prompt?.version ?? "Tidak diketahui"}</dd>
        </div>
        <div>
          <dt>Versi induk</dt>
          <dd className={styles.mono}>
            {version?.parentVersionId ?? "Tidak tercatat"}
          </dd>
        </div>
      </dl>
      <section
        className={styles.promptBlock}
        aria-labelledby="prompt-version-title"
      >
        <h3 id="prompt-version-title">Isi prompt tersimpan</h3>
        {versionText ? (
          <pre>{versionText}</pre>
        ) : (
          <p>Isi prompt tidak tersedia dari API untuk item ini.</p>
        )}
      </section>
      <section
        className={styles.invariants}
        aria-labelledby="prompt-invariants-title"
      >
        <h3 id="prompt-invariants-title">Invarian</h3>
        {invariants.length ? (
          <ul>
            {invariants.map((invariant, index) => (
              <li key={`${index}:${invariant}`}>{invariant}</li>
            ))}
          </ul>
        ) : (
          <p>Tidak ada invarian yang tercatat.</p>
        )}
      </section>
      <div className={styles.detailActions}>
        <Link className={styles.primaryLink} href="/workspace">
          Buka workspace
        </Link>
      </div>
    </>
  );
}

export function HistoryWorkspace() {
  const {
    activeProject,
    activeProjectId,
    loading: projectLoading,
  } = useProjectScope();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestKey = activeProjectId
    ? `${activeProjectId}:${refreshSignal}`
    : null;
  const loading = requestKey !== null && loadedKey !== requestKey;
  const currentSnapshot =
    snapshot.projectId === activeProjectId ? snapshot : emptySnapshot;
  const items = useMemo(() => buildItems(currentSnapshot), [currentSnapshot]);

  useEffect(() => {
    if (!activeProjectId) return;

    let active = true;
    const projectId = activeProjectId;
    const requestKey = `${projectId}:${refreshSignal}`;
    const load = async () => {
      const [runsResult, promptsResult, experimentsResult] =
        await Promise.allSettled([
          fetchPayload<{ runs?: RunRecord[] }>(
            `/api/projects/${projectId}/runs`,
            "Daftar run tidak tersedia.",
          ),
          fetchPayload<{ prompts?: PromptRecord[] }>(
            `/api/projects/${projectId}/prompts`,
            "Daftar prompt tidak tersedia.",
          ),
          fetchPayload<{ experiments?: ExperimentRecord[] }>(
            `/api/projects/${projectId}/experiments`,
            "Riwayat keputusan tidak tersedia.",
          ),
        ]);
      const prompts =
        promptsResult.status === "fulfilled"
          ? (promptsResult.value.prompts ?? [])
          : null;
      const versionResults = prompts
        ? await Promise.allSettled(
            prompts.map(async (prompt) => ({
              promptId: prompt.id,
              result: await fetchPayload<{ versions?: PromptVersionRecord[] }>(
                `/api/projects/${projectId}/prompts/${prompt.id}/versions`,
                `Versi prompt “${prompt.name}” tidak tersedia.`,
              ),
            })),
          )
        : [];
      if (!active) return;

      const versions: Record<string, PromptVersionRecord[]> = {};
      const versionErrors: Record<string, string> = {};
      versionResults.forEach((result, index) => {
        const prompt = prompts?.[index];
        if (!prompt) return;
        if (result.status === "fulfilled")
          versions[prompt.id] = result.value.result.versions ?? [];
        else
          versionErrors[prompt.id] = errorText(
            result.reason,
            `Versi prompt “${prompt.name}” tidak tersedia.`,
          );
      });

      setSnapshot({
        projectId,
        runs:
          runsResult.status === "fulfilled"
            ? (runsResult.value.runs ?? [])
            : null,
        prompts,
        versions,
        versionErrors,
        experiments:
          experimentsResult.status === "fulfilled"
            ? (experimentsResult.value.experiments ?? [])
            : null,
        runsError:
          runsResult.status === "rejected"
            ? errorText(runsResult.reason, "Daftar run tidak tersedia.")
            : null,
        promptsError:
          promptsResult.status === "rejected"
            ? errorText(promptsResult.reason, "Daftar prompt tidak tersedia.")
            : null,
        experimentsError:
          experimentsResult.status === "rejected"
            ? errorText(
                experimentsResult.reason,
                "Riwayat keputusan tidak tersedia.",
              )
            : null,
        refreshedAt: new Date().toISOString(),
      });
      setLoadedKey(requestKey);
    };

    void load().catch(() => {
      if (active) setLoadedKey(requestKey);
    });
    return () => {
      active = false;
    };
  }, [activeProjectId, refreshSignal]);

  const statusOptions = useMemo(
    () => [...new Set(items.map((item) => statusLabel(item.status)))].sort(),
    [items],
  );
  const modelOptions = useMemo(
    () =>
      [
        ...new Set(
          items
            .map((item) => item.model)
            .filter((model): model is string => Boolean(model)),
        ),
      ].sort(),
    [items],
  );
  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("id-ID");
    const days =
      dateFilter === "7" || dateFilter === "30" ? Number(dateFilter) : null;
    const snapshotTime = currentSnapshot.refreshedAt
      ? Date.parse(currentSnapshot.refreshedAt)
      : null;
    const cutoff =
      days === null || snapshotTime === null || !Number.isFinite(snapshotTime)
        ? null
        : snapshotTime - days * 24 * 60 * 60 * 1000;
    const filtered = items.filter((item) => {
      const kind = item.kind === "prompt" ? "version" : item.kind;
      const matchesKind = kindFilter === "all" || kindFilter === kind;
      const matchesStatus =
        statusFilter === "all" || statusLabel(item.status) === statusFilter;
      const matchesModel = modelFilter === "all" || item.model === modelFilter;
      const matchesQuery =
        !query ||
        `${item.title} ${item.subtitle} ${item.searchable}`
          .toLocaleLowerCase("id-ID")
          .includes(query);
      const timestamp = item.createdAt ? Date.parse(item.createdAt) : null;
      const matchesDate =
        cutoff === null || (timestamp !== null && timestamp >= cutoff);
      return (
        matchesKind &&
        matchesStatus &&
        matchesModel &&
        matchesQuery &&
        matchesDate
      );
    });
    return filtered.sort((left, right) => {
      const leftTime = left.createdAt
        ? Date.parse(left.createdAt)
        : Number.NEGATIVE_INFINITY;
      const rightTime = right.createdAt
        ? Date.parse(right.createdAt)
        : Number.NEGATIVE_INFINITY;
      return sortOrder === "newest"
        ? rightTime - leftTime
        : leftTime - rightTime;
    });
  }, [
    dateFilter,
    currentSnapshot.refreshedAt,
    items,
    kindFilter,
    modelFilter,
    search,
    sortOrder,
    statusFilter,
  ]);
  const selected =
    filteredItems.find((item) => item.id === selectedId) ??
    filteredItems[0] ??
    null;
  const versionErrorCount = Object.keys(currentSnapshot.versionErrors).length;
  const resourceErrors = [
    currentSnapshot.runsError,
    currentSnapshot.promptsError,
    currentSnapshot.experimentsError,
    versionErrorCount
      ? `${versionErrorCount} daftar versi prompt tidak dapat dimuat.`
      : null,
  ].filter((error): error is string => Boolean(error));

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <label className={styles.searchBox}>
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Cari riwayat</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari run, prompt, versi, atau eksperimen"
          />
        </label>
        <label>
          <span className="sr-only">Jenis riwayat</span>
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="all">Semua jenis</option>
            <option value="run">Run</option>
            <option value="version">Versi prompt</option>
            <option value="experiment">Eksperimen / keputusan</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Status riwayat</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">Semua status</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Periode riwayat</span>
          <select
            value={dateFilter}
            onChange={(event) => setDateFilter(event.target.value)}
          >
            <option value="all">Semua tanggal</option>
            <option value="7">7 hari terakhir</option>
            <option value="30">30 hari terakhir</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Model</span>
          <select
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
          >
            <option value="all">Semua model</option>
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.sortControl}>
          <ArrowDownUp size={14} aria-hidden="true" />
          <span className="sr-only">Urutan riwayat</span>
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          >
            <option value="newest">Terbaru dulu</option>
            <option value="oldest">Terlama dulu</option>
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!activeProjectId || loading}
          onClick={() => setRefreshSignal((current) => current + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Perbarui
        </Button>
      </div>

      {!activeProjectId ? (
        <section className={styles.emptyState} role="status">
          <History size={20} aria-hidden="true" />
          <div>
            <h2>
              {projectLoading ? "Memuat proyek…" : "Belum ada proyek aktif"}
            </h2>
            <p>
              Pilih proyek untuk membuka run, versi prompt, dan keputusan
              tersimpan.
            </p>
          </div>
        </section>
      ) : (
        <>
          {resourceErrors.length ? (
            <div className={styles.partialWarning} role="status">
              <strong>Riwayat dimuat sebagian.</strong>
              <ul>
                {resourceErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className={styles.contentGrid}>
            <section
              className={styles.listPanel}
              aria-labelledby="history-list-title"
            >
              <header className={styles.listHeader}>
                <div>
                  <h2 id="history-list-title">Aktivitas tersimpan</h2>
                  <p>{activeProject?.name ?? "Proyek aktif"}</p>
                </div>
                <span>
                  {filteredItems.length} / {items.length}
                </span>
              </header>
              {loading && items.length === 0 ? (
                <p className={styles.emptyCopy} role="status">
                  Memuat riwayat…
                </p>
              ) : filteredItems.length ? (
                <ul className={styles.historyList}>
                  {filteredItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`${styles.historyItem} ${selected?.id === item.id ? styles.selected : ""}`}
                        aria-pressed={selected?.id === item.id}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className={styles.itemIcon}>
                          {kindIcon(item.kind)}
                        </span>
                        <span className={styles.itemMain}>
                          <strong>{item.title}</strong>
                          <span>{item.subtitle}</span>
                          <span className={styles.itemMeta}>
                            <time dateTime={item.createdAt ?? undefined}>
                              {formatTime(item.createdAt)}
                            </time>
                            <span>{kindLabel(item.kind)}</span>
                          </span>
                        </span>
                        <span className={styles.itemStatus}>
                          <Badge variant={statusVariant(item.status)}>
                            {statusLabel(item.status)}
                          </Badge>
                          {item.model ? (
                            <span className={styles.modelLabel}>
                              {item.model}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : items.length ? (
                <div className={styles.emptyState}>
                  <Search size={18} aria-hidden="true" />
                  <div>
                    <h3>Tidak ada hasil</h3>
                    <p>Ubah pencarian atau filter untuk melihat item lain.</p>
                  </div>
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <History size={18} aria-hidden="true" />
                  <div>
                    <h3>
                      {resourceErrors.length
                        ? "Riwayat tidak dapat dimuat"
                        : "Belum ada riwayat tersimpan"}
                    </h3>
                    <p>
                      {resourceErrors.length
                        ? "Periksa koneksi backend lalu muat ulang. Item yang tidak berhasil diambil tidak dianggap kosong."
                        : "Run, versi prompt, dan keputusan akan muncul setelah tersimpan melalui workflow aplikasi."}
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className={styles.detailPanel} aria-label="Detail riwayat">
              {selected ? (
                <HistoryDetail item={selected} projectId={activeProjectId} />
              ) : (
                <div className={styles.emptyDetail}>
                  <FileText size={20} aria-hidden="true" />
                  <p>Pilih item untuk melihat detail tersimpan.</p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
