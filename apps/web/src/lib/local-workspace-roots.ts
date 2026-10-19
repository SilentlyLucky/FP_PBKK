import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  lstat,
  stat,
  unlink,
} from "node:fs/promises";

import { IdSchema } from "@promptlab/contracts";

const MAX_REGISTRY_BYTES = 256 * 1_024;
const MAX_REGISTERED_ROOTS = 100;
const REGISTRY_FORMAT = "promptlab-local-workspace-roots-v1";

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

export interface RegisteredWorkspaceRoot {
  readonly projectId: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly available: boolean;
}

export interface WorkspaceRootSummary {
  readonly projectId: string;
  readonly rootId: string;
  readonly displayName: string;
  readonly source: "registered";
  readonly available: boolean;
  readonly createdAt: string;
}

/** Durable local configuration for explicitly selected, read-only folders. */
export class LocalWorkspaceRootRegistry {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory = path.join(homedir(), ".promptlab"),
    private readonly ownerHome = homedir(),
  ) {}

  async list(projectId?: string): Promise<readonly RegisteredWorkspaceRoot[]> {
    const roots = await this.readRecords();
    const filtered = projectId
      ? roots.filter((root) => root.projectId === projectId)
      : roots;
    const checked: RegisteredWorkspaceRoot[] = [];
    for (const root of filtered) {
      checked.push({
        ...root,
        available: await this.isAvailable(root.rootPath),
      });
    }
    return checked;
  }

  async register(
    projectIdValue: string,
    rootPath: string,
  ): Promise<RegisteredWorkspaceRoot> {
    const project = IdSchema.safeParse(projectIdValue);
    if (!project.success) throw new Error("ROOT_REGISTRATION_INVALID");
    const canonical = await this.verifyRoot(rootPath);
    return this.withWriteQueue(async () => {
      const roots = await this.readRecords();
      const existing = roots.find(
        (root) =>
          root.projectId === project.data && root.rootPath === canonical,
      );
      if (existing) return { ...existing, available: true };
      if (roots.length >= MAX_REGISTERED_ROOTS) {
        throw new Error("ROOT_REGISTRATION_LIMIT_REACHED");
      }
      const root: RegisteredWorkspaceRoot = {
        projectId: project.data,
        rootId: randomUUID(),
        rootPath: canonical,
        displayName: path.basename(canonical).slice(0, 255),
        createdAt: new Date().toISOString(),
        available: true,
      };
      await this.writeRecords([...roots, root]);
      return root;
    });
  }

  async revoke(projectIdValue: string, rootIdValue: string): Promise<boolean> {
    const project = IdSchema.safeParse(projectIdValue);
    const rootId = IdSchema.safeParse(rootIdValue);
    if (!project.success || !rootId.success) {
      throw new Error("ROOT_REGISTRATION_INVALID");
    }
    return this.withWriteQueue(async () => {
      const roots = await this.readRecords();
      const next = roots.filter(
        (root) =>
          root.projectId !== project.data || root.rootId !== rootId.data,
      );
      if (next.length === roots.length) return false;
      await this.writeRecords(next);
      return true;
    });
  }

  summaries(roots: readonly RegisteredWorkspaceRoot[]): WorkspaceRootSummary[] {
    return roots.map((root) => ({
      projectId: root.projectId,
      rootId: root.rootId,
      displayName: root.displayName,
      source: "registered",
      available: root.available,
      createdAt: root.createdAt,
    }));
  }

  private async readRecords(): Promise<RegisteredWorkspaceRoot[]> {
    if (!(await this.secureDirectoryExists())) return [];
    const filePath = path.join(this.directory, "workspace-roots.json");
    let metadata;
    try {
      metadata = await lstat(filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("ROOT_REGISTRY_UNAVAILABLE");
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_REGISTRY_BYTES
    ) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    if (
      !isRecord(value) ||
      value.format !== REGISTRY_FORMAT ||
      !Array.isArray(value.roots) ||
      value.roots.length > MAX_REGISTERED_ROOTS
    ) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    const roots: RegisteredWorkspaceRoot[] = [];
    const ids = new Set<string>();
    for (const item of value.roots) {
      if (
        !isRecord(item) ||
        Object.keys(item).length !== 5 ||
        typeof item.projectId !== "string" ||
        typeof item.rootId !== "string" ||
        typeof item.rootPath !== "string" ||
        typeof item.displayName !== "string" ||
        typeof item.createdAt !== "string"
      ) {
        throw new Error("ROOT_REGISTRY_INVALID");
      }
      const project = IdSchema.safeParse(item.projectId);
      const rootId = IdSchema.safeParse(item.rootId);
      if (
        !project.success ||
        !rootId.success ||
        !path.isAbsolute(item.rootPath) ||
        item.rootPath.includes("\0") ||
        item.displayName !== path.basename(item.rootPath) ||
        !Number.isFinite(Date.parse(item.createdAt)) ||
        ids.has(rootId.data)
      ) {
        throw new Error("ROOT_REGISTRY_INVALID");
      }
      ids.add(rootId.data);
      roots.push({
        projectId: project.data,
        rootId: rootId.data,
        rootPath: item.rootPath,
        displayName: item.displayName,
        createdAt: item.createdAt,
        available: false,
      });
    }
    return roots;
  }

  private async writeRecords(roots: readonly RegisteredWorkspaceRoot[]) {
    await this.ensureSecureDirectory();
    const filePath = path.join(this.directory, "workspace-roots.json");
    const temporaryPath = path.join(
      this.directory,
      ".workspace-roots-" + randomUUID() + ".tmp",
    );
    const bytes = Buffer.from(
      JSON.stringify({
        format: REGISTRY_FORMAT,
        roots: roots.map((root) => ({
          projectId: root.projectId,
          rootId: root.rootId,
          rootPath: root.rootPath,
          displayName: root.displayName,
          createdAt: root.createdAt,
        })),
      }),
      "utf8",
    );
    if (bytes.length > MAX_REGISTRY_BYTES) {
      throw new Error("ROOT_REGISTRY_LIMIT_REACHED");
    }
    let handle;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        const existing = await lstat(filePath);
        if (
          existing.isSymbolicLink() ||
          !existing.isFile() ||
          existing.nlink !== 1
        ) {
          throw new Error("ROOT_REGISTRY_INVALID");
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await rename(temporaryPath, filePath);
      const directoryHandle = await open(this.directory, fsConstants.O_RDONLY);
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new Error("ROOT_REGISTRY_UNAVAILABLE");
    }
  }

  private async ensureSecureDirectory() {
    const home = await realpath(this.ownerHome).catch(() => {
      throw new Error("ROOT_REGISTRY_UNAVAILABLE");
    });
    const expected = path.resolve(this.directory);
    const relative = path.relative(home, expected);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    await mkdir(expected, { recursive: true, mode: 0o700 });
    const metadata = await lstat(expected);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    const canonicalDirectory = await realpath(expected);
    if (canonicalDirectory !== expected) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
  }

  private async secureDirectoryExists(): Promise<boolean> {
    const home = await realpath(this.ownerHome).catch(() => {
      throw new Error("ROOT_REGISTRY_UNAVAILABLE");
    });
    const expected = path.resolve(this.directory);
    const relative = path.relative(home, expected);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    let metadata;
    try {
      metadata = await lstat(expected);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw new Error("ROOT_REGISTRY_UNAVAILABLE");
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (await realpath(expected)) !== expected
    ) {
      throw new Error("ROOT_REGISTRY_INVALID");
    }
    return true;
  }

  private async verifyRoot(rootPath: string): Promise<string> {
    const home = await realpath(this.ownerHome).catch(() => {
      throw new Error("ROOT_REGISTRATION_UNAVAILABLE");
    });
    if (!path.isAbsolute(rootPath) || rootPath.includes("\0")) {
      throw new Error("ROOT_REGISTRATION_INVALID");
    }
    const normalized = path.resolve(rootPath);
    const canonical = await realpath(normalized).catch(() => {
      throw new Error("ROOT_REGISTRATION_UNAVAILABLE");
    });
    const metadata = await lstat(normalized).catch(() => null);
    const relative = path.relative(home, canonical);
    if (
      !metadata?.isDirectory() ||
      metadata.isSymbolicLink() ||
      normalized !== canonical ||
      relative === "" ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).some(isDeniedDirectoryName)
    ) {
      throw new Error("ROOT_REGISTRATION_INVALID");
    }
    return canonical;
  }

  private async isAvailable(rootPath: string): Promise<boolean> {
    try {
      await this.verifyRoot(rootPath);
      const metadata = await stat(rootPath);
      return metadata.isDirectory();
    } catch {
      return false;
    }
  }

  private withWriteQueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function defaultLocalWorkspaceRootRegistry(): LocalWorkspaceRootRegistry {
  return new LocalWorkspaceRootRegistry();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

function isDeniedDirectoryName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".") ||
    DENIED_DIRECTORY_NAMES.has(lower) ||
    /(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens)(?:$|[._-])/u.test(
      lower,
    ) ||
    /(?:^|[._-])(?:(?:api|private|ssh|server|client)[._-]*)?key(?:$|[._-])/u.test(
      lower,
    )
  );
}
