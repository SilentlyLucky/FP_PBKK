"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, RefreshCw } from "lucide-react";
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
  const [projectDataLoading, setProjectDataLoading] = useState(
    Boolean(activeProjectId),
  );
  const [projectDataError, setProjectDataError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [controlledError, setControlledError] = useState<string | null>(null);
  const [controlledMessage, setControlledMessage] = useState<string | null>(
    null,
  );
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
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
  const [selectedExperimentId, setSelectedExperimentId] = useState("");
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptVersions, setPromptVersions] = useState<PromptVersionSummary[]>(
    [],
  );
  const [promptVersionsLoading, setPromptVersionsLoading] = useState(false);
  const [promptVersionsError, setPromptVersionsError] = useState<string | null>(
    null,
  );
  const [selectedPromptVersionId, setSelectedPromptVersionId] = useState("");
  const [pilotInput, setPilotInput] = useState("");
  const [pilotModelId, setPilotModelId] = useState("");
  const [controlledModelId, setControlledModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
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
  const pilotModel = codexModels.find((model) => model.id === pilotModelId);
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
        setProjectDataLoading(false);
        setProjectDataError(null);
        setKnowledgeSources([]);
        setActiveGraphSnapshot(null);
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
        setPilotModelId("");
        setControlledModelId("");
        setPageError(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const projectId = activeProjectId;
    const controller = new AbortController();
    setProjectDataLoading(true);
    setProjectDataError(null);
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
        const availablePrompts = promptPayload.prompts ?? [];
        const availableModels = providerPayload.codexModels ?? [];
        const configuredTargetModelId = providerPayload.providers?.find(
          (provider) =>
            provider.provider === "codex_app_server" &&
            provider.role === "target",
        )?.requestedModel;
        const defaultModelId =
          availableModels.find((model) => model.id === configuredTargetModelId)
            ?.id ??
          availableModels[0]?.id ??
          "";
        setPrompts(availablePrompts);
        setExperiments(experimentPayload.experiments ?? []);
        setSelectedPromptId((current) => {
          if (availablePrompts.some((prompt) => prompt.id === current))
            return current;
          return (
            availablePrompts.find((prompt) => prompt.currentVersionId)?.id ??
            availablePrompts.find((prompt) => prompt.version !== null)?.id ??
            ""
          );
        });
        setPilotModelId(defaultModelId);
        setControlledModelId((current) =>
          availableModels.some((model) => model.id === current)
            ? current
            : defaultModelId,
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
        setProjectDataError(
          cause instanceof Error
            ? cause.message
            : "Data proyek tidak dapat dimuat.",
        );
        setPageError(
          cause instanceof Error
            ? cause.message
            : "Data eksperimen tidak dapat dimuat.",
        );
      })
      .finally(() => {
        window.clearTimeout(loadingTimer);
        if (!controller.signal.aborted) {
          setLoading(false);
          setProjectDataLoading(false);
        }
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
        setPromptVersionsLoading(false);
        setPromptVersionsError(null);
        setSelectedPromptVersionId("");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    const prompt = prompts.find((item) => item.id === selectedPromptId);
    setPromptVersionsLoading(true);
    setPromptVersionsError(null);
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
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPromptVersions([]);
        setSelectedPromptVersionId("");
        setPromptVersionsError(
          cause instanceof Error
            ? cause.message
            : "Versi prompt tidak dapat dimuat.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPromptVersionsLoading(false);
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

  const pilotModelVerified = Boolean(
    targetProvider?.status === "verified" &&
    targetProvider.requestedModel === pilotModelId,
  );
  const controlledModelVerified = Boolean(
    targetProvider?.status === "verified" &&
    targetProvider.requestedModel === controlledModelId,
  );
  const optimizerReady = optimizerProvider?.status === "verified";
  const reportResult = reportMatches?.result ?? null;
  let runBlocker: string | null = null;
  if (!activeProjectId)
    runBlocker = "Pilih proyek sebelum membandingkan prompt.";
  else if (projectDataLoading) runBlocker = "Memuat data proyek…";
  else if (projectDataError)
    runBlocker = "Data proyek tidak dapat dimuat. Muat ulang halaman.";
  else if (promptVersionsLoading) runBlocker = "Memuat prompt baseline…";
  else if (promptVersionsError)
    runBlocker = "Versi baseline tidak dapat dimuat. Muat ulang halaman.";
  else if (!selectedPromptVersion)
    runBlocker = "Simpan prompt di Workspace untuk dipakai sebagai baseline.";
  else if (!pilotModel)
    runBlocker = "Model Codex belum tersedia. Atur koneksi di Pengaturan.";
  else if (!pilotModelVerified)
    runBlocker = "Verifikasi model Codex di Pengaturan sebelum membandingkan.";
  else if (!optimizerReady)
    runBlocker = "Hubungkan Flowku di Pengaturan sebelum membandingkan.";
  else if (!pilotInput.trim()) runBlocker = "Masukkan prompt yang mau diuji.";

  const runBlockerHref = !activeProjectId
    ? null
    : projectDataLoading || projectDataError
      ? null
      : promptVersionsLoading || promptVersionsError
        ? null
        : !selectedPromptVersion
          ? "/workspace"
          : !pilotModel || !pilotModelVerified || !optimizerReady
            ? "/settings"
            : null;
  const runBlockerLinkLabel =
    runBlockerHref === "/workspace" ? "Buka Workspace" : "Buka Pengaturan";
  const canStart =
    !starting && !loading && !projectDataLoading && runBlocker === null;

  async function startPromptComparison(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (
      !activeProjectId ||
      !selectedPrompt ||
      !selectedPromptVersion ||
      !canStart
    )
      return;
    const projectId = activeProjectId;
    const retrieval: RunRetrievalSelection = {
      strategy: "lexical",
      sourceIds: [],
      snapshotId: null,
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
          requestedModel: pilotModelId,
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
          responseError(runPayload, "Perbandingan tidak dapat dibuat."),
        );

      const metadata: ExperimentPilotMetadata = {
        datasetName: "Uji prompt",
        datasetVersion: "v1",
        arm: "original",
        split: "development",
        caseId,
        input: pilotInput.trim(),
        promptId: selectedPrompt.id,
        promptVersionId: selectedPromptVersion.id,
        promptName: selectedPrompt.name,
        promptVersion: selectedPromptVersion.version,
        baselinePrompt: selectedPromptVersion.text,
        requestedModel: pilotModelId,
        reasoningEffort: null,
        retrieval,
        activeSnapshotId: null,
        sources: [],
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
          `Run ${runPayload.run.id} sudah dibuat, tetapi hasil perbandingan gagal disimpan: ${responseError(markerPayload, "muat ulang riwayat pengujian.")}`,
        );

      await loadExperiments(projectId);
      setSelectedExperimentId(markerPayload.experiment.experimentId);
      setActionMessage(
        `Perbandingan dimulai. Status: ${runStatusLabel(runPayload.run.status)}.`,
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Perbandingan prompt tidak dapat dimulai.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function startControlledEvaluation(draft: ControlledEvaluationDraft) {
    if (!activeProjectId || starting) return;
    const projectId = activeProjectId;
    setStarting(true);
    setControlledError(null);
    setControlledMessage(null);
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
      setControlledMessage(
        "Evaluasi terkontrol dibuat. Status run: " +
          runStatusLabel(runPayload.run.status) +
          ".",
      );
    } catch (cause) {
      setControlledError(
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
    setDecisionError(null);
    setDecisionMessage(null);
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
      setDecisionMessage(
        "Keputusan tersimpan. Prompt aktif tidak berubah otomatis.",
      );
    } catch (cause) {
      setDecisionError(
        cause instanceof Error
          ? cause.message
          : "Keputusan tidak dapat disimpan.",
      );
    } finally {
      setDecisionBusy(false);
    }
  }

  return (
    <div className={`stack experiment-workspace ${styles.experiments}`}>
      {!activeProjectId ? (
        <p className="helper" role="status">
          Pilih proyek dari bilah atas untuk mulai membandingkan prompt.
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
              <CardTitle>Bandingkan prompt</CardTitle>
              <CardDescription>
                Masukkan prompt uji. Flowku otomatis memakai prompt tersimpan
                terbaru sebagai baseline, lalu membandingkannya dengan versi
                yang diperbaiki.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className={`experiment-form ${styles.promptForm}`}
            onSubmit={startPromptComparison}
          >
            <div className={`field ${styles.promptEditor}`}>
              <label htmlFor="experiment-input">Prompt yang mau diuji</label>
              <textarea
                id="experiment-input"
                className={`input experiment-input ${styles.promptInput}`}
                maxLength={10_000}
                value={pilotInput}
                onChange={(event) => setPilotInput(event.target.value)}
                placeholder="Tulis pertanyaan atau instruksi yang biasa Anda kirim ke AI."
                required
                disabled={starting}
              />
              <p className="helper">
                Prompt yang sama dikirim ke baseline dan Flowku agar jawabannya
                bisa dibandingkan langsung.
              </p>
            </div>

            <div className={styles.baselineSummary}>
              <span className={styles.baselineMarker} aria-hidden="true" />
              <div>
                <span className={styles.summaryLabel}>Baseline</span>
                <strong>
                  {selectedPromptVersion
                    ? `${selectedPrompt?.name ?? "Prompt aktif"} · v${selectedPromptVersion.version}`
                    : "Belum ada baseline tersimpan"}
                </strong>
              </div>
              <span className={styles.modelSummary}>
                {pilotModel?.displayName ?? "Model belum tersedia"}
              </span>
            </div>

            {runBlocker ? (
              <p className={`helper ${styles.blocker}`} role="status">
                {runBlocker}{" "}
                {runBlockerHref ? (
                  <Link className="knowledge-link" href={runBlockerHref}>
                    {runBlockerLinkLabel}
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

            <div className={styles.promptActions}>
              <span className="helper">
                Satu klik menjalankan kedua jawaban dengan model yang sama.
              </span>
              <Button type="submit" disabled={!canStart}>
                {starting
                  ? "Menyiapkan perbandingan…"
                  : "Bandingkan dengan Flowku"}
              </Button>
            </div>
          </form>

          <details className={styles.advancedSetup}>
            <summary>Evaluasi batch (lanjutan)</summary>
            <p className="helper">
              Untuk membandingkan beberapa versi prompt pada dataset, holdout,
              dan metode retrieval yang dibekukan.
            </p>
            <ControlledEvaluationSetup
              projectId={activeProjectId}
              prompts={prompts}
              models={codexModels}
              selectedModelId={controlledModelId}
              onModelChange={(value) => {
                setControlledModelId(value);
                setReasoningEffort("");
              }}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              modelVerified={controlledModelVerified}
              sources={eligibleSources}
              graphSources={graphEligibleSources}
              graphSnapshotId={activeSnapshotId}
              sourceLoadError={sourceLoadError}
              starting={starting}
              error={controlledError}
              message={controlledMessage}
              onStart={(draft) => void startControlledEvaluation(draft)}
            />
          </details>
        </CardContent>
      </Card>

      <Card className={styles.reportCard}>
        <CardHeader>
          <CardTitle>
            {selectedExperiment?.mode === "controlled_evaluation"
              ? "Hasil evaluasi batch"
              : "Hasil perbandingan"}
          </CardTitle>
          <CardDescription>
            Baca kedua jawaban berdampingan. Token dan waktu hanya menunjukkan
            pemakaian, bukan kualitas jawaban.
          </CardDescription>
        </CardHeader>
        <CardContent className="experiment-report-content">
          {experiments.length ? (
            <details className={styles.historyDisclosure}>
              <summary>Riwayat pengujian ({experiments.length})</summary>
              <div className={styles.historyControls}>
                <label className="field">
                  <span>Pilih hasil sebelumnya</span>
                  <select
                    className="select"
                    aria-label="Pilih eksperimen"
                    value={selectedExperimentId}
                    onChange={(event) =>
                      setSelectedExperimentId(event.target.value)
                    }
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
                            : "Riwayat pengujian tidak dapat dimuat.",
                        ),
                      )
                      .finally(() => setLoading(false));
                  }}
                  aria-label="Muat ulang riwayat pengujian"
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </Button>
              </div>
            </details>
          ) : null}
          {selectedExperiment ? (
            selectedExperiment.mode === "controlled_evaluation" ? (
              <>
                {decisionMessage ? (
                  <p className="success-message" role="status">
                    {decisionMessage}
                  </p>
                ) : null}
                <ControlledEvaluationResults
                  key={selectedExperiment.experimentId}
                  experiment={selectedExperiment}
                  report={reportMatches?.controlledReport ?? null}
                  status={reportMatches?.status ?? selectedExperiment.status}
                  connection={reportMatches?.connection ?? "connecting"}
                  error={
                    reportMatches?.error ?? selectedExperiment.errorSummary
                  }
                  decisionError={decisionError}
                  decisionBusy={decisionBusy}
                  onDecision={(decision, note) =>
                    void saveDecision(decision, note)
                  }
                />
              </>
            ) : (
              <>
                <div className={styles.reportStatus}>
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
                    {new Date(selectedExperiment.createdAt).toLocaleString(
                      "id-ID",
                    )}
                  </span>
                </div>
                <div className={styles.testPrompt}>
                  <span className={styles.summaryLabel}>Prompt yang diuji</span>
                  <p>{selectedExperiment.metadata.input}</p>
                </div>

                {reportMatches?.connection === "connecting" ||
                reportMatches?.connection === "reconnecting" ? (
                  <p className="helper" role="status">
                    Menunggu jawaban perbandingan…
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
                      {reportResult.candidates.length ? (
                        reportResult.candidates.map((candidate) => (
                          <AnswerColumn
                            key={candidate.id}
                            title="Dengan Flowku"
                            prompt={candidate.prompt}
                            answer={candidate.answers[0]}
                          />
                        ))
                      ) : (
                        <article
                          className={`experiment-answer-column ${styles.flowkuAnswer} ${styles.noFlowkuCandidate}`}
                        >
                          <h3>Dengan Flowku</h3>
                          <p>
                            {reportResult.status === "no_change_recommended"
                              ? "Flowku tidak menyarankan perubahan untuk prompt ini."
                              : "Flowku belum menghasilkan jawaban pembanding."}
                          </p>
                        </article>
                      )}
                    </section>
                    <p className="helper">
                      Angka token dan waktu membantu melihat pemakaian. Nilai
                      kualitas jawaban dari isinya.
                    </p>
                    <details className={styles.reportDetails}>
                      <summary>Detail hasil dan ekspor</summary>
                      <dl className="experiment-facts">
                        <div>
                          <dt>Prompt baseline</dt>
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
                          <dt>Konteks</dt>
                          <dd>
                            {selectedExperiment.metadata.arm === "original"
                              ? "Tanpa sumber knowledge"
                              : `${selectedExperiment.metadata.sources.length} sumber · ${armLabels[selectedExperiment.metadata.arm]}`}
                          </dd>
                        </div>
                        <div>
                          <dt>ID run</dt>
                          <dd className="mono">{selectedExperiment.runId}</dd>
                        </div>
                      </dl>
                      <div className="experiment-metric-card">
                        <strong>Biaya perbaikan Flowku</strong>
                        <span>
                          {formatMetric(reportResult.optimizer.usage.total)} ·{" "}
                          {formatDuration(reportResult.optimizationOverheadMs)}
                        </span>
                        <span className="helper">
                          Terpisah dari pemakaian dan waktu jawaban model.
                        </span>
                      </div>
                      <div className="experiment-report-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            downloadReport(selectedExperiment, reportResult)
                          }
                        >
                          <Download size={15} aria-hidden="true" /> Ekspor
                          laporan JSON
                        </Button>
                        <Link className="workspace-result-link" href="/runs">
                          Buka riwayat run
                        </Link>
                      </div>
                    </details>
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
                        Hasil akan muncul di sini setelah kedua jawaban selesai.
                      </p>
                    </div>
                  </div>
                )}

                <details className={styles.decisionDisclosure}>
                  <summary>Catat keputusan</summary>
                  <section className="experiment-decision">
                    <div>
                      <h3>Keputusan Anda</h3>
                      <p className="helper">
                        Keputusan hanya dicatat. Untuk mengubah prompt, pilih
                        Terapkan secara terpisah di Workspace.
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
                      <span>Catatan (opsional)</span>
                      <input
                        className="input"
                        maxLength={500}
                        value={decisionNote}
                        onChange={(event) =>
                          setDecisionNote(event.target.value)
                        }
                        placeholder="Catat alasan singkat"
                      />
                    </label>
                    {decisionError ? (
                      <p className="error-message" role="alert">
                        {decisionError}
                      </p>
                    ) : null}
                    {decisionMessage ? (
                      <p className="success-message" role="status">
                        {decisionMessage}
                      </p>
                    ) : null}
                    <div className="experiment-decision-actions">
                      {(
                        [
                          ["accepted", "Terima Flowku"],
                          ["rejected", "Tolak"],
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
                              reportMatches?.status ??
                                selectedExperiment.status,
                            )
                          }
                          onClick={() => void saveDecision(decision)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </section>
                </details>
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
                  Masukkan prompt di atas untuk melihat jawaban baseline dan
                  jawaban dengan Flowku berdampingan.
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
    <article
      className={`experiment-answer-column ${title === "Dengan Flowku" ? styles.flowkuAnswer : styles.baselineAnswer}`}
    >
      <h3>{title}</h3>
      <details>
        <summary>Instruksi yang digunakan</summary>
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
      ) : null}
    </article>
  );
}
