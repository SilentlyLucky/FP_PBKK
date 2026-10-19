import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export type WorkspaceSnapshotErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_CHANGED"
  | "SNAPSHOT_LIMIT_REACHED"
  | "SNAPSHOT_FAILED";

export class WorkspaceSnapshotError extends Error {
  constructor(readonly code: WorkspaceSnapshotErrorCode) {
    super(code);
    this.name = "WorkspaceSnapshotError";
  }
}

export interface WorkspaceEvaluationSnapshotPair {
  /** Private temporary directories. Never return these paths from an HTTP API. */
  readonly baselineDirectory: string;
  readonly candidateDirectory: string;
  /** Hashes of the same copied project state before applying the candidate patch. */
  readonly startingSnapshotHash: string;
  readonly baselineSnapshotHash: string;
  /** Hash of the candidate snapshot after the proposed file content was applied. */
  readonly candidateSnapshotHash: string;
  readonly filesPerSnapshot: number;
  readonly bytesPerSnapshot: number;
  readonly entriesExcludedByPolicy: number;
  readonly cleanup: () => Promise<void>;
}

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50_000;
const HARD_MAX_ENTRIES = 250_000;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".cache",
  ".codex",
  ".git",
  ".next",
  ".ssh",
  ".turbo",
  "backups",
  "credentials",
  "secrets",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  "id_ed25519",
  "id_rsa",
]);

const EXCLUDED_FILE_EXTENSIONS = new Set([
  ".asc",
  ".gpg",
  ".jks",
  ".key",
  ".kdbx",
  ".keystore",
  ".p12",
  ".p8",
  ".pem",
  ".pfx",
]);

interface CopyState {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  bytesCopied: number;
  filesCopied: number;
  entriesSeen: number;
  entriesExcludedByPolicy: number;
}

/**
 * Create two independent, writable project copies and apply the proposed text
 * only to the candidate. This prepares snapshots; it deliberately does not
 * execute project commands. Callers must use a separately verified OS sandbox
 * before running any code from either snapshot.
 */
export async function createWorkspaceEvaluationSnapshots(input: {
  readonly workspaceRoot: string;
  readonly patchPath: string;
  readonly expectedBeforeHash: string;
  readonly candidateContent: string;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}): Promise<WorkspaceEvaluationSnapshotPair> {
  if (
    typeof input.workspaceRoot !== "string" ||
    !path.isAbsolute(input.workspaceRoot) ||
    !HASH_PATTERN.test(input.expectedBeforeHash) ||
    typeof input.candidateContent !== "string" ||
    input.candidateContent.includes("\0")
  ) {
    throw new WorkspaceSnapshotError("INVALID_INPUT");
  }
  const patchPath = parsePatchPath(input.patchPath);
  const candidateBytes = Buffer.from(input.candidateContent, "utf8");
  if (candidateBytes.byteLength > MAX_PATCH_BYTES) {
    throw new WorkspaceSnapshotError("SNAPSHOT_LIMIT_REACHED");
  }
  const maxBytes = positiveBoundedInteger(
    input.maxBytes,
    DEFAULT_MAX_BYTES,
    HARD_MAX_BYTES,
  );
  const maxEntries = positiveBoundedInteger(
    input.maxEntries,
    DEFAULT_MAX_ENTRIES,
    HARD_MAX_ENTRIES,
  );

  let sourceRoot: string;
  try {
    sourceRoot = path.resolve(await realpath(input.workspaceRoot));
    if (!(await lstat(sourceRoot)).isDirectory()) {
      throw new WorkspaceSnapshotError("INVALID_INPUT");
    }
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError("SNAPSHOT_FAILED");
  }

  let temporaryRoot: string | undefined;
  try {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "promptlab-workspace-eval-"),
    );
    const canonicalTemporaryRoot = path.resolve(await realpath(temporaryRoot));
    if (
      isPathWithin(sourceRoot, canonicalTemporaryRoot) ||
      isPathWithin(canonicalTemporaryRoot, sourceRoot)
    ) {
      throw new WorkspaceSnapshotError("INVALID_INPUT");
    }

    const baselineDirectory = path.join(canonicalTemporaryRoot, "baseline");
    const candidateDirectory = path.join(canonicalTemporaryRoot, "candidate");
    await mkdir(baselineDirectory, { mode: 0o700 });
    const state: CopyState = {
      sourceRoot,
      destinationRoot: baselineDirectory,
      maxBytes,
      maxEntries,
      bytesCopied: 0,
      filesCopied: 0,
      entriesSeen: 0,
      entriesExcludedByPolicy: 0,
    };
    await copyDirectory(state, "");
    const startingSnapshotHash = await hashWorkspaceSnapshot(baselineDirectory);

    const baselineTarget = resolveSnapshotPath(baselineDirectory, patchPath);
    await assertNoSymlinkPath(baselineDirectory, patchPath);
    const actualBeforeHash = await hashRegularFile(baselineTarget);
    if (actualBeforeHash !== input.expectedBeforeHash) {
      throw new WorkspaceSnapshotError("SOURCE_CHANGED");
    }

    await mkdir(candidateDirectory, { mode: 0o700 });
    const candidateState: CopyState = {
      sourceRoot: baselineDirectory,
      destinationRoot: candidateDirectory,
      maxBytes,
      maxEntries,
      bytesCopied: 0,
      filesCopied: 0,
      entriesSeen: 0,
      entriesExcludedByPolicy: 0,
    };
    await copyDirectory(candidateState, "");
    const candidateTarget = resolveSnapshotPath(candidateDirectory, patchPath);
    await assertNoSymlinkPath(candidateDirectory, patchPath);
    const candidateBeforeHash = await hashRegularFile(candidateTarget);
    if (candidateBeforeHash !== input.expectedBeforeHash) {
      throw new WorkspaceSnapshotError("SOURCE_CHANGED");
    }
    await writeFile(candidateTarget, candidateBytes, { flag: "w" });

    const [baselineSnapshotHash, candidateSnapshotHash] = await Promise.all([
      hashWorkspaceSnapshot(baselineDirectory),
      hashWorkspaceSnapshot(candidateDirectory),
    ]);
    const cleanup = async () => {
      await rm(canonicalTemporaryRoot, { recursive: true, force: true });
    };
    return {
      baselineDirectory,
      candidateDirectory,
      startingSnapshotHash,
      baselineSnapshotHash,
      candidateSnapshotHash,
      filesPerSnapshot: state.filesCopied,
      bytesPerSnapshot: state.bytesCopied,
      entriesExcludedByPolicy: state.entriesExcludedByPolicy,
      cleanup,
    };
  } catch (error) {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError("SNAPSHOT_FAILED");
  }
}

function positiveBoundedInteger(
  value: number | undefined,
  defaultValue: number,
  hardLimit: number,
): number {
  const selected = value ?? defaultValue;
  if (
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > hardLimit
  ) {
    throw new WorkspaceSnapshotError("INVALID_INPUT");
  }
  return selected;
}

function parsePatchPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new WorkspaceSnapshotError("INVALID_INPUT");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    throw new WorkspaceSnapshotError("INVALID_INPUT");
  }
  return segments.join("/");
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function resolveSnapshotPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isPathWithin(root, resolved)) {
    throw new WorkspaceSnapshotError("INVALID_INPUT");
  }
  return resolved;
}

function excludedByPolicy(relativePath: string, directory: boolean): boolean {
  const name = path.posix.basename(relativePath);
  if (directory && EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase())) {
    return true;
  }
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    EXCLUDED_FILE_NAMES.has(name.toLowerCase())
  ) {
    return true;
  }
  return EXCLUDED_FILE_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}

async function copyDirectory(
  state: CopyState,
  relativeDirectory: string,
): Promise<void> {
  const sourceDirectory = path.join(
    state.sourceRoot,
    ...relativeDirectory.split("/").filter(Boolean),
  );
  const destinationDirectory = path.join(
    state.destinationRoot,
    ...relativeDirectory.split("/").filter(Boolean),
  );
  let entries;
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch {
    throw new WorkspaceSnapshotError("SNAPSHOT_FAILED");
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    const stats = await lstat(sourcePath).catch(() => undefined);
    if (!stats) throw new WorkspaceSnapshotError("SOURCE_CHANGED");
    if (excludedByPolicy(relativePath, stats.isDirectory())) {
      state.entriesExcludedByPolicy += 1;
      continue;
    }

    state.entriesSeen += 1;
    if (state.entriesSeen > state.maxEntries) {
      throw new WorkspaceSnapshotError("SNAPSHOT_LIMIT_REACHED");
    }
    if (stats.isDirectory()) {
      await mkdir(destinationPath, {
        mode: safeWritableMode(stats.mode, true),
      });
      await copyDirectory(state, relativePath);
      await chmod(destinationPath, safeWritableMode(stats.mode, true));
      continue;
    }
    if (stats.isFile()) {
      await copyRegularFile(state, sourcePath, destinationPath, stats);
      continue;
    }
    if (stats.isSymbolicLink()) {
      await copyInternalSymlink(state, sourcePath, destinationPath);
    } else {
      state.entriesExcludedByPolicy += 1;
    }
  }
}

async function copyRegularFile(
  state: CopyState,
  sourcePath: string,
  destinationPath: string,
  expectedStats: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  if (expectedStats.size > state.maxBytes - state.bytesCopied) {
    throw new WorkspaceSnapshotError("SNAPSHOT_LIMIT_REACHED");
  }
  let handle;
  try {
    handle = await open(
      sourcePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== expectedStats.dev ||
      before.ino !== expectedStats.ino
    ) {
      throw new WorkspaceSnapshotError("SOURCE_CHANGED");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw new WorkspaceSnapshotError("SOURCE_CHANGED");
    }
    await writeFile(destinationPath, bytes, {
      flag: "wx",
      mode: safeWritableMode(before.mode, false),
    });
    await chmod(destinationPath, safeWritableMode(before.mode, false));
    state.bytesCopied += bytes.byteLength;
    state.filesCopied += 1;
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError("SNAPSHOT_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function copyInternalSymlink(
  state: CopyState,
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  try {
    const target = await readlink(sourcePath);
    if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
      state.entriesExcludedByPolicy += 1;
      return;
    }
    const resolvedTarget = path.resolve(path.dirname(sourcePath), target);
    const canonicalTarget = await realpath(resolvedTarget);
    if (!isPathWithin(state.sourceRoot, canonicalTarget)) {
      state.entriesExcludedByPolicy += 1;
      return;
    }
    const copiedTarget = path.resolve(path.dirname(destinationPath), target);
    if (!isPathWithin(state.destinationRoot, copiedTarget)) {
      state.entriesExcludedByPolicy += 1;
      return;
    }
    await symlink(target, destinationPath);
    state.entriesSeen += 1;
    if (state.entriesSeen > state.maxEntries) {
      throw new WorkspaceSnapshotError("SNAPSHOT_LIMIT_REACHED");
    }
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error;
    state.entriesExcludedByPolicy += 1;
  }
}

async function assertNoSymlinkPath(
  root: string,
  relativePath: string,
): Promise<void> {
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      throw new WorkspaceSnapshotError("SOURCE_CHANGED");
    }
    const isLast = index === segments.length - 1;
    if (
      stats.isSymbolicLink() ||
      (isLast ? !stats.isFile() : !stats.isDirectory())
    ) {
      throw new WorkspaceSnapshotError("INVALID_INPUT");
    }
  }
}

function safeWritableMode(mode: number, directory: boolean): number {
  const executableBits = mode & 0o111;
  return (directory ? 0o700 : 0o600) | executableBits;
}

async function hashRegularFile(filePath: string): Promise<string> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile()) throw new WorkspaceSnapshotError("INVALID_INPUT");
    const bytes = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const content = await bytes.readFile();
      return createHash("sha256").update(content).digest("hex");
    } finally {
      await bytes.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError("SOURCE_CHANGED");
  }
}

async function hashWorkspaceSnapshot(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relativeDirectory: string): Promise<void> {
    const directory = path.join(
      root,
      ...relativeDirectory.split("/").filter(Boolean),
    );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await visit(relativePath);
      } else if (stats.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        const handle = await open(
          absolutePath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        try {
          hash.update(await handle.readFile());
        } finally {
          await handle.close();
        }
      } else if (stats.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${await readlink(absolutePath)}\0`,
        );
      }
    }
  }
  try {
    await visit("");
    return hash.digest("hex");
  } catch {
    throw new WorkspaceSnapshotError("SNAPSHOT_FAILED");
  }
}
