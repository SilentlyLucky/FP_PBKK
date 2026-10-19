"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Download, FlaskConical, RefreshCw } from "lucide-react";
import type {
  ControlledEvaluationReport,
  ControlledEvaluationRequest,
  ProviderConnectionState,
  RunRetrievalSelection,
} from "@promptlab/contracts";
import { useProjectScope } from "@/components/project-scope";
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
  parseOptimizationResult,
  type OptimizationAnswer,
  type OptimizationResult,
  type OptimizationUsage,
} from "@/lib/optimization-result";
import styles from "./experiments-workspace.module.css";
import { ControlledEvaluationResults } from "./controlled-evaluation-results";
import { ControlledEvaluationSetup } from "./controlled-evaluation-setup";
import type { ControlledEvaluationDraft } from "./controlled-evaluation-types";
import type {
  ExperimentArm,
  ExperimentDecision,
  ExperimentRecord,
  ExperimentPilotRecord,
  ExperimentPilotMetadata,
} from "@/lib/experiment-pilot";
import {
  experimentHistoryLabel,
  parseControlledEvaluationReport,
} from "@/lib/controlled-evaluation-ui";

interface PromptSummary {
  id: string;
  name: string;
  currentVersionId: string | null;
  version: number | null;
  text: string | null;
}

interface PromptVersionSummary {
  id: string;
  version: number;
  text: string;
  createdAt: string;
}

interface ProviderPayload {
  providers?: ProviderConnectionState[];
  codexModels?: Array<{
    id: string;
    displayName: string;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
  }>;
  error?: string;
  message?: string;
}

interface ExperimentListPayload {
  experiments?: ExperimentRecord[];
  error?: string;
  message?: string;
}

interface KnowledgeSourceSummary {
  id: string;
  displayName: string;
  permission: "campus_indexer_allowed" | "local_only";
  version: number | null;
  versionId: string | null;
  checksum: string | null;
  eligible: boolean;
  deleted: boolean;
}

interface KnowledgePayload {
  sources?: KnowledgeSourceSummary[];
  error?: string;
  message?: string;
}

interface GraphSourceVersion {
  documentId: string;
  documentVersionId: string;
  checksum: string;
}

interface GraphSnapshotPayload {
  activeSnapshot?: {
    id: string;
    state: string;
    current: boolean;
    sourceManifest: unknown;
  } | null;
  error?: string;
  message?: string;
}

interface ReportSnapshot {
  key: string;
  status: string;
  result: OptimizationResult | null;
  controlledReport: ControlledEvaluationReport | null;
  error: string | null;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
}

const runEventNames = ["run.status", "run.completed", "run.failed"] as const;

function selectableSourceIds(
  sources: readonly KnowledgeSourceSummary[],
  snapshot: GraphSnapshotPayload["activeSnapshot"],
  arm: ExperimentArm,
): string[] {
  const eligible = sources.filter(
    (source) =>
      source.eligible &&
      !source.deleted &&
      source.permission === "campus_indexer_allowed" &&
      source.version !== null &&
      source.versionId !== null &&
      source.checksum !== null,
  );
  if (arm !== "graphrag") return eligible.map((source) => source.id);

  const graphSources = sourceVersionEntries(snapshot?.sourceManifest);
  return eligible
    .filter((source) =>
      graphSources.some(
        (entry) =>
          entry.documentId === source.id &&
          entry.documentVersionId === source.versionId &&
          entry.checksum === source.checksum,
      ),
    )
    .map((source) => source.id);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function responseError(
  value: { error?: string; message?: string },
  fallback: string,
) {
  return value.message ?? value.error ?? fallback;
}

function sourceVersionEntries(value: unknown): GraphSourceVersion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    return source &&
      typeof source.documentId === "string" &&
      typeof source.documentVersionId === "string" &&
      typeof source.checksum === "string"
      ? [
          {
            documentId: source.documentId,
            documentVersionId: source.documentVersionId,
            checksum: source.checksum,
          },
        ]
      : [];
  });
}

const armLabels: Record<ExperimentArm, string> = {
  original: "Original · prompt tanpa sumber",
  rag: "RAG · retrieval leksikal",
  graphrag: "GraphRAG · retrieval graph",
};

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "Disiapkan",
    queued: "Menunggu",
    running: "Berjalan",
    cancel_requested: "Pembatalan diminta",
    paused_quota: "Dijeda karena batas provider",
    paused_auth_required: "Dijeda sampai koneksi siap",
    succeeded: "Selesai",
    failed: "Gagal",
    canceled: "Dibatalkan",
    interrupted_unknown: "Terhenti; hasil tidak diketahui",
  };
  return labels[status] ?? status;
}

function statusVariant(
  status: string,
): "success" | "warning" | "muted" | "danger" {
  if (status === "succeeded") return "success";
  if (["failed", "canceled", "interrupted_unknown"].includes(status))
    return "danger";
  if (
    [
      "queued",
      "running",
      "cancel_requested",
      "paused_quota",
      "paused_auth_required",
    ].includes(status)
  )
    return "warning";
  return "muted";
}

function formatMetric(metric: OptimizationUsage["total"]): string {
  if (metric.value === null) return "Tidak tersedia";
  const provenance =
    metric.status === "reported"
      ? "terlapor"
      : metric.status === "estimated"
        ? "perkiraan"
        : "status tidak diketahui";
  return `${metric.value.toLocaleString("id-ID")} token · ${provenance}`;
}

function formatDuration(value: number | null): string {
  return value === null
    ? "Tidak tersedia"
    : `${value.toLocaleString("id-ID")} ms`;
}

function verificationStatus(answer: OptimizationAnswer): string | null {
  const verification = answer.verificationEvidence;
  if (!verification) return null;
  const status = verification.status;
  return typeof status === "string" ? status : null;
}

function verificationLabel(status: string): string {
  const labels: Record<string, string> = {
    passed: "Lolos pemeriksaan",
    failed: "Tidak lolos pemeriksaan",
    unavailable: "Pemeriksaan tidak tersedia",
    invalid_fixture: "Data uji tidak valid",
  };
  return labels[status] ?? "Status pemeriksaan tidak tersedia";
}

function downloadReport(
  experiment: ExperimentPilotRecord,
  result: OptimizationResult,
) {
  const payload = {
    reportVersion: 1,
    experiment: {
      id: experiment.experimentId,
      runId: experiment.runId,
      status: experiment.status,
      createdAt: experiment.createdAt,
      dataset: {
        name: experiment.metadata.datasetName,
        version: experiment.metadata.datasetVersion,
        arm: experiment.metadata.arm,
        split: experiment.metadata.split,
      },
      evidenceEligible: experiment.evidenceEligible,
      decisionVerified: experiment.decisionVerified,
      frozen: experiment.metadata,
      decision: experiment.decision
        ? {
            value: experiment.decision,
            note: experiment.decisionNote,
            decidedAt: experiment.decidedAt,
          }
        : null,
    },
    result,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = experiment.metadata.datasetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  link.href = url;
  link.download = `pilot-${safeName || "promptlab"}-${experiment.metadata.datasetVersion}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function hashPromptText(value: string): Promise<string> {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function ExperimentsWorkspace() {
  const { activeProjectId } = useProjectScope();
  return (
    <ExperimentsWorkspaceForProject
      key={activeProjectId ?? "no-project"}
      activeProjectId={activeProjectId}
    />
  );
}

function ExperimentsWorkspaceForProject({
  activeProjectId,
}: {
  activeProjectId: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderConnectionState[]>([]);
  const [codexModels, setCodexModels] = useState<
    NonNullable<ProviderPayload["codexModels"]>
  >([]);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [knowledgeSources, setKnowledgeSources] = useState<
    KnowledgeSourceSummary[]
  >([]);
  const [activeGraphSnapshot, setActiveGraphSnapshot] =
    useState<GraphSnapshotPayload["activeSnapshot"]>(null);
  const [sourceLoadError, setSourceLoadError] = useState<string | null>(null);
  const [selectedArm, setSelectedArm] = useState<ExperimentArm>("original");
  const selectedArmRef = useRef<ExperimentArm>("original");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState("");
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptVersions, setPromptVersions] = useState<PromptVersionSummary[]>(
    [],
  );
  const [selectedPromptVersionId, setSelectedPromptVersionId] = useState("");
  const [datasetName, setDatasetName] = useState("Pilot kecil");
  const [datasetVersion, setDatasetVersion] = useState("v1");
  const [pilotInput, setPilotInput] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [setupMode, setSetupMode] = useState<"controlled" | "pilot">(
    "controlled",
  );
  const [starting, setStarting] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const [reportSnapshot, setReportSnapshot] = useState<ReportSnapshot | null>(
    null,
  );

  const selectedPrompt = prompts.find(
    (prompt) => prompt.id === selectedPromptId,
  );
  const selectedPromptVersion = promptVersions.find(
    (version) => version.id === selectedPromptVersionId,
  );
  const selectedModel = codexModels.find(
    (model) => model.id === selectedModelId,
  );
  const targetProvider = providers.find(
    (provider) =>
      provider.provider === "codex_app_server" && provider.role === "target",
  );
  const optimizerProvider = providers.find(
    (provider) =>
      provider.provider === "campus_gateway" && provider.role === "optimizer",
  );
  const selectedExperiment = activeProjectId
    ? experiments.find(
        (experiment) => experiment.experimentId === selectedExperimentId,
      )
    : undefined;
  const activeSnapshotId =
    activeGraphSnapshot?.state === "active" && activeGraphSnapshot.current
      ? activeGraphSnapshot.id
      : null;
  const graphSourceVersions = sourceVersionEntries(
    activeGraphSnapshot?.sourceManifest,
  );
  const eligibleSources = knowledgeSources.filter(
    (source) =>
      source.eligible &&
      !source.deleted &&
      source.permission === "campus_indexer_allowed" &&
      source.version !== null &&
      source.versionId !== null &&
      source.checksum !== null,
  );
  const graphEligibleSources = eligibleSources.filter((source) =>
    graphSourceVersions.some(
      (entry) =>
        entry.documentId === source.id &&
        entry.documentVersionId === source.versionId &&
        entry.checksum === source.checksum,
    ),
  );
  const selectableSources =
    selectedArm === "graphrag" ? graphEligibleSources : eligibleSources;
  const frozenSelectedSources =
    selectedArm === "original"
      ? []
      : selectableSources.filter((source) =>
          selectedSourceIds.includes(source.id),
        );
  const reportMatches = selectedExperiment
    ? reportSnapshot?.key === selectedExperiment.experimentId
      ? reportSnapshot
      : {
          key: selectedExperiment.experimentId,
          status: selectedExperiment.status,
          result: null,
          controlledReport: null,
          error: selectedExperiment.errorSummary,
          connection: "connecting" as const,
        }
    : null;

  const loadExperiments = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/projects/${projectId}/experiments`, {
      cache: "no-store",
    });
    const result = (await response.json()) as ExperimentListPayload;
    if (!response.ok)
      throw new Error(
        responseError(result, "Riwayat eksperimen tidak dapat dimuat."),
      );
    setExperiments(result.experiments ?? []);
  }, []);

  useEffect(() => {
    if (!activeProjectId) {
      const timer = window.setTimeout(() => {
        setKnowledgeSources([]);
        setActiveGraphSnapshot(null);
        setSelectedSourceIds([]);
        setSourceLoadError(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const projectId = activeProjectId;
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/projects/${projectId}/knowledge`, {
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch(`/api/projects/${projectId}/graph/snapshots`, {
        cache: "no-store",
        signal: controller.signal,
      }),
    ])
      .then(async ([knowledgeResponse, graphResponse]) => {
        const [knowledgePayload, graphPayload] = (await Promise.all([
          knowledgeResponse.json(),
          graphResponse.json(),
        ])) as [KnowledgePayload, GraphSnapshotPayload];
        if (!knowledgeResponse.ok)
          throw new Error(
            responseError(
              knowledgePayload,
              "Daftar sumber tidak dapat dimuat.",
            ),
          );
        if (!graphResponse.ok)
          throw new Error(
            responseError(
              graphPayload,
              "Status snapshot graph tidak dapat dimuat.",
            ),
          );
        const nextSources = knowledgePayload.sources ?? [];
        const nextSnapshot = graphPayload.activeSnapshot ?? null;
        setKnowledgeSources(nextSources);
        setActiveGraphSnapshot(nextSnapshot);
        const available = new Set(
          selectableSourceIds(
            nextSources,
            nextSnapshot,
            selectedArmRef.current,
          ),
        );
        setSelectedSourceIds((current) =>
          current.filter((sourceId) => available.has(sourceId)),
        );
        setSourceLoadError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSourceLoadError(
          cause instanceof Error
            ? cause.message
            : "Status sumber dan graph tidak dapat dimuat.",
        );
        setKnowledgeSources([]);
        setActiveGraphSnapshot(null);
        setSelectedSourceIds([]);
      });
    return () => controller.abort();
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) {
      const timer = window.setTimeout(() => {
        setLoading(false);
        setProviders([]);
        setCodexModels([]);
        setPrompts([]);
        setExperiments([]);
        setSelectedExperimentId("");
        setPageError(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const projectId = activeProjectId;
    const controller = new AbortController();
    const loadingTimer = window.setTimeout(() => setLoading(true), 0);

    void Promise.all([
      fetch(`/api/providers?projectId=${encodeURIComponent(projectId)}`, {
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch(`/api/projects/${projectId}/prompts`, {
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch(`/api/projects/${projectId}/experiments`, {
        cache: "no-store",
        signal: controller.signal,
      }),
    ])
      .then(async ([providerResponse, promptResponse, experimentResponse]) => {
        const [providerPayload, promptPayload, experimentPayload] =
          (await Promise.all([
            providerResponse.json(),
            promptResponse.json(),
            experimentResponse.json(),
          ])) as [
            ProviderPayload,
            {
              prompts?: PromptSummary[];
              error?: string;
              message?: string;
            },
            ExperimentListPayload,
          ];

        if (!providerResponse.ok)
          throw new Error(
            responseError(providerPayload, "Model belum dapat dimuat."),
          );
        if (!promptResponse.ok)
          throw new Error(
            responseError(promptPayload, "Prompt belum dapat dimuat."),
          );
        if (!experimentResponse.ok)
          throw new Error(
            responseError(
              experimentPayload,
              "Riwayat eksperimen belum dapat dimuat.",
            ),
          );

        setPageError(null);
        setProviders(providerPayload.providers ?? []);
        setCodexModels(providerPayload.codexModels ?? []);
        setPrompts(promptPayload.prompts ?? []);
        setExperiments(experimentPayload.experiments ?? []);
        setSelectedPromptId((current) =>
          (promptPayload.prompts ?? []).some((prompt) => prompt.id === current)
            ? current
            : (promptPayload.prompts?.[0]?.id ?? ""),
        );
        setSelectedModelId((current) =>
          (providerPayload.codexModels ?? []).some(
            (model) => model.id === current,
          )
            ? current
            : (providerPayload.codexModels?.[0]?.id ?? ""),
        );
        setSelectedExperimentId((current) =>
          (experimentPayload.experiments ?? []).some(
            (experiment) => experiment.experimentId === current,
          )
            ? current
            : (experimentPayload.experiments?.[0]?.experimentId ?? ""),
        );
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPageError(
          cause instanceof Error
            ? cause.message
            : "Data eksperimen tidak dapat dimuat.",
        );
      })
      .finally(() => {
        window.clearTimeout(loadingTimer);
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      window.clearTimeout(loadingTimer);
      controller.abort();
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId || !selectedPromptId) {
      const timer = window.setTimeout(() => {
        setPromptVersions([]);
        setSelectedPromptVersionId("");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    const prompt = prompts.find((item) => item.id === selectedPromptId);
    void fetch(
      `/api/projects/${activeProjectId}/prompts/${selectedPromptId}/versions`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          versions?: PromptVersionSummary[];
          error?: string;
          message?: string;
        };
        if (!response.ok)
          throw new Error(
            responseError(result, "Riwayat prompt tidak dapat dimuat."),
          );
        const versions = result.versions ?? [];
        setPromptVersions(versions);
        setSelectedPromptVersionId((current) =>
          versions.some((version) => version.id === current)
            ? current
            : (prompt?.currentVersionId ?? versions[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setPromptVersions([]);
      });
    return () => controller.abort();
  }, [activeProjectId, prompts, selectedPromptId]);

  useEffect(() => {
    if (!activeProjectId || !selectedExperiment) return;
    const experiment = selectedExperiment;
    const projectId = activeProjectId;
    const runId = experiment.runId;
    const key = experiment.experimentId;
    const initialSnapshot: ReportSnapshot = {
      key,
      status: experiment.status,
      result: null,
      controlledReport: null,
      error: experiment.errorSummary,
      connection: "connecting",
    };
    let active = true;
    const updateSnapshot = (
      update: (current: ReportSnapshot) => ReportSnapshot,
    ) => {
      setReportSnapshot((current) => {
        if (!active) return current;
        return update(current?.key === key ? current : initialSnapshot);
      });
    };
    const eventSource = new EventSource(
      `/api/projects/${projectId}/runs/${runId}/events`,
    );

    const handleEvent = (event: Event) => {
      const messageEvent = event as MessageEvent<string>;
      let envelope: Record<string, unknown> | null = null;
      try {
        envelope = record(JSON.parse(messageEvent.data));
      } catch {
        updateSnapshot((current) => ({
          ...current,
          connection: "reconnecting",
        }));
        return;
      }
      const payload = record(envelope?.payload) ?? {};
      const eventType = envelope?.eventType;
      if (eventType === "run.status") {
        updateSnapshot((current) => ({
          ...current,
          status:
            typeof payload.status === "string"
              ? payload.status
              : current.status,
        }));
        return;
      }
      if (eventType === "run.completed") {
        if (experiment.mode === "controlled_evaluation") {
          const controlledReport = parseControlledEvaluationReport(
            payload.controlledEvaluation,
            experiment,
          );
          updateSnapshot((current) => ({
            ...current,
            status: "succeeded",
            result: null,
            controlledReport,
            error: controlledReport
              ? null
              : "Run selesai, tetapi laporan evaluasi terkontrol tidak tersedia atau tidak cocok dengan run.",
          }));
        } else {
          const parsed = parseOptimizationResult(
            payload.result,
            experiment.metadata.baselinePrompt,
          );
          updateSnapshot((current) => ({
            ...current,
            status: "succeeded",
            result: parsed,
            controlledReport: null,
            error: parsed
              ? null
              : "Run selesai, tetapi laporan pasangan tidak tersedia pada event.",
          }));
        }
        void loadExperiments(projectId).catch(() => undefined);
        return;
      }
      if (eventType === "run.failed") {
        updateSnapshot((current) => ({
          ...current,
          status: "failed",
          error:
            (typeof payload.errorSummary === "string" &&
              payload.errorSummary) ||
            experiment.errorSummary ||
            "Run gagal. Lihat halaman Runs untuk detail status.",
        }));
      }
    };

    const listeners = new Map<string, EventListener>();
    for (const name of runEventNames) {
      const listener: EventListener = handleEvent;
      listeners.set(name, listener);
      eventSource.addEventListener(name, listener);
    }
    eventSource.onopen = () =>
      updateSnapshot((current) => ({ ...current, connection: "connected" }));
    eventSource.onerror = () =>
      updateSnapshot((current) => ({
        ...current,
        connection:
          current.status === "succeeded" || current.status === "failed"
            ? "closed"
            : "reconnecting",
      }));

    return () => {
      active = false;
      for (const [name, listener] of listeners)
        eventSource.removeEventListener(name, listener);
      eventSource.close();
    };
  }, [activeProjectId, loadExperiments, selectedExperiment]);

  const selectedModelVerified = Boolean(
    targetProvider?.status === "verified" &&
    targetProvider.requestedModel === selectedModelId,
  );
  const optimizerReady = optimizerProvider?.status === "verified";
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const selectedEffortIsValid =
    !reasoningEffort || supportedEfforts.includes(reasoningEffort);
  const reportResult = reportMatches?.result ?? null;
  const runBlocker = !activeProjectId
    ? "Pilih proyek sebelum memulai pilot."
    : !selectedPromptVersion
      ? "Pilih prompt dan versi yang sudah tersimpan."
      : !selectedModel
        ? "Muat model Codex dari Pengaturan terlebih dahulu."
        : !selectedModelVerified
          ? "Verifikasi model Codex yang dipilih di Pengaturan."
          : !optimizerReady
            ? "Verifikasi koneksi optimizer kampus di Pengaturan."
            : !selectedEffortIsValid
              ? "Kedalaman berpikir tidak didukung model yang dipilih."
              : !datasetName.trim() || !datasetVersion.trim()
                ? "Isi nama dan versi pilot."
                : !pilotInput.trim()
                  ? "Isi satu input uji untuk pilot ini."
                  : selectedArm === "graphrag" && !activeSnapshotId
                    ? "Aktifkan snapshot graph yang masih sesuai sebelum memilih GraphRAG."
                    : selectedArm !== "original" && sourceLoadError
                      ? sourceLoadError
                      : selectedArm !== "original" &&
                          selectedSourceIds.length === 0
                        ? "Pilih sedikitnya satu sumber yang eligible untuk metode ini."
                        : selectedArm !== "original" &&
                            frozenSelectedSources.length !==
                              selectedSourceIds.length
                          ? "Pilihan sumber berubah atau tidak cocok dengan snapshot aktif. Muat ulang sumber lalu pilih kembali."
                          : null;
  const canStart = !starting && !loading && runBlocker === null;

  async function startPilot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !activeProjectId ||
      !selectedPrompt ||
      !selectedPromptVersion ||
      !canStart
    )
      return;
    const projectId = activeProjectId;
    const frozenSources =
      selectedArm === "original" ? [] : frozenSelectedSources;
    const retrieval: RunRetrievalSelection = {
      strategy: selectedArm === "graphrag" ? "graph" : "lexical",
      sourceIds:
        selectedArm === "original"
          ? []
          : frozenSources.map((source) => source.id).sort(),
      snapshotId: selectedArm === "graphrag" ? activeSnapshotId : null,
    };
    const caseId = "pilot-case-1";
    setStarting(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const runResponse = await fetch(`/api/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          promptVersionId: selectedPromptVersion.id,
          provider: "codex_app_server",
          requestedModel: selectedModelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          purpose: "target",
          intent: "prompt_optimization",
          idempotencyKey: crypto.randomUUID(),
          retrieval,
          optimization: {
            maxIterations: 1,
            testCases: [{ id: caseId, input: pilotInput.trim() }],
          },
        }),
      });
      const runPayload = (await runResponse.json()) as {
        run?: { id: string; status: string };
        error?: string;
        message?: string;
      };
      if (!runResponse.ok || !runPayload.run?.id)
        throw new Error(
          responseError(runPayload, "Run pilot tidak dapat dibuat."),
        );

      const metadata: ExperimentPilotMetadata = {
        datasetName: datasetName.trim(),
        datasetVersion: datasetVersion.trim(),
        arm: selectedArm,
        split: "development",
        caseId,
        input: pilotInput.trim(),
        promptId: selectedPrompt.id,
        promptVersionId: selectedPromptVersion.id,
        promptName: selectedPrompt.name,
        promptVersion: selectedPromptVersion.version,
        baselinePrompt: selectedPromptVersion.text,
        requestedModel: selectedModelId,
        reasoningEffort: reasoningEffort || null,
        retrieval,
        activeSnapshotId: retrieval.snapshotId ?? null,
        sources: frozenSources.map((source) => ({
          id: source.id,
          title: source.displayName,
          version: source.version!,
          versionId: source.versionId!,
          checksum: source.checksum!,
        })),
      };
      const markerResponse = await fetch(
        `/api/projects/${projectId}/experiments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: runPayload.run.id, metadata }),
        },
      );
      const markerPayload = (await markerResponse.json()) as {
        experiment?: { experimentId: string };
        error?: string;
        message?: string;
      };
      if (!markerResponse.ok || !markerPayload.experiment?.experimentId)
        throw new Error(
          `Run ${runPayload.run.id} sudah dibuat, tetapi catatan pilot gagal disimpan: ${responseError(markerPayload, "coba muat ulang daftar pilot.")}`,
        );

      await loadExperiments(projectId);
      setSelectedExperimentId(markerPayload.experiment.experimentId);
      setActionMessage(
        `Pilot satu kasus dibuat. Status run: ${runStatusLabel(runPayload.run.status)}.`,
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Pilot tidak dapat dimulai.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function startControlledEvaluation(draft: ControlledEvaluationDraft) {
    if (!activeProjectId || starting) return;
    const projectId = activeProjectId;
    setStarting(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const metadata: ControlledEvaluationRequest = {
        mode: "controlled_evaluation",
        format: "promptlab-controlled-evaluation-v1",
        datasetName: draft.datasetName,
        datasetVersion: draft.datasetVersion,
        promptId: draft.promptId,
        baselinePromptVersionId: draft.baselinePrompt.id,
        baselinePromptHash: await hashPromptText(draft.baselinePrompt.text),
        candidatePromptVersionId: draft.candidatePrompt.id,
        candidatePromptHash: await hashPromptText(draft.candidatePrompt.text),
        cases: draft.cases,
        arms: draft.arms,
      };
      const runResponse = await fetch("/api/projects/" + projectId + "/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          promptVersionId: draft.baselinePrompt.id,
          provider: "codex_app_server",
          requestedModel: draft.requestedModel,
          ...(draft.reasoningEffort
            ? { reasoningEffort: draft.reasoningEffort }
            : {}),
          purpose: "target",
          intent: "controlled_evaluation",
          idempotencyKey: crypto.randomUUID(),
          retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
          controlledEvaluation: metadata,
        }),
      });
      const runPayload = (await runResponse.json()) as {
        run?: { id: string; status: string };
        error?: string;
        message?: string;
      };
      if (!runResponse.ok || !runPayload.run?.id) {
        throw new Error(
          responseError(
            runPayload,
            "Run evaluasi terkontrol tidak dapat dibuat.",
          ),
        );
      }

      const markerResponse = await fetch(
        "/api/projects/" + projectId + "/experiments",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: runPayload.run.id, metadata }),
        },
      );
      const markerPayload = (await markerResponse.json()) as {
        experiment?: { experimentId: string };
        error?: string;
        message?: string;
      };
      if (!markerResponse.ok || !markerPayload.experiment?.experimentId) {
        throw new Error(
          "Run " +
            runPayload.run.id +
            " sudah dibuat, tetapi catatan eksperimen gagal disimpan: " +
            responseError(markerPayload, "muat ulang riwayat eksperimen."),
        );
      }

      await loadExperiments(projectId);
      setSelectedExperimentId(markerPayload.experiment.experimentId);
      setActionMessage(
        "Evaluasi terkontrol dibuat. Status run: " +
          runStatusLabel(runPayload.run.status) +
          ".",
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Evaluasi terkontrol tidak dapat dimulai.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function saveDecision(
    decision: ExperimentDecision,
    note = decisionNote,
  ) {
    if (!activeProjectId || !selectedExperiment || decisionBusy) return;
    setDecisionBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/experiments/${selectedExperiment.experimentId}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, note: note.trim() }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          responseError(result, "Keputusan tidak dapat disimpan."),
        );
      await loadExperiments(activeProjectId);
      setActionMessage(
        "Keputusan tersimpan. Prompt aktif tidak berubah otomatis.",
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Keputusan pilot tidak dapat disimpan.",
      );
    } finally {
      setDecisionBusy(false);
    }
  }

  return (
    <div className={`stack experiment-workspace ${styles.experiments}`}>
      {!activeProjectId ? (
        <p className="helper" role="status">
          Pilih proyek dari bilah atas untuk membuat dan membuka evaluasi.
        </p>
      ) : null}
      {pageError ? (
        <p className="error-message" role="alert">
          {pageError}
        </p>
      ) : null}
      <Card className={styles.setupCard}>
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle>
                {setupMode === "controlled"
                  ? "Evaluasi batch terkontrol"
                  : "Pilot berpasangan"}
              </CardTitle>
              <CardDescription>
                {setupMode === "controlled"
                  ? "Bandingkan versi baseline dan kandidat yang tersimpan pada kasus development serta holdout dengan konteks yang dibekukan."
                  : "Pilot satu kasus bersifat eksploratif; bukan holdout atau klaim mutu umum. Penghematan token dan latency saja tidak membuktikan kualitas meningkat."}
              </CardDescription>
            </div>
            <Badge variant="muted">
              <FlaskConical size={13} aria-hidden="true" />
              {setupMode === "controlled"
                ? "Batch · 2–20 kasus"
                : "Pilot · 1 kasus"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div
            className={styles.setupMode}
            role="radiogroup"
            aria-label="Jenis evaluasi"
          >
            <label>
              <input
                type="radio"
                name="experiment-setup-mode"
                value="controlled"
                checked={setupMode === "controlled"}
                onChange={() => setSetupMode("controlled")}
              />
              <span>
                <strong>Batch terkontrol</strong>
                <small>Versi tersimpan, split development dan holdout</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="experiment-setup-mode"
                value="pilot"
                checked={setupMode === "pilot"}
                onChange={() => setSetupMode("pilot")}
              />
              <span>
                <strong>Pilot eksploratif</strong>
                <small>
                  Satu kasus development, tetap tersedia untuk riwayat lama
                </small>
              </span>
            </label>
          </div>
          {setupMode === "controlled" ? (
            <ControlledEvaluationSetup
              projectId={activeProjectId}
              prompts={prompts}
              models={codexModels}
              selectedModelId={selectedModelId}
              onModelChange={(value) => {
                setSelectedModelId(value);
                setReasoningEffort("");
              }}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              modelVerified={selectedModelVerified}
              sources={eligibleSources}
              graphSources={graphEligibleSources}
              graphSnapshotId={activeSnapshotId}
              sourceLoadError={sourceLoadError}
              starting={starting}
              error={actionError}
              message={actionMessage}
              onStart={(draft) => void startControlledEvaluation(draft)}
            />
          ) : (
            <form className="experiment-form" onSubmit={startPilot}>
              <div className="experiment-form-grid">
                <div className="field">
                  <label htmlFor="experiment-arm">Metode A/R/G</label>
                  <select
                    id="experiment-arm"
                    className="select"
                    value={selectedArm}
                    onChange={(event) => {
                      const nextArm = event.target.value as ExperimentArm;
                      selectedArmRef.current = nextArm;
                      setSelectedArm(nextArm);
                      const available = new Set(
                        selectableSourceIds(
                          knowledgeSources,
                          activeGraphSnapshot,
                          nextArm,
                        ),
                      );
                      setSelectedSourceIds((current) =>
                        current.filter((sourceId) => available.has(sourceId)),
                      );
                    }}
                    disabled={starting}
                  >
                    <option value="original">Original · tanpa sumber</option>
                    <option value="rag">RAG · retrieval leksikal</option>
                    <option value="graphrag">GraphRAG · retrieval graph</option>
                  </select>
                  <p className="helper">
                    Satu run membandingkan prompt baseline dan kandidat dengan
                    metode, input, model, dan effort yang sama.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="experiment-dataset-name">Nama pilot</label>
                  <input
                    id="experiment-dataset-name"
                    className="input"
                    maxLength={120}
                    value={datasetName}
                    onChange={(event) => setDatasetName(event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="experiment-dataset-version">
                    Versi pilot
                  </label>
                  <input
                    id="experiment-dataset-version"
                    className="input"
                    maxLength={80}
                    value={datasetVersion}
                    onChange={(event) => setDatasetVersion(event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="experiment-prompt">Prompt baseline</label>
                  <select
                    id="experiment-prompt"
                    className="select"
                    value={selectedPromptId}
                    onChange={(event) => {
                      setSelectedPromptId(event.target.value);
                      setSelectedPromptVersionId("");
                    }}
                    disabled={!prompts.length || starting}
                    required
                  >
                    {prompts.length ? null : (
                      <option value="">
                        Simpan prompt di Workspace terlebih dahulu
                      </option>
                    )}
                    {prompts.map((prompt) => (
                      <option key={prompt.id} value={prompt.id}>
                        {prompt.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="experiment-prompt-version">
                    Versi prompt
                  </label>
                  <select
                    id="experiment-prompt-version"
                    className="select"
                    value={selectedPromptVersionId}
                    onChange={(event) =>
                      setSelectedPromptVersionId(event.target.value)
                    }
                    disabled={!promptVersions.length || starting}
                    required
                  >
                    {promptVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        v{version.version}
                        {version.id === selectedPrompt?.currentVersionId
                          ? " · aktif"
                          : " · riwayat"}
                      </option>
                    ))}
                    {!promptVersions.length ? (
                      <option value="">Riwayat prompt belum tersedia</option>
                    ) : null}
                  </select>
                  <p className="helper">
                    Versi lama hanya dipakai untuk pilot ini. Prompt aktif dan
                    riwayat tidak berubah.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="experiment-model">Model Codex</label>
                  <select
                    id="experiment-model"
                    className="select"
                    value={selectedModelId}
                    onChange={(event) => {
                      setSelectedModelId(event.target.value);
                      setReasoningEffort("");
                    }}
                    disabled={!codexModels.length || starting}
                    required
                  >
                    {codexModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                    {!codexModels.length ? (
                      <option value="">Login Codex untuk memuat model</option>
                    ) : null}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="experiment-reasoning-effort">
                    Kedalaman berpikir
                  </label>
                  <select
                    id="experiment-reasoning-effort"
                    className="select"
                    value={reasoningEffort}
                    onChange={(event) => setReasoningEffort(event.target.value)}
                    disabled={!selectedModel || starting}
                  >
                    <option value="">Bawaan model</option>
                    {supportedEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                  <p className="helper">
                    Pilihan mengikuti kemampuan model yang dimuat dari Codex.
                  </p>
                </div>
              </div>

              {selectedArm !== "original" ? (
                <fieldset className="experiment-source-selection">
                  <legend>Sumber yang dibekukan</legend>
                  {sourceLoadError ? (
                    <p className="error-message" role="alert">
                      {sourceLoadError}
                    </p>
                  ) : selectableSources.length ? (
                    <div className="experiment-source-list">
                      {selectableSources.map((source) => (
                        <label key={source.id}>
                          <input
                            type="checkbox"
                            checked={selectedSourceIds.includes(source.id)}
                            disabled={starting}
                            onChange={(event) =>
                              setSelectedSourceIds((current) =>
                                event.target.checked
                                  ? [...new Set([...current, source.id])]
                                  : current.filter((id) => id !== source.id),
                              )
                            }
                          />
                          <span>
                            <strong>{source.displayName}</strong>
                            <small>
                              v{source.version} · checksum{" "}
                              {source.checksum?.slice(0, 12)}
                              {selectedArm === "graphrag"
                                ? " · ada pada snapshot aktif"
                                : " · retrieval leksikal"}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="helper">
                      {selectedArm === "graphrag" && !activeSnapshotId
                        ? "Belum ada snapshot graph aktif yang masih sesuai."
                        : "Belum ada sumber eligible untuk metode ini."}
                    </p>
                  )}
                  <p className="helper">
                    Hanya sumber dengan izin Campus dan versi aktif yang dapat
                    dipilih. Versi, checksum, dan snapshot disimpan bersama
                    hasil.
                  </p>
                </fieldset>
              ) : null}

              <div
                className="experiment-context-summary"
                aria-label="Konteks pilot"
              >
                <div>
                  <span className="panel-label">Konteks dibekukan</span>
                  <strong>{armLabels[selectedArm]}</strong>
                  <span className="helper">
                    {selectedArm === "original"
                      ? "Tanpa sumber knowledge dan tanpa snapshot. Input, model, serta prompt tetap dibekukan untuk baseline dan kandidat."
                      : selectedArm === "rag"
                        ? `${frozenSelectedSources.length} sumber dipilih dengan retrieval leksikal. Input, versi sumber, model, dan prompt tetap dibekukan untuk baseline serta kandidat.`
                        : `${frozenSelectedSources.length} sumber dipilih pada snapshot ${activeSnapshotId ?? "belum tersedia"}. Jika retrieval graph jatuh ke fallback, hasil tidak eligible sebagai GraphRAG.`}
                  </span>
                  {frozenSelectedSources.length ? (
                    <span className="helper">
                      {frozenSelectedSources
                        .map(
                          (source) =>
                            `${source.displayName} v${source.version}`,
                        )
                        .join(" · ")}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="field">
                <label htmlFor="experiment-input">Satu input uji</label>
                <textarea
                  id="experiment-input"
                  className="input experiment-input"
                  maxLength={10_000}
                  value={pilotInput}
                  onChange={(event) => setPilotInput(event.target.value)}
                  placeholder="Tulis satu input yang sama untuk jawaban baseline dan kandidat."
                  required
                />
                <p className="helper">
                  Data uji tidak dikirim sampai Anda memilih Run. Hasil akan
                  menampilkan jawaban nyata dan angka pemakaian dari run.
                </p>
              </div>

              {!selectedPrompt && activeProjectId ? (
                <p className="helper" role="status">
                  Belum ada prompt tersimpan. Buat dan simpan prompt di{" "}
                  <Link className="knowledge-link" href="/workspace">
                    Workspace
                  </Link>
                  .
                </p>
              ) : null}
              {runBlocker ? (
                <p className="helper" role="status">
                  {runBlocker}{" "}
                  {activeProjectId ? (
                    <Link className="knowledge-link" href="/settings">
                      Buka Pengaturan
                    </Link>
                  ) : null}
                </p>
              ) : null}
              {actionError ? (
                <p className="error-message" role="alert">
                  {actionError}
                </p>
              ) : null}
              {actionMessage ? (
                <p className="success-message" role="status">
                  {actionMessage}
                </p>
              ) : null}
              <div className="experiment-run-actions">
                <Button type="submit" disabled={!canStart}>
                  {starting ? "Menyiapkan pilot…" : "Run"}
                </Button>
                {selectedPromptVersion ? (
                  <span className="helper">
                    {selectedPrompt?.name} · v{selectedPromptVersion.version} ·{" "}
                    {selectedModel?.displayName ?? "Model belum dipilih"}
                    {reasoningEffort
                      ? ` · ${reasoningEffort}`
                      : " · bawaan model"}
                  </span>
                ) : null}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card className={styles.reportCard}>
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle>
                {selectedExperiment?.mode === "controlled_evaluation"
                  ? "Laporan evaluasi terkontrol"
                  : "Laporan pilot"}
              </CardTitle>
              <CardDescription>
                Riwayat dan bukti berasal dari event run tersimpan. Token dan
                latency menjelaskan pemakaian; keduanya tidak membuktikan
                peningkatan kualitas.
              </CardDescription>
            </div>
            <div className="form-row">
              <label className="field experiment-select-label">
                <span>Pilih eksperimen</span>
                <select
                  className="select"
                  aria-label="Pilih eksperimen"
                  value={selectedExperimentId}
                  onChange={(event) =>
                    setSelectedExperimentId(event.target.value)
                  }
                  disabled={!experiments.length}
                >
                  {experiments.map((experiment) => (
                    <option
                      key={experiment.experimentId}
                      value={experiment.experimentId}
                    >
                      {experimentHistoryLabel(experiment)} ·{" "}
                      {new Date(experiment.createdAt).toLocaleString("id-ID")}
                    </option>
                  ))}
                  {!experiments.length ? (
                    <option value="">Belum ada eksperimen</option>
                  ) : null}
                </select>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!activeProjectId || loading}
                onClick={() => {
                  if (!activeProjectId) return;
                  setLoading(true);
                  void loadExperiments(activeProjectId)
                    .catch((cause: unknown) =>
                      setPageError(
                        cause instanceof Error
                          ? cause.message
                          : "Riwayat eksperimen tidak dapat dimuat.",
                      ),
                    )
                    .finally(() => setLoading(false));
                }}
                aria-label="Muat ulang riwayat eksperimen"
              >
                <RefreshCw size={15} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="experiment-report-content">
          {selectedExperiment ? (
            selectedExperiment.mode === "controlled_evaluation" ? (
              <ControlledEvaluationResults
                key={selectedExperiment.experimentId}
                experiment={selectedExperiment}
                report={reportMatches?.controlledReport ?? null}
                status={reportMatches?.status ?? selectedExperiment.status}
                connection={reportMatches?.connection ?? "connecting"}
                error={reportMatches?.error ?? selectedExperiment.errorSummary}
                decisionError={actionError}
                decisionBusy={decisionBusy}
                onDecision={(decision, note) =>
                  void saveDecision(decision, note)
                }
              />
            ) : (
              <>
                <div className="experiment-report-meta">
                  <Badge
                    variant={statusVariant(
                      reportMatches?.status ?? selectedExperiment.status,
                    )}
                  >
                    {runStatusLabel(
                      reportMatches?.status ?? selectedExperiment.status,
                    )}
                  </Badge>
                  <span className="helper">
                    Pilot {selectedExperiment.metadata.datasetName} · v
                    {selectedExperiment.metadata.datasetVersion}
                  </span>
                  <Badge variant="muted">
                    {armLabels[selectedExperiment.metadata.arm]} · development
                  </Badge>
                  <Badge
                    variant={
                      selectedExperiment.evidenceEligible
                        ? "success"
                        : "warning"
                    }
                  >
                    {selectedExperiment.evidenceEligible
                      ? "Bukti lengkap dan cocok"
                      : "Eksploratif · bukti belum terverifikasi"}
                  </Badge>
                  <span className="helper mono">
                    Run {selectedExperiment.runId}
                  </span>
                </div>
                <dl className="experiment-facts">
                  <div>
                    <dt>Prompt</dt>
                    <dd>
                      {selectedExperiment.metadata.promptName} · v
                      {selectedExperiment.metadata.promptVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{selectedExperiment.metadata.requestedModel}</dd>
                  </div>
                  <div>
                    <dt>Kedalaman</dt>
                    <dd>
                      {selectedExperiment.metadata.reasoningEffort ??
                        "Bawaan model"}
                    </dd>
                  </div>
                  <div>
                    <dt>Konteks</dt>
                    <dd>
                      {selectedExperiment.metadata.arm === "original"
                        ? "Tanpa sumber knowledge"
                        : `${selectedExperiment.metadata.sources.length} sumber · ${selectedExperiment.metadata.arm === "graphrag" ? `snapshot ${selectedExperiment.metadata.activeSnapshotId ?? "tidak dipilih"}` : "retrieval leksikal"}`}
                    </dd>
                  </div>
                  <div className="experiment-fact-input">
                    <dt>Input yang dibekukan</dt>
                    <dd>{selectedExperiment.metadata.input}</dd>
                  </div>
                </dl>

                {reportMatches?.connection === "connecting" ||
                reportMatches?.connection === "reconnecting" ? (
                  <p className="helper" role="status">
                    Mengambil hasil dari riwayat run…
                  </p>
                ) : null}
                {reportMatches?.error ? (
                  <p className="error-message" role="status">
                    {reportMatches.error}
                  </p>
                ) : null}
                {reportResult ? (
                  <>
                    <section
                      className="experiment-answer-grid"
                      aria-label="Perbandingan jawaban"
                    >
                      <AnswerColumn
                        title="Baseline"
                        prompt={reportResult.baseline.prompt}
                        answer={reportResult.baseline.answers[0]}
                      />
                      {reportResult.candidates.map((candidate) => (
                        <AnswerColumn
                          key={candidate.id}
                          title="Kandidat"
                          prompt={candidate.prompt}
                          answer={candidate.answers[0]}
                        />
                      ))}
                    </section>
                    <div className="experiment-metrics-grid">
                      <MetricCard
                        title="Baseline"
                        usage={reportResult.baseline.usage}
                        latency={reportResult.baseline.latencyMs}
                      />
                      {reportResult.candidates.map((candidate) => (
                        <MetricCard
                          key={candidate.id}
                          title="Kandidat"
                          usage={candidate.usage}
                          latency={candidate.latencyMs}
                        />
                      ))}
                      <div className="experiment-metric-card">
                        <strong>Biaya perbaikan</strong>
                        <span>
                          {formatMetric(reportResult.optimizer.usage.total)} ·{" "}
                          {formatDuration(reportResult.optimizationOverheadMs)}
                        </span>
                        <span className="helper">
                          Terpisah dari token dan waktu jawaban Codex; ini
                          metrik efisiensi, bukan ukuran peningkatan kualitas.
                        </span>
                      </div>
                    </div>
                    <div className="experiment-report-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          downloadReport(selectedExperiment, reportResult)
                        }
                      >
                        <Download size={15} aria-hidden="true" /> Ekspor laporan
                        JSON
                      </Button>
                      <Link className="workspace-result-link" href="/runs">
                        Buka riwayat run
                      </Link>
                    </div>
                  </>
                ) : reportMatches?.status === "succeeded" ? (
                  <p className="helper" role="status">
                    Run selesai, tetapi laporan pasangan tidak tersedia.
                  </p>
                ) : (
                  <div className="empty-state experiment-empty-report">
                    <div>
                      <p>Jawaban belum tersedia.</p>
                      <p className="helper">
                        Laporan muncul setelah run menyimpan jawaban baseline
                        dan kandidat.
                      </p>
                    </div>
                  </div>
                )}

                <section
                  className="experiment-decision"
                  aria-labelledby="experiment-decision-title"
                >
                  <div>
                    <h3 id="experiment-decision-title">Keputusan Anda</h3>
                    <p className="helper">
                      Keputusan hanya dicatat pada laporan. Untuk mengubah
                      prompt, pilih Terapkan secara terpisah di Workspace.
                    </p>
                  </div>
                  {selectedExperiment.decision ? (
                    <Badge
                      variant={
                        selectedExperiment.decision === "accepted" &&
                        !selectedExperiment.decisionVerified
                          ? "warning"
                          : "success"
                      }
                    >
                      {selectedExperiment.decision === "accepted"
                        ? selectedExperiment.decisionVerified
                          ? "Diterima · bukti terverifikasi"
                          : "Diterima · bukti belum terverifikasi"
                        : selectedExperiment.decision === "rejected"
                          ? "Ditolak"
                          : "Belum meyakinkan"}
                    </Badge>
                  ) : null}
                  <label className="field">
                    <span>Catatan keputusan (opsional)</span>
                    <input
                      className="input"
                      maxLength={500}
                      value={decisionNote}
                      onChange={(event) => setDecisionNote(event.target.value)}
                      placeholder="Catat alasan singkat"
                    />
                  </label>
                  <div className="experiment-decision-actions">
                    {(
                      [
                        ["accepted", "Terima kandidat"],
                        ["rejected", "Tolak kandidat"],
                        ["inconclusive", "Belum meyakinkan"],
                      ] as const
                    ).map(([decision, label]) => (
                      <Button
                        key={decision}
                        type="button"
                        variant={
                          decision === "accepted" ? "secondary" : "ghost"
                        }
                        disabled={
                          decisionBusy ||
                          (decision === "accepted" &&
                            !selectedExperiment.evidenceEligible) ||
                          ["queued", "running", "cancel_requested"].includes(
                            reportMatches?.status ?? selectedExperiment.status,
                          )
                        }
                        onClick={() => void saveDecision(decision)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </section>
              </>
            )
          ) : (
            <div className="empty-state">
              <div>
                <p>
                  {loading
                    ? "Memuat riwayat eksperimen…"
                    : "Belum ada laporan eksperimen."}
                </p>
                <p className="helper">
                  Mulai evaluasi terkontrol atau pilot eksploratif untuk
                  mencatat perbandingan baseline dan kandidat.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AnswerColumn({
  title,
  prompt,
  answer,
}: {
  title: string;
  prompt: string;
  answer: OptimizationAnswer | undefined;
}) {
  const verification = answer ? verificationStatus(answer) : null;
  const verificationEvidence = answer?.verificationEvidence;
  return (
    <article className="experiment-answer-column">
      <h3>{title}</h3>
      <details>
        <summary>Prompt yang diuji</summary>
        <pre>{prompt}</pre>
      </details>
      <p className="panel-label">Jawaban</p>
      <pre className="experiment-answer-text">
        {answer?.text ?? "Jawaban tidak tersedia pada hasil run."}
      </pre>
      {answer ? (
        <div className="experiment-answer-facts">
          <span>{formatMetric(answer.usage.total)}</span>
          <span>{formatDuration(answer.latencyMs)}</span>
        </div>
      ) : null}
      {verificationEvidence ? (
        <details className="experiment-verification">
          <summary>
            Pemeriksaan deterministik:{" "}
            {verification
              ? verificationLabel(verification)
              : "Status pemeriksaan tidak tersedia"}
          </summary>
          <pre>{JSON.stringify(verificationEvidence, null, 2)}</pre>
        </details>
      ) : answer?.verification ? (
        <p className="helper">Bukti pemeriksaan belum tersedia.</p>
      ) : (
        <p className="helper">Pemeriksaan deterministik tidak dikonfigurasi.</p>
      )}
    </article>
  );
}

function MetricCard({
  title,
  usage,
  latency,
}: {
  title: string;
  usage: OptimizationUsage;
  latency: number | null;
}) {
  return (
    <div className="experiment-metric-card">
      <strong>{title}</strong>
      <span>{formatMetric(usage.total)}</span>
      <span>{formatDuration(latency)}</span>
      <span className="helper">
        Input {formatMetric(usage.input)} · output {formatMetric(usage.output)}
      </span>
    </div>
  );
}
