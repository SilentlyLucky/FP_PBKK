import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  LocalWorkspaceError,
  createLocalWorkspaceService,
  type LocalWorkspaceLimits,
  type LocalWorkspaceProjectRoot,
  type LocalWorkspaceService,
} from "./local-workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeFixture(): Promise<{
  base: string;
  project: string;
  outside: string;
}> {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "promptlab-local-workspace-"),
  );
  temporaryDirectories.push(base);
  const project = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(project);
  await mkdir(outside);
  return { base, project, outside };
}

async function serviceFor(
  project: string,
  options: {
    readonly limits?: Partial<LocalWorkspaceLimits>;
    readonly monotonicNow?: () => number;
  } = {},
): Promise<LocalWorkspaceService> {
  const root: LocalWorkspaceProjectRoot = {
    projectId: "project-123",
    rootPath: project,
  };
  return createLocalWorkspaceService({
    allowedProjectRoots: [root],
    ...options,
  });
}

async function captureError(
  action: () => Promise<unknown> | unknown,
): Promise<LocalWorkspaceError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalWorkspaceError);
    return error as LocalWorkspaceError;
  }
  throw new Error("Expected the local workspace operation to fail");
}

describe("read-only local workspace foundation", () => {
  it("starts with no roots or grants and returns safe structured errors", async () => {
    const service = await createLocalWorkspaceService();
    const error = await captureError(() => service.issueGrant("project-123"));
    expect(error).toMatchObject({
      code: "PROJECT_NOT_ALLOWLISTED",
      message: "The requested project is not available.",
    });
    expect(error.toJSON()).toEqual({
      code: "PROJECT_NOT_ALLOWLISTED",
      message: "The requested project is not available.",
    });
  });

  it("issues only configured project grants, scopes operations, and revokes access", async () => {
    const { project, outside } = await makeFixture();
    await writeFile(path.join(project, "README.md"), "project file", "utf8");
    await writeFile(
      path.join(outside, "outside.txt"),
      "outside content",
      "utf8",
    );
    const service = await serviceFor(project);

    await expect(
      Promise.resolve().then(() => service.issueGrant("unconfigured-project")),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_ALLOWLISTED" });
    const grant = service.issueGrant("project-123");
    expect(grant).toMatchObject({
      projectId: "project-123",
      access: "read_only",
      scope: "project_root",
    });
    expect("write" in service).toBe(false);
    expect("execute" in service).toBe(false);

    await expect(
      service.read(grant.grantId, "README.md"),
    ).resolves.toMatchObject({
      content: "project file",
    });
    await expect(
      service.read(grant.grantId, path.join(outside, "outside.txt")),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });

    expect(service.revokeGrant(grant.grantId)).toBe(true);
    expect(service.revokeGrant(grant.grantId)).toBe(false);
    await expect(
      service.read(grant.grantId, "README.md"),
    ).rejects.toMatchObject({
      code: "GRANT_NOT_FOUND",
    });
  });

  it("rejects traversal and absolute path injection", async () => {
    const { project, outside } = await makeFixture();
    await writeFile(
      path.join(outside, "secret.txt"),
      "must not be returned",
      "utf8",
    );
    const service = await serviceFor(project);
    const grant = service.issueGrant("project-123");

    for (const requestedPath of [
      "../outside/secret.txt",
      path.join(outside, "secret.txt"),
      "C:\\Users\\example\\secret.txt",
      "src/../../outside/secret.txt",
    ]) {
      const error = await captureError(() =>
        service.read(grant.grantId, requestedPath),
      );
      expect(error.code).toBe("INVALID_PATH");
      expect(JSON.stringify(error)).not.toContain("must not be returned");
      expect(error.message).not.toContain(outside);
    }
  });

  it("refuses symlink escapes without listing or searching their targets", async () => {
    const { project, outside } = await makeFixture();
    await writeFile(path.join(outside, "outside.txt"), "escape needle", "utf8");
    await symlink(
      path.join(outside, "outside.txt"),
      path.join(project, "escape.txt"),
    );
    await writeFile(path.join(project, "visible.txt"), "ordinary text", "utf8");
    const service = await serviceFor(project);
    const grant = service.issueGrant("project-123");

    await expect(
      service.read(grant.grantId, "escape.txt"),
    ).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
    const listing = await service.list(grant.grantId);
    expect(listing.entries.map((entry) => entry.name)).not.toContain(
      "escape.txt",
    );
    const search = await service.search(grant.grantId, "needle");
    expect(search.matches).toEqual([]);
  });

  it("excludes environment, credential, hidden, and internal paths", async () => {
    const { project } = await makeFixture();
    await writeFile(
      path.join(project, ".env"),
      "SECRET_VALUE=should-not-leak",
      "utf8",
    );
    await writeFile(
      path.join(project, ".env.example"),
      "EXAMPLE_TOKEN=hidden",
      "utf8",
    );
    await mkdir(path.join(project, "credentials"));
    await writeFile(
      path.join(project, "credentials", "provider.json"),
      "PROVIDER_SECRET=should-not-leak",
      "utf8",
    );
    await mkdir(path.join(project, ".git"));
    await writeFile(
      path.join(project, ".git", "config"),
      "internal data",
      "utf8",
    );
    await mkdir(path.join(project, "backups"));
    await writeFile(
      path.join(project, "backups", "old.txt"),
      "internal data",
      "utf8",
    );
    await writeFile(path.join(project, "notes.txt"), "visible marker", "utf8");
    const service = await serviceFor(project);
    const grant = service.issueGrant("project-123");

    const listing = await service.list(grant.grantId);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.txt"]);
    for (const secretPath of [
      ".env",
      ".env.example",
      "credentials/provider.json",
      ".git/config",
      "backups/old.txt",
    ]) {
      const error = await captureError(() =>
        service.read(grant.grantId, secretPath),
      );
      expect(error.code).toBe("SECRET_PATH_DENIED");
      expect(error.message).not.toContain("SECRET_VALUE");
      expect(JSON.stringify(error)).not.toContain("PROVIDER_SECRET");
    }
    const search = await service.search(grant.grantId, "should-not-leak");
    expect(search.matches).toEqual([]);
  });

  it("excludes extensionless OpenSSH host private keys from read, list, and search", async () => {
    const { project } = await makeFixture();
    const hostKeyNames = [
      "ssh_host_rsa_key",
      "ssh_host_dsa_key",
      "SSH_HOST_ECDSA_KEY",
      "ssh_host_ed25519_key",
    ];
    for (const name of hostKeyNames) {
      await writeFile(
        path.join(project, name),
        "synthetic-host-private-key-canary",
        "utf8",
      );
    }
    await mkdir(path.join(project, "src"));
    await writeFile(
      path.join(project, "src", "ordinary.ts"),
      "export const marker = 'ordinary-source-canary';",
      "utf8",
    );
    const service = await serviceFor(project);
    const grant = service.issueGrant("project-123");

    const listing = await service.list(grant.grantId);
    const listedNames = listing.entries.map((entry) => entry.name);
    for (const name of hostKeyNames) {
      expect(listedNames).not.toContain(name);
      await expect(service.read(grant.grantId, name)).rejects.toMatchObject({
        code: "SECRET_PATH_DENIED",
      });
    }
    expect(listedNames).toContain("src");

    const privateKeySearch = await service.search(
      grant.grantId,
      "synthetic-host-private-key-canary",
    );
    expect(privateKeySearch.matches).toEqual([]);

    await expect(
      service.read(grant.grantId, "src/ordinary.ts"),
    ).resolves.toMatchObject({
      content: "export const marker = 'ordinary-source-canary';",
    });
    const sourceSearch = await service.search(
      grant.grantId,
      "ordinary-source-canary",
    );
    expect(sourceSearch.matches).toEqual([
      {
        path: "src/ordinary.ts",
        line: 1,
        snippet: "export const marker = 'ordinary-source-canary';",
      },
    ]);
  });

  it("rejects oversized, binary, and hard-linked files", async () => {
    const { project, outside } = await makeFixture();
    await writeFile(path.join(project, "large.txt"), "12345", "utf8");
    await writeFile(
      path.join(project, "binary.dat"),
      Buffer.from([0x61, 0x00, 0x62]),
    );
    await writeFile(
      path.join(outside, "linked.txt"),
      "linked private data",
      "utf8",
    );
    await link(
      path.join(outside, "linked.txt"),
      path.join(project, "linked.txt"),
    );
    const service = await serviceFor(project, { limits: { maxFileBytes: 4 } });
    const grant = service.issueGrant("project-123");

    await expect(
      service.read(grant.grantId, "large.txt"),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(
      service.read(grant.grantId, "binary.dat"),
    ).rejects.toMatchObject({
      code: "BINARY_FILE",
    });
    await expect(
      service.read(grant.grantId, "linked.txt"),
    ).rejects.toMatchObject({
      code: "HARDLINK_NOT_ALLOWED",
    });
  });

  it("bounds grants, directory listings, search results, file count, and search time", async () => {
    const { project } = await makeFixture();
    await writeFile(path.join(project, "a.txt"), "match\nmatch", "utf8");
    await writeFile(path.join(project, "b.txt"), "match", "utf8");
    await writeFile(path.join(project, "c.txt"), "match", "utf8");
    const service = await serviceFor(project, {
      limits: {
        maxActiveGrants: 1,
        maxListEntries: 2,
        maxSearchFiles: 1,
        maxSearchResults: 10,
      },
    });
    const grant = service.issueGrant("project-123");
    await expect(
      Promise.resolve().then(() => service.issueGrant("project-123")),
    ).rejects.toMatchObject({ code: "GRANT_LIMIT_REACHED" });

    const listing = await service.list(grant.grantId);
    expect(listing.entries).toHaveLength(2);
    expect(listing.truncated).toBe(true);

    const search = await service.search(grant.grantId, "match");
    expect(search.filesScanned).toBe(1);
    expect(search.truncated).toBe(true);
    expect(search.limitReason).toBe("file_count");

    const resultLimitedService = await serviceFor(project, {
      limits: { maxSearchResults: 1 },
    });
    const resultLimitedGrant = resultLimitedService.issueGrant("project-123");
    const resultLimited = await resultLimitedService.search(
      resultLimitedGrant.grantId,
      "match",
    );
    expect(resultLimited.matches).toHaveLength(1);
    expect(resultLimited.truncated).toBe(true);
    expect(resultLimited.limitReason).toBe("result_count");

    const timedService = await serviceFor(project, {
      limits: { maxSearchDurationMs: 1 },
      monotonicNow: (() => {
        let time = 0;
        return () => {
          const current = time;
          time += 2;
          return current;
        };
      })(),
    });
    const timedGrant = timedService.issueGrant("project-123");
    const timedSearch = await timedService.search(timedGrant.grantId, "match");
    expect(timedSearch.matches).toEqual([]);
    expect(timedSearch.truncated).toBe(true);
    expect(timedSearch.limitReason).toBe("time");

    const byteLimitedService = await serviceFor(project, {
      limits: { maxSearchBytes: 2 },
    });
    const byteLimitedGrant = byteLimitedService.issueGrant("project-123");
    const byteLimitedSearch = await byteLimitedService.search(
      byteLimitedGrant.grantId,
      "match",
    );
    expect(byteLimitedSearch.truncated).toBe(true);
    expect(byteLimitedSearch.limitReason).toBe("byte_count");
    expect(byteLimitedSearch.bytesScanned).toBe(0);
  });

  it("hashes the exact UTF-8 snapshot bytes including BOM and newline bytes", async () => {
    const { project } = await makeFixture();
    const rawBytes = Buffer.from("\uFEFFcafé\r\nsecond\rthird\n", "utf8");
    await writeFile(path.join(project, "snapshot.txt"), rawBytes);
    const service = await serviceFor(project);
    const grant = service.issueGrant("project-123");

    const snapshot = await service.read(grant.grantId, "snapshot.txt");

    expect(snapshot).toMatchObject({
      bytes: rawBytes.length,
      content: "café\r\nsecond\rthird\n",
      contentHash: createHash("sha256").update(rawBytes).digest("hex"),
      rawBytes: new Uint8Array(rawBytes),
    });
    expect(snapshot.rawBytes).toEqual(new Uint8Array(rawBytes));
    expect(snapshot.contentHash).not.toBe(
      createHash("sha256").update(snapshot.content, "utf8").digest("hex"),
    );
  });

  it("returns bounded list, read, and literal search results for ordinary text", async () => {
    const { project } = await makeFixture();
    await mkdir(path.join(project, "src"));
    await writeFile(
      path.join(project, "README.md"),
      "PromptLab workspace",
      "utf8",
    );
    await writeFile(
      path.join(project, "src", "task.ts"),
      "const result = 'needle';\nexport { result };",
      "utf8",
    );
    const service = await serviceFor(project);
    const grant = service.issueGrant("project-123");

    const listing = await service.list(grant.grantId);
    expect(listing.entries).toEqual([
      { name: "README.md", path: "README.md", kind: "file" },
      { name: "src", path: "src", kind: "directory" },
    ]);
    const read = await service.read(grant.grantId, "src/task.ts");
    expect(read).toMatchObject({
      path: "src/task.ts",
      encoding: "utf-8",
      content: "const result = 'needle';\nexport { result };",
    });
    const search = await service.search(grant.grantId, "NEEDLE");
    expect(search.matches).toEqual([
      { path: "src/task.ts", line: 1, snippet: "const result = 'needle';" },
    ]);
    expect(search.truncated).toBe(false);
  });
});
