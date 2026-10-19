import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import {
  probeWorkspaceEvaluationCommand,
  runIsolatedWorkspaceEvaluation,
  validateWorkspaceEvaluationCommand,
  type WorkspaceEvaluationCommand,
  type WorkspaceEvaluationReport,
} from "./workspace-evaluation-runner.js";

export type LocalWorkspaceErrorCode =
  | "PROJECT_NOT_ALLOWLISTED"
  | "GRANT_NOT_FOUND"
  | "GRANT_LIMIT_REACHED"
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "ACCESS_DENIED"
  | "PATH_NOT_ALLOWED"
  | "SECRET_PATH_DENIED"
  | "NOT_A_DIRECTORY"
  | "NOT_A_FILE"
  | "HARDLINK_NOT_ALLOWED"
  | "FILE_TOO_LARGE"
  | "BINARY_FILE"
  | "INVALID_SEARCH_QUERY"
  | "CONFIGURATION_INVALID"
  | "WRITE_NOT_CONFIGURED"
  | "GRANT_EXPIRED"
  | "PATCH_NOT_FOUND"
  | "PATCH_EXPIRED"
  | "PATCH_CONFLICT"
  | "PATCH_HASH_INVALID"
  | "PATCH_STATE_INVALID"
  | "PATCH_LIMIT_REACHED"
  | "WORKSPACE_EVALUATION_NOT_CONFIGURED"
  | "WORKSPACE_EVALUATION_UNAVAILABLE"
  | "IO_ERROR";

export interface LocalWorkspaceSafeError {
  readonly code: LocalWorkspaceErrorCode;
  readonly message: string;
}

const SAFE_ERROR_MESSAGES: Record<LocalWorkspaceErrorCode, string> = {
  PROJECT_NOT_ALLOWLISTED: "The requested project is not available.",
  GRANT_NOT_FOUND: "The workspace grant is not active.",
  GRANT_LIMIT_REACHED: "The workspace grant limit has been reached.",
  INVALID_PATH: "The requested path is invalid.",
  PATH_NOT_FOUND: "The requested path is unavailable.",
  ACCESS_DENIED: "The requested path is unavailable.",
  PATH_NOT_ALLOWED: "The requested path is outside the allowed workspace.",
  SECRET_PATH_DENIED: "The requested path is excluded by workspace policy.",
  NOT_A_DIRECTORY: "The requested path is not a directory.",
  NOT_A_FILE: "The requested path is not a regular file.",
  HARDLINK_NOT_ALLOWED: "Hard-linked files are excluded by workspace policy.",
  FILE_TOO_LARGE: "The file exceeds the workspace size limit.",
  BINARY_FILE: "The file is not supported as UTF-8 text.",
  INVALID_SEARCH_QUERY: "The search query is invalid.",
  CONFIGURATION_INVALID: "The local workspace configuration is invalid.",
  WRITE_NOT_CONFIGURED: "Workspace write access is not configured.",
  GRANT_EXPIRED: "The workspace grant has expired.",
  PATCH_NOT_FOUND: "The requested file proposal is unavailable.",
  PATCH_EXPIRED: "The file proposal has expired.",
  PATCH_CONFLICT: "The file changed after its snapshot was read.",
  PATCH_HASH_INVALID: "The expected file hash is invalid.",
  PATCH_STATE_INVALID:
    "The file proposal is no longer available for this action.",
  PATCH_LIMIT_REACHED: "The file proposal limit has been reached.",
  WORKSPACE_EVALUATION_NOT_CONFIGURED:
    "No server-approved workspace evaluation is configured.",
  WORKSPACE_EVALUATION_UNAVAILABLE:
    "The isolated workspace evaluation runner is unavailable.",
  IO_ERROR: "The local workspace operation could not be completed.",
};

/** Safe, serializable error shape for server adapters. It never contains a path or file content. */
export class LocalWorkspaceError extends Error {
  readonly code: LocalWorkspaceErrorCode;
  /** Number of bytes consumed internally before failure; omitted from toJSON(). */
  readonly bytesConsumed: number;

  constructor(code: LocalWorkspaceErrorCode, bytesConsumed = 0) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "LocalWorkspaceError";
    this.code = code;
    this.bytesConsumed = bytesConsumed;
  }

  toJSON(): LocalWorkspaceSafeError {
    return { code: this.code, message: this.message };
  }
}

export interface LocalWorkspaceProjectRoot {
  /** Stable server-side project key. It is not a filesystem path. */
  readonly projectId: string;
  /** Absolute path from trusted server configuration. */
  readonly rootPath: string;
}

export interface LocalWorkspaceLimits {
  readonly maxActiveGrants: number;
  readonly maxFileBytes: number;
  readonly maxListEntries: number;
  readonly maxSearchFiles: number;
  readonly maxSearchEntries: number;
  readonly maxSearchResults: number;
  readonly maxSearchBytes: number;
  readonly maxSearchDurationMs: number;
  readonly maxSearchDepth: number;
  readonly maxQueryChars: number;
  readonly maxSnippetChars: number;
}

export interface LocalWorkspaceEvaluationCommandConfiguration {
  readonly projectId: string;
  readonly command: WorkspaceEvaluationCommand;
}

export interface LocalWorkspaceEvaluationTest {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

export interface LocalWorkspaceEvaluationStatus {
  readonly executionAvailable: boolean;
  readonly reasonCode: string | null;
  readonly tests: readonly LocalWorkspaceEvaluationTest[];
}

export interface LocalWorkspaceServiceOptions {
  /**
   * Server-configured allowlist. Omitted means no authorized roots and no grants.
   * Do not populate this from browser or model input.
   */
  readonly allowedProjectRoots?: readonly LocalWorkspaceProjectRoot[];
  /** Separate server-side write opt-in. Read roots alone never enable writes. */
  readonly enableWrites?: boolean;
  /** Project IDs with explicit write opt-in; each must also have a read root. */
  readonly allowedWriteProjectIds?: readonly string[];
  /** Fixed test commands trusted from server configuration, never from requests. */
  readonly workspaceEvaluationCommands?: readonly LocalWorkspaceEvaluationCommandConfiguration[];
  /** Short-lived write grant lifetime. */
  readonly writeGrantTtlMs?: number;
  /** Proposal lifetime before approval. */
  readonly patchTtlMs?: number;
  /** Maximum proposals retained in this process. */
  readonly maxStoredPatches?: number;
  /** Wall-clock seam for write-grant and patch expiry tests. */
  readonly wallClockNow?: () => number;
  /** Server-side ceilings. Values above the hard limits are rejected. */
  readonly limits?: Partial<LocalWorkspaceLimits>;
  /** Monotonic clock seam for deterministic offline tests; keep server-side. */
  readonly monotonicNow?: () => number;
}

export interface LocalWorkspaceGrant {
  readonly grantId: string;
  readonly projectId: string;
  readonly access: "read_only";
  readonly scope: "project_root";
}

export interface LocalWorkspaceWriteGrant {
  readonly grantId: string;
  readonly projectId: string;
  readonly access: "workspace_write";
  readonly scope: "project_root";
  readonly expiresAt: string;
}

export type LocalWorkspacePatchStatus =
  "proposed" | "approved" | "rejected" | "rolled_back";

/** Immutable text and hash snapshot returned for review; absolute paths are never included. */
export interface LocalWorkspacePatch {
  readonly patchId: string;
  readonly path: string;
  readonly status: LocalWorkspacePatchStatus;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt: string | null;
  readonly rolledBackAt: string | null;
  readonly beforeContent: string;
  readonly proposedContent: string;
  readonly diff: string;
  readonly diffRows: readonly {
    readonly before: string | null;
    readonly proposed: string | null;
  }[];
  readonly diffTruncated: boolean;
}

export interface LocalWorkspacePatchAction {
  readonly patch: LocalWorkspacePatch;
  readonly repeated: boolean;
}

export interface LocalWorkspaceEntry {
  readonly name: string;
  /** Slash-separated path relative to the granted project root. */
  readonly path: string;
  readonly kind: "directory" | "file";
}

export interface LocalWorkspaceListResult {
  readonly path: string;
  readonly entries: readonly LocalWorkspaceEntry[];
  readonly truncated: boolean;
}

export interface LocalWorkspaceReadResult {
  readonly path: string;
  readonly encoding: "utf-8";
  readonly bytes: number;
  readonly content: string;
  /** SHA-256 of the exact raw UTF-8 bytes read from disk. */
  readonly contentHash: string;
  /** Server-side snapshot bytes; HTTP read handlers must omit this field. */
  readonly rawBytes: Uint8Array;
}

export type LocalWorkspaceSearchLimitReason =
  | "time"
  | "file_count"
  | "entry_count"
  | "result_count"
  | "byte_count"
  | "depth";

export interface LocalWorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

export interface LocalWorkspaceSearchResult {
  readonly matches: readonly LocalWorkspaceSearchMatch[];
  readonly filesScanned: number;
  readonly filesSkipped: number;
  readonly bytesScanned: number;
  readonly truncated: boolean;
  readonly limitReason?: LocalWorkspaceSearchLimitReason;
}

export interface LocalWorkspaceService {
  /** Issue an opaque, process-local capability for a configured project root. */
  issueGrant(projectId: string): LocalWorkspaceGrant;
  /** Issue an explicitly configured, short-lived read/write capability. */
  issueWriteGrant(projectId: string): LocalWorkspaceWriteGrant;
  /** Revoke a capability. Returns false when it was already absent or revoked. */
  revokeGrant(grantId: string): boolean;
  /** List one directory level; symlinks and excluded entries are omitted. */
  list(
    grantId: string,
    relativePath?: string,
  ): Promise<LocalWorkspaceListResult>;
  /** Read one bounded UTF-8 text file. */
  read(
    grantId: string,
    relativePath: string,
  ): Promise<LocalWorkspaceReadResult>;
  /** Search bounded UTF-8 text files using a literal, case-insensitive query. */
  search(grantId: string, query: string): Promise<LocalWorkspaceSearchResult>;
  /** Create an immutable text proposal against the current file hash. */
  proposePatch(
    grantId: string,
    relativePath: string,
    proposedContent: string,
    expectedBeforeHash?: string,
  ): Promise<LocalWorkspacePatch>;
  /** Read a proposal only while an active write grant for its project is held. */
  getPatch(grantId: string, patchId: string): Promise<LocalWorkspacePatch>;
  /** Return server-configured test IDs and sandbox readiness without source paths. */
  workspaceEvaluationStatus(
    projectId: string,
  ): Promise<LocalWorkspaceEvaluationStatus>;
  /** Run a configured test against isolated baseline and candidate snapshots. */
  evaluatePatch(
    grantId: string,
    patchId: string,
    testId: string,
  ): Promise<WorkspaceEvaluationReport>;
  /** Reject a pending proposal without touching the file. */
  rejectPatch(grantId: string, patchId: string): Promise<LocalWorkspacePatch>;
  /** Apply the exact approved bytes only if the current content hash still matches. */
  approvePatch(
    grantId: string,
    patchId: string,
  ): Promise<LocalWorkspacePatchAction>;
  /** Restore the saved before bytes only while the file still matches afterHash. */
  rollbackPatch(
    grantId: string,
    patchId: string,
  ): Promise<LocalWorkspacePatchAction>;
}

const DEFAULT_LIMITS: LocalWorkspaceLimits = {
  maxActiveGrants: 128,
  maxFileBytes: 1_048_576,
  maxListEntries: 200,
  maxSearchFiles: 100,
  maxSearchEntries: 2_000,
  maxSearchResults: 50,
  maxSearchBytes: 16_777_216,
  maxSearchDurationMs: 1_000,
  maxSearchDepth: 8,
  maxQueryChars: 1_000,
  maxSnippetChars: 240,
};

const HARD_LIMITS: LocalWorkspaceLimits = {
  maxActiveGrants: 1_024,
  maxFileBytes: 8_388_608,
  maxListEntries: 1_000,
  maxSearchFiles: 1_000,
  maxSearchEntries: 10_000,
  maxSearchResults: 200,
  maxSearchBytes: 67_108_864,
  maxSearchDurationMs: 10_000,
  maxSearchDepth: 16,
  maxQueryChars: 4_000,
  maxSnippetChars: 1_000,
};

const DENIED_DIRECTORY_NAMES = new Set([
  "backups",
  "build",
  "coverage",
  "credentials",
  "dist",
  "node_modules",
  "private",
  "secrets",
  "temp",
  "tmp",
  "vendor",
  "venv",
]);

const DENIED_FILE_EXTENSIONS = new Set([
  ".asc",
  ".db",
  ".dump",
  ".gpg",
  ".jks",
  ".key",
  ".kdbx",
  ".keystore",
  ".p12",
  ".p8",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3",
]);

const MAX_RELATIVE_PATH_CHARS = 4_096;
const MAX_PATH_SEGMENTS = 64;
const MAX_PATH_SEGMENT_CHARS = 255;

interface ConfiguredRoot {
  readonly projectId: string;
  readonly canonicalRoot: string;
}

interface GrantRecord {
  readonly descriptor: LocalWorkspaceGrant | LocalWorkspaceWriteGrant;
  readonly canonicalRoot: string;
  readonly expiresAt?: number;
}

interface ParsedPath {
  readonly relativePath: string;
  readonly segments: readonly string[];
}

interface ResolvedPath {
  readonly absolutePath: string;
  readonly stats: Stats;
}

interface ReadTextResult {
  readonly content: string;
  readonly bytes: number;
  readonly rawBytes: Buffer;
}

interface StoredPatch {
  readonly patchId: string;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly path: string;
  readonly beforeBytes: Buffer;
  readonly proposedBytes: Buffer;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  status: LocalWorkspacePatchStatus;
  approvedAt: string | null;
  rolledBackAt: string | null;
}

const DEFAULT_WRITE_GRANT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_PATCH_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_STORED_PATCHES = 16;

/**
 * Construct a scoped local filesystem service. Read access is the default;
 * writes require an independent server opt-in and a short-lived write grant.
 */
export async function createLocalWorkspaceService(
  options: LocalWorkspaceServiceOptions = {},
): Promise<LocalWorkspaceService> {
  const limits = resolveLimits(options.limits);
  const roots = await canonicalizeRoots(options.allowedProjectRoots ?? []);
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallClockNow = options.wallClockNow ?? Date.now;
  const writeGrantTtlMs = validatePositiveLimit(
    options.writeGrantTtlMs ?? DEFAULT_WRITE_GRANT_TTL_MS,
    60 * 60 * 1_000,
  );
  const patchTtlMs = validatePositiveLimit(
    options.patchTtlMs ?? DEFAULT_PATCH_TTL_MS,
    60 * 60 * 1_000,
  );
  const maxStoredPatches = validatePositiveLimit(
    options.maxStoredPatches ?? DEFAULT_MAX_STORED_PATCHES,
    1_024,
  );
  const writeEnabled = options.enableWrites === true;
  const configuredWriteProjectIds = options.allowedWriteProjectIds ?? [];
  if (!Array.isArray(configuredWriteProjectIds)) {
    throw new LocalWorkspaceError("CONFIGURATION_INVALID");
  }
  const writableProjectIds = new Set<string>();
  for (const projectId of configuredWriteProjectIds) {
    if (
      typeof projectId !== "string" ||
      !roots.has(projectId) ||
      writableProjectIds.has(projectId)
    ) {
      throw new LocalWorkspaceError("CONFIGURATION_INVALID");
    }
    writableProjectIds.add(projectId);
  }
  const workspaceEvaluationCommands = new Map<
    string,
    Map<string, WorkspaceEvaluationCommand>
  >();
  const configuredEvaluationCommands =
    options.workspaceEvaluationCommands ?? [];
  if (!Array.isArray(configuredEvaluationCommands)) {
    throw new LocalWorkspaceError("CONFIGURATION_INVALID");
  }
  try {
    for (const configured of configuredEvaluationCommands) {
      if (
        !configured ||
        typeof configured !== "object" ||
        !roots.has(configured.projectId) ||
        !writableProjectIds.has(configured.projectId)
      ) {
        throw new Error("invalid_workspace_evaluation_project");
      }
      const command = validateWorkspaceEvaluationCommand(configured.command);
      const projectCommands =
        workspaceEvaluationCommands.get(configured.projectId) ?? new Map();
      if (projectCommands.has(command.id)) {
        throw new Error("duplicate_workspace_evaluation_command");
      }
      projectCommands.set(command.id, command);
      workspaceEvaluationCommands.set(configured.projectId, projectCommands);
    }
  } catch {
    throw new LocalWorkspaceError("CONFIGURATION_INVALID");
  }
  const grants = new Map<string, GrantRecord>();
  const patches = new Map<string, StoredPatch>();
  const pathLocks = new Map<string, Promise<void>>();

  function currentWallClock(): number {
    const value = wallClockNow();
    if (!Number.isFinite(value)) {
      throw new LocalWorkspaceError("CONFIGURATION_INVALID");
    }
    return value;
  }

  function pruneExpiredGrants(): void {
    const now = currentWallClock();
    for (const [grantId, record] of grants) {
      if (record.expiresAt !== undefined && now >= record.expiresAt) {
        grants.delete(grantId);
      }
    }
  }

  function requireGrant(grantId: string): GrantRecord {
    if (typeof grantId !== "string") {
      throw new LocalWorkspaceError("GRANT_NOT_FOUND");
    }
    const record = grants.get(grantId);
    if (!record) throw new LocalWorkspaceError("GRANT_NOT_FOUND");
    if (
      record.expiresAt !== undefined &&
      currentWallClock() >= record.expiresAt
    ) {
      grants.delete(grantId);
      throw new LocalWorkspaceError("GRANT_EXPIRED");
    }
    return record;
  }

  function assertGrantActive(grantId: string, record: GrantRecord): void {
    if (grants.get(grantId) !== record) {
      throw new LocalWorkspaceError("GRANT_NOT_FOUND");
    }
    if (
      record.expiresAt !== undefined &&
      currentWallClock() >= record.expiresAt
    ) {
      grants.delete(grantId);
      throw new LocalWorkspaceError("GRANT_EXPIRED");
    }
  }

  function requireWriteGrant(grantId: string): GrantRecord {
    const record = requireGrant(grantId);
    if (record.descriptor.access !== "workspace_write") {
      throw new LocalWorkspaceError("WRITE_NOT_CONFIGURED");
    }
    return record;
  }

  function requirePatch(writeGrant: GrantRecord, patchId: string): StoredPatch {
    if (typeof patchId !== "string") {
      throw new LocalWorkspaceError("PATCH_NOT_FOUND");
    }
    const patch = patches.get(patchId);
    if (
      !patch ||
      patch.projectId !== writeGrant.descriptor.projectId ||
      patch.canonicalRoot !== writeGrant.canonicalRoot
    ) {
      throw new LocalWorkspaceError("PATCH_NOT_FOUND");
    }
    return patch;
  }

  function assertPatchLive(patch: StoredPatch): void {
    if (patch.status === "proposed" && currentWallClock() >= patch.expiresAt) {
      throw new LocalWorkspaceError("PATCH_EXPIRED");
    }
  }

  function makeRoomForPatch(): void {
    const now = currentWallClock();
    for (const [patchId, patch] of patches) {
      const expiredProposal =
        patch.status === "proposed" && now >= patch.expiresAt;
      const terminal =
        patch.status === "rejected" || patch.status === "rolled_back";
      if (expiredProposal || terminal) patches.delete(patchId);
      if (patches.size < maxStoredPatches) return;
    }
  }

  async function withPathLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = pathLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    pathLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (pathLocks.get(key) === queued) pathLocks.delete(key);
    }
  }

  return {
    issueGrant(projectId: string): LocalWorkspaceGrant {
      pruneExpiredGrants();
      if (typeof projectId !== "string") {
        throw new LocalWorkspaceError("PROJECT_NOT_ALLOWLISTED");
      }
      const root = roots.get(projectId);
      if (!root) throw new LocalWorkspaceError("PROJECT_NOT_ALLOWLISTED");
      if (grants.size >= limits.maxActiveGrants) {
        throw new LocalWorkspaceError("GRANT_LIMIT_REACHED");
      }

      const descriptor = Object.freeze({
        grantId: randomUUID(),
        projectId: root.projectId,
        access: "read_only" as const,
        scope: "project_root" as const,
      });
      grants.set(descriptor.grantId, {
        descriptor,
        canonicalRoot: root.canonicalRoot,
      });
      return descriptor;
    },

    issueWriteGrant(projectId: string): LocalWorkspaceWriteGrant {
      pruneExpiredGrants();
      if (
        !writeEnabled ||
        typeof projectId !== "string" ||
        !writableProjectIds.has(projectId)
      ) {
        throw new LocalWorkspaceError("WRITE_NOT_CONFIGURED");
      }
      const root = roots.get(projectId);
      if (!root) throw new LocalWorkspaceError("WRITE_NOT_CONFIGURED");
      if (grants.size >= limits.maxActiveGrants) {
        throw new LocalWorkspaceError("GRANT_LIMIT_REACHED");
      }
      const expiresAt = currentWallClock() + writeGrantTtlMs;
      const descriptor = Object.freeze({
        grantId: randomUUID(),
        projectId: root.projectId,
        access: "workspace_write" as const,
        scope: "project_root" as const,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      grants.set(descriptor.grantId, {
        descriptor,
        canonicalRoot: root.canonicalRoot,
        expiresAt,
      });
      return descriptor;
    },

    revokeGrant(grantId: string): boolean {
      if (typeof grantId !== "string") return false;
      return grants.delete(grantId);
    },

    async list(
      grantId: string,
      relativePath = "",
    ): Promise<LocalWorkspaceListResult> {
      const grant = requireGrant(grantId);
      const parsed = parseRelativePath(relativePath, true);
      const resolved = await resolveSafePath(grant, parsed, "directory");
      let directory;
      try {
        directory = await opendir(resolved.absolutePath);
      } catch (error) {
        throw mapFilesystemError(error);
      }

      const entries: LocalWorkspaceEntry[] = [];
      let entriesVisited = 0;
      let truncated = false;
      try {
        await verifyDirectoryPath(grant, resolved.absolutePath);
        for await (const entry of directory) {
          entriesVisited += 1;
          if (entriesVisited > limits.maxListEntries) {
            truncated = true;
            break;
          }
          const kind = direntKind(entry);
          if (!kind || !isUsableEntryName(entry.name)) continue;
          if (isDeniedPathSegment(entry.name)) continue;
          entries.push({
            name: entry.name,
            path: joinRelativePath(parsed.relativePath, entry.name),
            kind,
          });
        }
      } catch (error) {
        throw mapFilesystemError(error);
      } finally {
        await directory.close().catch(() => undefined);
      }

      assertGrantActive(grantId, grant);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return {
        path: parsed.relativePath,
        entries,
        truncated,
      };
    },

    async read(
      grantId: string,
      relativePath: string,
    ): Promise<LocalWorkspaceReadResult> {
      const grant = requireGrant(grantId);
      const parsed = parseRelativePath(relativePath, false);
      const file = await readTextFile(grant, parsed, limits.maxFileBytes);
      assertGrantActive(grantId, grant);
      return {
        path: parsed.relativePath,
        encoding: "utf-8",
        bytes: file.bytes,
        content: file.content,
        contentHash: hashBytes(file.rawBytes),
        rawBytes: new Uint8Array(file.rawBytes),
      };
    },

    async search(
      grantId: string,
      query: string,
    ): Promise<LocalWorkspaceSearchResult> {
      const grant = requireGrant(grantId);
      const normalizedQuery = validateSearchQuery(query, limits.maxQueryChars);
      const startedAt = readClock(monotonicNow);
      const deadline = startedAt + limits.maxSearchDurationMs;
      const matches: LocalWorkspaceSearchMatch[] = [];
      const pendingDirectories: Array<{ path: string; depth: number }> = [
        { path: "", depth: 0 },
      ];
      let filesScanned = 0;
      let filesSkipped = 0;
      let bytesScanned = 0;
      let entriesVisited = 0;
      let limitReason: LocalWorkspaceSearchLimitReason | undefined;

      const timeExpired = (): boolean => readClock(monotonicNow) >= deadline;
      scan: while (pendingDirectories.length > 0) {
        assertGrantActive(grantId, grant);
        if (timeExpired()) {
          limitReason = "time";
          break;
        }

        const current = pendingDirectories.pop();
        if (!current) break;
        const directoryPath = parseRelativePath(current.path, true);
        const directory = await resolveSafePath(
          grant,
          directoryPath,
          "directory",
        );
        let openedDirectory;
        try {
          openedDirectory = await opendir(directory.absolutePath);
        } catch (error) {
          throw mapFilesystemError(error);
        }

        try {
          await verifyDirectoryPath(grant, directory.absolutePath);
          for await (const entry of openedDirectory) {
            assertGrantActive(grantId, grant);
            if (timeExpired()) {
              limitReason = "time";
              break scan;
            }
            entriesVisited += 1;
            if (entriesVisited > limits.maxSearchEntries) {
              limitReason = "entry_count";
              break scan;
            }

            const kind = direntKind(entry);
            if (!kind || !isUsableEntryName(entry.name)) continue;
            if (isDeniedPathSegment(entry.name)) continue;
            const childPath = joinRelativePath(current.path, entry.name);

            if (kind === "directory") {
              if (current.depth >= limits.maxSearchDepth) {
                limitReason = "depth";
                break scan;
              }
              pendingDirectories.push({
                path: childPath,
                depth: current.depth + 1,
              });
              continue;
            }

            if (filesScanned >= limits.maxSearchFiles) {
              limitReason = "file_count";
              break scan;
            }
            filesScanned += 1;

            const remainingBytes = limits.maxSearchBytes - bytesScanned;
            if (remainingBytes <= 0) {
              limitReason = "byte_count";
              break scan;
            }
            const readLimit = Math.min(limits.maxFileBytes, remainingBytes);
            let file: ReadTextResult;
            try {
              file = await readTextFile(
                grant,
                parseRelativePath(childPath, false),
                readLimit,
              );
            } catch (error) {
              if (!(error instanceof LocalWorkspaceError)) {
                throw mapFilesystemError(error);
              }
              if (error.code === "FILE_TOO_LARGE") {
                bytesScanned += error.bytesConsumed;
                if (readLimit < limits.maxFileBytes) {
                  limitReason = "byte_count";
                  break scan;
                }
                filesSkipped += 1;
                continue;
              }
              if (
                error.code === "BINARY_FILE" ||
                error.code === "HARDLINK_NOT_ALLOWED" ||
                error.code === "PATH_NOT_ALLOWED" ||
                error.code === "PATH_NOT_FOUND" ||
                error.code === "ACCESS_DENIED" ||
                error.code === "NOT_A_FILE"
              ) {
                bytesScanned += error.bytesConsumed;
                filesSkipped += 1;
                continue;
              }
              throw error;
            }

            bytesScanned += file.bytes;
            const lines = file.content.split(/\r?\n/u);
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index] ?? "";
              if (!line.toLowerCase().includes(normalizedQuery)) continue;
              if (matches.length >= limits.maxSearchResults) {
                limitReason = "result_count";
                break scan;
              }
              matches.push({
                path: childPath,
                line: index + 1,
                snippet: makeSnippet(
                  line,
                  normalizedQuery,
                  limits.maxSnippetChars,
                ),
              });
            }
          }
        } catch (error) {
          throw mapFilesystemError(error);
        } finally {
          await openedDirectory.close().catch(() => undefined);
        }
      }

      if (!limitReason && timeExpired()) limitReason = "time";
      assertGrantActive(grantId, grant);
      return {
        matches,
        filesScanned,
        filesSkipped,
        bytesScanned,
        truncated: limitReason !== undefined,
        ...(limitReason ? { limitReason } : {}),
      };
    },

    async proposePatch(
      grantId: string,
      relativePath: string,
      proposedContent: string,
      expectedBeforeHash?: string,
    ): Promise<LocalWorkspacePatch> {
      const grant = requireWriteGrant(grantId);
      if (
        expectedBeforeHash !== undefined &&
        !isSha256Hash(expectedBeforeHash)
      ) {
        throw new LocalWorkspaceError("PATCH_HASH_INVALID");
      }
      const parsed = parseRelativePath(relativePath, false);
      if (/[\u0001-\u001f\u007f]/u.test(parsed.relativePath)) {
        throw new LocalWorkspaceError("INVALID_PATH");
      }
      const proposedBytes = encodeProposedText(
        proposedContent,
        limits.maxFileBytes,
      );
      const lockKey = `${grant.canonicalRoot}\0${parsed.relativePath}`;
      return withPathLock(lockKey, async () => {
        const before = await readTextFile(grant, parsed, limits.maxFileBytes);
        const beforeHash = hashBytes(before.rawBytes);
        if (
          expectedBeforeHash !== undefined &&
          beforeHash !== expectedBeforeHash
        ) {
          throw new LocalWorkspaceError("PATCH_CONFLICT");
        }
        const afterHash = hashBytes(proposedBytes);
        if (beforeHash === afterHash) {
          throw new LocalWorkspaceError("PATCH_STATE_INVALID");
        }
        assertGrantActive(grantId, grant);
        makeRoomForPatch();
        if (patches.size >= maxStoredPatches) {
          throw new LocalWorkspaceError("PATCH_LIMIT_REACHED");
        }
        const createdAtMs = currentWallClock();
        const patch: StoredPatch = {
          patchId: randomUUID(),
          projectId: grant.descriptor.projectId,
          canonicalRoot: grant.canonicalRoot,
          path: parsed.relativePath,
          beforeBytes: Buffer.from(before.rawBytes),
          proposedBytes: Buffer.from(proposedBytes),
          beforeHash,
          afterHash,
          createdAt: new Date(createdAtMs).toISOString(),
          expiresAt: createdAtMs + patchTtlMs,
          status: "proposed",
          approvedAt: null,
          rolledBackAt: null,
        };
        patches.set(patch.patchId, patch);
        return toPublicPatch(patch);
      });
    },

    async getPatch(
      grantId: string,
      patchId: string,
    ): Promise<LocalWorkspacePatch> {
      const grant = requireWriteGrant(grantId);
      const patch = requirePatch(grant, patchId);
      assertPatchLive(patch);
      assertGrantActive(grantId, grant);
      return toPublicPatch(patch);
    },

    async workspaceEvaluationStatus(
      projectId: string,
    ): Promise<LocalWorkspaceEvaluationStatus> {
      const commands = workspaceEvaluationCommands.get(projectId);
      if (!commands?.size) {
        return {
          executionAvailable: false,
          reasonCode: "no_server_evaluation_tests_configured",
          tests: [],
        };
      }
      const checks = await Promise.all(
        [...commands.values()].map(async (command) => ({
          command,
          readiness: await probeWorkspaceEvaluationCommand(command),
        })),
      );
      const available = checks.some((check) => check.readiness.available);
      return {
        executionAvailable: available,
        reasonCode: available
          ? null
          : "verified_isolated_project_test_runner_unavailable",
        tests: checks.map(({ command, readiness }) => ({
          id: command.id,
          label: command.label,
          available: readiness.available,
        })),
      };
    },

    async evaluatePatch(
      grantId: string,
      patchId: string,
      testId: string,
    ): Promise<WorkspaceEvaluationReport> {
      const grant = requireWriteGrant(grantId);
      const patch = requirePatch(grant, patchId);
      assertPatchLive(patch);
      if (patch.status !== "proposed") {
        throw new LocalWorkspaceError("PATCH_STATE_INVALID");
      }
      const command = workspaceEvaluationCommands
        .get(grant.descriptor.projectId)
        ?.get(testId);
      if (!command) {
        throw new LocalWorkspaceError("WORKSPACE_EVALUATION_NOT_CONFIGURED");
      }
      const report = await runIsolatedWorkspaceEvaluation({
        workspaceRoot: patch.canonicalRoot,
        patchPath: patch.path,
        expectedBeforeHash: patch.beforeHash,
        candidateContent: patch.proposedBytes.toString("utf8"),
        command,
      });
      assertGrantActive(grantId, grant);
      if (patch.status !== "proposed") {
        throw new LocalWorkspaceError("PATCH_STATE_INVALID");
      }
      assertPatchLive(patch);
      return report;
    },

    async rejectPatch(
      grantId: string,
      patchId: string,
    ): Promise<LocalWorkspacePatch> {
      const grant = requireWriteGrant(grantId);
      const patch = requirePatch(grant, patchId);
      const lockKey = `${patch.canonicalRoot}\0${patch.path}`;
      return withPathLock(lockKey, async () => {
        assertGrantActive(grantId, grant);
        if (patch.status === "rejected") return toPublicPatch(patch);
        assertPatchLive(patch);
        if (patch.status !== "proposed") {
          throw new LocalWorkspaceError("PATCH_STATE_INVALID");
        }
        patch.status = "rejected";
        return toPublicPatch(patch);
      });
    },

    async approvePatch(
      grantId: string,
      patchId: string,
    ): Promise<LocalWorkspacePatchAction> {
      const grant = requireWriteGrant(grantId);
      const patch = requirePatch(grant, patchId);
      const lockKey = `${patch.canonicalRoot}\0${patch.path}`;
      return withPathLock(lockKey, async () => {
        assertGrantActive(grantId, grant);
        if (patch.status === "approved") {
          const current = await readTextFile(
            grant,
            parseRelativePath(patch.path, false),
            limits.maxFileBytes,
          );
          if (hashBytes(current.rawBytes) !== patch.afterHash) {
            throw new LocalWorkspaceError("PATCH_CONFLICT");
          }
          assertGrantActive(grantId, grant);
          return { patch: toPublicPatch(patch), repeated: true };
        }
        assertPatchLive(patch);
        if (patch.status !== "proposed") {
          throw new LocalWorkspaceError("PATCH_STATE_INVALID");
        }
        const approvedAt = new Date(currentWallClock()).toISOString();
        await atomicReplaceTextFile(
          grant,
          parseRelativePath(patch.path, false),
          patch.beforeHash,
          patch.proposedBytes,
          limits.maxFileBytes,
          () => assertGrantActive(grantId, grant),
        );
        patch.status = "approved";
        patch.approvedAt = approvedAt;
        return { patch: toPublicPatch(patch), repeated: false };
      });
    },

    async rollbackPatch(
      grantId: string,
      patchId: string,
    ): Promise<LocalWorkspacePatchAction> {
      const grant = requireWriteGrant(grantId);
      const patch = requirePatch(grant, patchId);
      const lockKey = `${patch.canonicalRoot}\0${patch.path}`;
      return withPathLock(lockKey, async () => {
        assertGrantActive(grantId, grant);
        const parsed = parseRelativePath(patch.path, false);
        if (patch.status === "rolled_back") {
          const current = await readTextFile(
            grant,
            parsed,
            limits.maxFileBytes,
          );
          if (hashBytes(current.rawBytes) !== patch.beforeHash) {
            throw new LocalWorkspaceError("PATCH_CONFLICT");
          }
          assertGrantActive(grantId, grant);
          return { patch: toPublicPatch(patch), repeated: true };
        }
        if (patch.status !== "approved") {
          throw new LocalWorkspaceError("PATCH_STATE_INVALID");
        }
        const rolledBackAt = new Date(currentWallClock()).toISOString();
        await atomicReplaceTextFile(
          grant,
          parsed,
          patch.afterHash,
          patch.beforeBytes,
          limits.maxFileBytes,
          () => assertGrantActive(grantId, grant),
        );
        patch.status = "rolled_back";
        patch.rolledBackAt = rolledBackAt;
        return { patch: toPublicPatch(patch), repeated: false };
      });
    },
  };
}

function resolveLimits(
  requested: Partial<LocalWorkspaceLimits> | undefined,
): LocalWorkspaceLimits {
  const values = { ...DEFAULT_LIMITS, ...requested };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<
    keyof LocalWorkspaceLimits
  >) {
    const value = values[key];
    const minimum = key === "maxSearchDepth" ? 0 : 1;
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > HARD_LIMITS[key]
    ) {
      throw new LocalWorkspaceError("CONFIGURATION_INVALID");
    }
  }
  return Object.freeze(values);
}

async function canonicalizeRoots(
  configuredRoots: readonly LocalWorkspaceProjectRoot[],
): Promise<Map<string, ConfiguredRoot>> {
  if (!Array.isArray(configuredRoots)) {
    throw new LocalWorkspaceError("CONFIGURATION_INVALID");
  }
  const roots = new Map<string, ConfiguredRoot>();
  for (const configured of configuredRoots) {
    if (
      !configured ||
      typeof configured.projectId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(configured.projectId) ||
      typeof configured.rootPath !== "string" ||
      configured.rootPath.includes("\0") ||
      !path.isAbsolute(configured.rootPath) ||
      roots.has(configured.projectId)
    ) {
      throw new LocalWorkspaceError("CONFIGURATION_INVALID");
    }
    try {
      const canonicalRoot = await realpath(configured.rootPath);
      const rootStats = await stat(canonicalRoot);
      if (!rootStats.isDirectory()) {
        throw new LocalWorkspaceError("CONFIGURATION_INVALID");
      }
      roots.set(configured.projectId, {
        projectId: configured.projectId,
        canonicalRoot: path.resolve(canonicalRoot),
      });
    } catch (error) {
      if (error instanceof LocalWorkspaceError) throw error;
      throw new LocalWorkspaceError("CONFIGURATION_INVALID");
    }
  }
  return roots;
}

function parseRelativePath(input: unknown, allowRoot: boolean): ParsedPath {
  if (
    typeof input !== "string" ||
    input.length > MAX_RELATIVE_PATH_CHARS ||
    input.includes("\0") ||
    input.includes("\\") ||
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    /^[A-Za-z]:/u.test(input)
  ) {
    throw new LocalWorkspaceError("INVALID_PATH");
  }
  if (input === "") {
    if (!allowRoot) throw new LocalWorkspaceError("INVALID_PATH");
    return { relativePath: "", segments: [] };
  }

  const segments = input.split("/");
  if (
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > MAX_PATH_SEGMENT_CHARS ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new LocalWorkspaceError("INVALID_PATH");
  }
  if (segments.some(isDeniedPathSegment)) {
    throw new LocalWorkspaceError("SECRET_PATH_DENIED");
  }
  return { relativePath: segments.join("/"), segments };
}

async function resolveSafePath(
  grant: GrantRecord,
  parsed: ParsedPath,
  expectedKind: "directory" | "file",
): Promise<ResolvedPath> {
  let currentPath = grant.canonicalRoot;
  let currentStats: Stats;
  try {
    currentStats = await lstat(currentPath);
    if (currentStats.isSymbolicLink()) {
      throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
    }
    const currentRealPath = await realpath(currentPath);
    if (!samePath(currentRealPath, grant.canonicalRoot)) {
      throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
    }
    if (!currentStats.isDirectory()) {
      throw new LocalWorkspaceError("NOT_A_DIRECTORY");
    }

    for (let index = 0; index < parsed.segments.length; index += 1) {
      const segment = parsed.segments[index];
      if (!segment) throw new LocalWorkspaceError("INVALID_PATH");
      currentPath = path.join(currentPath, segment);
      currentStats = await lstat(currentPath);
      if (currentStats.isSymbolicLink()) {
        throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
      }
      const currentRealPath = await realpath(currentPath);
      if (!isWithinRoot(grant.canonicalRoot, currentRealPath)) {
        throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
      }
      const isLastSegment = index === parsed.segments.length - 1;
      if (!isLastSegment && !currentStats.isDirectory()) {
        throw new LocalWorkspaceError("NOT_A_DIRECTORY");
      }
    }
  } catch (error) {
    throw mapFilesystemError(error);
  }

  if (expectedKind === "directory" && !currentStats.isDirectory()) {
    throw new LocalWorkspaceError("NOT_A_DIRECTORY");
  }
  if (expectedKind === "file" && !currentStats.isFile()) {
    throw new LocalWorkspaceError("NOT_A_FILE");
  }
  return { absolutePath: currentPath, stats: currentStats };
}

async function readTextFile(
  grant: GrantRecord,
  parsed: ParsedPath,
  maxBytes: number,
): Promise<ReadTextResult> {
  const resolved = await resolveSafePath(grant, parsed, "file");
  if (resolved.stats.nlink > 1) {
    throw new LocalWorkspaceError("HARDLINK_NOT_ALLOWED");
  }
  if (resolved.stats.size > maxBytes) {
    throw new LocalWorkspaceError("FILE_TOO_LARGE");
  }

  let fileHandle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    fileHandle = await open(
      resolved.absolutePath,
      fsConstants.O_RDONLY | noFollow,
    );
  } catch (error) {
    throw mapFilesystemError(error);
  }

  try {
    await verifyOpenedFilePath(
      fileHandle.fd,
      grant.canonicalRoot,
      resolved.absolutePath,
    );
    const openedStats = await fileHandle.stat();
    if (!openedStats.isFile()) throw new LocalWorkspaceError("NOT_A_FILE");
    if (openedStats.nlink > 1) {
      throw new LocalWorkspaceError("HARDLINK_NOT_ALLOWED");
    }
    if (openedStats.size > maxBytes) {
      throw new LocalWorkspaceError("FILE_TOO_LARGE");
    }

    const buffer = Buffer.allocUnsafe(maxBytes);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await fileHandle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const contentBytes = buffer.subarray(0, bytesRead);
    if (contentBytes.includes(0)) {
      throw new LocalWorkspaceError("BINARY_FILE", bytesRead);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
    } catch {
      throw new LocalWorkspaceError("BINARY_FILE", bytesRead);
    }

    const finalStats = await fileHandle.stat();
    if (!finalStats.isFile()) throw new LocalWorkspaceError("NOT_A_FILE");
    if (finalStats.nlink > 1) {
      throw new LocalWorkspaceError("HARDLINK_NOT_ALLOWED");
    }
    if (finalStats.size > maxBytes) {
      throw new LocalWorkspaceError("FILE_TOO_LARGE", bytesRead);
    }
    if (finalStats.size !== bytesRead) {
      throw new LocalWorkspaceError("IO_ERROR", bytesRead);
    }
    return {
      content,
      bytes: bytesRead,
      rawBytes: Buffer.from(contentBytes),
    };
  } catch (error) {
    throw mapFilesystemError(error);
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

function validatePositiveLimit(value: number, hardMaximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new LocalWorkspaceError("CONFIGURATION_INVALID");
  }
  return value;
}

function encodeProposedText(content: string, maxBytes: number): Buffer {
  if (typeof content !== "string" || content.length > maxBytes) {
    throw new LocalWorkspaceError("FILE_TOO_LARGE");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maxBytes) {
    throw new LocalWorkspaceError("FILE_TOO_LARGE");
  }
  if (bytes.includes(0)) throw new LocalWorkspaceError("BINARY_FILE");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new LocalWorkspaceError("BINARY_FILE");
  }
  if (decoded !== content) throw new LocalWorkspaceError("BINARY_FILE");
  return bytes;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function toPublicPatch(patch: StoredPatch): LocalWorkspacePatch {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const beforeContent = decoder.decode(patch.beforeBytes);
  const proposedContent = decoder.decode(patch.proposedBytes);
  const preview = makeSideBySidePreview(beforeContent, proposedContent);
  return Object.freeze({
    patchId: patch.patchId,
    path: patch.path,
    status: patch.status,
    beforeHash: patch.beforeHash,
    afterHash: patch.afterHash,
    createdAt: patch.createdAt,
    expiresAt: new Date(patch.expiresAt).toISOString(),
    approvedAt: patch.approvedAt,
    rolledBackAt: patch.rolledBackAt,
    beforeContent,
    proposedContent,
    diff: makeFullReplacementDiff(
      patch.path,
      preview.beforeLines,
      preview.proposedLines,
      preview.truncated,
    ),
    diffRows: preview.rows,
    diffTruncated: preview.truncated,
  });
}

const MAX_REVIEW_DIFF_LINES = 500;

function makeSideBySidePreview(
  beforeContent: string,
  proposedContent: string,
): {
  beforeLines: string[];
  proposedLines: string[];
  rows: Array<{ before: string | null; proposed: string | null }>;
  truncated: boolean;
} {
  const before = boundedContentLines(beforeContent, MAX_REVIEW_DIFF_LINES);
  const proposed = boundedContentLines(proposedContent, MAX_REVIEW_DIFF_LINES);
  const length = Math.max(before.lines.length, proposed.lines.length);
  return {
    beforeLines: before.lines,
    proposedLines: proposed.lines,
    rows: Array.from({ length }, (_, index) => ({
      before: before.lines[index] ?? null,
      proposed: proposed.lines[index] ?? null,
    })),
    truncated: before.truncated || proposed.truncated,
  };
}

function boundedContentLines(
  content: string,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  if (content === "") return { lines: [], truncated: false };
  const lines: string[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) {
      lines.push(content.slice(start));
      return { lines, truncated: false };
    }
    const line = content.slice(start, newline);
    lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    start = newline + 1;
    if (start === content.length) return { lines, truncated: false };
    if (lines.length >= maxLines) return { lines, truncated: true };
  }
  return { lines, truncated: false };
}

function makeFullReplacementDiff(
  relativePath: string,
  beforeLines: string[],
  proposedLines: string[],
  truncated: boolean,
): string {
  const diffPath = escapeDiffPath(relativePath);
  const range = (count: number) => (count === 0 ? "0,0" : `1,${count}`);
  return [
    `--- a/${diffPath}`,
    `+++ b/${diffPath}`,
    `@@ -${range(beforeLines.length)} +${range(proposedLines.length)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...proposedLines.map((line) => `+${line}`),
    ...(truncated
      ? ["... preview truncated after 500 lines per side ..."]
      : []),
  ].join("\n");
}

function escapeDiffPath(value: string): string {
  return value.replace(/[\\\t\r\n\u0000-\u001f\u007f]/gu, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case "\t":
        return "\\t";
      case "\r":
        return "\\r";
      case "\n":
        return "\\n";
      default:
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

async function atomicReplaceTextFile(
  grant: GrantRecord,
  parsed: ParsedPath,
  expectedHash: string,
  replacement: Buffer,
  maxBytes: number,
  assertGrant: () => void,
): Promise<void> {
  const initial = await readTextFile(grant, parsed, maxBytes);
  if (hashBytes(initial.rawBytes) !== expectedHash) {
    throw new LocalWorkspaceError("PATCH_CONFLICT");
  }
  assertGrant();

  const initialPath = await resolveSafePath(grant, parsed, "file");
  if (initialPath.stats.nlink > 1) {
    throw new LocalWorkspaceError("HARDLINK_NOT_ALLOWED");
  }
  if (initialPath.stats.size > maxBytes) {
    throw new LocalWorkspaceError("FILE_TOO_LARGE");
  }
  const parentPath = path.dirname(initialPath.absolutePath);
  await verifyDirectoryPath(grant, parentPath);
  const temporaryPath = path.join(parentPath, `.promptlab-${randomUUID()}.tmp`);
  let temporaryHandle;
  let temporaryExists = false;
  try {
    temporaryHandle = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      initialPath.stats.mode & 0o777,
    );
    temporaryExists = true;
    await temporaryHandle.writeFile(replacement);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    assertGrant();
    const currentPath = await resolveSafePath(grant, parsed, "file");
    if (
      currentPath.stats.nlink > 1 ||
      currentPath.stats.dev !== initialPath.stats.dev ||
      currentPath.stats.ino !== initialPath.stats.ino
    ) {
      throw new LocalWorkspaceError(
        currentPath.stats.nlink > 1 ? "HARDLINK_NOT_ALLOWED" : "PATCH_CONFLICT",
      );
    }
    const current = await readTextFile(grant, parsed, maxBytes);
    if (hashBytes(current.rawBytes) !== expectedHash) {
      throw new LocalWorkspaceError("PATCH_CONFLICT");
    }
    await verifyDirectoryPath(grant, parentPath);
    assertGrant();
    await rename(temporaryPath, currentPath.absolutePath);
    temporaryExists = false;
    const applied = await readTextFile(grant, parsed, maxBytes);
    if (hashBytes(applied.rawBytes) !== hashBytes(replacement)) {
      throw new LocalWorkspaceError("IO_ERROR");
    }
    const directory = await open(parentPath, fsConstants.O_RDONLY);
    try {
      await directory.sync().catch(() => undefined);
    } finally {
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    throw mapFilesystemError(error);
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function verifyDirectoryPath(
  grant: GrantRecord,
  expectedPath: string,
): Promise<void> {
  let currentPath: string;
  try {
    currentPath = await realpath(expectedPath);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (
    !isWithinRoot(grant.canonicalRoot, currentPath) ||
    !samePath(currentPath, expectedPath)
  ) {
    throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
  }
}

async function verifyOpenedFilePath(
  fileDescriptor: number,
  canonicalRoot: string,
  expectedPath: string,
): Promise<void> {
  let openedPath = expectedPath;
  if (process.platform === "linux") {
    try {
      openedPath = await realpath(`/proc/self/fd/${fileDescriptor}`);
    } catch (error) {
      throw mapFilesystemError(error);
    }
  } else {
    try {
      openedPath = await realpath(expectedPath);
    } catch (error) {
      throw mapFilesystemError(error);
    }
  }
  if (
    !isWithinRoot(canonicalRoot, openedPath) ||
    !samePath(openedPath, expectedPath)
  ) {
    throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
  }
}

function validateSearchQuery(query: unknown, maximumChars: number): string {
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    query.length > maximumChars ||
    /[\u0000-\u001f\u007f]/u.test(query) ||
    query.trim().length === 0
  ) {
    throw new LocalWorkspaceError("INVALID_SEARCH_QUERY");
  }
  return query.trim().toLowerCase();
}

function makeSnippet(
  line: string,
  normalizedQuery: string,
  maxChars: number,
): string {
  if (line.length <= maxChars) return line;
  const position = line.toLowerCase().indexOf(normalizedQuery);
  const start = Math.max(
    0,
    Math.min(position - Math.floor(maxChars / 3), line.length - maxChars),
  );
  return line.slice(start, start + maxChars);
}

function readClock(monotonicNow: () => number): number {
  const value = monotonicNow();
  if (!Number.isFinite(value)) {
    throw new LocalWorkspaceError("CONFIGURATION_INVALID");
  }
  return value;
}

function direntKind(entry: Dirent<string>): "directory" | "file" | null {
  if (entry.isSymbolicLink()) return null;
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return null;
}

function isUsableEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_PATH_SEGMENT_CHARS &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".."
  );
}

function isDeniedPathSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower.startsWith(".")) return true;
  if (DENIED_DIRECTORY_NAMES.has(lower)) return true;
  if (
    lower === "env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".env") ||
    DENIED_FILE_EXTENSIONS.has(path.extname(lower)) ||
    /(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens)(?:$|[._-])/u.test(
      lower,
    ) ||
    /(?:^|[._-])(?:(?:api|private|ssh|server|client)[._-]*)?key(?:$|[._-])/u.test(
      lower,
    ) ||
    /(?:^|[._-])(?:id|ssh_host)[._-]?(?:rsa|dsa|ecdsa|ed25519)(?:[._-]?key)?(?:$|[._-])/u.test(
      lower,
    ) ||
    /^(?:authorized_keys|known_hosts|id_(?:rsa|dsa|ecdsa|ed25519)|ssh_host_(?:rsa|dsa|ecdsa|ed25519)_key)$/u.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

function joinRelativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function mapFilesystemError(error: unknown): LocalWorkspaceError {
  if (error instanceof LocalWorkspaceError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
  if (code === "ENOENT") return new LocalWorkspaceError("PATH_NOT_FOUND");
  if (code === "ENOTDIR") return new LocalWorkspaceError("NOT_A_DIRECTORY");
  if (code === "EACCES" || code === "EPERM") {
    return new LocalWorkspaceError("ACCESS_DENIED");
  }
  if (code === "ELOOP") return new LocalWorkspaceError("PATH_NOT_ALLOWED");
  return new LocalWorkspaceError("IO_ERROR");
}
