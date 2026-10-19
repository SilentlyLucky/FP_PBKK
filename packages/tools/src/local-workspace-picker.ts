import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";
import { lstat, opendir, realpath, stat } from "node:fs/promises";

import { LocalWorkspaceError } from "./local-workspace.js";

const MAX_PICKER_ENTRIES = 160;
const PICKER_TOKEN_TTL_MS = 10 * 60 * 1_000;

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

export interface LocalWorkspacePickerEntry {
  readonly name: string;
  readonly token: string;
}

export interface LocalWorkspacePickerListing {
  readonly currentName: string;
  readonly breadcrumbs: readonly string[];
  readonly currentToken: string | null;
  readonly parentToken: string | null;
  readonly directories: readonly LocalWorkspacePickerEntry[];
  readonly truncated: boolean;
}

export interface LocalWorkspacePickerSelection {
  readonly rootPath: string;
  readonly displayName: string;
}

interface PickerToken {
  readonly projectId: string;
  readonly path: string;
  readonly homePath: string;
  readonly expiresAt: number;
  readonly selectable: boolean;
  readonly rootSelectable: boolean;
}

/**
 * Metadata-only directory chooser. The browser receives opaque, project-bound
 * tokens and directory names; it never submits an arbitrary filesystem path.
 */
export class LocalWorkspaceDirectoryPicker {
  private readonly tokens = new Map<string, PickerToken>();

  constructor(
    private readonly homeDirectory: () => string = homedir,
    private readonly now: () => number = Date.now,
    private readonly configuredRoot: () => string | undefined = () => undefined,
  ) {}

  async begin(projectId: string): Promise<LocalWorkspacePickerListing> {
    const configuredRoot = this.configuredRoot()?.trim();
    const homePath = await realpath(configuredRoot || this.homeDirectory());
    const homeStats = await stat(homePath);
    if (!homeStats.isDirectory()) {
      throw new LocalWorkspaceError("ACCESS_DENIED");
    }
    const rootSelectable = Boolean(configuredRoot);
    const homeToken = this.issueToken({
      projectId,
      path: homePath,
      homePath,
      selectable: rootSelectable,
      rootSelectable,
    });
    return this.list(projectId, homeToken);
  }

  async browse(
    projectId: string,
    token: string,
  ): Promise<LocalWorkspacePickerListing> {
    const record = this.requireToken(projectId, token);
    return this.list(projectId, token, record);
  }

  async resolveSelection(
    projectId: string,
    token: string,
  ): Promise<LocalWorkspacePickerSelection> {
    const record = this.requireToken(projectId, token);
    if (!record.selectable) {
      throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
    }
    const canonical = await this.verifyDirectory(record, record.path);
    return {
      rootPath: canonical,
      displayName: path.basename(canonical),
    };
  }

  private async list(
    projectId: string,
    token: string,
    known?: PickerToken,
  ): Promise<LocalWorkspacePickerListing> {
    const current = known ?? this.requireToken(projectId, token);
    const canonical = await this.verifyDirectory(current, current.path);
    const entries: LocalWorkspacePickerEntry[] = [];
    let truncated = false;
    let directory;
    try {
      directory = await opendir(canonical);
      for await (const entry of directory) {
        if (!entry.isDirectory() || isDeniedDirectoryName(entry.name)) continue;
        if (entries.length >= MAX_PICKER_ENTRIES) {
          truncated = true;
          break;
        }
        const candidate = path.join(canonical, entry.name);
        try {
          const metadata = await lstat(candidate);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
          const childPath = await this.verifyDirectory(current, candidate);
          const childToken = this.issueToken({
            projectId,
            path: childPath,
            homePath: current.homePath,
            selectable: true,
            rootSelectable: current.rootSelectable,
          });
          entries.push({ name: entry.name, token: childToken });
        } catch {
          // Entries that change during enumeration or resolve outside the
          // allowed home are omitted from the metadata-only picker.
        }
      }
    } catch {
      throw new LocalWorkspaceError("ACCESS_DENIED");
    }

    const parentPath = path.dirname(canonical);
    const parentToken =
      canonical === current.homePath
        ? null
        : this.issueToken({
            projectId,
            path: parentPath,
            homePath: current.homePath,
            selectable:
              parentPath === current.homePath
                ? current.rootSelectable
                : true,
            rootSelectable: current.rootSelectable,
          });
    const relative = path.relative(current.homePath, canonical);
    const breadcrumbs = relative
      ? relative
          .split(path.sep)
          .filter(Boolean)
          .map((segment) => segment.slice(0, 255))
      : [];
    const currentName =
      breadcrumbs.at(-1) ??
      (current.rootSelectable
        ? path.basename(canonical) || "Folder utama"
        : "Folder pengguna");
    return {
      currentName,
      breadcrumbs,
      currentToken: current.selectable ? token : null,
      parentToken,
      directories: entries,
      truncated,
    };
  }

  private issueToken(input: Omit<PickerToken, "expiresAt">): string {
    this.pruneExpired();
    const token = randomUUID();
    this.tokens.set(token, {
      ...input,
      expiresAt: this.now() + PICKER_TOKEN_TTL_MS,
    });
    return token;
  }

  private requireToken(projectId: string, token: string): PickerToken {
    this.pruneExpired();
    const record = this.tokens.get(token);
    if (!record || record.projectId !== projectId) {
      throw new LocalWorkspaceError("GRANT_NOT_FOUND");
    }
    return record;
  }

  private async verifyDirectory(
    record: PickerToken,
    candidate: string,
  ): Promise<string> {
    try {
      const canonical = await realpath(candidate);
      const metadata = await lstat(candidate);
      const relative = path.relative(record.homePath, canonical);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        canonical !== path.resolve(candidate) ||
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).some(isDeniedDirectoryName)
      ) {
        throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
      }
      return canonical;
    } catch (error) {
      if (error instanceof LocalWorkspaceError) throw error;
      throw new LocalWorkspaceError("PATH_NOT_ALLOWED");
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, record] of this.tokens) {
      if (now >= record.expiresAt) this.tokens.delete(token);
    }
  }
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
