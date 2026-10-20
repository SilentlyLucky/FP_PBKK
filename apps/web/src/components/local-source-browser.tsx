"use client";

import {
  ChevronRight,
  FileText,
  FolderOpen,
  Search,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

import styles from "./local-source-browser.module.css";

interface WorkspaceStatus {
  projectConfigured: boolean;
  databaseConfigured: boolean;
  reason: string | null;
  grantDurationSeconds: number | null;
}

interface WorkspaceRoot {
  rootId: string;
  displayName: string;
  source: "environment" | "registered";
  available: boolean;
  createdAt?: string | null;
}

interface DirectoryPickerListing {
  currentName: string;
  breadcrumbs: string[];
  currentToken: string | null;
  parentToken: string | null;
  directories: Array<{ name: string; token: string }>;
  truncated: boolean;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface WorkspaceGrant {
  projectId: string;
  rootId: string;
  grantId: string;
  expiresAt: string;
}

interface WorkspaceRead {
  path: string;
  encoding: "utf-8";
  bytes: number;
  content: string;
}

interface WorkspaceSearch {
  matches: Array<{ path: string; line: number; snippet: string }>;
  truncated: boolean;
  filesSkipped: number;
}

interface ApiPayload {
  error?: string;
  message?: string;
  projectConfigured?: boolean;
  databaseConfigured?: boolean;
  reason?: string | null;
  grantDurationSeconds?: number | null;
  roots?: WorkspaceRoot[];
  canChooseDirectory?: boolean;
  runtimeAvailable?: boolean;
  unavailableReason?: string | null;
  grantId?: string;
  rootId?: string;
  expiresAt?: string;
  selectionToken?: string;
  root?: WorkspaceRoot;
  revoked?: boolean;
  currentName?: string;
  breadcrumbs?: string[];
  currentToken?: string | null;
  parentToken?: string | null;
  directories?: DirectoryPickerListing["directories"];
  truncated?: boolean;
  entries?: WorkspaceEntry[];
  path?: string;
  content?: string;
  encoding?: "utf-8";
  bytes?: number;
  matches?: WorkspaceSearch["matches"];
  filesSkipped?: number;
  version?: number;
  sourceId?: string;
  updated?: boolean;
}

async function responsePayload(response: Response): Promise<ApiPayload> {
  try {
    return (await response.json()) as ApiPayload;
  } catch {
    return {};
  }
}

function isImportable(path: string): boolean {
  return /\.(txt|md|markdown)$/iu.test(path);
}

function isStaleGrantResponse(
  response: Response,
  payload: ApiPayload,
): boolean {
  return (
    response.status === 410 ||
    (response.status === 404 && payload.error === "GRANT_NOT_FOUND")
  );
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function parseDirectoryPickerListing(
  payload: ApiPayload,
): DirectoryPickerListing | null {
  if (
    typeof payload.currentName !== "string" ||
    !Array.isArray(payload.breadcrumbs) ||
    !Array.isArray(payload.directories)
  ) {
    return null;
  }
  return {
    currentName: payload.currentName,
    breadcrumbs: payload.breadcrumbs.filter(
      (item): item is string => typeof item === "string",
    ),
    currentToken:
      typeof payload.currentToken === "string" ? payload.currentToken : null,
    parentToken:
      typeof payload.parentToken === "string" ? payload.parentToken : null,
    directories: payload.directories.filter(
      (item): item is { name: string; token: string } =>
        Boolean(item) &&
        typeof item.name === "string" &&
        typeof item.token === "string",
    ),
    truncated: Boolean(payload.truncated),
  };
}

export function LocalSourceBrowser({
  onImported,
}: {
  onImported: (sourceId?: string) => Promise<void>;
}) {
  const { activeProjectId } = useProjectScope();
  return (
    <LocalSourceBrowserForProject
      key={activeProjectId ?? "no-project"}
      activeProjectId={activeProjectId}
      onImported={onImported}
    />
  );
}

function LocalSourceBrowserForProject({
  activeProjectId,
  onImported,
}: {
  activeProjectId: string | null;
  onImported: (sourceId?: string) => Promise<void>;
}) {
  const projectIdRef = useRef<string | null>(activeProjectId);
  const approvalRequestRef = useRef(0);
  const approvalInFlightRef = useRef(false);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(() =>
    Boolean(activeProjectId),
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [grant, setGrant] = useState<WorkspaceGrant | null>(null);
  const grantRef = useRef<WorkspaceGrant | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceRead | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<WorkspaceSearch | null>(
    null,
  );
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [roots, setRoots] = useState<WorkspaceRoot[]>([]);
  const [rootCatalogAvailable, setRootCatalogAvailable] = useState(false);
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootActionBusy, setRootActionBusy] = useState(false);
  const [rootActionMessage, setRootActionMessage] = useState<string | null>(
    null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerListing, setPickerListing] =
    useState<DirectoryPickerListing | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectionToken, setSelectionToken] = useState<string | null>(null);
  const [selectedFolderName, setSelectedFolderName] = useState<string | null>(
    null,
  );

  const readRootCatalog = useCallback(async (projectId: string) => {
    const response = await fetch(
      "/api/projects/" + projectId + "/workspace/roots",
      { cache: "no-store" },
    );
    const result = await responsePayload(response);
    if (!response.ok || !Array.isArray(result.roots)) {
      throw new Error(
        response.status === 403
          ? "Pemilih folder hanya tersedia dari aplikasi lokal loopback dengan koneksi same-origin. Deployment ini tidak dapat mendaftarkan folder komputer ini."
          : (result.message ??
              "Pemilih folder lokal tidak tersedia pada alamat aplikasi ini."),
      );
    }
    setRuntimeAvailable(result.runtimeAvailable !== false);
    return result.roots.filter(
      (root): root is WorkspaceRoot =>
        Boolean(root) &&
        typeof root.rootId === "string" &&
        typeof root.displayName === "string" &&
        (root.source === "environment" || root.source === "registered") &&
        typeof root.available === "boolean",
    );
  }, []);

  const refreshRootCatalog = useCallback(
    async (projectId: string) => {
      setRootLoading(true);
      setRootError(null);
      try {
        const nextRoots = await readRootCatalog(projectId);
        setRoots(nextRoots);
        setRootCatalogAvailable(true);
        return nextRoots;
      } catch (cause) {
        setRoots([]);
        setRuntimeAvailable(false);
        setRootCatalogAvailable(false);
        const message =
          cause instanceof Error
            ? cause.message
            : "Pemilih folder lokal belum tersedia.";
        setRootError(message);
        throw new Error(message);
      } finally {
        setRootLoading(false);
      }
    },
    [readRootCatalog],
  );

  const clearFolderContent = useCallback(() => {
    setCurrentPath("");
    setEntries([]);
    setListBusy(false);
    setListError(null);
    setPreview(null);
    setPreviewBusy(false);
    setPreviewError(null);
    setQuery("");
    setSearchResult(null);
    setSearchBusy(false);
    setSearchError(null);
    setImportBusy(false);
    setImportMessage(null);
    setImportError(null);
  }, []);

  const clearActiveGrant = useCallback(() => {
    approvalRequestRef.current += 1;
    approvalInFlightRef.current = false;
    grantRef.current = null;
    setGrant(null);
    clearFolderContent();
  }, [clearFolderContent]);

  const clearStaleGrant = useCallback(
    (grantId: string) => {
      if (grantRef.current?.grantId !== grantId) return false;
      clearActiveGrant();
      setRootActionMessage(
        "Izin baca sudah tidak berlaku. Hubungkan kembali folder untuk memilih file.",
      );
      return true;
    },
    [clearActiveGrant],
  );

  const revoke = useCallback(
    async (current: WorkspaceGrant) => {
      if (grantRef.current?.grantId !== current.grantId) return;
      clearActiveGrant();
      try {
        await fetch(
          "/api/projects/" +
            current.projectId +
            "/workspace/grants/" +
            current.grantId,
          { method: "DELETE", cache: "no-store" },
        );
      } catch {
        // The server grant still expires automatically if revocation cannot reach it.
      }
    },
    [clearActiveGrant],
  );

  const loadDirectory = useCallback(
    async (projectId: string, grantId: string, path: string) => {
      setListBusy(true);
      setListError(null);
      setPreview(null);
      setPreviewError(null);
      setCurrentPath(path);
      try {
        const params = path ? "?path=" + encodeURIComponent(path) : "";
        const response = await fetch(
          "/api/projects/" +
            projectId +
            "/workspace/grants/" +
            grantId +
            "/list" +
            params,
          { cache: "no-store" },
        );
        const result = await responsePayload(response);
        if (
          projectIdRef.current !== projectId ||
          grantRef.current?.grantId !== grantId
        ) {
          return;
        }
        if (!response.ok || !Array.isArray(result.entries)) {
          if (isStaleGrantResponse(response, result)) {
            clearStaleGrant(grantId);
            return;
          }
          throw new Error(result.message ?? "Folder tidak dapat dibaca.");
        }
        setEntries(result.entries);
      } catch (cause) {
        if (
          projectIdRef.current !== projectId ||
          grantRef.current?.grantId !== grantId
        ) {
          return;
        }
        setEntries([]);
        setListError(
          cause instanceof Error ? cause.message : "Folder tidak dapat dibaca.",
        );
      } finally {
        if (grantRef.current?.grantId === grantId) setListBusy(false);
      }
    },
    [clearStaleGrant],
  );

  const readFile = useCallback(
    async (projectId: string, grantId: string, path: string) => {
      setPreviewBusy(true);
      setPreviewError(null);
      setImportMessage(null);
      setImportError(null);
      try {
        const response = await fetch(
          "/api/projects/" +
            projectId +
            "/workspace/grants/" +
            grantId +
            "/read?path=" +
            encodeURIComponent(path),
          { cache: "no-store" },
        );
        const result = await responsePayload(response);
        if (
          projectIdRef.current !== projectId ||
          grantRef.current?.grantId !== grantId
        ) {
          return;
        }
        if (
          !response.ok ||
          typeof result.content !== "string" ||
          typeof result.path !== "string"
        ) {
          if (isStaleGrantResponse(response, result)) {
            clearStaleGrant(grantId);
            return;
          }
          throw new Error(result.message ?? "Pratinjau file tidak tersedia.");
        }
        setPreview({
          path: result.path,
          content: result.content,
          encoding: result.encoding ?? "utf-8",
          bytes:
            result.bytes ?? new TextEncoder().encode(result.content).byteLength,
        });
      } catch (cause) {
        if (
          projectIdRef.current !== projectId ||
          grantRef.current?.grantId !== grantId
        ) {
          return;
        }
        setPreview(null);
        setPreviewError(
          cause instanceof Error
            ? cause.message
            : "Pratinjau file tidak tersedia.",
        );
      } finally {
        if (grantRef.current?.grantId === grantId) setPreviewBusy(false);
      }
    },
    [clearStaleGrant],
  );

  async function openDirectoryPicker() {
    if (!activeProjectId) return;
    setPickerOpen(true);
    setPickerBusy(true);
    setPickerError(null);
    setPickerListing(null);
    setSelectionToken(null);
    setSelectedFolderName(null);
    try {
      const response = await fetch(
        "/api/projects/" + activeProjectId + "/workspace/roots/picker",
        { cache: "no-store" },
      );
      const result = await responsePayload(response);
      const listing = parseDirectoryPickerListing(result);
      if (!response.ok || !listing) {
        throw new Error(
          response.status === 403
            ? "Pemilih folder hanya tersedia dari aplikasi lokal loopback dengan koneksi same-origin."
            : (result.message ??
                "Pemilih folder lokal tidak tersedia pada deployment ini."),
        );
      }
      setPickerListing(listing);
    } catch (cause) {
      setPickerError(
        cause instanceof Error
          ? cause.message
          : "Pemilih folder lokal tidak tersedia.",
      );
    } finally {
      setPickerBusy(false);
    }
  }

  async function browseDirectory(token: string) {
    if (!activeProjectId) return;
    setPickerBusy(true);
    setPickerError(null);
    setSelectionToken(null);
    setSelectedFolderName(null);
    try {
      const response = await fetch(
        "/api/projects/" +
          activeProjectId +
          "/workspace/roots/picker?token=" +
          encodeURIComponent(token),
        { cache: "no-store" },
      );
      const result = await responsePayload(response);
      const listing = parseDirectoryPickerListing(result);
      if (!response.ok || !listing) {
        throw new Error(result.message ?? "Folder tidak dapat ditampilkan.");
      }
      setPickerListing(listing);
    } catch (cause) {
      setPickerError(
        cause instanceof Error
          ? cause.message
          : "Folder tidak dapat ditampilkan.",
      );
    } finally {
      setPickerBusy(false);
    }
  }

  async function requestReadGrant(
    projectId: string,
    rootId: string,
  ): Promise<WorkspaceGrant | null> {
    if (approvalInFlightRef.current) return null;
    approvalInFlightRef.current = true;
    const requestId = ++approvalRequestRef.current;
    try {
      const response = await fetch(
        "/api/projects/" + projectId + "/workspace/grants",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approval: "read_only_project_root",
            rootId,
          }),
        },
      );
      const result = await responsePayload(response);
      if (
        !response.ok ||
        !result.grantId ||
        !result.expiresAt ||
        result.rootId !== rootId
      ) {
        throw new Error(
          result.message ?? "Izin baca untuk folder ini belum tersedia.",
        );
      }
      if (
        projectIdRef.current !== projectId ||
        approvalRequestRef.current !== requestId
      ) {
        await fetch(
          "/api/projects/" +
            projectId +
            "/workspace/grants/" +
            encodeURIComponent(result.grantId),
          { method: "DELETE", cache: "no-store" },
        ).catch(() => undefined);
        return null;
      }
      const nextGrant = {
        projectId,
        rootId,
        grantId: result.grantId,
        expiresAt: result.expiresAt,
      };
      clearFolderContent();
      grantRef.current = nextGrant;
      setGrant(nextGrant);
      await loadDirectory(projectId, nextGrant.grantId, "");
      return grantRef.current?.grantId === nextGrant.grantId ? nextGrant : null;
    } finally {
      if (approvalRequestRef.current === requestId) {
        approvalInFlightRef.current = false;
      }
    }
  }

  async function connectRoot(root: WorkspaceRoot) {
    if (
      !activeProjectId ||
      !root.available ||
      rootActionBusy ||
      grantRef.current
    ) {
      return;
    }
    setRootActionBusy(true);
    setRootError(null);
    setRootActionMessage(null);
    try {
      const nextGrant = await requestReadGrant(activeProjectId, root.rootId);
      if (!nextGrant) return;
      setRootActionMessage(
        root.displayName +
          " terhubung. PromptLab dapat membaca folder ini selama " +
          Math.floor(grantDuration / 60) +
          " menit.",
      );
    } catch (cause) {
      setRootError(
        cause instanceof Error
          ? cause.message
          : "Izin baca untuk folder ini belum tersedia.",
      );
    } finally {
      setRootActionBusy(false);
    }
  }

  async function registerSelectedFolder() {
    if (!activeProjectId || !selectionToken || rootActionBusy) return;
    setRootActionBusy(true);
    setRootError(null);
    setRootActionMessage(null);
    try {
      const response = await fetch(
        "/api/projects/" + activeProjectId + "/workspace/roots",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectionToken }),
        },
      );
      const result = await responsePayload(response);
      if (!response.ok || !result.root?.rootId) {
        throw new Error(result.message ?? "Folder tidak dapat didaftarkan.");
      }
      const registeredRoot: WorkspaceRoot = {
        ...result.root,
        displayName:
          result.root.displayName || selectedFolderName || "Folder lokal",
        source: "registered",
        available: true,
      };
      clearActiveGrant();
      setRoots((previous) => [
        ...previous.filter((root) => root.rootId !== registeredRoot.rootId),
        registeredRoot,
      ]);
      setRootCatalogAvailable(true);
      setRuntimeAvailable(true);
      setStatus((previous) => ({
        projectConfigured: true,
        databaseConfigured: previous?.databaseConfigured ?? false,
        reason: null,
        grantDurationSeconds: previous?.grantDurationSeconds ?? 15 * 60,
      }));
      setPickerOpen(false);
      setPickerListing(null);
      setSelectionToken(null);
      setSelectedFolderName(null);
      setRootActionMessage(
        registeredRoot.displayName +
          " berhasil didaftarkan. Menyiapkan akses baca…",
      );
      try {
        const nextGrant = await requestReadGrant(
          activeProjectId,
          registeredRoot.rootId,
        );
        if (!nextGrant) return;
        setRootActionMessage(
          registeredRoot.displayName +
            " terhubung. PromptLab dapat membaca folder ini selama " +
            Math.floor(grantDuration / 60) +
            " menit.",
        );
      } catch (cause) {
        const reason =
          cause instanceof Error
            ? cause.message
            : "Izin baca untuk folder ini belum tersedia.";
        setRootActionMessage(
          registeredRoot.displayName +
            " sudah didaftarkan. Akses baca belum aktif.",
        );
        setRootError(
          reason +
            " Pilih “Hubungkan dan izinkan baca” pada folder ini untuk mencoba lagi.",
        );
      }
    } catch (cause) {
      setRootError(
        cause instanceof Error
          ? cause.message
          : "Folder tidak dapat didaftarkan.",
      );
    } finally {
      setRootActionBusy(false);
    }
  }

  async function revokeRegisteredRoot(root: WorkspaceRoot) {
    if (!activeProjectId || root.source !== "registered") return;
    setRootActionBusy(true);
    setRootError(null);
    setRootActionMessage(null);
    try {
      const currentGrant = grantRef.current;
      if (currentGrant?.rootId === root.rootId) await revoke(currentGrant);
      const response = await fetch(
        "/api/projects/" + activeProjectId + "/workspace/roots",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rootId: root.rootId }),
        },
      );
      const result = await responsePayload(response);
      if (!response.ok || result.revoked !== true) {
        throw new Error(result.message ?? "Folder tidak dapat dicabut.");
      }
      clearActiveGrant();
      setRoots((previous) =>
        previous.filter((registered) => registered.rootId !== root.rootId),
      );
      setRootCatalogAvailable(true);
      setStatus((previous) => ({
        projectConfigured: roots.some(
          (registered) =>
            registered.rootId !== root.rootId && registered.available,
        ),
        databaseConfigured: previous?.databaseConfigured ?? false,
        reason: null,
        grantDurationSeconds: previous?.grantDurationSeconds ?? 15 * 60,
      }));
      setRootActionMessage("Folder " + root.displayName + " dihapus.");
    } catch (cause) {
      setRootError(
        cause instanceof Error ? cause.message : "Folder tidak dapat dicabut.",
      );
    } finally {
      setRootActionBusy(false);
    }
  }

  useEffect(() => {
    approvalRequestRef.current += 1;
    projectIdRef.current = activeProjectId;
    if (!activeProjectId) return;
    setRuntimeAvailable(false);
    let current = true;
    void fetch("/api/projects/" + activeProjectId + "/workspace", {
      cache: "no-store",
    })
      .then(async (response) => {
        const result = await responsePayload(response);
        if (!response.ok) {
          throw new Error(
            result.message ?? "Status folder lokal belum tersedia.",
          );
        }
        if (!current) return;
        setStatus({
          projectConfigured: Boolean(result.projectConfigured),
          databaseConfigured: Boolean(result.databaseConfigured),
          reason: result.reason ?? null,
          grantDurationSeconds: result.grantDurationSeconds ?? null,
        });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setStatus(null);
        setStatusError(
          cause instanceof Error
            ? cause.message
            : "Status folder lokal belum tersedia.",
        );
      })
      .finally(() => {
        if (current) setStatusLoading(false);
      });
    void readRootCatalog(activeProjectId)
      .then((nextRoots) => {
        if (!current) return;
        setRoots(nextRoots);
        setRootCatalogAvailable(true);
        setRootError(null);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setRoots([]);
        setRuntimeAvailable(false);
        setRootCatalogAvailable(false);
        setRootError(
          cause instanceof Error
            ? cause.message
            : "Pemilih folder lokal belum tersedia.",
        );
      })
      .finally(() => {
        if (current) setRootLoading(false);
      });

    return () => {
      current = false;
      approvalRequestRef.current += 1;
      approvalInFlightRef.current = false;
      const active = grantRef.current;
      if (active?.projectId === activeProjectId) void revoke(active);
    };
  }, [activeProjectId, readRootCatalog, revoke]);

  useEffect(() => {
    if (!grant) return;
    const remaining = Math.max(
      0,
      new Date(grant.expiresAt).getTime() - Date.now(),
    );
    const timer = window.setTimeout(() => void revoke(grant), remaining);
    return () => window.clearTimeout(timer);
  }, [grant, revoke]);

  async function searchFiles() {
    const currentGrant = grantRef.current;
    const currentQuery = query;
    if (!currentGrant || !currentQuery.trim()) return;
    setSearchBusy(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const response = await fetch(
        "/api/projects/" +
          currentGrant.projectId +
          "/workspace/grants/" +
          currentGrant.grantId +
          "/search?q=" +
          encodeURIComponent(currentQuery),
        { cache: "no-store" },
      );
      const result = await responsePayload(response);
      if (
        projectIdRef.current !== currentGrant.projectId ||
        grantRef.current?.grantId !== currentGrant.grantId
      ) {
        return;
      }
      if (!response.ok || !Array.isArray(result.matches)) {
        if (isStaleGrantResponse(response, result)) {
          clearStaleGrant(currentGrant.grantId);
          return;
        }
        throw new Error(result.message ?? "Pencarian lokal belum tersedia.");
      }
      setSearchResult({
        matches: result.matches,
        truncated: Boolean(result.truncated),
        filesSkipped: result.filesSkipped ?? 0,
      });
    } catch (cause) {
      if (grantRef.current?.grantId === currentGrant.grantId) {
        setSearchError(
          cause instanceof Error
            ? cause.message
            : "Pencarian lokal belum tersedia.",
        );
      }
    } finally {
      if (grantRef.current?.grantId === currentGrant.grantId) {
        setSearchBusy(false);
      }
    }
  }

  async function importPreview() {
    const currentGrant = grantRef.current;
    const currentPreview = preview;
    if (!currentGrant || !currentPreview || !status?.databaseConfigured) return;
    setImportBusy(true);
    setImportError(null);
    setImportMessage(null);
    try {
      const response = await fetch(
        "/api/projects/" +
          currentGrant.projectId +
          "/workspace/grants/" +
          currentGrant.grantId +
          "/import",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: currentPreview.path,
          }),
        },
      );
      const result = await responsePayload(response);
      if (
        projectIdRef.current !== currentGrant.projectId ||
        grantRef.current?.grantId !== currentGrant.grantId
      ) {
        return;
      }
      if (!response.ok || typeof result.version !== "number") {
        if (isStaleGrantResponse(response, result)) {
          clearStaleGrant(currentGrant.grantId);
          return;
        }
        throw new Error(
          result.message ?? "File belum dapat diimpor sebagai sumber.",
        );
      }
      setImportMessage(
        result.updated
          ? "Versi sumber diperbarui menjadi v" + result.version + "."
          : "Sumber lokal diimpor sebagai v" + result.version + ".",
      );
      await onImported(
        typeof result.sourceId === "string" ? result.sourceId : undefined,
      );
    } catch (cause) {
      if (grantRef.current?.grantId === currentGrant.grantId) {
        setImportError(
          cause instanceof Error
            ? cause.message
            : "File belum dapat diimpor sebagai sumber.",
        );
      }
    } finally {
      if (grantRef.current?.grantId === currentGrant.grantId) {
        setImportBusy(false);
      }
    }
  }

  const projectConfigured = roots.some((root) => root.available);
  const grantDuration = status?.grantDurationSeconds ?? 15 * 60;

  return (
    <section
      className={styles.section}
      aria-labelledby="local-source-browser-title"
    >
      <Card>
        <CardHeader>
          <div className={styles.heading}>
            <span className={styles.headingIcon} aria-hidden="true">
              <FolderOpen size={18} />
            </span>
            <div>
              <CardTitle id="local-source-browser-title">
                Folder di komputer ini
              </CardTitle>
              <CardDescription>
                Hubungkan folder untuk memberi akses baca selama{" "}
                {Math.floor(grantDuration / 60)} menit. PromptLab tidak mengubah
                file atau menjalankan perintah.
              </CardDescription>
            </div>
            <Badge
              variant={
                grant ? "success" : projectConfigured ? "muted" : "warning"
              }
            >
              {grant
                ? "Izin baca aktif"
                : projectConfigured
                  ? "Tersedia atas persetujuan"
                  : "Belum diizinkan"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className={styles.body}>
          {activeProjectId ? (
            <div className={styles.rootManager}>
              <div className={styles.rootManagerHeading}>
                <div>
                  <strong>Folder yang terhubung</strong>
                  <p>
                    Pemilih hanya menampilkan nama folder. Isi file tidak dibaca
                    sampai Anda mengizinkannya.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    rootActionBusy ||
                    rootLoading ||
                    !rootCatalogAvailable ||
                    !runtimeAvailable
                  }
                  onClick={() => void openDirectoryPicker()}
                >
                  <FolderOpen aria-hidden="true" size={15} />
                  Hubungkan folder
                </Button>
              </div>
              {rootLoading ? (
                <p className="helper" role="status">
                  Memeriksa folder yang tersedia…
                </p>
              ) : null}
              {!rootLoading && rootCatalogAvailable && !runtimeAvailable ? (
                <p className="helper" role="status">
                  Folder lokal belum diaktifkan pada server ini.
                </p>
              ) : null}
              {!rootLoading &&
              rootCatalogAvailable &&
              runtimeAvailable &&
              roots.length === 0 ? (
                <p className="helper" role="status">
                  Belum ada folder yang terhubung. Pilih folder melalui tombol
                  di atas.
                </p>
              ) : null}
              {roots.map((root) => (
                <div className={styles.rootRow} key={root.rootId}>
                  <div>
                    <strong>{root.displayName}</strong>
                    <small>
                      {root.source === "environment"
                        ? "Tersedia dari pengaturan server · hanya membaca"
                        : "Terhubung di komputer ini · hanya membaca"}
                      {!root.available ? " · folder tidak tersedia" : ""}
                    </small>
                  </div>
                  <div className={styles.rootActions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={
                        !root.available || rootActionBusy || Boolean(grant)
                      }
                      aria-label={
                        "Hubungkan dan izinkan baca untuk " + root.displayName
                      }
                      onClick={() => void connectRoot(root)}
                    >
                      {grant?.rootId === root.rootId
                        ? "Terhubung"
                        : rootActionBusy
                          ? "Menghubungkan…"
                          : "Hubungkan dan izinkan baca"}
                    </Button>
                    {root.source === "registered" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={rootActionBusy}
                        onClick={() => void revokeRegisteredRoot(root)}
                      >
                        Cabut
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
              {rootError ? (
                <p className="error-message" role="alert">
                  {rootError}
                </p>
              ) : null}
              {rootActionMessage ? (
                <p className="success-message" role="status">
                  {rootActionMessage}
                </p>
              ) : null}

              {pickerOpen ? (
                <div className={styles.directoryPicker}>
                  <div className={styles.directoryPickerHeading}>
                    <div>
                      <strong>
                        Pilih folder di komputer yang menjalankan PromptLab
                      </strong>
                      <p>
                        Pemilih hanya menampilkan nama folder. File belum dibaca
                        pada tahap ini.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPickerOpen(false)}
                    >
                      Tutup
                    </Button>
                  </div>
                  {pickerBusy ? (
                    <p className="helper" role="status">
                      Membaca daftar folder…
                    </p>
                  ) : null}
                  {pickerError ? (
                    <p className="error-message" role="alert">
                      {pickerError}
                    </p>
                  ) : null}
                  {pickerListing ? (
                    <>
                      <div className={styles.pickerBreadcrumbs}>
                        <span>Folder pengguna</span>
                        {pickerListing.breadcrumbs.map((part, index) => (
                          <span key={part + index}>
                            <ChevronRight aria-hidden="true" size={13} />
                            {part}
                          </span>
                        ))}
                      </div>
                      <div className={styles.pickerDirectories}>
                        {pickerListing.parentToken ? (
                          <button
                            type="button"
                            onClick={() =>
                              void browseDirectory(pickerListing.parentToken!)
                            }
                          >
                            <FolderOpen aria-hidden="true" size={15} />
                            Folder induk
                          </button>
                        ) : null}
                        {pickerListing.directories.map((directory) => (
                          <button
                            type="button"
                            key={directory.token}
                            onClick={() =>
                              void browseDirectory(directory.token)
                            }
                          >
                            <FolderOpen aria-hidden="true" size={15} />
                            {directory.name}
                            <ChevronRight aria-hidden="true" size={14} />
                          </button>
                        ))}
                        {!pickerListing.directories.length && !pickerBusy ? (
                          <p className="helper">
                            Tidak ada subfolder yang dapat ditampilkan.
                          </p>
                        ) : null}
                      </div>
                      {pickerListing.truncated ? (
                        <p className="helper">
                          Daftar dibatasi. Buka subfolder tertentu untuk
                          melanjutkan.
                        </p>
                      ) : null}
                      {pickerListing.currentToken ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            setSelectionToken(pickerListing.currentToken);
                            setSelectedFolderName(pickerListing.currentName);
                          }}
                        >
                          Pilih folder “{pickerListing.currentName}”
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {selectionToken ? (
                    <div className={styles.registrationApproval}>
                      <p>
                        Folder <strong>{selectedFolderName}</strong> akan
                        dihubungkan ke proyek ini. PromptLab dapat membaca
                        isinya selama {Math.floor(grantDuration / 60)} menit,
                        tanpa mengubah file atau menjalankan perintah. File
                        tidak diunggah otomatis; pilih dan impor sendiri jika
                        ingin menambahkannya sebagai sumber.
                      </p>
                      <Button
                        type="button"
                        disabled={rootActionBusy}
                        aria-label={
                          "Hubungkan dan izinkan baca untuk " +
                          (selectedFolderName ?? "folder ini")
                        }
                        onClick={() => void registerSelectedFolder()}
                      >
                        {rootActionBusy
                          ? "Menghubungkan…"
                          : "Hubungkan dan izinkan baca"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {!activeProjectId ? (
            <p className="helper" role="status">
              Pilih proyek untuk memeriksa folder lokal yang dapat diakses.
            </p>
          ) : statusLoading ? (
            <p className="helper" role="status">
              Memeriksa konfigurasi folder proyek…
            </p>
          ) : statusError ? (
            <p className="error-message" role="alert">
              {statusError}
            </p>
          ) : !projectConfigured ? (
            <div className={styles.unavailable} role="status">
              <p>
                Belum ada folder yang tersedia. Gunakan pemilih di atas untuk
                menghubungkan folder dari komputer yang menjalankan PromptLab.
              </p>
            </div>
          ) : !grant ? (
            <div className={styles.unavailable} role="status">
              <p>
                Pilih “Hubungkan dan izinkan baca” pada folder yang ingin Anda
                gunakan. PromptLab hanya dapat membaca file selama izin aktif.
              </p>
            </div>
          ) : (
            <div className={styles.browser}>
              <div className={styles.browserToolbar}>
                <div className={styles.breadcrumbs} aria-label="Lokasi folder">
                  <button
                    type="button"
                    onClick={() =>
                      void loadDirectory(grant.projectId, grant.grantId, "")
                    }
                  >
                    <FolderOpen aria-hidden="true" size={14} />
                    {roots.find((root) => root.rootId === grant.rootId)
                      ?.displayName ?? "Folder lokal"}
                  </button>
                  {currentPath
                    .split("/")
                    .filter(Boolean)
                    .map((part, index, parts) => {
                      const path = parts.slice(0, index + 1).join("/");
                      return (
                        <span className={styles.crumb} key={path}>
                          <ChevronRight aria-hidden="true" size={13} />
                          <button
                            type="button"
                            onClick={() =>
                              void loadDirectory(
                                grant.projectId,
                                grant.grantId,
                                path,
                              )
                            }
                          >
                            {part}
                          </button>
                        </span>
                      );
                    })}
                </div>
                <span className={styles.expires}>
                  Berakhir{" "}
                  {new Date(grant.expiresAt).toLocaleTimeString("id-ID")}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void revoke(grant)}
                >
                  Cabut izin
                </Button>
              </div>

              {!status?.databaseConfigured ? (
                <p className={styles.databaseNote} role="note">
                  Database knowledge belum dikonfigurasi. Pratinjau baca tetap
                  tersedia, tetapi impor sumber akan aktif setelah database
                  lokal dikonfigurasi.
                </p>
              ) : null}

              <div className={styles.columns}>
                <div className={styles.fileColumn}>
                  <div
                    role="search"
                    aria-label="Cari di folder lokal"
                    className={styles.search}
                  >
                    <label className="sr-only" htmlFor="local-source-search">
                      Cari teks di folder lokal
                    </label>
                    <Search aria-hidden="true" size={15} />
                    <input
                      id="local-source-search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.nativeEvent.isComposing
                        ) {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        void searchFiles();
                      }}
                      maxLength={1_000}
                      placeholder="Cari nama atau isi file…"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!query.trim() || searchBusy}
                      onClick={() => void searchFiles()}
                    >
                      {searchBusy ? "Mencari…" : "Cari"}
                    </Button>
                  </div>
                  {searchError ? (
                    <p className="error-message" role="alert">
                      {searchError}
                    </p>
                  ) : null}
                  {searchResult ? (
                    <div
                      className={styles.searchResults}
                      aria-label="Hasil pencarian lokal"
                    >
                      {searchResult.matches.length ? (
                        searchResult.matches.map((match, index) => (
                          <button
                            type="button"
                            className={styles.searchMatch}
                            key={match.path + ":" + match.line + ":" + index}
                            onClick={() =>
                              void readFile(
                                grant.projectId,
                                grant.grantId,
                                match.path,
                              )
                            }
                          >
                            <strong>
                              {match.path} · baris {match.line}
                            </strong>
                            <span>{match.snippet}</span>
                          </button>
                        ))
                      ) : (
                        <p className="helper">
                          Tidak ada kecocokan pada file yang dapat dibaca.
                        </p>
                      )}
                      {searchResult.truncated ? (
                        <p className="helper">
                          Hasil dibatasi; {searchResult.filesSkipped} file
                          dilewati.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div
                    className={styles.fileList}
                    aria-label="Isi folder lokal"
                  >
                    {currentPath ? (
                      <button
                        type="button"
                        className={styles.fileEntry}
                        onClick={() =>
                          void loadDirectory(
                            grant.projectId,
                            grant.grantId,
                            parentPath(currentPath),
                          )
                        }
                      >
                        <FolderOpen aria-hidden="true" size={16} />
                        <span>Kembali ke folder induk</span>
                      </button>
                    ) : null}
                    {listBusy ? (
                      <p className="helper" role="status">
                        Memuat daftar file…
                      </p>
                    ) : null}
                    {listError ? (
                      <p className="error-message" role="alert">
                        {listError}
                      </p>
                    ) : null}
                    {!listBusy && !listError && entries.length === 0 ? (
                      <p className="helper">
                        Folder ini tidak memiliki file yang dapat ditampilkan.
                      </p>
                    ) : null}
                    {entries.map((entry) => (
                      <button
                        type="button"
                        className={styles.fileEntry}
                        key={entry.path}
                        onClick={() =>
                          entry.kind === "directory"
                            ? void loadDirectory(
                                grant.projectId,
                                grant.grantId,
                                entry.path,
                              )
                            : void readFile(
                                grant.projectId,
                                grant.grantId,
                                entry.path,
                              )
                        }
                      >
                        {entry.kind === "directory" ? (
                          <FolderOpen aria-hidden="true" size={16} />
                        ) : (
                          <FileText aria-hidden="true" size={16} />
                        )}
                        <span>{entry.name}</span>
                        {entry.kind === "directory" ? (
                          <ChevronRight aria-hidden="true" size={14} />
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.previewColumn}>
                  <div className={styles.previewHeading}>
                    <div>
                      <strong>Pratinjau file</strong>
                      <span className="helper">
                        {preview
                          ? preview.path +
                            " · " +
                            preview.bytes.toLocaleString("id-ID") +
                            " byte"
                          : "Pilih file teks untuk membaca isinya."}
                      </span>
                    </div>
                    <Badge variant="muted">Baca saja</Badge>
                  </div>
                  {previewBusy ? (
                    <p className="helper" role="status">
                      Membuka file…
                    </p>
                  ) : null}
                  {previewError ? (
                    <p className="error-message" role="alert">
                      {previewError}
                    </p>
                  ) : null}
                  {preview ? (
                    <>
                      <pre className={styles.previewContent}>
                        {preview.content}
                      </pre>
                      {isImportable(preview.path) ? (
                        <div className={styles.importPanel}>
                          <h3>Tambahkan sebagai sumber knowledge</h3>
                          <p>
                            Versi dan checksum dicatat bersama jalur relatif
                            file. Jalur absolut folder tidak dikirim ke
                            knowledge.
                          </p>
                          {importError ? (
                            <p className="error-message" role="alert">
                              {importError}
                            </p>
                          ) : null}
                          {importMessage ? (
                            <p className="success-message" role="status">
                              {importMessage}
                            </p>
                          ) : null}
                          <Button
                            type="button"
                            disabled={importBusy || !status?.databaseConfigured}
                            onClick={() => void importPreview()}
                          >
                            <Upload aria-hidden="true" size={14} />
                            {importBusy ? "Mengimpor…" : "Impor file terpilih"}
                          </Button>
                        </div>
                      ) : (
                        <p className={styles.unsupported} role="note">
                          Preview tersedia. Impor knowledge menerima file teks
                          UTF-8 dengan ekstensi apa pun. Untuk struktur dan
                          tautan Obsidian, gunakan catatan Markdown pendamping;
                          file asal tetap terpisah.
                        </p>
                      )}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
