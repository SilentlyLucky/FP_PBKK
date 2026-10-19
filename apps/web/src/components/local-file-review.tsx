"use client";

import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  LoaderCircle,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CodexFileDraft,
  type CodexDraftOptimizer,
  type CodexDraftTarget,
  type CodexFileDraftRunRecord,
} from "@/components/codex-file-draft";
import {
  compareCodexFileDraftContexts,
  isValidWorkspaceContentHash,
  validateCodexFileDraftResult,
  type CodexFileDraftContext,
} from "@/lib/codex-file-draft";

import styles from "./local-file-review.module.css";

interface WorkspaceStatus {
  projectConfigured: boolean;
  writeAvailable: boolean;
  grantDurationSeconds: number | null;
  writeGrantDurationSeconds: number | null;
  reason?: string | null;
  isolatedEvaluation?: WorkspaceEvaluationStatus;
}

interface WorkspaceEvaluationStatus {
  executionAvailable: boolean;
  reasonCode: string | null;
  tests: Array<{ id: string; label: string; available: boolean }>;
}

type WorkspaceEvaluationArmStatus =
  "completed" | "timed_out" | "output_limit" | "unavailable";

interface WorkspaceEvaluationArm {
  status: WorkspaceEvaluationArmStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  reasonCode: string | null;
}

type WorkspaceEvaluationAssessment =
  | "pass"
  | "candidate_regression"
  | "candidate_improved"
  | "baseline_failing"
  | "inconclusive";

interface WorkspaceEvaluationReport {
  status: "completed" | "unavailable";
  reasonCode: string | null;
  assessment: WorkspaceEvaluationAssessment;
  commandId: string;
  commandLabel: string;
  startingSnapshotHash: string | null;
  baselineSnapshotHash: string | null;
  candidateSnapshotHash: string | null;
  filesPerSnapshot: number | null;
  bytesPerSnapshot: number | null;
  entriesExcludedByPolicy: number | null;
  baseline: WorkspaceEvaluationArm;
  candidate: WorkspaceEvaluationArm;
}

interface WorkspaceGrant {
  grantId: string;
  expiresAt: string;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface WorkspaceList {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

interface WorkspaceRead {
  path: string;
  bytes: number;
  content: string;
  contentHash: string;
}

type PatchStatus = "proposed" | "approved" | "rejected" | "rolled_back";

interface WorkspacePatch {
  patchId: string;
  path: string;
  status: PatchStatus;
  beforeHash: string;
  afterHash: string;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  rolledBackAt: string | null;
  beforeContent: string;
  proposedContent: string;
  diff: string;
  diffRows: Array<{ before: string | null; proposed: string | null }>;
  diffTruncated: boolean;
}

interface WorkspacePatchAction {
  patch: WorkspacePatch;
  repeated: boolean;
}

interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

class LocalReviewError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LocalReviewError";
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const payloadRecord =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    const message =
      payloadRecord && typeof payloadRecord.message === "string"
        ? payloadRecord.message
        : "Permintaan file lokal tidak dapat diproses.";
    const code =
      payloadRecord && typeof payloadRecord.code === "string"
        ? payloadRecord.code
        : payloadRecord && typeof payloadRecord.error === "string"
          ? payloadRecord.error
          : undefined;
    throw new LocalReviewError(message, code);
  }
  return payload as T;
}

function workspaceBase(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/workspace`;
}

function formatExpiry(value: string): string {
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime())) return "waktu terbatas";
  return `aktif sampai ${expiresAt.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function evaluationAssessmentLabel(assessment: WorkspaceEvaluationAssessment): {
  readonly title: string;
  readonly explanation: string;
} {
  switch (assessment) {
    case "pass":
      return {
        title: "Kandidat lolos tes yang dipilih",
        explanation:
          "Perintah tes yang sama menghasilkan exit code 0 pada baseline dan kandidat.",
      };
    case "candidate_regression":
      return {
        title: "Regresi terdeteksi pada kandidat",
        explanation:
          "Baseline menghasilkan exit code 0, sedangkan kandidat menghasilkan exit code bukan 0.",
      };
    case "candidate_improved":
      return {
        title: "Kandidat lolos; baseline gagal",
        explanation:
          "Baseline menghasilkan exit code bukan 0, sedangkan kandidat menghasilkan exit code 0.",
      };
    case "baseline_failing":
      return {
        title: "Baseline dan kandidat sama-sama gagal",
        explanation:
          "Kedua snapshot menghasilkan exit code bukan 0. Hasil ini belum menunjukkan apakah kandidat memperbaiki kegagalan.",
      };
    case "inconclusive":
      return {
        title: "Hasil belum konklusif",
        explanation:
          "Runner tidak menyelesaikan kedua tes dalam batas waktu dan output yang ditetapkan.",
      };
  }
}

function evaluationArmLabel(status: WorkspaceEvaluationArmStatus): string {
  switch (status) {
    case "completed":
      return "Selesai";
    case "timed_out":
      return "Melewati batas waktu";
    case "output_limit":
      return "Melewati batas output";
    case "unavailable":
      return "Runner tidak tersedia";
  }
}

function isWorkspaceGrantUsable(
  grant: WorkspaceGrant | null,
): grant is WorkspaceGrant {
  return Boolean(
    grant &&
    Number.isFinite(Date.parse(grant.expiresAt)) &&
    Date.parse(grant.expiresAt) > Date.now(),
  );
}

export function LocalFileReview({
  projectId,
  codexTarget,
  codexOptimizer,
  onRunCreated = () => undefined,
  onRunStatusChange = () => undefined,
}: {
  projectId: string | null;
  codexTarget: CodexDraftTarget;
  codexOptimizer: CodexDraftOptimizer;
  onRunCreated?: (run: CodexFileDraftRunRecord) => void;
  onRunStatusChange?: (
    projectId: string,
    runId: string,
    status: string,
  ) => void;
}) {
  return (
    <LocalFileReviewForProject
      key={projectId ?? "no-project"}
      projectId={projectId}
      codexTarget={codexTarget}
      codexOptimizer={codexOptimizer}
      onRunCreated={onRunCreated}
      onRunStatusChange={onRunStatusChange}
    />
  );
}

function LocalFileReviewForProject({
  projectId,
  codexTarget,
  codexOptimizer,
  onRunCreated,
  onRunStatusChange,
}: {
  projectId: string | null;
  codexTarget: CodexDraftTarget;
  codexOptimizer: CodexDraftOptimizer;
  onRunCreated: (run: CodexFileDraftRunRecord) => void;
  onRunStatusChange: (projectId: string, runId: string, status: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(() => Boolean(projectId));
  const [readIntent, setReadIntent] = useState(false);
  const [writeIntent, setWriteIntent] = useState(false);
  const [readGrant, setReadGrant] = useState<WorkspaceGrant | null>(null);
  const [writeGrant, setWriteGrant] = useState<WorkspaceGrant | null>(null);
  const [previewGrant, setPreviewGrant] = useState<WorkspaceGrant | null>(null);
  const [directory, setDirectory] = useState("");
  const [listing, setListing] = useState<WorkspaceList | null>(null);
  const [preview, setPreview] = useState<WorkspaceRead | null>(null);
  const [contentSearch, setContentSearch] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [sourceDisclosureOpen, setSourceDisclosureOpen] = useState(false);
  const [draftInputLocked, setDraftInputLocked] = useState(false);
  const [sharedDraftSnapshot, setSharedDraftSnapshot] = useState<string | null>(
    null,
  );
  const [patch, setPatch] = useState<WorkspacePatch | null>(null);
  const [evaluationTestId, setEvaluationTestId] = useState("");
  const [evaluationReport, setEvaluationReport] =
    useState<WorkspaceEvaluationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const grantRef = useRef<{
    projectId: string | null;
    readGrantId: string | null;
    writeGrantId: string | null;
  }>({ projectId: null, readGrantId: null, writeGrantId: null });

  useEffect(() => {
    grantRef.current = {
      projectId,
      readGrantId: readGrant?.grantId ?? null,
      writeGrantId: writeGrant?.grantId ?? null,
    };
  }, [projectId, readGrant, writeGrant]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void fetch(workspaceBase(projectId), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(readResponse<WorkspaceStatus>)
      .then((result) => setStatus(result))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Status folder lokal tidak tersedia.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatusLoading(false);
      });
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    const availableTests =
      status?.isolatedEvaluation?.tests.filter((test) => test.available) ?? [];
    if (!availableTests.some((test) => test.id === evaluationTestId)) {
      setEvaluationTestId(availableTests[0]?.id ?? "");
    }
  }, [evaluationTestId, status?.isolatedEvaluation]);

  useEffect(() => {
    setEvaluationReport(null);
  }, [patch?.patchId, patch?.afterHash]);

  useEffect(
    () => () => {
      const active = grantRef.current;
      if (!active.projectId) return;
      for (const grantId of [active.readGrantId, active.writeGrantId]) {
        if (!grantId) continue;
        void fetch(
          `${workspaceBase(active.projectId)}/grants/${encodeURIComponent(grantId)}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => undefined);
      }
    },
    [],
  );

  const activeReadGrant = readGrant;
  const activeWriteGrant = writeGrant;

  function readableGrant(): WorkspaceGrant | null {
    return (
      [writeGrant, readGrant].find((grant): grant is WorkspaceGrant =>
        isWorkspaceGrantUsable(grant),
      ) ?? null
    );
  }
  const activeGrantId = readableGrant()?.grantId ?? null;

  useEffect(() => {
    if (!writeGrant) return;
    const expiresIn = Math.max(
      0,
      Date.parse(writeGrant.expiresAt) - Date.now(),
    );
    const timer = window.setTimeout(() => {
      setWriteGrant((current) =>
        current?.grantId === writeGrant.grantId ? null : current,
      );
      if (previewGrant?.grantId === writeGrant.grantId) {
        setPreview(null);
        setPreviewGrant(null);
        setEditedContent("");
        setEditing(false);
        setDraftInputLocked(false);
        setError("Izin tulis berakhir. Pratinjau dan draf lokal ditutup.");
      }
      void fetch(
        `${workspaceBase(projectId ?? "")}/grants/${encodeURIComponent(writeGrant.grantId)}`,
        { method: "DELETE", keepalive: true },
      ).catch(() => undefined);
    }, expiresIn);
    return () => window.clearTimeout(timer);
  }, [projectId, previewGrant?.grantId, writeGrant]);

  useEffect(() => {
    if (!readGrant) return;
    const expiresIn = Math.max(0, Date.parse(readGrant.expiresAt) - Date.now());
    const timer = window.setTimeout(() => {
      setReadGrant((current) =>
        current?.grantId === readGrant.grantId ? null : current,
      );
      setListing(null);
      setPreview(null);
      setPreviewGrant(null);
      setEditedContent("");
      setMatches([]);
      setEditing(false);
      setDraftInputLocked(false);
      void fetch(
        `${workspaceBase(projectId ?? "")}/grants/${encodeURIComponent(readGrant.grantId)}`,
        { method: "DELETE", keepalive: true },
      ).catch(() => undefined);
    }, expiresIn);
    return () => window.clearTimeout(timer);
  }, [projectId, readGrant]);

  useEffect(() => {
    if (statusMessage) statusRef.current?.focus();
  }, [statusMessage]);

  async function requestRead<T>(path: string, init?: RequestInit): Promise<T> {
    const activeGrant = [writeGrant, readGrant].find(
      (grant): grant is WorkspaceGrant => isWorkspaceGrantUsable(grant),
    );
    if (!projectId || !activeGrant) {
      throw new Error("Pilih proyek untuk membuka file lokal.");
    }
    const response = await fetch(
      `${workspaceBase(projectId)}/grants/${encodeURIComponent(activeGrant.grantId)}${path}`,
      { cache: "no-store", ...init },
    );
    return readResponse<T>(response);
  }

  async function requestWrite<T>(path: string, init?: RequestInit): Promise<T> {
    if (!projectId || !isWorkspaceGrantUsable(writeGrant)) {
      throw new Error("Minta izin tulis sementara sebelum mengubah file.");
    }
    const response = await fetch(
      `${workspaceBase(projectId)}/grants/${encodeURIComponent(writeGrant.grantId)}${path}`,
      { cache: "no-store", ...init },
    );
    return readResponse<T>(response);
  }

  async function loadDirectory(path: string) {
    if (!activeGrantId) return;
    setBusy(true);
    setError(null);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const result = await requestRead<WorkspaceList>(`/list${query}`);
      setDirectory(path);
      setListing(result);
      setMatches([]);
      setSearchSubmitted(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Daftar file tidak tersedia.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openFile(path: string): Promise<boolean> {
    const readGrantForPreview = readableGrant();
    if (!readGrantForPreview) return false;
    setBusy(true);
    setError(null);
    setEditing(false);
    setDraftInputLocked(false);
    setSourceDisclosureOpen(false);
    try {
      const result = await requestRead<WorkspaceRead>(
        `/read?path=${encodeURIComponent(path)}`,
      );
      if (!isValidWorkspaceContentHash(result.contentHash)) {
        throw new LocalReviewError(
          "Pembacaan file tidak menyertakan hash snapshot yang dapat diverifikasi.",
          "SNAPSHOT_HASH_REQUIRED",
        );
      }
      if (
        !isWorkspaceGrantUsable(readGrantForPreview) ||
        ![writeGrant, readGrant].some(
          (grant) => grant?.grantId === readGrantForPreview.grantId,
        )
      ) {
        throw new LocalReviewError(
          "Izin file berakhir sebelum snapshot dimuat.",
          "GRANT_EXPIRED",
        );
      }
      setPreview(result);
      setPreviewGrant(readGrantForPreview);
      setEditedContent(result.content);
      return true;
    } catch (cause) {
      setPreview(null);
      setPreviewGrant(null);
      setEditedContent("");
      setError(
        cause instanceof Error
          ? cause.message
          : "Pratinjau file tidak tersedia.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function grantReadAccess() {
    if (!projectId || !readIntent) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${workspaceBase(projectId)}/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval: "read_only_project_root" }),
        cache: "no-store",
      });
      const grant = await readResponse<WorkspaceGrant>(response);
      setReadGrant(grant);
      setReadIntent(false);
      setDirectory("");
      setPreview(null);
      setPreviewGrant(null);
      setEditedContent("");
      setEditing(false);
      setDraftInputLocked(false);
      setPatch(null);
      setError(null);
      const responseList = await fetch(
        `${workspaceBase(projectId)}/grants/${encodeURIComponent(grant.grantId)}/list`,
        { cache: "no-store" },
      );
      setListing(await readResponse<WorkspaceList>(responseList));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Izin baca tidak dapat dibuat.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function grantWriteAccess() {
    if (!projectId || !writeIntent || !status?.writeAvailable) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${workspaceBase(projectId)}/grants/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval: "workspace_write_project_root" }),
        cache: "no-store",
      });
      const grant = await readResponse<WorkspaceGrant>(response);
      setWriteGrant(grant);
      setWriteIntent(false);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Izin tulis tidak dapat dibuat.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant(grant: WorkspaceGrant, access: "read" | "write") {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${workspaceBase(projectId)}/grants/${encodeURIComponent(grant.grantId)}`,
        { method: "DELETE", cache: "no-store" },
      );
      await readResponse<{ revoked: boolean }>(response);
      if (access === "read") {
        setReadGrant(null);
        setListing(null);
        setPreview(null);
        setPreviewGrant(null);
        setEditedContent("");
        setMatches([]);
        setEditing(false);
        setDraftInputLocked(false);
      } else {
        setWriteGrant(null);
        setEditing(false);
        setDraftInputLocked(false);
        if (previewGrant?.grantId === grant.grantId) {
          setPreview(null);
          setPreviewGrant(null);
          setEditedContent("");
        }
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Izin tidak dapat dihentikan.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function searchContent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contentSearch.trim()) {
      setMatches([]);
      setSearchSubmitted(false);
      return;
    }
    setSearchSubmitted(true);
    setBusy(true);
    setError(null);
    try {
      const result = await requestRead<{
        matches: SearchMatch[];
        truncated: boolean;
      }>(`/search?q=${encodeURIComponent(contentSearch.trim())}`);
      setMatches(result.matches);
      if (result.truncated) {
        setError(
          "Pencarian mencapai batas lokal. Sebagian hasil mungkin belum tampil.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Pencarian file tidak tersedia.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createProposal() {
    if (!preview || !activeWriteGrant) return;
    if (!isValidWorkspaceContentHash(preview.contentHash)) {
      setError(
        "Snapshot file tidak memiliki hash yang dapat diverifikasi. Muat ulang file sebelum membuat usulan.",
      );
      return;
    }
    if (
      !previewGrant ||
      !isWorkspaceGrantUsable(previewGrant) ||
      ![writeGrant, readGrant].some(
        (grant) => grant?.grantId === previewGrant.grantId,
      )
    ) {
      setError("Izin file berakhir. Muat ulang file sebelum membuat usulan.");
      return;
    }
    const preservedEditorContent = editedContent;
    setBusy(true);
    setError(null);
    try {
      const created = await requestWrite<WorkspacePatch>("/patches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: preview.path,
          content: editedContent,
          source: "user_editor",
          expectedBeforeHash: preview.contentHash,
        }),
      });
      setPatch(created);
      setEditing(false);
    } catch (cause) {
      if (
        cause instanceof LocalReviewError &&
        cause.code === "PATCH_CONFLICT"
      ) {
        try {
          const refreshedGrant = readableGrant();
          if (!refreshedGrant) {
            throw new LocalReviewError(
              "Izin baca file berakhir sebelum snapshot dapat dimuat ulang.",
              "GRANT_EXPIRED",
            );
          }
          const refreshed = await requestRead<WorkspaceRead>(
            "/read?path=" + encodeURIComponent(preview.path),
          );
          if (!isValidWorkspaceContentHash(refreshed.contentHash)) {
            throw new LocalReviewError(
              "Snapshot terbaru tidak menyertakan hash yang dapat diverifikasi.",
              "SNAPSHOT_HASH_REQUIRED",
            );
          }
          if (
            !isWorkspaceGrantUsable(refreshedGrant) ||
            ![writeGrant, readGrant].some(
              (grant) => grant?.grantId === refreshedGrant.grantId,
            )
          ) {
            throw new LocalReviewError(
              "Izin baca file berakhir saat snapshot dimuat ulang.",
              "GRANT_EXPIRED",
            );
          }
          setPreview(refreshed);
          setPreviewGrant(refreshedGrant);
          setEditedContent(preservedEditorContent);
          setEditing(true);
          setDraftInputLocked(false);
          setSourceDisclosureOpen(true);
          setError(
            "File berubah sebelum usulan dibuat. Snapshot terbaru dimuat dan teks editor Anda tetap dipertahankan; tinjau kembali isinya sebelum membuat usulan.",
          );
        } catch (reloadCause) {
          setEditedContent(preservedEditorContent);
          setEditing(true);
          setError(
            "File berubah sebelum usulan dibuat. Teks editor Anda tetap dipertahankan, tetapi snapshot terbaru belum dapat dimuat: " +
              (reloadCause instanceof Error
                ? reloadCause.message
                : "coba muat ulang file."),
          );
        }
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Usulan perubahan tidak dapat dibuat.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function evaluateProposal() {
    if (
      !patch ||
      patch.status !== "proposed" ||
      !evaluationTestId ||
      !isWorkspaceGrantUsable(writeGrant)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setStatusMessage("");
    setEvaluationReport(null);
    try {
      const report = await requestWrite<WorkspaceEvaluationReport>(
        `/patches/${encodeURIComponent(patch.patchId)}/evaluate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ testId: evaluationTestId }),
        },
      );
      setEvaluationReport(report);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Tes proyek tidak dapat dijalankan.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function approveProposal() {
    if (!patch) return;
    setBusy(true);
    setError(null);
    setStatusMessage("");
    try {
      const result = await requestWrite<WorkspacePatchAction>(
        `/patches/${encodeURIComponent(patch.patchId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approval: "apply_exact_patch" }),
        },
      );
      setPatch(result.patch);
      setStatusMessage(
        result.repeated
          ? `Perubahan pada ${result.patch.path} sudah diterapkan.`
          : `Perubahan pada ${result.patch.path} diterapkan.`,
      );
      if (result.repeated)
        setError("Perubahan ini sudah diterapkan sebelumnya.");
      if (preview?.path === result.patch.path) {
        setPreview({
          path: result.patch.path,
          bytes: new TextEncoder().encode(result.patch.proposedContent)
            .byteLength,
          content: result.patch.proposedContent,
          contentHash: result.patch.afterHash,
        });
        setEditedContent(result.patch.proposedContent);
      }
    } catch (cause) {
      if (
        cause instanceof LocalReviewError &&
        cause.code === "PATCH_CONFLICT"
      ) {
        try {
          await requestWrite<WorkspacePatch>(
            `/patches/${encodeURIComponent(patch.patchId)}/reject`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ decision: "reject_patch" }),
            },
          );
        } catch {
          // The stale proposal cannot be approved after its source hash changes.
        }
        const reloaded = await openFile(patch.path);
        if (reloaded) {
          setPatch(null);
          setEditedContent(patch.proposedContent);
          setEditing(true);
          setSourceDisclosureOpen(true);
          setError(
            "File berubah setelah usulan dibuat. Usulan lama tidak diterapkan; versi terbaru dimuat dan teks usulan Anda tetap dipertahankan di editor untuk ditinjau kembali.",
          );
        } else {
          setPatch({ ...patch, status: "rejected" });
          setEditedContent(patch.proposedContent);
          setError(
            "File berubah setelah diff ditinjau. Perubahan tidak diterapkan. Teks usulan tetap terlihat pada diff, tetapi snapshot terbaru belum dapat dimuat.",
          );
        }
        return;
      }
      setError(
        cause instanceof Error
          ? `${cause.message} Muat ulang file lalu buat usulan baru jika masih diperlukan.`
          : "Perubahan tidak dapat diterapkan.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function rejectProposal() {
    if (!patch) return;
    setBusy(true);
    setError(null);
    try {
      const rejected = await requestWrite<WorkspacePatch>(
        `/patches/${encodeURIComponent(patch.patchId)}/reject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "reject_patch" }),
        },
      );
      setPatch(null);
      setError(
        rejected.status === "rejected"
          ? "Usulan ditolak. File asli belum diubah."
          : null,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Usulan tidak dapat ditolak.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function rollbackProposal() {
    if (!patch) return;
    setBusy(true);
    setError(null);
    setStatusMessage("");
    try {
      const result = await requestWrite<WorkspacePatchAction>(
        `/patches/${encodeURIComponent(patch.patchId)}/rollback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approval: "restore_exact_before_bytes" }),
        },
      );
      setPatch(result.patch);
      setStatusMessage(
        result.repeated
          ? `Versi sebelumnya untuk ${result.patch.path} sudah dipulihkan.`
          : `Versi sebelumnya untuk ${result.patch.path} dipulihkan.`,
      );
      if (preview?.path === result.patch.path) {
        setPreview({
          path: result.patch.path,
          bytes: new TextEncoder().encode(result.patch.beforeContent)
            .byteLength,
          content: result.patch.beforeContent,
          contentHash: result.patch.beforeHash,
        });
        setEditedContent(result.patch.beforeContent);
      }
      if (result.repeated)
        setError("Perubahan ini sudah dipulihkan sebelumnya.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `${cause.message} File yang berubah tidak ditimpa saat pemulihan.`
          : "Perubahan tidak dapat dipulihkan.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function closeProposal() {
    if (patch?.status === "proposed") {
      try {
        await requestWrite<WorkspacePatch>(
          `/patches/${encodeURIComponent(patch.patchId)}/reject`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "reject_patch" }),
          },
        );
      } catch {
        // Closing the review never applies the proposal.
      }
    }
    const path = patch?.path;
    setPatch(null);
    if (path && preview?.path === path) void openFile(path);
  }

  const draftContext: CodexFileDraftContext | null =
    projectId && preview && previewGrant && activeWriteGrant
      ? {
          projectId,
          path: preview.path,
          snapshotHash: preview.contentHash ?? null,
          readGrantId: previewGrant.grantId,
          readGrantExpiresAt: previewGrant.expiresAt,
          writeGrantId: activeWriteGrant.grantId,
          writeGrantExpiresAt: activeWriteGrant.expiresAt,
        }
      : null;
  const draftSnapshotKey =
    projectId && preview
      ? projectId + ":" + preview.path + ":" + preview.contentHash
      : null;

  function acceptCodexDraft(
    answer: string,
    captured: CodexFileDraftContext,
  ): boolean {
    if (!draftContext || !preview) return false;
    const reason = validateCodexFileDraftResult({
      answer,
      captured,
      current: draftContext,
    });
    if (
      reason ||
      compareCodexFileDraftContexts(captured, draftContext) !== null ||
      (!draftInputLocked && editedContent !== preview.content)
    ) {
      setError(
        "Hasil Codex tidak sesuai dengan snapshot dan izin yang masih aktif. Teks editor belum diubah; muat ulang file untuk membuat draf baru.",
      );
      return false;
    }
    setEditedContent(answer);
    setEditing(true);
    setError(null);
    return true;
  }

  return (
    <section className={styles.panel} aria-labelledby="local-file-review-title">
      <header className={styles.panelHeader}>
        <div className={styles.headingCopy}>
          <p className={styles.eyebrow}>Ruang kerja lokal</p>
          <h2 id="local-file-review-title">Tinjau file</h2>
          <p>
            Preview tetap di perangkat. Isi file tidak ikut terkirim ke chat.
          </p>
        </div>
        <div className={styles.headerActions}>
          {!projectId ? <Badge variant="warning">Pilih proyek</Badge> : null}
          {projectId && statusLoading ? (
            <Badge variant="muted">Memeriksa folder</Badge>
          ) : null}
          {status?.projectConfigured ? (
            <Badge variant="success">Folder diizinkan</Badge>
          ) : null}
          {projectId && status && !status.projectConfigured ? (
            <Badge variant="warning">Folder belum diatur</Badge>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className={styles.collapseButton}
            aria-expanded={open}
            aria-controls={open ? "local-file-review-body" : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Sembunyikan" : "Buka tinjauan"}
            <ChevronDown
              aria-hidden="true"
              className={open ? styles.chevronOpen : undefined}
              size={15}
            />
          </Button>
        </div>
      </header>

      {open ? (
        <div className={styles.body} id="local-file-review-body">
          {!projectId ? (
            <p className={styles.emptyState}>
              Pilih proyek dari header untuk memeriksa file.
            </p>
          ) : null}
          {projectId && status && !status.projectConfigured ? (
            <div className={styles.unavailable} role="status">
              <ShieldX aria-hidden="true" size={18} />
              <div>
                <strong>Akses folder lokal belum tersedia</strong>
                <p>
                  Admin lokal perlu mengizinkan folder proyek ini di server.
                </p>
              </div>
            </div>
          ) : null}

          {projectId &&
          status?.projectConfigured &&
          !activeReadGrant &&
          !activeWriteGrant ? (
            <div className={styles.permissionCard}>
              <div className={styles.permissionMark}>
                <ShieldCheck aria-hidden="true" size={18} />
              </div>
              <div className={styles.permissionCopy}>
                <strong>Baca file lokal untuk meninjau isinya</strong>
                <p>
                  Izin baca berlaku 15 menit. Hanya file teks yang diizinkan
                  server yang dapat dibuka.
                </p>
                <label className={styles.consent}>
                  <input
                    type="checkbox"
                    checked={readIntent}
                    onChange={(event) => setReadIntent(event.target.checked)}
                  />
                  <span>
                    Saya meminta akses baca sementara ke folder proyek ini.
                  </span>
                </label>
              </div>
              <Button
                type="button"
                disabled={!readIntent || busy}
                onClick={() => void grantReadAccess()}
              >
                Izinkan baca
              </Button>
            </div>
          ) : null}

          {projectId &&
          status?.projectConfigured &&
          (activeReadGrant || activeWriteGrant) ? (
            <>
              <div className={styles.permissionRow}>
                <p>
                  Izin baca{" "}
                  {activeReadGrant
                    ? formatExpiry(activeReadGrant.expiresAt)
                    : "tidak aktif"}
                  {activeWriteGrant
                    ? ` · tulis ${formatExpiry(activeWriteGrant.expiresAt)}`
                    : ""}
                </p>
                <div>
                  {activeWriteGrant ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void revokeGrant(activeWriteGrant, "write")
                      }
                    >
                      Hentikan izin tulis
                    </Button>
                  ) : null}
                  {activeReadGrant ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revokeGrant(activeReadGrant, "read")}
                    >
                      Hentikan izin baca
                    </Button>
                  ) : null}
                </div>
              </div>

              {!activeWriteGrant && status.writeAvailable ? (
                <div className={styles.writeIntent}>
                  <label className={styles.consent}>
                    <input
                      type="checkbox"
                      checked={writeIntent}
                      onChange={(event) => setWriteIntent(event.target.checked)}
                    />
                    <span>
                      Saya ingin mengusulkan perubahan file dan mengizinkan
                      penerapan setelah saya menyetujui diff.
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!writeIntent || busy}
                    onClick={() => void grantWriteAccess()}
                  >
                    Izinkan edit 5 menit
                  </Button>
                </div>
              ) : null}
              {!activeWriteGrant && !status.writeAvailable ? (
                <p className={styles.writeUnavailable} role="status">
                  Review perubahan belum aktif di server. Folder ini tetap hanya
                  dapat dibaca; admin lokal perlu mengaktifkan izin tulis untuk
                  proyek ini.
                </p>
              ) : null}

              {!activeWriteGrant ? (
                <p className={styles.agentUnavailable}>
                  Pengusulan otomatis oleh Codex belum tersedia. Anda dapat
                  mengedit teks sendiri setelah izin tulis diaktifkan.
                </p>
              ) : null}

              <div className={styles.reviewGrid}>
                <aside
                  className={styles.fileRail}
                  aria-label="File dalam folder proyek"
                >
                  <div className={styles.fileRailHeading}>
                    <div>
                      <h3>File proyek</h3>
                      <p>{directory || "Folder proyek"}</p>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Muat ulang folder"
                      disabled={busy}
                      onClick={() => void loadDirectory(directory)}
                    >
                      <RotateCcw aria-hidden="true" size={15} />
                    </Button>
                  </div>
                  <form
                    className={styles.searchForm}
                    onSubmit={(event) => void searchContent(event)}
                  >
                    <label
                      className={styles.visuallyHidden}
                      htmlFor="local-content-search"
                    >
                      Cari isi file
                    </label>
                    <Search aria-hidden="true" size={15} />
                    <input
                      id="local-content-search"
                      value={contentSearch}
                      onChange={(event) => setContentSearch(event.target.value)}
                      placeholder="Cari isi file…"
                    />
                    <button
                      type="submit"
                      aria-label="Cari isi file"
                      disabled={busy}
                    >
                      <ChevronRight aria-hidden="true" size={15} />
                    </button>
                  </form>
                  {directory ? (
                    <button
                      type="button"
                      className={styles.parentFolder}
                      disabled={busy}
                      onClick={() =>
                        void loadDirectory(
                          directory.split("/").slice(0, -1).join("/"),
                        )
                      }
                    >
                      <ChevronLeft aria-hidden="true" size={15} />
                      Folder sebelumnya
                    </button>
                  ) : null}
                  <div className={styles.fileList}>
                    {searchSubmitted
                      ? matches.map((match) => (
                          <button
                            type="button"
                            className={styles.fileItem}
                            key={`${match.path}:${match.line}`}
                            disabled={busy}
                            onClick={() => void openFile(match.path)}
                          >
                            <FileText aria-hidden="true" size={15} />
                            <span>
                              <strong>{match.path}</strong>
                              <small>
                                Baris {match.line} · {match.snippet}
                              </small>
                            </span>
                          </button>
                        ))
                      : listing?.entries.map((entry) => (
                          <button
                            type="button"
                            className={`${styles.fileItem}${preview?.path === entry.path ? ` ${styles.fileItemActive}` : ""}`}
                            key={entry.path}
                            disabled={busy}
                            onClick={() =>
                              entry.kind === "directory"
                                ? void loadDirectory(entry.path)
                                : void openFile(entry.path)
                            }
                          >
                            {entry.kind === "directory" ? (
                              <Folder aria-hidden="true" size={15} />
                            ) : (
                              <FileCode2 aria-hidden="true" size={15} />
                            )}
                            <span>
                              <strong>{entry.name}</strong>
                              <small>
                                {entry.kind === "directory"
                                  ? "Folder"
                                  : entry.path}
                              </small>
                            </span>
                            {entry.kind === "directory" ? (
                              <ChevronRight aria-hidden="true" size={14} />
                            ) : null}
                          </button>
                        ))}
                    {searchSubmitted && !matches.length ? (
                      <p className={styles.listEmpty}>
                        Tidak ada isi file yang cocok.
                      </p>
                    ) : null}
                    {!searchSubmitted && !listing?.entries.length ? (
                      <p className={styles.listEmpty}>
                        Folder ini kosong atau semua item tidak diizinkan.
                      </p>
                    ) : null}
                  </div>
                  {listing?.truncated ? (
                    <p className={styles.limitNote}>
                      Daftar dibatasi. Buka subfolder untuk melihat item lain.
                    </p>
                  ) : null}
                </aside>

                <div className={styles.reviewPane}>
                  {patch ? (
                    <section
                      className={styles.diffCard}
                      aria-label="Usulan perubahan file"
                    >
                      <header className={styles.diffHeader}>
                        <div>
                          <p className={styles.eyebrow}>
                            Tinjau perubahan berdampingan
                          </p>
                          <h3>{patch.path}</h3>
                          <p>
                            Sebelum <code>{patch.beforeHash.slice(0, 12)}</code>
                            {" · "}Sesudah{" "}
                            <code>{patch.afterHash.slice(0, 12)}</code>
                          </p>
                        </div>
                        <Badge
                          variant={
                            patch.status === "approved"
                              ? "success"
                              : patch.status === "proposed"
                                ? "warning"
                                : "muted"
                          }
                        >
                          {patch.status === "proposed"
                            ? "Menunggu persetujuan"
                            : patch.status === "approved"
                              ? "Diterapkan"
                              : patch.status === "rejected"
                                ? "Ditolak"
                                : "Dipulihkan"}
                        </Badge>
                      </header>
                      <div
                        className={styles.diff}
                        role="table"
                        aria-label="Perbandingan isi sebelum dan sesudah"
                      >
                        <div className={styles.diffRow} role="row">
                          <strong
                            className={styles.diffColumnHeader}
                            role="columnheader"
                          >
                            Sebelum
                          </strong>
                          <strong
                            className={styles.diffColumnHeader}
                            role="columnheader"
                          >
                            Sesudah
                          </strong>
                        </div>
                        <div role="rowgroup">
                          {patch.diffRows.map((row, index) => (
                            <div
                              className={styles.diffRow}
                              role="row"
                              key={`diff-row-${index}`}
                            >
                              <code className={styles.diffCell} role="cell">
                                {row.before ?? " "}
                              </code>
                              <code className={styles.diffCell} role="cell">
                                {row.proposed ?? " "}
                              </code>
                            </div>
                          ))}
                        </div>
                      </div>
                      {patch.diffTruncated ? (
                        <p className={styles.diffTruncated}>
                          Pratinjau dibatasi pada 500 baris pertama di tiap
                          sisi. Baca sisa file di editor lokal sebelum
                          menyetujui perubahan.
                        </p>
                      ) : null}
                      {patch.status === "proposed" ? (
                        <section
                          className={styles.evaluationPanel}
                          aria-label="Evaluasi snapshot baseline dan kandidat"
                        >
                          <div>
                            <p className={styles.eyebrow}>
                              Bukti sebelum diterapkan
                            </p>
                            <h4>Jalankan tes proyek</h4>
                            <p>
                              Tes yang sama dijalankan pada salinan baseline dan
                              kandidat. Hasil ini tidak mengubah file proyek.
                            </p>
                          </div>
                          {status?.isolatedEvaluation?.executionAvailable ? (
                            <div className={styles.evaluationControls}>
                              <label htmlFor="workspace-evaluation-test">
                                Tes dari konfigurasi server
                                <select
                                  id="workspace-evaluation-test"
                                  value={evaluationTestId}
                                  disabled={busy}
                                  onChange={(event) => {
                                    setEvaluationTestId(event.target.value);
                                    setEvaluationReport(null);
                                  }}
                                >
                                  {status.isolatedEvaluation.tests.map(
                                    (test) => (
                                      <option
                                        key={test.id}
                                        value={test.id}
                                        disabled={!test.available}
                                      >
                                        {test.label}
                                        {test.available
                                          ? ""
                                          : " (tidak tersedia)"}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                  busy ||
                                  !evaluationTestId ||
                                  !isWorkspaceGrantUsable(writeGrant)
                                }
                                onClick={() => void evaluateProposal()}
                              >
                                {busy ? (
                                  <LoaderCircle
                                    className={styles.spin}
                                    aria-hidden="true"
                                    size={15}
                                  />
                                ) : null}
                                Jalankan evaluasi
                              </Button>
                            </div>
                          ) : (
                            <p className={styles.evaluationUnavailable}>
                              {status?.isolatedEvaluation?.reasonCode ===
                              "workspace_write_not_configured"
                                ? "Admin lokal belum mengaktifkan izin perubahan untuk proyek ini."
                                : status?.isolatedEvaluation?.reasonCode ===
                                    "evaluation_configuration_invalid"
                                  ? "Konfigurasi tes proyek di server perlu diperbaiki."
                                  : status?.isolatedEvaluation?.reasonCode ===
                                      "no_server_evaluation_tests_configured"
                                    ? "Admin lokal perlu mendaftarkan tes bernama di server sebelum evaluasi dapat dijalankan."
                                    : "Runner terisolasi belum siap di server ini. Evaluasi tidak akan dijalankan di luar sandbox."}
                            </p>
                          )}
                        </section>
                      ) : null}
                      {evaluationReport ? (
                        <section
                          className={styles.evaluationReport}
                          aria-label="Hasil evaluasi proyek"
                          aria-live="polite"
                        >
                          <div className={styles.evaluationReportHeading}>
                            <div>
                              <p className={styles.eyebrow}>
                                Hasil · {evaluationReport.commandLabel}
                              </p>
                              <h4>
                                {
                                  evaluationAssessmentLabel(
                                    evaluationReport.assessment,
                                  ).title
                                }
                              </h4>
                              <p>
                                {
                                  evaluationAssessmentLabel(
                                    evaluationReport.assessment,
                                  ).explanation
                                }
                              </p>
                            </div>
                            <Badge
                              variant={
                                evaluationReport.assessment === "pass"
                                  ? "success"
                                  : evaluationReport.assessment ===
                                      "candidate_regression"
                                    ? "warning"
                                    : "muted"
                              }
                            >
                              {evaluationReport.assessment.replaceAll("_", " ")}
                            </Badge>
                          </div>
                          <dl className={styles.evaluationMetrics}>
                            <div>
                              <dt>File dalam tiap snapshot</dt>
                              <dd>
                                {evaluationReport.filesPerSnapshot ?? "—"}
                              </dd>
                            </div>
                            <div>
                              <dt>Ukuran snapshot</dt>
                              <dd>
                                {evaluationReport.bytesPerSnapshot === null
                                  ? "—"
                                  : `${evaluationReport.bytesPerSnapshot.toLocaleString("id-ID")} byte`}
                              </dd>
                            </div>
                            <div>
                              <dt>Entri dikecualikan</dt>
                              <dd>
                                {evaluationReport.entriesExcludedByPolicy ??
                                  "—"}
                              </dd>
                            </div>
                            <div>
                              <dt>Hash baseline / kandidat</dt>
                              <dd>
                                {evaluationReport.baselineSnapshotHash?.slice(
                                  0,
                                  12,
                                ) ?? "—"}
                                {" / "}
                                {evaluationReport.candidateSnapshotHash?.slice(
                                  0,
                                  12,
                                ) ?? "—"}
                              </dd>
                            </div>
                          </dl>
                          <div className={styles.evaluationArms}>
                            {(
                              [
                                ["Baseline", evaluationReport.baseline],
                                ["Kandidat", evaluationReport.candidate],
                              ] as const
                            ).map(([label, arm]) => (
                              <section
                                className={styles.evaluationArm}
                                key={label}
                                aria-label={`Hasil ${label.toLowerCase()}`}
                              >
                                <h5>{label}</h5>
                                <p>
                                  {evaluationArmLabel(arm.status)} · exit code{" "}
                                  {arm.exitCode ?? "—"} · {arm.durationMs} ms
                                </p>
                                {arm.reasonCode ? (
                                  <code>{arm.reasonCode}</code>
                                ) : null}
                                <details>
                                  <summary>Lihat output tes</summary>
                                  <pre>
                                    {arm.stdout ||
                                      arm.stderr ||
                                      "Tes tidak menghasilkan output."}
                                  </pre>
                                </details>
                              </section>
                            ))}
                          </div>
                        </section>
                      ) : null}
                      <p className={styles.sessionLimit}>
                        {patch.status === "approved"
                          ? "Pemulihan tersedia selama tinjauan ini dan server lokal tetap aktif. Menutup tinjauan, berpindah proyek, atau memulai ulang server dapat menghilangkan jalur pemulihan di PromptLab."
                          : "Jika diterapkan, pemulihan tersedia selama tinjauan ini dan server lokal tetap aktif. Menutup tinjauan, berpindah proyek, atau memulai ulang server dapat menghilangkan jalur pemulihan di PromptLab."}
                      </p>
                      <div className={styles.reviewActions}>
                        {patch.status === "proposed" ? (
                          <>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void rejectProposal()}
                            >
                              <X aria-hidden="true" size={15} />
                              Tolak usulan
                            </Button>
                            <Button
                              type="button"
                              disabled={busy}
                              onClick={() => void approveProposal()}
                            >
                              {busy ? (
                                <LoaderCircle
                                  className={styles.spin}
                                  aria-hidden="true"
                                  size={15}
                                />
                              ) : (
                                <Check aria-hidden="true" size={15} />
                              )}
                              Setujui dan terapkan
                            </Button>
                          </>
                        ) : null}
                        {patch.status === "approved" ? (
                          <>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void closeProposal()}
                            >
                              Tutup tinjauan
                            </Button>
                            <Button
                              type="button"
                              disabled={busy}
                              onClick={() => void rollbackProposal()}
                            >
                              <RotateCcw aria-hidden="true" size={15} />
                              Pulihkan versi sebelumnya
                            </Button>
                          </>
                        ) : null}
                        {patch.status === "rolled_back" ? (
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void closeProposal()}
                          >
                            Tutup tinjauan
                          </Button>
                        ) : null}
                      </div>
                    </section>
                  ) : preview ? (
                    <section
                      className={styles.previewCard}
                      aria-label="Pratinjau file lokal"
                    >
                      <header className={styles.previewHeader}>
                        <div>
                          <p className={styles.eyebrow}>
                            Pratinjau lokal ·{" "}
                            {preview.bytes.toLocaleString("id-ID")} byte
                          </p>
                          <h3>{preview.path}</h3>
                          <p>
                            {sharedDraftSnapshot === draftSnapshotKey
                              ? "Teks snapshot ini sudah dikirim ke Codex dan disimpan dalam riwayat proyek."
                              : "Pratinjau tetap lokal sampai Anda menyetujui pengiriman draf Codex."}
                          </p>
                        </div>
                        {!editing && activeWriteGrant ? (
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              setEditedContent(preview.content);
                              setEditing(true);
                            }}
                          >
                            Edit teks sendiri
                          </Button>
                        ) : null}
                      </header>
                      {editing ? (
                        <div className={styles.editor}>
                          <label htmlFor="local-file-edit">Teks usulan</label>
                          <textarea
                            id="local-file-edit"
                            value={editedContent}
                            maxLength={1_048_576}
                            spellCheck={false}
                            onChange={(event) =>
                              setEditedContent(event.target.value)
                            }
                            disabled={busy || draftInputLocked}
                          />
                          {editedContent !== preview.content ? (
                            <details
                              open={sourceDisclosureOpen}
                              onToggle={(event) =>
                                setSourceDisclosureOpen(
                                  event.currentTarget.open,
                                )
                              }
                            >
                              <summary>
                                Snapshot file saat ini · hash{" "}
                                {preview.contentHash.slice(0, 12)}
                              </summary>
                              <pre className={styles.previewContent}>
                                {preview.content}
                              </pre>
                            </details>
                          ) : null}
                          {draftContext && activeWriteGrant ? (
                            editedContent === preview.content ||
                            sharedDraftSnapshot === draftSnapshotKey ? (
                              <CodexFileDraft
                                key={
                                  draftContext.projectId +
                                  ":" +
                                  draftContext.path +
                                  ":" +
                                  String(draftContext.snapshotHash) +
                                  ":" +
                                  draftContext.readGrantId +
                                  ":" +
                                  draftContext.writeGrantId
                                }
                                context={draftContext}
                                fileText={preview.content}
                                target={codexTarget}
                                optimizer={codexOptimizer}
                                onAnswer={acceptCodexDraft}
                                onInputLockChange={setDraftInputLocked}
                                onPromptSaved={() => {
                                  setSharedDraftSnapshot(draftSnapshotKey);
                                }}
                                onRunCreated={onRunCreated}
                                onRunStatusChange={onRunStatusChange}
                              />
                            ) : (
                              <p className={styles.sessionLimit} role="status">
                                Teks editor berbeda dari snapshot file. Buat
                                atau batalkan usulan saat ini sebelum meminta
                                draf Codex agar hasilnya tidak menimpa
                                suntingan.
                              </p>
                            )
                          ) : null}
                          <div className={styles.editorActions}>
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={busy || draftInputLocked}
                              onClick={() => {
                                setEditing(false);
                                setEditedContent(preview.content);
                              }}
                            >
                              Batal edit
                            </Button>
                            <Button
                              type="button"
                              disabled={
                                busy ||
                                draftInputLocked ||
                                editedContent === preview.content ||
                                !isValidWorkspaceContentHash(
                                  preview.contentHash,
                                )
                              }
                              onClick={() => void createProposal()}
                            >
                              Buat usulan untuk ditinjau
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <pre className={styles.previewContent}>
                          {preview.content}
                        </pre>
                      )}
                    </section>
                  ) : (
                    <div className={styles.previewEmpty}>
                      <FileText aria-hidden="true" size={22} />
                      <h3>Pilih file teks untuk melihat isinya</h3>
                      <p>
                        Perubahan hanya dibuat setelah Anda menulis usulan,
                        meninjau diff, lalu menyetujuinya.
                      </p>
                      {!busy && listing === null ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void loadDirectory("")}
                        >
                          Buka folder proyek
                        </Button>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {error ? (
            <p className={styles.feedback} role="alert">
              {error}
            </p>
          ) : null}
          {busy ? (
            <p className={styles.busyStatus} role="status" aria-live="polite">
              <LoaderCircle
                className={styles.spin}
                aria-hidden="true"
                size={14}
              />
              Memeriksa operasi lokal…
            </p>
          ) : null}
        </div>
      ) : null}
      <p
        className={styles.actionStatus}
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
      >
        {statusMessage}
      </p>
    </section>
  );
}
