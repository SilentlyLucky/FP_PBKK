"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  FileText,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { useProjectScope } from "@/components/project-scope";
import { KnowledgeGraphExplorer } from "@/components/knowledge-graph-explorer";
import { LocalSourceBrowser } from "@/components/local-source-browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import styles from "./knowledge-workspace.module.css";

type Permission = "local_only" | "campus_indexer_allowed";
type Strategy = "lexical" | "graph" | "full_context";

interface SourceSummary {
  id: string;
  displayName: string;
  sourceKind: string;
  permission: Permission;
  updatedAt: string;
  deleted: boolean;
  version: number | null;
  versionId: string | null;
  checksum: string | null;
  eligible: boolean;
  contentType: string | null;
  wordCount: number | null;
  extractStatus: string;
  chunkCount: number;
  sourceRef?: string | null;
  semanticReadiness?: {
    status: string;
    profiles?: Array<{
      requestedModel: string;
      observedModel: string;
      chunkCount: number;
      embeddedChunkCount: number;
      status: string;
    }>;
  } | null;
}

interface SourceChunkPreview {
  id: string;
  ordinal: number;
  content: string;
  heading: string | null;
  pageNumber: number | null;
}

interface SourceDetailPreview {
  id: string;
  displayName: string;
  version: number;
  checksum: string;
  contentType: string;
  sourceMetadata: Record<string, unknown>;
  chunks: SourceChunkPreview[];
}

interface BuildSummary {
  id: string;
  state: string;
  sourceManifest: Array<{
    documentId?: string;
    documentVersionId?: string;
    displayName?: string;
    version?: number;
    chunks?: Array<{ chunkId: string }>;
  }>;
  sourceManifestHash: string;
  extractorModel: string | null;
  budget: Record<string, unknown>;
  usageRefs: string[];
  requestedAt: string;
  finishedAt: string | null;
}

interface EvidenceSummary {
  id: string;
  quote: string;
  documentName: string;
  documentVersion: number;
  documentVersionId: string;
  chunkId: string;
  checksum: string;
  extractionRunId: string | null;
  extractorModel: string | null;
  sourceRef?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  reviewState?: string | null;
  traceId?: string | null;
  pageNumber?: number | null;
}

interface AssertionSummary {
  id: string;
  version: number;
  status: "extracted_supported" | "needs_review" | "rejected";
  eligible: boolean;
  subject: string;
  subjectType: string;
  predicate: string;
  object: string;
  objectType: string;
  qualifiers: Record<string, unknown>;
  evidence: EvidenceSummary[];
}

interface ReadinessSummary {
  documents: { total: number; eligible: number; chunkCount: number };
  snapshot: {
    id: string | null;
    status: string;
    buildId: string | null;
    revision: number | null;
    activatedAt: string | null;
    coverage?: Record<string, unknown>;
  };
  build: { id: string | null; state: string };
  retrieval: {
    status: string;
    backend: string;
    graphAvailable: boolean;
    fallback: string | null;
  };
  indexer: {
    requestedModel: string | null;
    connectionStatus: string;
    ready: boolean;
    reason: string | null;
  };
}

interface KnowledgePayload {
  readiness: ReadinessSummary;
  sources: SourceSummary[];
  builds: BuildSummary[];
  snapshotId: string | null;
  assertions: AssertionSummary[];
}

interface ReferenceSource {
  id: string;
  title: string;
  publisher: string;
  url: string;
  accessed_at_utc: string;
  source_type: string;
  use: string;
  sections_used: string[];
  license_caveat?: string;
  temporal_caveat?: string;
}

interface ReferencePreview {
  id: string;
  source_id: string;
  topic: string;
  summary: string;
  evidence_excerpt: string;
  source_section: string;
  claim_type: string;
}

interface ReferencePackMetadata {
  schema_version?: string;
  corpus_id?: string;
  status?: string;
  source_snapshot_at_utc?: string;
  scope?: {
    purpose?: string;
    bounds?: { source_count?: number; chunk_count?: number };
  };
}

interface ReferencePackPayload {
  metadata?: ReferencePackMetadata;
  pack?: ReferencePackMetadata;
  sources?: ReferenceSource[];
  publicSources?: ReferenceSource[];
  previews?: ReferencePreview[];
  chunks?: ReferencePreview[];
  error?: string;
  message?: string;
}

interface ReferenceImportPayload {
  imported?: number;
  skipped?: number;
  documentIds?: string[];
  packId?: string;
  error?: string;
  message?: string;
}

interface BuildPreview {
  projectId: string;
  ready: boolean;
  sourceCount: number;
  chunkCount: number;
  sources: Array<{
    id: string;
    name: string;
    version: number;
    checksum: string;
    chunkCount: number;
  }>;
  requestedModel: string | null;
  providerReady: boolean;
  providerReason: string | null;
  minModelCalls: number;
  maxModelCalls: number;
  selectedMaxModelCalls: number;
}

interface RetrievalPreview {
  requestedStrategy: Strategy;
  strategyUsed: Strategy;
  snapshotId: string | null;
  traceId: string;
  seeds: Array<{ id: string; label: string; entityType: string }>;
  paths: Array<{ entityIds: string[]; predicates: string[]; labels: string[] }>;
  evidence: Array<{
    id: string;
    kind: "graph" | "chunk";
    quote: string;
    documentName: string;
    documentVersion: number;
    chunkId: string;
    sourceRef?: string | null;
    sourceTitle?: string | null;
    sourceUrl?: string | null;
    reviewState?: string | null;
    traceId?: string | null;
    extractorModel?: string | null;
    pageNumber?: number | null;
  }>;
  estimatedContextTokens: number;
  fallbackReason: string | null;
  clipping: Record<string, unknown>;
  elapsedMs: number;
}

const activeBuildStates = new Set([
  "queued",
  "extracting",
  "validating",
  "ready_to_activate",
]);
const MAX_SOURCE_BYTES = 98_304;
const MAX_PDF_FILE_BYTES = 5_242_880;
const RELATION_MAP_LIMIT = 16;

interface RelationMapNode {
  key: string;
  label: string;
  type: string;
  x: number;
  y: number;
}

interface RelationMapEdge {
  assertion: AssertionSummary;
  source: RelationMapNode;
  target: RelationMapNode;
  path: string;
}

function createRelationMap(assertions: AssertionSummary[]) {
  const displayedAssertions = assertions.slice(0, RELATION_MAP_LIMIT);
  const rawNodes = new Map<
    string,
    { key: string; label: string; type: string }
  >();
  const keyFor = (label: string, type: string) => JSON.stringify([type, label]);

  for (const assertion of displayedAssertions) {
    const subjectKey = keyFor(assertion.subject, assertion.subjectType);
    const objectKey = keyFor(assertion.object, assertion.objectType);
    rawNodes.set(subjectKey, {
      key: subjectKey,
      label: assertion.subject,
      type: assertion.subjectType,
    });
    rawNodes.set(objectKey, {
      key: objectKey,
      label: assertion.object,
      type: assertion.objectType,
    });
  }

  const nodes = Array.from(rawNodes.values()).map((node, index, allNodes) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / allNodes.length;
    return {
      ...node,
      x: 500 + Math.cos(angle) * 290,
      y: 300 + Math.sin(angle) * 180,
    };
  });
  for (let iteration = 0; iteration < 90; iteration += 1) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < nodes.length;
        rightIndex += 1
      ) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        if (!left || !right) continue;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.max(Math.hypot(dx, dy), 0.1);
        const minimumDistance = 100;
        if (distance >= minimumDistance) continue;
        const separation = ((minimumDistance - distance) / distance) * 0.22;
        left.x -= dx * separation;
        left.y -= dy * separation;
        right.x += dx * separation;
        right.y += dy * separation;
      }
    }
    for (const node of nodes) {
      node.x = Math.min(950, Math.max(50, node.x));
      node.y = Math.min(550, Math.max(50, node.y));
    }
  }
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const edges = displayedAssertions
    .map((assertion, index) => {
      const source = nodeByKey.get(
        keyFor(assertion.subject, assertion.subjectType),
      );
      const target = nodeByKey.get(
        keyFor(assertion.object, assertion.objectType),
      );
      if (!source || !target) return null;

      if (source.key === target.key) {
        return {
          assertion,
          source,
          target,
          path: `M ${source.x - 16} ${source.y - 32} C ${source.x - 90} ${source.y - 130}, ${source.x + 90} ${source.y - 130}, ${source.x + 16} ${source.y - 32}`,
        };
      }

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const length = Math.hypot(dx, dy);
      const unitX = dx / length;
      const unitY = dy / length;
      const startX = source.x + unitX * 42;
      const startY = source.y + unitY * 42;
      const endX = target.x - unitX * 48;
      const endY = target.y - unitY * 48;
      const offset = ((index % 5) - 2) * 13;
      const controlX = (startX + endX) / 2 - unitY * offset;
      const controlY = (startY + endY) / 2 + unitX * offset;
      return {
        assertion,
        source,
        target,
        path: `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`,
      };
    })
    .filter((edge): edge is RelationMapEdge => edge !== null);

  return { nodes, edges, displayedCount: displayedAssertions.length };
}

interface GraphSnapshotOption {
  id: string;
  state: string;
  current: boolean;
  active: boolean;
  revision: number | null;
  sourceManifestHash: string;
  buildId: string;
  createdAt: string;
  activatedAt: string | null;
}

function errorMessage(
  result: { error?: string; message?: string },
  fallback: string,
) {
  return result.message ?? result.error ?? fallback;
}

function buildStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: "Menunggu worker",
    extracting: "Mengekstrak sumber",
    validating: "Memeriksa bukti",
    ready_to_activate: "Memeriksa snapshot",
    active: "Aktif",
    partial: "Parsial · snapshot sebelumnya dipertahankan",
    failed: "Gagal · snapshot sebelumnya dipertahankan",
    cancelled: "Dibatalkan",
  };
  return labels[state] ?? state;
}

function statusVariant(
  state: string,
): "success" | "warning" | "muted" | "danger" {
  if (state === "active" || state === "extracted_supported") return "success";
  if (
    state === "needs_review" ||
    state === "stale" ||
    activeBuildStates.has(state)
  )
    return "warning";
  if (state === "failed" || state === "partial" || state === "rejected")
    return "danger";
  return "muted";
}

function assertionStatusLabel(status: AssertionSummary["status"]): string {
  const labels: Record<AssertionSummary["status"], string> = {
    extracted_supported: "Didukung bukti",
    needs_review: "Perlu ditinjau",
    rejected: "Ditolak",
  };
  return labels[status];
}

function publicHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function reviewStateLabel(value: string | null | undefined): string {
  if (value === "extracted_supported") return "Didukung bukti";
  if (value === "needs_review") return "Perlu ditinjau";
  if (value === "rejected") return "Ditolak";
  return value || "Status review tidak tersedia";
}

function referencePackData(payload: ReferencePackPayload) {
  return {
    metadata:
      payload.metadata ?? payload.pack ?? (payload as ReferencePackMetadata),
    sources: payload.sources ?? payload.publicSources ?? [],
    previews: payload.previews ?? payload.chunks ?? [],
  };
}

export function KnowledgeWorkspace() {
  const { activeProjectId, activeProject } = useProjectScope();
  const [snapshot, setSnapshot] = useState<{
    projectId: string;
    data: KnowledgePayload;
  } | null>(null);
  const [graphSnapshotList, setGraphSnapshotList] = useState<{
    projectId: string;
    snapshots: GraphSnapshotOption[];
  } | null>(null);
  const [graphSnapshotLoading, setGraphSnapshotLoading] = useState(false);
  const [graphSnapshotError, setGraphSnapshotError] = useState<string | null>(
    null,
  );
  const [referenceSnapshot, setReferenceSnapshot] = useState<{
    projectId: string;
    data: ReturnType<typeof referencePackData>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [referenceImportMessage, setReferenceImportMessage] = useState<
    string | null
  >(null);
  const [referenceImportBusy, setReferenceImportBusy] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(
    null,
  );
  const [sourceMode, setSourceMode] = useState<"paste" | "upload">("upload");
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const sourceDialogRef = useRef<HTMLDialogElement>(null);
  const sourceReturnFocusRef = useRef<HTMLElement | null>(null);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  const [localImportOpen, setLocalImportOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"files" | "relations">(
    "files",
  );
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(
    null,
  );
  const [relationPage, setRelationPage] = useState(0);
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceStatusFilter, setSourceStatusFilter] = useState("all");
  const [sourceTypeFilter, setSourceTypeFilter] = useState("all");
  const [sourcePreview, setSourcePreview] = useState<{
    projectId: string;
    source: SourceDetailPreview;
  } | null>(null);
  const [sourcePreviewBusy, setSourcePreviewBusy] = useState<string | null>(
    null,
  );
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(
    null,
  );
  const [pasteName, setPasteName] = useState("Catatan baru.md");
  const [pasteContent, setPasteContent] = useState("");
  const [sourcePermission, setSourcePermission] = useState<Permission>("local_only");
  const [vaultPath, setVaultPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [replaceSourceId, setReplaceSourceId] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [buildSelections, setBuildSelections] = useState<
    Record<string, string[]>
  >({});
  const [buildPreview, setBuildPreview] = useState<BuildPreview | null>(null);
  const [buildIdempotencyKey, setBuildIdempotencyKey] = useState<string | null>(
    null,
  );
  const [maxModelCalls, setMaxModelCalls] = useState(0);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>(
    {},
  );
  const [retrievalQuery, setRetrievalQuery] = useState("");
  const [retrievalStrategy, setRetrievalStrategy] = useState<Strategy>("graph");
  const [retrievalSnapshotSelections, setRetrievalSnapshotSelections] =
    useState<Record<string, string>>({});
  const [retrievalSelections, setRetrievalSelections] = useState<
    Record<string, string[]>
  >({});
  const [retrievalPreview, setRetrievalPreview] = useState<{
    projectId: string;
    result: RetrievalPreview;
  } | null>(null);
  const [retrievalBusy, setRetrievalBusy] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);

  const data = snapshot?.projectId === activeProjectId ? snapshot.data : null;
  const availableGraphSnapshots =
    graphSnapshotList?.projectId === activeProjectId
      ? graphSnapshotList.snapshots
      : [];
  const retrievalSnapshotSelection =
    retrievalSnapshotSelections[activeProjectId ?? ""] ?? "";
  const referenceData =
    referenceSnapshot?.projectId === activeProjectId
      ? referenceSnapshot.data
      : null;
  const sources = data?.sources ?? [];
  const listedSources = sources.filter((source) => !source.deleted);
  const normalizedSourceSearch = sourceSearch.trim().toLowerCase();
  const visibleSources = listedSources.filter((source) => {
    const isLexicallyIndexed = source.extractStatus === "ready" && source.chunkCount > 0;
    const statusMatches =
      sourceStatusFilter === "all" ||
      (sourceStatusFilter === "indexed" && isLexicallyIndexed) ||
      (sourceStatusFilter === "pending" && !isLexicallyIndexed) ||
      (sourceStatusFilter === "review" && !source.eligible) ||
      (sourceStatusFilter === "local" && source.permission === "local_only");
    const typeMatches =
      sourceTypeFilter === "all" ||
      (source.contentType ?? source.sourceKind) === sourceTypeFilter;
    if (!statusMatches || !typeMatches) return false;
    if (!normalizedSourceSearch) return true;
    return [source.displayName, source.sourceKind, source.contentType]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(normalizedSourceSearch));
  });
  const currentSources = sources.filter(
    (source) => !source.deleted && source.eligible,
  );
  const sourcesNeedingReview = listedSources.filter(
    (source) => !source.eligible,
  );
  const activeAssertions = useMemo(
    () =>
      (data?.assertions ?? []).filter(
        (assertion) =>
          assertion.eligible &&
          assertion.status === "extracted_supported" &&
          assertion.evidence.length > 0,
      ),
    [data?.assertions],
  );
  const relationPageCount = Math.max(
    1,
    Math.ceil(activeAssertions.length / RELATION_MAP_LIMIT),
  );
  const currentRelationPage = Math.min(relationPage, relationPageCount - 1);
  const relationMap = useMemo(() => {
    const start = currentRelationPage * RELATION_MAP_LIMIT;
    return createRelationMap(
      activeAssertions.slice(start, start + RELATION_MAP_LIMIT),
    );
  }, [activeAssertions, currentRelationPage]);
  const displayedAssertions = relationMap.edges.map((edge) => edge.assertion);
  const relationRangeStart = currentRelationPage * RELATION_MAP_LIMIT + 1;
  const relationRangeEnd =
    currentRelationPage * RELATION_MAP_LIMIT + displayedAssertions.length;
  const selectedRelation =
    displayedAssertions.find(
      (assertion) => assertion.id === selectedRelationId,
    ) ??
    displayedAssertions[0] ??
    null;
  const activeGraphSnapshot = availableGraphSnapshots.find(
    (item) => item.active,
  );
  const graphIsStale = Boolean(
    data &&
    (data.readiness.snapshot.status === "stale" ||
      (activeGraphSnapshot && !activeGraphSnapshot.current)),
  );

  useEffect(() => {
    setRelationPage(0);
    setSelectedRelationId(null);
  }, [activeProjectId]);

  function navigateRelationPage(offset: number) {
    const nextPage = Math.min(
      relationPageCount - 1,
      Math.max(0, currentRelationPage + offset),
    );
    setRelationPage(nextPage);
    setSelectedRelationId(
      activeAssertions[nextPage * RELATION_MAP_LIMIT]?.id ?? null,
    );
  }

  const buildSourceIds = buildSelections[activeProjectId ?? ""] ?? [];
  const retrievalSourceIds = (retrievalSelections[activeProjectId ?? ""] ?? [])
    .filter((id) => currentSources.some((source) => source.id === id));
  const activePreview =
    retrievalPreview?.projectId === activeProjectId
      ? retrievalPreview.result
      : null;
  const latestBuild = data?.builds[0] ?? null;
  const buildInProgress = Boolean(
    latestBuild && activeBuildStates.has(latestBuild.state),
  );
  const buildReady = Boolean(
    buildPreview?.projectId === activeProjectId &&
    buildPreview.providerReady &&
    buildPreview.ready &&
    buildSourceIds.length > 0,
  );

  const loadReferencePack = useCallback(async (projectId: string) => {
    setReferenceLoading(true);
    setReferenceError(null);
    setReferenceImportMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/knowledge/reference-pack`,
        { cache: "no-store" },
      );
      const result = (await response.json()) as ReferencePackPayload;
      if (!response.ok)
        throw new Error(
          errorMessage(result, "Referensi umum belum dapat dimuat."),
        );
      setReferenceSnapshot({
        projectId,
        data: referencePackData(result),
      });
    } catch (cause) {
      setReferenceSnapshot((current) =>
        current?.projectId === projectId ? null : current,
      );
      setReferenceError(
        cause instanceof Error
          ? cause.message
          : "Referensi umum belum dapat dimuat.",
      );
    } finally {
      setReferenceLoading(false);
    }
  }, []);

  const loadGraphSnapshots = useCallback(async (projectId: string) => {
    setGraphSnapshotLoading(true);
    setGraphSnapshotError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/graph/snapshots`,
        { cache: "no-store" },
      );
      const result = (await response.json()) as {
        snapshots?: GraphSnapshotOption[];
        error?: string;
        message?: string;
      };
      if (!response.ok || !Array.isArray(result.snapshots))
        throw new Error(
          errorMessage(result, "Daftar snapshot graph belum dapat dimuat."),
        );
      setGraphSnapshotList({ projectId, snapshots: result.snapshots });
    } catch (cause) {
      setGraphSnapshotList((current) =>
        current?.projectId === projectId ? null : current,
      );
      setGraphSnapshotError(
        cause instanceof Error
          ? cause.message
          : "Daftar snapshot graph belum dapat dimuat.",
      );
    } finally {
      setGraphSnapshotLoading(false);
    }
  }, []);

  const refresh = useCallback(
    async (showLoading = false) => {
      if (!activeProjectId) {
        setSnapshot(null);
        setGraphSnapshotList(null);
        setLoading(false);
        setError(null);
        return;
      }
      const projectId = activeProjectId;
      if (showLoading) setLoading(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/knowledge`, {
          cache: "no-store",
        });
        const result = (await response.json()) as KnowledgePayload & {
          error?: string;
          message?: string;
        };
        if (!response.ok)
          throw new Error(
            errorMessage(result, "Knowledge tidak dapat dimuat."),
          );
        setSnapshot({ projectId, data: result });
        setError(null);
        void loadGraphSnapshots(projectId);
      } catch (cause) {
        setSnapshot((current) =>
          current?.projectId === projectId ? null : current,
        );
        setError(
          cause instanceof Error
            ? cause.message
            : "Knowledge tidak dapat dimuat.",
        );
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [activeProjectId, loadGraphSnapshots],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    const timer = window.setTimeout(() => void loadReferencePack(projectId), 0);
    return () => window.clearTimeout(timer);
  }, [activeProjectId, loadReferencePack]);

  useEffect(() => {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    const timer = window.setTimeout(
      () => void loadGraphSnapshots(projectId),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [activeProjectId, loadGraphSnapshots]);

  useEffect(() => {
    if (!activeProjectId || !buildInProgress) return;
    const timer = window.setInterval(() => void refresh(false), 2_000);
    return () => window.clearInterval(timer);
  }, [activeProjectId, buildInProgress, refresh]);

  useEffect(() => {
    const dialog = sourceDialogRef.current;
    if (!dialog) return;

    if (sourceFormOpen && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => {
        document
          .getElementById(
            sourceMode === "upload" ? "source-file" : "source-name",
          )
          ?.focus();
      });
    } else if (!sourceFormOpen && dialog.open) {
      dialog.close();
      const returnFocus = sourceReturnFocusRef.current;
      if (returnFocus?.isConnected) {
        window.requestAnimationFrame(() => returnFocus.focus());
      }
    }
  }, [sourceFormOpen, sourceMode]);

  const selectedBuildSources = buildSourceIds
    .filter((id) => currentSources.some((source) => source.id === id));

  function toggleBuildSource(sourceId: string, checked: boolean) {
    if (!activeProjectId) return;
    setBuildSelections((current) => {
      const previous = (current[activeProjectId] ?? []).filter((id) =>
        currentSources.some((source) => source.id === id),
      );
      return {
        ...current,
        [activeProjectId]: checked
          ? [...new Set([...previous, sourceId])]
          : previous.filter((id) => id !== sourceId),
      };
    });
    setBuildPreview(null);
    setBuildIdempotencyKey(null);
  }

  function toggleRetrievalSource(sourceId: string, checked: boolean) {
    if (!activeProjectId) return;
    setRetrievalSelections((current) => {
      const previous = (current[activeProjectId] ?? []).filter((id) =>
        currentSources.some((source) => source.id === id),
      );
      return {
        ...current,
        [activeProjectId]: checked
          ? [...new Set([...previous, sourceId])]
          : previous.filter((id) => id !== sourceId),
      };
    });
    setRetrievalPreview(null);
  }

  async function saveSource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) {
      setSourceError("Pilih proyek sebelum menyimpan sumber.");
      return;
    }
    if (!data) {
      setSourceError(
        "Database knowledge belum tersedia untuk menyimpan sumber.",
      );
      return;
    }
    setSourceBusy(true);
    setSourceError(null);
    setSourceMessage(null);
    const form = new FormData();
    form.set("sourceKind", sourceMode === "upload" ? "upload" : "paste");
    form.set("permission", sourcePermission);
    if (sourceMode === "upload") {
      if (!selectedFile) {
        setSourceError("Pilih file sumber terlebih dahulu.");
        setSourceBusy(false);
        return;
      }
      const isPdf =
        /\.pdf$/iu.test(selectedFile.name) ||
        selectedFile.type.toLowerCase() === "application/pdf";
      if (isPdf && selectedFile.type.toLowerCase() !== "application/pdf") {
        setSourceError("File PDF harus memiliki MIME type application/pdf.");
        setSourceBusy(false);
        return;
      }
      const maxUploadBytes = isPdf ? MAX_PDF_FILE_BYTES : MAX_SOURCE_BYTES;
      if (selectedFile.size > maxUploadBytes) {
        setSourceError(
          `Ukuran file melewati batas ${maxUploadBytes.toLocaleString("id-ID")} byte.`,
        );
        setSourceBusy(false);
        return;
      }
      form.set("file", selectedFile);
    } else {
      const contentBytes = new TextEncoder().encode(pasteContent).byteLength;
      if (contentBytes > MAX_SOURCE_BYTES) {
        setSourceError(
          `Teks melewati batas ${MAX_SOURCE_BYTES.toLocaleString("id-ID")} byte UTF-8.`,
        );
        setSourceBusy(false);
        return;
      }
      form.set("displayName", pasteName);
      form.set("content", pasteContent);
    }
    const sourceName =
      sourceMode === "upload" ? (selectedFile?.name ?? "") : pasteName;
    if (vaultPath.trim() && !/\.(md|markdown)$/iu.test(sourceName)) {
      setSourceError("Path vault hanya tersedia untuk sumber Markdown.");
      setSourceBusy(false);
      return;
    }
    if (vaultPath.trim()) form.set("vaultPath", vaultPath.trim());
    try {
      const target = replaceSourceId
        ? `/api/projects/${activeProjectId}/knowledge/sources/${replaceSourceId}`
        : `/api/projects/${activeProjectId}/knowledge/sources`;
      const response = await fetch(target, {
        method: replaceSourceId ? "PUT" : "POST",
        body: form,
      });
      const result = (await response.json()) as {
        source?: { version?: number };
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(errorMessage(result, "Sumber tidak dapat disimpan."));
      setSourceMessage(
        selectedFile &&
          (/\.pdf$/iu.test(selectedFile.name) ||
            selectedFile.type.toLowerCase() === "application/pdf")
          ? "PDF disimpan. Hanya lapisan teks yang diekstrak; OCR tidak dilakukan."
          : replaceSourceId
            ? "Versi sumber baru tersimpan."
            : "Sumber tersimpan.",
      );
      setPasteContent("");
      setVaultPath("");
      setSelectedFile(null);
      setFileInputKey((current) => current + 1);
      setReplaceSourceId("");
      setBuildPreview(null);
      setBuildIdempotencyKey(null);
      setSourceFormOpen(false);
      await refresh(false);
    } catch (cause) {
      setSourceError(
        cause instanceof Error ? cause.message : "Sumber tidak dapat disimpan.",
      );
    } finally {
      setSourceBusy(false);
    }
  }

  function openVersionEditor(
    source: SourceSummary,
    returnFocus?: HTMLElement | null,
  ) {
    sourceReturnFocusRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setReplaceSourceId(source.id);
    setSourcePermission(source.permission);
    setSourceMode("upload");
    setSelectedFile(null);
    setFileInputKey((current) => current + 1);
    setPasteName(source.displayName);
    setPasteContent("");
    setVaultPath("");
    setSourceError(null);
    setSourceMessage(null);
    setSourceFormOpen(true);
  }

  function showGraphBuildTools() {
    const disclosure = document.getElementById(
      "knowledge-advanced-tools",
    ) as HTMLDetailsElement | null;
    if (disclosure) {
      disclosure.open = true;
      setAdvancedToolsOpen(true);
    }
    window.requestAnimationFrame(() =>
      document
        .getElementById("knowledge-graph-build")
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }

  async function previewSource(source: SourceSummary) {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    setSourcePreviewBusy(source.id);
    setSourcePreviewError(null);
    try {
      const response = await fetch(
        "/api/projects/" + projectId + "/knowledge/sources/" + source.id,
        { cache: "no-store" },
      );
      const result = (await response.json()) as {
        source?: SourceDetailPreview;
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.source) {
        throw new Error(
          errorMessage(result, "Pratinjau sumber belum dapat dimuat."),
        );
      }
      setSourcePreview({ projectId, source: result.source });
    } catch (cause) {
      setSourcePreview(null);
      setSourcePreviewError(
        cause instanceof Error
          ? cause.message
          : "Pratinjau sumber belum dapat dimuat.",
      );
    } finally {
      setSourcePreviewBusy(null);
    }
  }

  async function removeSource(source: SourceSummary) {
    if (
      !activeProjectId ||
      !window.confirm(
        `Hapus sumber “${source.displayName}”? Versi dan bukti lama langsung tidak dapat dipakai.`,
      )
    )
      return;
    setPermissionError(null);
    setPermissionMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/knowledge/sources/${source.id}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(errorMessage(result, "Sumber tidak dapat dihapus."));
      setSourcePreview((current) =>
        current?.source.id === source.id ? null : current,
      );
      setPermissionMessage("Sumber dihapus dan readiness proyek diperbarui.");
      setBuildPreview(null);
      setBuildIdempotencyKey(null);
      await refresh(false);
    } catch (cause) {
      setPermissionError(
        cause instanceof Error ? cause.message : "Sumber tidak dapat dihapus.",
      );
    }
  }

  async function importReferencePack() {
    if (!activeProjectId || !data || referenceImportBusy) return;
    setReferenceImportBusy(true);
    setReferenceError(null);
    setReferenceImportMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/knowledge/reference-pack`,
        {
          method: "POST",
        },
      );
      const result = (await response.json()) as ReferenceImportPayload;
      if (!response.ok)
        throw new Error(
          errorMessage(result, "Referensi umum tidak dapat ditambahkan."),
        );
      const imported = result.imported ?? 0;
      const skipped = result.skipped ?? 0;
      setReferenceImportMessage(
        `${imported} sumber ditambahkan, ${skipped} dilewati. Paket ${result.packId ?? "tidak tersedia"}. Indexing berjalan otomatis saat worker memproses sumber.`,
      );
      await refresh(false);
    } catch (cause) {
      setReferenceError(
        cause instanceof Error
          ? cause.message
          : "Referensi umum tidak dapat ditambahkan.",
      );
    } finally {
      setReferenceImportBusy(false);
    }
  }

  async function previewBuild() {
    if (!activeProjectId || !selectedBuildSources.length) {
      setBuildError("Pilih minimal satu sumber untuk build.");
      return;
    }
    setBuildBusy(true);
    setBuildError(null);
    setBuildIdempotencyKey(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/graph/build-preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceIds: selectedBuildSources }),
        },
      );
      const result = (await response.json()) as {
        preview?: Omit<BuildPreview, "projectId">;
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.preview)
        throw new Error(errorMessage(result, "Build preview gagal."));
      const next = { ...result.preview, projectId: activeProjectId };
      setBuildPreview(next);
      setBuildIdempotencyKey(crypto.randomUUID());
      setMaxModelCalls(next.selectedMaxModelCalls);
    } catch (cause) {
      setBuildPreview(null);
      setBuildIdempotencyKey(null);
      setBuildError(
        cause instanceof Error ? cause.message : "Build preview gagal.",
      );
    } finally {
      setBuildBusy(false);
    }
  }

  async function enqueueBuild() {
    if (!activeProjectId || !buildPreview) {
      setBuildError("Tinjau preview sumber terlebih dahulu untuk enqueue.");
      return;
    }
    setBuildBusy(true);
    setBuildError(null);
    const idempotencyKey = buildIdempotencyKey ?? crypto.randomUUID();
    setBuildIdempotencyKey(idempotencyKey);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/graph/builds`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceIds: selectedBuildSources,
            maxModelCalls,
            idempotencyKey,
          }),
        },
      );
      const result = (await response.json()) as {
        build?: { id: string; state: string; created: boolean };
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.build)
        throw new Error(errorMessage(result, "Build tidak dapat diantrekan."));
      setSourceMessage(
        result.build.created
          ? "Build masuk antrean."
          : "Build idempoten yang sama sudah ada.",
      );
      setBuildPreview(null);
      setBuildIdempotencyKey(null);
      await refresh(false);
    } catch (cause) {
      setBuildError(
        cause instanceof Error
          ? cause.message
          : "Build tidak dapat diantrekan.",
      );
    } finally {
      setBuildBusy(false);
    }
  }

  async function cancelBuild(buildId: string) {
    if (!activeProjectId) return;
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/graph/builds/${buildId}/cancel`,
        { method: "POST" },
      );
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(errorMessage(result, "Build tidak dapat dibatalkan."));
      await refresh(false);
    } catch (cause) {
      setBuildError(
        cause instanceof Error
          ? cause.message
          : "Build tidak dapat dibatalkan.",
      );
    }
  }

  async function runRetrievalPreview() {
    if (!activeProjectId || !retrievalQuery.trim()) {
      setRetrievalError("Masukkan pertanyaan untuk melihat bukti.");
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
            sourceIds: retrievalSourceIds,
            ...(retrievalSnapshotSelection
              ? { snapshotId: retrievalSnapshotSelection }
              : {}),
          }),
        },
      );
      const result = (await response.json()) as {
        retrieval?: RetrievalPreview;
        error?: string;
        message?: string;
      };
      if (!response.ok || !result.retrieval)
        throw new Error(errorMessage(result, "Retrieval preview gagal."));
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

  async function reviewAssertion(
    assertion: AssertionSummary,
    decision: "accept" | "reject",
  ) {
    if (!activeProjectId) return;
    setReviewBusy(assertion.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${activeProjectId}/graph/assertions/${assertion.id}/review`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: assertion.version,
            decision,
            reason: reviewReasons[assertion.id] ?? "",
          }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(errorMessage(result, "Review tidak dapat disimpan."));
      await refresh(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Review tidak dapat disimpan.",
      );
    } finally {
      setReviewBusy(null);
    }
  }

  const knowledgeStatus = !activeProjectId
    ? "Pilih proyek"
    : data
      ? null
      : loading
        ? "Memuat…"
        : error
          ? "Tidak dapat dimuat"
          : "Status belum tersedia";
  const snapshotStatusLabel =
    knowledgeStatus ??
    (data?.readiness.snapshot.status === "active"
      ? "Aktif"
      : data?.readiness.snapshot.status === "stale"
        ? "Perlu build ulang"
        : data?.readiness.snapshot.status === "none"
          ? "Belum dibuat"
          : (data?.readiness.snapshot.status ?? "Belum tersedia"));
  const graphReadinessLabel =
    knowledgeStatus ??
    (data?.readiness.documents.eligible === 0
      ? "Belum ada sumber"
      : data?.readiness.retrieval.graphAvailable
        ? "Snapshot tersedia"
        : "Belum tersedia");
  const indexerStatusLabel =
    knowledgeStatus ??
    (data?.readiness.indexer.ready
      ? `Siap · ${data.readiness.indexer.requestedModel}`
      : "Belum siap");
  const graphSnapshotLabel =
    knowledgeStatus ??
    (data?.snapshotId
      ? `Snapshot ${data.snapshotId.slice(0, 8)}`
      : "Belum ada snapshot");
  const indexedSourceCount = listedSources.filter(
    (source) => source.extractStatus === "ready" && source.chunkCount > 0,
  ).length;
  const semanticReadyCount = listedSources.filter(
    (source) => source.semanticReadiness?.status === "ready",
  ).length;
  const coverage = data?.readiness.snapshot.coverage ?? {};
  const graphEntityCount = Number(
    coverage.entityCount ?? coverage.nodeCount ?? 0,
  );
  const graphRelationCount = Number(
    coverage.supportedCount ?? coverage.linkCount ?? coverage.assertionCount ?? 0,
  );
  const graphHealthLabel =
    knowledgeStatus ??
    (data?.readiness.build.state === "failed"
      ? "Gagal"
      : data?.readiness.build.state === "queued" ||
          data?.readiness.build.state === "running"
        ? "Sedang diindeks"
        : data?.readiness.snapshot.status === "stale"
          ? "Graph perlu diperbarui"
          : data?.readiness.snapshot.status === "active"
            ? "Siap"
            : "Belum dibangun");
  const sourceSummaryNotice = !data
    ? (knowledgeStatus ?? "Status sumber belum tersedia.")
    : sourcesNeedingReview.length
      ? `${sourcesNeedingReview.length} sumber perlu ditinjau sebelum aktif.`
      : currentSources.length
        ? null
        : "Belum ada sumber. Tambahkan file atau tempel teks.";

  return (
    <div className={`knowledge-workspace ${styles.workspace}`}>
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      {!activeProjectId ? (
        <p className="helper" role="status">
          Pilih proyek untuk melihat dan mengelola file sumber.
        </p>
      ) : null}
      <section className={styles.sourceOverview} aria-label="Ringkasan sumber">
        <div className={styles.overviewHeading}>
          <span className="helper">Ringkasan basis pengetahuan proyek</span>
          <Badge variant={graphHealthLabel === "Siap" ? "success" : graphHealthLabel === "Gagal" ? "danger" : graphHealthLabel === "Belum dibangun" ? "muted" : "warning"}>
            {graphHealthLabel}
          </Badge>
        </div>
        <div className={styles.overviewMetrics}>
          <div><strong>{data ? listedSources.length : "—"}</strong><span>Total sumber</span></div>
          <div><strong>{data ? indexedSourceCount : "—"}</strong><span>Lexical · {data ? semanticReadyCount : "—"} semantik siap</span></div>
          <div><strong>{data?.readiness.snapshot.status === "active" ? graphEntityCount : "—"}</strong><span>Entitas graph</span></div>
          <div><strong>{data?.readiness.snapshot.status === "active" ? graphRelationCount : "—"}</strong><span>Relasi graph</span></div>
        </div>
        <Button
          type="button"
          disabled={!activeProjectId}
          aria-expanded={sourceFormOpen}
          aria-controls={sourceFormOpen ? "knowledge-add-source" : undefined}
          onClick={(event) => {
            sourceReturnFocusRef.current = event.currentTarget;
            setReplaceSourceId("");
            setSourcePermission("local_only");
            setSelectedFile(null);
            setFileInputKey((current) => current + 1);
            setSourceMode("upload");
            setPasteName("Catatan baru.md");
            setPasteContent("");
            setVaultPath("");
            setSourceError(null);
            setSourceMessage(null);
            setSourceFormOpen(true);
          }}
        >
          <Upload aria-hidden="true" size={16} /> Tambah sumber
        </Button>
      </section>

      {sourceMessage ? (
        <p className={`success-message ${styles.sourceFeedback}`} role="status">
          {sourceMessage}
        </p>
      ) : null}

      <dialog
        ref={sourceDialogRef}
        id="knowledge-add-source"
        className={styles.sourceDialog}
        aria-labelledby="knowledge-add-source-title"
        aria-describedby="knowledge-add-source-description"
        onCancel={(event) => {
          event.preventDefault();
          setSourceFormOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setSourceFormOpen(false);
          }
        }}
      >
        <Card>
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle id="knowledge-add-source-title">
                  {replaceSourceId ? "Ganti versi sumber" : "Tambah sumber"}
                </CardTitle>
                <CardDescription id="knowledge-add-source-description">
                  {replaceSourceId
                    ? "Unggah file baru untuk menyimpan versi berikutnya."
                    : "Pilih cara memasukkan sumber, lalu tinjau sebelum disimpan."}
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Tutup form sumber"
                onClick={() => setSourceFormOpen(false)}
              >
                <X aria-hidden="true" size={17} />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div
              className="form-row source-mode-switch"
              role="group"
              aria-label="Pilih cara memasukkan sumber"
            >
              <Button
                type="button"
                variant={sourceMode === "upload" ? "secondary" : "ghost"}
                aria-pressed={sourceMode === "upload"}
                onClick={() => setSourceMode("upload")}
              >
                Unggah file
              </Button>
              <Button
                type="button"
                variant={sourceMode === "paste" ? "secondary" : "ghost"}
                aria-pressed={sourceMode === "paste"}
                onClick={() => setSourceMode("paste")}
              >
                Tempel teks
              </Button>
            </div>
            <form
              className={`knowledge-ingest ${styles.sourceForm}`}
              onSubmit={(event) => void saveSource(event)}
            >
              <div className="field">
                <label htmlFor="source-permission">Izin pemrosesan sumber</label>
                <select
                  id="source-permission"
                  className="select"
                  value={sourcePermission}
                  onChange={(event) => setSourcePermission(event.target.value as Permission)}
                >
                  <option value="local_only">Hanya perangkat</option>
                  <option value="campus_indexer_allowed">Izinkan indexer kampus</option>
                </select>
                <span className="helper">
                  Sumber baru tetap di perangkat sampai Anda memilih izin indexer kampus. Izin ini menentukan apakah sumber dapat dipakai membangun Knowledge Graph.
                </span>
              </div>
              {sourceMode === "paste" ? (
                <>
                  <div className="field">
                    <label htmlFor="source-name">Nama sumber</label>
                    <input
                      id="source-name"
                      className="input"
                      value={pasteName}
                      onChange={(event) => setPasteName(event.target.value)}
                      maxLength={240}
                      required
                    />
                    <span className="helper">
                      Nama ini tampil di daftar sumber.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="source-content">Teks sumber</label>
                    <textarea
                      id="source-content"
                      className="input source-content-input"
                      value={pasteContent}
                      onChange={(event) => setPasteContent(event.target.value)}
                      maxLength={MAX_SOURCE_BYTES}
                      required
                      placeholder="Tempel isi dokumen yang ingin digunakan sebagai sumber."
                    />
                  </div>
                </>
              ) : (
                <div className="field">
                  <label htmlFor="source-file">File sumber</label>
                  <label className={styles.filePicker} htmlFor="source-file">
                    <span className={styles.filePickerAction}>Pilih file</span>
                    <span className={styles.filePickerName} aria-live="polite">
                      {selectedFile?.name ?? "Belum ada file dipilih"}
                    </span>
                    <input
                      key={fileInputKey}
                      id="source-file"
                      className={styles.filePickerInput}
                      type="file"
                      aria-label="File sumber"
                      aria-describedby="source-file-help"
                      onChange={(event) =>
                        setSelectedFile(event.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  <span id="source-file-help" className="helper">
                    Ekstensi bebas. File selain PDF harus berisi teks yang dapat
                    dibaca.
                  </span>
                </div>
              )}
              <details className={styles.sourceOptions}>
                <summary>Opsi tambahan</summary>
                <div className={styles.sourceOptionsContent}>
                  <div className="field">
                    <label htmlFor="source-vault-path">
                      Path catatan Markdown{" "}
                      <span className="helper">(opsional)</span>
                    </label>
                    <input
                      id="source-vault-path"
                      className="input"
                      value={vaultPath}
                      onChange={(event) => setVaultPath(event.target.value)}
                      maxLength={500}
                      placeholder="notes/overview.md"
                    />
                    <span className="helper">
                      Disimpan sebagai metadata; file lokal tidak dibuka.
                    </span>
                  </div>
                  {sources.some((source) => !source.deleted) ? (
                    <div className="field">
                      <label htmlFor="replace-source">
                        Simpan sebagai versi baru{" "}
                        <span className="helper">(opsional)</span>
                      </label>
                      <select
                        id="replace-source"
                        className="select"
                        value={replaceSourceId}
                        onChange={(event) =>
                          {
                            const nextId = event.target.value;
                            setReplaceSourceId(nextId);
                            const nextSource = sources.find((source) => source.id === nextId);
                            setSourcePermission(nextSource?.permission ?? "local_only");
                          }
                        }
                      >
                        <option value="">Buat sumber baru</option>
                        {sources
                          .filter((source) => !source.deleted)
                          .map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.displayName} · v{source.version}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}
                  <details className={styles.sourceLimits}>
                    <summary>Batas dan dukungan file</summary>
                    <p className="helper">
                      Ekstensi bebas. File selain PDF harus berupa teks UTF-8;
                      CSV dan JSON dibaca sebagai teks biasa. PDF perlu lapisan
                      teks, OCR tidak dilakukan, maksimal 50 halaman dan{" "}
                      {MAX_PDF_FILE_BYTES.toLocaleString("id-ID")} byte. Teks
                      dibatasi {MAX_SOURCE_BYTES.toLocaleString("id-ID")} byte.
                    </p>
                  </details>
                </div>
              </details>
              {sourceError ? (
                <p className="error-message" role="alert">
                  {sourceError}
                </p>
              ) : null}
              <div className={styles.sourceFormActions}>
                <Button
                  type="submit"
                  disabled={sourceBusy || !activeProjectId || !data}
                >
                  <Upload aria-hidden="true" size={15} />
                  {sourceBusy
                    ? "Menyimpan…"
                    : replaceSourceId
                      ? "Simpan versi baru"
                      : "Simpan sumber"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setReplaceSourceId("");
                    setSourceFormOpen(false);
                  }}
                >
                  Batal
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </dialog>

      <div
        className={styles.viewSwitch}
        role="group"
        aria-label="Tampilan sumber"
      >
        <Button
          type="button"
          variant={workspaceView === "files" ? "secondary" : "ghost"}
          aria-pressed={workspaceView === "files"}
          onClick={() => setWorkspaceView("files")}
        >
          File <span>{listedSources.length}</span>
        </Button>
        <Button
          type="button"
          variant={workspaceView === "relations" ? "secondary" : "ghost"}
          aria-pressed={workspaceView === "relations"}
          onClick={() => setWorkspaceView("relations")}
        >
          Peta relasi <span>{activeAssertions.length}</span>
        </Button>
      </div>

      {workspaceView === "files" ? (
        <Card className={styles.sourcesCard}>
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle>File sumber</CardTitle>
              </div>
              <div className={styles.sourceTools}>
                <label className="sr-only" htmlFor="knowledge-source-search">
                  Cari sumber
                </label>
                <div className={styles.searchField}>
                  <Search aria-hidden="true" size={15} />
                  <input
                    id="knowledge-source-search"
                    type="search"
                    value={sourceSearch}
                    onChange={(event) => setSourceSearch(event.target.value)}
                    placeholder="Cari file…"
                  />
                </div>
                <label className="sr-only" htmlFor="knowledge-source-status">Filter status sumber</label>
                <select
                  id="knowledge-source-status"
                  className="select"
                  value={sourceStatusFilter}
                  onChange={(event) => setSourceStatusFilter(event.target.value)}
                >
                  <option value="all">Semua status</option>
                  <option value="indexed">Terindeks</option>
                  <option value="pending">Belum terindeks</option>
                  <option value="review">Perlu ditinjau</option>
                  <option value="local">Hanya perangkat</option>
                </select>
                <label className="sr-only" htmlFor="knowledge-source-type">Filter jenis sumber</label>
                <select
                  id="knowledge-source-type"
                  className="select"
                  value={sourceTypeFilter}
                  onChange={(event) => setSourceTypeFilter(event.target.value)}
                >
                  <option value="all">Semua jenis</option>
                  {[...new Set(listedSources.map((source) => source.contentType ?? source.sourceKind))].sort().map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Muat ulang sumber"
                  onClick={() => void refresh(true)}
                  disabled={loading}
                >
                  <RefreshCw aria-hidden="true" size={15} />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {permissionMessage ? (
              <p className="success-message" role="status">
                {permissionMessage}
              </p>
            ) : null}
            {permissionError ? (
              <p className="error-message" role="alert">
                {permissionError}
              </p>
            ) : null}
            <div className={`${styles.sourceListAndPreview} ${sourcePreview?.projectId === activeProjectId ? styles.withPreview : ""}`}>
            <div className={styles.sourceListPane}>
            {visibleSources.length ? (
              <ul className="knowledge-source-list">
                {visibleSources.map((source) => (
                  <li
                    className={`knowledge-source-card ${styles.compactSourceRow}`}
                    id={`knowledge-source-${source.id}`}
                    key={source.id}
                  >
                    <div className={styles.sourceRowMain}>
                      <div className={styles.sourceIdentity}>
                        <div className="knowledge-source-icon">
                          <FileText aria-hidden="true" size={17} />
                        </div>
                        <div className="knowledge-source-title">
                          <strong>{source.displayName}</strong>
                          <span className="helper">
                            v{source.version} · diperbarui{" "}
                            {new Date(source.updatedAt).toLocaleDateString(
                              "id-ID",
                            )}
                          </span>
                        </div>
                      </div>
                      <div className={styles.sourceActionGroup}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={sourcePreviewBusy === source.id}
                          onClick={() => void previewSource(source)}
                        >
                          <FileText aria-hidden="true" size={14} />
                          {sourcePreviewBusy === source.id
                            ? "Memuat…"
                            : "Pratinjau"}
                        </Button>
                        <details className={styles.sourceMoreActions}>
                          <summary
                            aria-label={
                              "Aksi lainnya untuk " + source.displayName
                            }
                          >
                            <MoreHorizontal aria-hidden="true" size={17} />
                            <span className="sr-only">
                              Aksi lainnya untuk {source.displayName}
                            </span>
                          </summary>
                          <div className={styles.sourceMoreMenu}>
                            <button
                              type="button"
                              onClick={(event) => {
                                const menu =
                                  event.currentTarget.closest("details");
                                const summary = menu?.querySelector("summary");
                                openVersionEditor(
                                  source,
                                  summary instanceof HTMLElement
                                    ? summary
                                    : null,
                                );
                                menu?.removeAttribute("open");
                              }}
                            >
                              Ganti dengan versi baru
                            </button>
                            <button
                              type="button"
                              className={styles.sourceDeleteAction}
                              onClick={(event) => {
                                event.currentTarget
                                  .closest("details")
                                  ?.removeAttribute("open");
                                void removeSource(source);
                              }}
                            >
                              <Trash2 aria-hidden="true" size={14} /> Hapus
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>
                    <div className={styles.sourceMetaLine}>
                      <Badge variant="muted">
                        {source.contentType ?? source.sourceKind}
                      </Badge>
                      <Badge variant={source.extractStatus === "ready" && source.chunkCount > 0 ? "success" : "warning"}>
                        {source.extractStatus === "ready" && source.chunkCount > 0 ? "Terindeks" : source.extractStatus === "failed" ? "Gagal diproses" : "Menunggu indeks"}
                      </Badge>
                      <Badge variant={source.semanticReadiness?.status === "ready" ? "success" : "muted"}>
                        {source.semanticReadiness?.status === "ready" ? "Semantik siap" : "Semantik belum siap"}
                      </Badge>
                      <Badge variant={source.permission === "local_only" ? "warning" : "muted"}>
                        {source.permission === "local_only" ? "Hanya perangkat" : "Izin indeks kampus"}
                      </Badge>
                      {!source.eligible ? (
                        <Badge variant="warning">Perlu ditinjau</Badge>
                      ) : null}
                    </div>
                    {source.semanticReadiness?.profiles?.length ? (
                      <details className={styles.sourceIndexDetails}>
                        <summary>Detail indeks</summary>
                        <div>
                          <strong>Lengkap pada profil tersimpan</strong>
                          {source.semanticReadiness.profiles.map((profile, index) => (
                            <p key={`${profile.requestedModel}-${index}`}>
                              {profile.requestedModel} → {profile.observedModel} · {profile.embeddedChunkCount}/{profile.chunkCount} chunk · {profile.status === "ready" ? "lengkap" : "sebagian"}
                            </p>
                          ))}
                          <small>Coverage ini menggambarkan indeks tersimpan; kecocokan dengan profil query saat retrieval belum diverifikasi.</small>
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state knowledge-empty-state">
                <div>
                  <FileText aria-hidden="true" size={22} />
                  <p>
                    {listedSources.length && normalizedSourceSearch
                      ? "Tidak ada sumber yang cocok dengan pencarian."
                      : !activeProjectId
                        ? "Pilih proyek untuk melihat sumber."
                        : loading
                          ? "Memuat sumber…"
                          : data
                            ? "Belum ada sumber pada proyek ini."
                            : "Sumber belum dapat dimuat."}
                  </p>
                  <p className="helper">
                    {listedSources.length && normalizedSourceSearch
                      ? "Coba nama atau jenis sumber yang berbeda."
                      : !activeProjectId
                        ? "Pilih proyek di bagian atas untuk melihat atau menambahkan sumber."
                        : "Gunakan Tambah sumber di atas untuk mengunggah file atau menempel teks. File dari folder kerja lokal dapat diimpor dari bagian lanjutan."}
                  </p>
                </div>
              </div>
            )}
            {sourcePreviewError ? (
              <p className="error-message" role="alert">
                {sourcePreviewError}
              </p>
            ) : null}
            </div>
            {sourcePreview?.projectId === activeProjectId ? (
              <section
                className={styles.sourcePreview}
                aria-label="Pratinjau sumber terpilih"
              >
                <div className={styles.sourcePreviewHeading}>
                  <div>
                    <h3>{sourcePreview.source.displayName}</h3>
                    <p className="helper">
                      v{sourcePreview.source.version} ·{" "}
                      {sourcePreview.source.chunks.length} chunk · SHA-256{" "}
                      {sourcePreview.source.checksum.slice(0, 12)}…
                    </p>
                    {sourcePreview.source.sourceMetadata.origin ===
                      "local_workspace" &&
                    typeof sourcePreview.source.sourceMetadata.relativePath ===
                      "string" ? (
                      <p className="helper">
                        Asal lokal:{" "}
                        {sourcePreview.source.sourceMetadata.relativePath}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSourcePreview(null)}
                  >
                    Tutup pratinjau
                  </Button>
                </div>
                {sourcePreview.source.chunks.slice(0, 5).map((chunk) => (
                  <article className={styles.sourcePreviewChunk} key={chunk.id}>
                    <strong>
                      {chunk.heading || "Bagian " + (chunk.ordinal + 1)}
                      {chunk.pageNumber ? " · halaman " + chunk.pageNumber : ""}
                    </strong>
                    <p>{chunk.content}</p>
                  </article>
                ))}
                {sourcePreview.source.chunks.length > 5 ? (
                  <p className="helper">
                    Menampilkan 5 dari {sourcePreview.source.chunks.length}{" "}
                    chunk.
                  </p>
                ) : null}
              </section>
            ) : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <section className={styles.graphExplorerSection} aria-label="Knowledge Graph">
          <div className={styles.graphExplorerHeading}>
            <div>
              <h2>Knowledge Graph</h2>
              <p>Jelajahi hubungan yang didukung bukti dari sumber proyek.</p>
            </div>
            <Badge variant={graphIsStale ? "warning" : data?.snapshotId ? "success" : "muted"}>
              {graphHealthLabel}
            </Badge>
          </div>
          <KnowledgeGraphExplorer
            assertions={activeAssertions}
            hasSnapshot={Boolean(data?.snapshotId)}
            isStale={graphIsStale}
            sourceIds={listedSources.map((source) => source.id)}
            onOpenSource={(sourceId) => {
              const source = listedSources.find((item) => item.id === sourceId);
              if (source) {
                setWorkspaceView("files");
                void previewSource(source);
              }
            }}
            onBuildGraph={showGraphBuildTools}
          />
        </section>
      )}

      <details
        id="knowledge-advanced-tools"
        className={styles.advancedDiagnostics}
        open={advancedToolsOpen}
        onToggle={(event) => setAdvancedToolsOpen(event.currentTarget.open)}
      >
        <summary>
          Alat lanjutan · indeks, build GraphRAG, retrieval, referensi, impor
          lokal
        </summary>
        <div className={styles.advancedFacts}>
          <span>Snapshot: {snapshotStatusLabel}</span>
          <span>GraphRAG: {graphReadinessLabel}</span>
          <span>Indexer: {indexerStatusLabel}</span>
          <span>Snapshot graph: {graphSnapshotLabel}</span>
          {activeProjectId ? (
            <div className={styles.memoryExport}>
              <Button asChild variant="ghost">
                <a
                  href={`/api/projects/${activeProjectId}/memory?format=markdown&audience=evaluator`}
                  aria-label="Unduh wiki verified memory evaluator, termasuk kasus dan kriteria holdout"
                >
                  <FileText aria-hidden="true" size={15} /> Wiki evaluator
                </a>
              </Button>
              <span className="helper">
                Ekspor Markdown untuk evaluator, bukan retrieval runtime.
              </span>
            </div>
          ) : null}
        </div>
        <div className={styles.advancedGrid}>
          <details className={styles.secondaryDisclosure}>
            <summary>Referensi umum · sumber publik dan preview</summary>
            <Card
              className={`knowledge-reference-pack ${styles.referenceCard}`}
            >
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle>Referensi umum</CardTitle>
                    <CardDescription>
                      Kumpulan ringkas dari sumber publik untuk prompt,
                      evaluasi, retrieval, keamanan, dan provenance. Preview
                      hanya membaca metadata dan kutipan; belum mengimpor atau
                      mengindeks sumber.
                    </CardDescription>
                  </div>
                  <Badge variant="muted">
                    {referenceData?.metadata.status ===
                    "researched_only_not_ingested"
                      ? "Belum ditambahkan"
                      : referenceData
                        ? "Siap ditinjau"
                        : referenceLoading
                          ? "Memuat referensi"
                          : "Status belum tersedia"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="reference-pack-content">
                {activeProjectId && referenceError ? (
                  <div className="knowledge-reference-error" role="alert">
                    <p>{referenceError}</p>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!activeProjectId || referenceLoading}
                      onClick={() => {
                        if (activeProjectId)
                          void loadReferencePack(activeProjectId);
                      }}
                    >
                      {referenceLoading ? "Memuat…" : "Muat ulang referensi"}
                    </Button>
                  </div>
                ) : null}
                {referenceData ? (
                  <>
                    <div className="reference-pack-summary">
                      <div>
                        <span className="panel-label">Kumpulan sumber</span>
                        <strong>
                          {referenceData.metadata.corpus_id ?? "Referensi umum"}
                        </strong>
                        <span className="helper">
                          {referenceData.metadata.scope?.bounds?.source_count ??
                            referenceData.sources.length}{" "}
                          sumber ·{" "}
                          {referenceData.metadata.scope?.bounds?.chunk_count ??
                            referenceData.previews.length}{" "}
                          ringkasan · versi riset{" "}
                          {referenceData.metadata.schema_version ??
                            "tidak tersedia"}
                        </span>
                        {referenceData.metadata.scope?.purpose ? (
                          <p className="helper">
                            {referenceData.metadata.scope.purpose}
                          </p>
                        ) : null}
                        {referenceData.metadata.source_snapshot_at_utc ? (
                          <span className="helper">
                            Ditinjau{" "}
                            {new Date(
                              referenceData.metadata.source_snapshot_at_utc,
                            ).toLocaleString("id-ID", { timeZone: "UTC" })}{" "}
                            UTC
                          </span>
                        ) : null}
                      </div>
                      <div className="reference-pack-actions">
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={!activeProjectId || referenceLoading}
                          onClick={() => {
                            if (activeProjectId)
                              void loadReferencePack(activeProjectId);
                          }}
                        >
                          {referenceLoading ? "Memuat…" : "Muat ulang"}
                        </Button>
                        <Button
                          type="button"
                          disabled={
                            !activeProjectId ||
                            !data ||
                            referenceImportBusy ||
                            referenceLoading
                          }
                          onClick={() => void importReferencePack()}
                        >
                          {referenceImportBusy
                            ? "Menambahkan…"
                            : "Tambahkan referensi umum"}
                        </Button>
                      </div>
                    </div>
                    <p className="helper" role="note">
                      Sumber yang diimpor masuk ke indexing otomatis. Provider
                      yang dikonfigurasi memprosesnya saat worker berjalan.
                    </p>
                    {activeProjectId && referenceImportMessage ? (
                      <p className="success-message" role="status">
                        {referenceImportMessage}
                      </p>
                    ) : null}
                    <section aria-labelledby="reference-source-list-title">
                      <h3 id="reference-source-list-title">Sumber publik</h3>
                      <ul className="reference-source-list">
                        {referenceData.sources.map((source, index) => {
                          const href = publicHttpsUrl(source.url);
                          return (
                            <li
                              className="reference-source-card"
                              id={`reference-source-${index}`}
                              key={source.id}
                            >
                              <div className="reference-source-heading">
                                <div>
                                  <strong>{source.title}</strong>
                                  <span className="helper">
                                    {source.publisher} · {source.source_type}
                                  </span>
                                </div>
                                {href ? (
                                  <a
                                    className="reference-source-link"
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={`Buka sumber publik ${source.title} di tab baru`}
                                  >
                                    Buka sumber{" "}
                                    <ExternalLink
                                      size={14}
                                      aria-hidden="true"
                                    />
                                  </a>
                                ) : (
                                  <span className="helper">
                                    URL publik tidak tersedia
                                  </span>
                                )}
                              </div>
                              <p>{source.use}</p>
                              <span className="helper">
                                Diakses {source.accessed_at_utc} ·{" "}
                                {source.sections_used.join("; ")}
                              </span>
                              {source.license_caveat ||
                              source.temporal_caveat ? (
                                <details>
                                  <summary>Catatan penggunaan sumber</summary>
                                  {source.license_caveat ? (
                                    <p className="helper">
                                      Lisensi: {source.license_caveat}
                                    </p>
                                  ) : null}
                                  {source.temporal_caveat ? (
                                    <p className="helper">
                                      Waktu: {source.temporal_caveat}
                                    </p>
                                  ) : null}
                                </details>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                    <section aria-labelledby="reference-preview-list-title">
                      <h3 id="reference-preview-list-title">Preview bukti</h3>
                      <ul className="reference-preview-list">
                        {referenceData.previews.map((preview) => {
                          const sourceIndex = referenceData.sources.findIndex(
                            (source) => source.id === preview.source_id,
                          );
                          const source = referenceData.sources[sourceIndex];
                          const href = source
                            ? publicHttpsUrl(source.url)
                            : null;
                          return (
                            <li
                              className="reference-preview-card"
                              key={preview.id}
                            >
                              <div className="reference-source-heading">
                                <div>
                                  <strong>{preview.topic}</strong>
                                  <span className="helper">
                                    {source?.title ?? preview.source_id} ·{" "}
                                    {preview.source_section}
                                  </span>
                                </div>
                                {href ? (
                                  <a
                                    className="reference-source-link"
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Sumber{" "}
                                    <ExternalLink
                                      size={14}
                                      aria-hidden="true"
                                    />
                                  </a>
                                ) : null}
                              </div>
                              <p>{preview.summary}</p>
                              <blockquote>
                                {preview.evidence_excerpt}
                              </blockquote>
                              <span className="helper">
                                {preview.claim_type}
                                {sourceIndex >= 0 ? (
                                  <>
                                    {" "}
                                    ·{" "}
                                    <a
                                      href={`#reference-source-${sourceIndex}`}
                                    >
                                      Lihat provenance sumber
                                    </a>
                                  </>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  </>
                ) : !referenceError ? (
                  <p className="helper" role="status">
                    {referenceLoading
                      ? "Memuat metadata, sumber publik, dan preview…"
                      : !activeProjectId
                        ? "Pilih proyek untuk meninjau referensi umum."
                        : "Referensi umum belum tersedia."}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </details>
          <details
            className={styles.secondaryDisclosure}
            onToggle={(event) => setLocalImportOpen(event.currentTarget.open)}
          >
            <summary>Impor file dari folder kerja lokal</summary>
            {advancedToolsOpen && localImportOpen ? (
              <LocalSourceBrowser
                key={activeProjectId ?? "no-project"}
                onImported={() => refresh(false)}
              />
            ) : null}
          </details>

          <Card className={styles.buildCard} id="knowledge-graph-build">
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>Graph build</CardTitle>
                  <CardDescription>
                    Preview tidak memanggil model. Setelah Anda memilih sumber
                    dan meninjau budget, build dapat langsung diantrekan saat
                    provider indexer siap.
                  </CardDescription>
                </div>
                <Badge
                  variant={
                    data?.readiness.indexer.ready
                      ? "success"
                      : knowledgeStatus
                        ? "muted"
                        : "warning"
                  }
                >
                  {indexerStatusLabel}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="knowledge-build-content">
              <p className="helper" role="status">
                {data?.snapshotId
                  ? `Preview retrieval memakai snapshot aktif ${data.snapshotId}.`
                  : "Belum ada snapshot aktif; snapshot terbaru akan diaktifkan oleh backend setelah build selesai."}{" "}
                API saat ini menampilkan snapshot aktif. Pilih sumber di bawah
                untuk membangun snapshot berikutnya.
              </p>
              <fieldset className="source-selection build-source-selection">
                <legend>Pilih sumber untuk build</legend>
                {currentSources.length ? (
                  currentSources.map((source) => (
                    <label className="source-choice" key={source.id}>
                      <input
                        type="checkbox"
                        checked={selectedBuildSources.includes(source.id)}
                        onChange={(event) =>
                          toggleBuildSource(source.id, event.target.checked)
                        }
                      />
                      <span>
                        <span className="source-choice-name">
                          {source.displayName}
                        </span>
                        <span className="helper">
                          v{source.version} · {source.chunkCount} chunk · siap
                          dipilih untuk build
                        </span>
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="helper">
                    {!activeProjectId
                      ? "Pilih proyek sebelum memilih sumber."
                      : loading
                        ? "Memuat sumber…"
                        : data
                          ? "Belum ada sumber aktif. Simpan sumber terlebih dahulu."
                          : "Daftar sumber belum dapat dimuat."}
                  </p>
                )}
              </fieldset>
              {data?.readiness.indexer.reason ? (
                <p className="helper">{data.readiness.indexer.reason}</p>
              ) : null}
              {buildError ? (
                <p className="error-message" role="alert">
                  {buildError}
                </p>
              ) : null}
              <div className="form-row">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void previewBuild()}
                  disabled={buildBusy || !selectedBuildSources.length}
                >
                  <Search aria-hidden="true" size={15} />{" "}
                  {buildBusy ? "Memeriksa…" : "Pratinjau build"}
                </Button>
              </div>
              {currentSources.length && !selectedBuildSources.length ? (
                <p className="helper" role="status">
                  Pilih minimal satu sumber. Pilihan kosong tidak memulai build.
                </p>
              ) : null}
              {buildPreview?.projectId === activeProjectId ? (
                <section
                  className="build-preview"
                  aria-label="Pratinjau graph build"
                >
                  <h3>Pratinjau sumber dan budget</h3>
                  <dl className="build-preview-facts">
                    <div>
                      <dt>Model</dt>
                      <dd>
                        {buildPreview.requestedModel ?? "Belum dikonfigurasi"}
                      </dd>
                    </div>
                    <div>
                      <dt>Sumber</dt>
                      <dd>{buildPreview.sourceCount}</dd>
                    </div>
                    <div>
                      <dt>Chunk</dt>
                      <dd>{buildPreview.chunkCount}</dd>
                    </div>
                    <div>
                      <dt>Max model calls</dt>
                      <dd>{buildPreview.maxModelCalls}</dd>
                    </div>
                  </dl>
                  <ul className="build-preview-source-list">
                    {buildPreview.sources.map((source) => (
                      <li key={source.id}>
                        {source.name} · v{source.version} · {source.chunkCount}{" "}
                        chunk · SHA-256 {source.checksum.slice(0, 12)}…
                      </li>
                    ))}
                  </ul>
                  <div className="field build-budget-field">
                    <label htmlFor="graph-call-budget">
                      Batas panggilan model
                    </label>
                    <input
                      id="graph-call-budget"
                      className="input"
                      type="number"
                      min={buildPreview.minModelCalls}
                      max={buildPreview.maxModelCalls}
                      value={maxModelCalls}
                      onChange={(event) => {
                        setMaxModelCalls(Number(event.target.value));
                        setBuildIdempotencyKey(null);
                      }}
                    />
                    <span className="helper">
                      {buildPreview.minModelCalls} panggilan awal sampai{" "}
                      {buildPreview.maxModelCalls} termasuk maksimal satu repair
                      per chunk.
                    </span>
                  </div>
                  {buildPreview.providerReason ? (
                    <p className="error-message">
                      {buildPreview.providerReason}
                    </p>
                  ) : null}
                  <p className="helper">
                    Percobaan ulang dari preview dan budget yang sama memakai
                    kunci idempoten yang sama agar tidak membuat build duplikat.
                  </p>
                  <Button
                    type="button"
                    onClick={() => void enqueueBuild()}
                    disabled={
                      buildBusy ||
                      !buildReady ||
                      maxModelCalls < buildPreview.minModelCalls ||
                      maxModelCalls > buildPreview.maxModelCalls
                    }
                  >
                    {buildBusy ? "Mengantrekan…" : "Enqueue build"}
                  </Button>
                </section>
              ) : null}
              <div className="knowledge-builds">
                <h3>Build terakhir</h3>
                {data?.builds.length ? (
                  data.builds.slice(0, 8).map((build) => {
                    const chunkCount = build.sourceManifest.reduce(
                      (total, source) => total + (source.chunks?.length ?? 0),
                      0,
                    );
                    const budget = build.budget;
                    const completed = Array.isArray(budget.completedChunks)
                      ? budget.completedChunks.length
                      : 0;
                    const calls = Number(budget.callsUsed ?? 0);
                    const cap = Number(budget.maxModelCalls ?? 0);
                    const failed = Array.isArray(budget.failedChunks)
                      ? (budget.failedChunks as Array<{
                          chunkId: string;
                          reason: string;
                        }>)
                      : [];
                    return (
                      <article className="build-row" key={build.id}>
                        <div className="build-row-heading">
                          <div>
                            <strong>
                              {build.extractorModel ?? "Campus model"}
                            </strong>
                            <span className="helper">
                              {new Date(build.requestedAt).toLocaleString(
                                "id-ID",
                              )}{" "}
                              · {build.sourceManifest.length} sumber ·{" "}
                              {chunkCount} chunk
                            </span>
                          </div>
                          <Badge variant={statusVariant(build.state)}>
                            {buildStateLabel(build.state)}
                          </Badge>
                        </div>
                        <p className="helper">
                          Chunk selesai {completed}/{chunkCount} · calls {calls}
                          /{cap} · usage refs {build.usageRefs.length}
                        </p>
                        {failed.length ? (
                          <details className="build-failures">
                            <summary>
                              {failed.length} chunk gagal atau stale
                            </summary>
                            <ul>
                              {failed.slice(0, 20).map((failure) => (
                                <li
                                  key={`${failure.chunkId}:${failure.reason}`}
                                >
                                  <span className="mono">
                                    {failure.chunkId.slice(0, 8)}
                                  </span>{" "}
                                  · {failure.reason}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        {activeBuildStates.has(build.state) ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void cancelBuild(build.id)}
                          >
                            Batalkan build
                          </Button>
                        ) : null}
                      </article>
                    );
                  })
                ) : (
                  <p className="helper">
                    {!activeProjectId
                      ? "Pilih proyek untuk melihat status build."
                      : loading
                        ? "Memuat status build…"
                        : data
                          ? "Belum ada build. Indexing semantik berjalan otomatis setelah sumber disimpan; graph build diantrekan dari panel ini."
                          : "Status build belum dapat dimuat."}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className={styles.graphCard}>
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>Graph dan evidence</CardTitle>
                  <CardDescription>
                    extracted_supported berarti kutipan dan relasi lolos
                    validasi struktural; bukan verifikasi kebenaran semantik.
                  </CardDescription>
                </div>
                <Badge
                  variant={
                    data?.readiness.snapshot.status === "active"
                      ? "success"
                      : data?.readiness.snapshot.status === "stale"
                        ? "warning"
                        : "muted"
                  }
                >
                  {graphSnapshotLabel}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {data?.assertions.length ? (
                <ul className="assertion-list">
                  {data.assertions.map((assertion) => (
                    <li className="assertion-card" key={assertion.id}>
                      <div className="assertion-heading">
                        <p>
                          <strong>{assertion.subject}</strong>{" "}
                          <span className="helper">
                            ({assertion.subjectType})
                          </span>{" "}
                          <span className="assertion-arrow">
                            {assertion.predicate}
                          </span>{" "}
                          <strong>{assertion.object}</strong>{" "}
                          <span className="helper">
                            ({assertion.objectType})
                          </span>
                        </p>
                        <Badge variant={statusVariant(assertion.status)}>
                          {assertionStatusLabel(assertion.status)}
                        </Badge>
                      </div>
                      <p className="helper">
                        Versi assertion {assertion.version} ·{" "}
                        {assertion.eligible
                          ? "eligible"
                          : "review atau evidence tidak aktif"}{" "}
                        · kutipan cocok tidak membuktikan interpretasi semantik.
                      </p>
                      {Object.keys(assertion.qualifiers).some(
                        (key) => assertion.qualifiers[key] !== null,
                      ) ? (
                        <p className="helper">
                          Qualifiers: {JSON.stringify(assertion.qualifiers)}
                        </p>
                      ) : null}
                      {assertion.evidence.length ? (
                        <ul className="assertion-evidence-list">
                          {assertion.evidence.map((item) => (
                            <li key={item.id}>
                              <EvidenceCitation
                                item={item}
                                reviewState={assertionStatusLabel(
                                  assertion.status,
                                )}
                                traceId={item.traceId ?? item.extractionRunId}
                                traceHref={
                                  item.extractionRunId
                                    ? `/runs?run=${encodeURIComponent(item.extractionRunId)}`
                                    : null
                                }
                                localSourceId={
                                  item.sourceRef &&
                                  sources.some(
                                    (source) => source.id === item.sourceRef,
                                  )
                                    ? item.sourceRef
                                    : null
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="helper">
                          Evidence tidak lagi eligible dari sumber terkini.
                        </p>
                      )}
                      {assertion.status !== "rejected" ? (
                        <div className="assertion-review">
                          <label className="field">
                            <span>
                              Alasan review{" "}
                              <span className="helper">(opsional)</span>
                            </span>
                            <input
                              className="input"
                              maxLength={500}
                              value={reviewReasons[assertion.id] ?? ""}
                              onChange={(event) =>
                                setReviewReasons((current) => ({
                                  ...current,
                                  [assertion.id]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <div className="form-row">
                            <Button
                              type="button"
                              size="sm"
                              disabled={
                                reviewBusy === assertion.id ||
                                !assertion.evidence.length
                              }
                              onClick={() =>
                                void reviewAssertion(assertion, "accept")
                              }
                            >
                              Terima assertion
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={reviewBusy === assertion.id}
                              onClick={() =>
                                void reviewAssertion(assertion, "reject")
                              }
                            >
                              Tolak assertion
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-state">
                  <div>
                    <GitBranch aria-hidden="true" size={22} />
                    <p>
                      {!activeProjectId
                        ? "Pilih proyek untuk melihat graph."
                        : loading
                          ? "Memuat graph evidence…"
                          : data?.snapshotId
                            ? "Belum ada assertion pada snapshot aktif."
                            : data
                              ? "Belum ada snapshot aktif."
                              : "Status graph belum dapat dimuat."}
                    </p>
                    <p className="helper">
                      Bangun graph dari sumber yang Anda pilih. Relasi tanpa
                      kutipan persis tidak akan diaktifkan.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={styles.retrievalCard}>
            <CardHeader>
              <CardTitle>Pratinjau retrieval</CardTitle>
              <CardDescription>
                Query ini hanya mencari dan menyimpan trace; tidak memanggil
                model generation.
              </CardDescription>
            </CardHeader>
            <CardContent className="knowledge-retrieval-content">
              <div className="knowledge-retrieval-controls">
                <div className="field">
                  <label htmlFor="knowledge-query">Pertanyaan</label>
                  <textarea
                    id="knowledge-query"
                    className="input context-query"
                    maxLength={2_000}
                    value={retrievalQuery}
                    onChange={(event) => setRetrievalQuery(event.target.value)}
                    placeholder="Tanyakan sesuatu yang memerlukan bukti dari sumber terpilih."
                  />
                </div>
                <div className="field">
                  <label htmlFor="knowledge-strategy">Strategi</label>
                  <select
                    id="knowledge-strategy"
                    className="select"
                    value={retrievalStrategy}
                    onChange={(event) =>
                      setRetrievalStrategy(event.target.value as Strategy)
                    }
                  >
                    <option value="graph">GraphRAG</option>
                    <option value="lexical">Lexical search</option>
                    <option value="full_context">
                      Full context · dibatasi
                    </option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="knowledge-snapshot-selection">
                    Snapshot untuk preview
                  </label>
                  <select
                    id="knowledge-snapshot-selection"
                    className="select"
                    value={retrievalSnapshotSelection}
                    disabled={graphSnapshotLoading}
                    onChange={(event) => {
                      if (!activeProjectId) return;
                      setRetrievalSnapshotSelections((current) => ({
                        ...current,
                        [activeProjectId]: event.target.value,
                      }));
                      setRetrievalPreview(null);
                    }}
                  >
                    <option value="">Snapshot aktif</option>
                    {availableGraphSnapshots
                      .filter((item) => !item.active)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.revision
                            ? `Revision ${item.revision}`
                            : "Snapshot"}{" "}
                          · {item.state} ·{" "}
                          {item.current ? "sumber cocok" : "sumber berubah"}
                        </option>
                      ))}
                  </select>
                  <p className="helper">
                    {graphSnapshotLoading
                      ? "Memuat daftar snapshot…"
                      : graphSnapshotError
                        ? graphSnapshotError
                        : retrievalSnapshotSelection
                          ? availableGraphSnapshots.find(
                              (item) => item.id === retrievalSnapshotSelection,
                            )?.current
                            ? "Snapshot dipilih masih cocok dengan versi sumber saat ini."
                            : "Snapshot dipilih mungkin sudah usang; preview akan menampilkan alasan fallback dari backend."
                          : data?.readiness.snapshot.id
                            ? `Menggunakan snapshot aktif ${data.readiness.snapshot.id}.`
                            : "Belum ada snapshot aktif; preview tetap dapat memakai lexical search."}
                  </p>
                </div>
              </div>
              {currentSources.length ? (
                <fieldset className="source-selection retrieval-source-selection">
                  <legend>Sumber untuk query</legend>
                  {currentSources.map((source) => (
                    <label className="source-choice" key={source.id}>
                      <input
                        type="checkbox"
                        checked={retrievalSourceIds.includes(source.id)}
                        onChange={(event) =>
                          toggleRetrievalSource(source.id, event.target.checked)
                        }
                      />
                      <span>
                        <span className="source-choice-name">
                          {source.displayName}
                        </span>
                        <span className="helper">
                          v{source.version} · {source.chunkCount} chunk
                        </span>
                      </span>
                    </label>
                  ))}
                  {!retrievalSourceIds.length ? (
                    <p className="helper">
                      Tidak ada sumber dipilih; preview ini menghasilkan nol
                      evidence.
                    </p>
                  ) : null}
                </fieldset>
              ) : (
                <p className="helper">
                  {!activeProjectId
                    ? "Pilih proyek untuk memilih sumber."
                    : loading
                      ? "Memuat sumber…"
                      : data
                        ? "Belum ada sumber aktif; preview dengan pilihan kosong menghasilkan nol evidence."
                        : "Daftar sumber belum dapat dimuat."}
                </p>
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => void runRetrievalPreview()}
                disabled={retrievalBusy || !retrievalQuery.trim()}
              >
                <Search aria-hidden="true" size={15} />{" "}
                {retrievalBusy ? "Mencari…" : "Jalankan preview"}
              </Button>
              {retrievalError ? (
                <p className="error-message" role="alert">
                  {retrievalError}
                </p>
              ) : null}
              {activePreview ? (
                <section
                  className="retrieval-result"
                  id={`retrieval-trace-${activePreview.traceId}`}
                  aria-label="Trace retrieval"
                >
                  <div className="retrieval-result-heading">
                    <strong>
                      {activePreview.strategyUsed === "graph"
                        ? "Graph evidence"
                        : `${activePreview.strategyUsed} fallback`}
                    </strong>
                    <span className="helper">
                      {activePreview.estimatedContextTokens} token perkiraan ·{" "}
                      {activePreview.elapsedMs} ms
                    </span>
                  </div>
                  <dl className="retrieval-facts">
                    <div>
                      <dt>Snapshot</dt>
                      <dd className="mono">
                        {activePreview.snapshotId ?? "Tidak digunakan"}
                      </dd>
                    </div>
                    <div>
                      <dt>Paths</dt>
                      <dd>{activePreview.paths.length}</dd>
                    </div>
                    <div>
                      <dt>Trace</dt>
                      <dd className="mono">{activePreview.traceId}</dd>
                    </div>
                  </dl>
                  {activePreview.fallbackReason ? (
                    <p className="helper">
                      Alasan fallback: {activePreview.fallbackReason}
                    </p>
                  ) : null}
                  {activePreview.evidence.length ? (
                    <ul className="retrieval-evidence-list">
                      {activePreview.evidence.map((item) => (
                        <li key={item.id}>
                          <EvidenceCitation
                            item={item}
                            reviewState={item.reviewState}
                            traceId={item.traceId ?? activePreview.traceId}
                            traceHref={`#retrieval-trace-${activePreview.traceId}`}
                            localSourceId={
                              item.sourceRef &&
                              sources.some(
                                (source) => source.id === item.sourceRef,
                              )
                                ? item.sourceRef
                                : null
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="helper">
                      Tidak ada evidence eligible untuk query ini.
                    </p>
                  )}
                </section>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </details>
    </div>
  );
}

function EvidenceCitation({
  item,
  reviewState,
  traceId,
  traceHref,
  localSourceId,
}: {
  item: EvidenceSummary | RetrievalPreview["evidence"][number];
  reviewState?: string | null | undefined;
  traceId?: string | null | undefined;
  traceHref?: string | null | undefined;
  localSourceId?: string | null | undefined;
}) {
  const sourceUrl = publicHttpsUrl(item.sourceUrl ?? item.sourceRef);
  const sourceTitle = item.sourceTitle || item.documentName;
  return (
    <article
      className="evidence-citation"
      aria-label={`Bukti dari ${sourceTitle}, versi ${item.documentVersion}, chunk ${item.chunkId}`}
    >
      <div className="evidence-citation-heading">
        <strong>{sourceTitle}</strong>
        <span className="helper">
          v{item.documentVersion} · chunk {item.chunkId}
          {item.pageNumber ? ` · halaman ${item.pageNumber}` : ""}
        </span>
      </div>
      <blockquote>
        <span className="sr-only">Kutipan persis: </span>
        {item.quote}
      </blockquote>
      <div className="evidence-citation-facts">
        <span>Review: {reviewStateLabel(reviewState ?? item.reviewState)}</span>
        {traceId ? (
          traceHref ? (
            <a
              className="mono evidence-trace-link"
              href={traceHref}
              aria-label={`Buka trace/run ${traceId}`}
            >
              Trace/run {traceId}
            </a>
          ) : (
            <span className="mono evidence-trace-link">
              Trace/run {traceId}
            </span>
          )
        ) : (
          <span>Trace tidak tersedia</span>
        )}
        {item.extractorModel ? (
          <span>Model ekstraksi {item.extractorModel}</span>
        ) : null}
        {sourceUrl ? (
          <a
            className="knowledge-link"
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Buka sumber publik
            <ExternalLink aria-hidden="true" size={14} />
          </a>
        ) : localSourceId ? (
          <a
            className="knowledge-link"
            href={`#knowledge-source-${localSourceId}`}
          >
            Lihat dokumen proyek
          </a>
        ) : null}
      </div>
    </article>
  );
}
