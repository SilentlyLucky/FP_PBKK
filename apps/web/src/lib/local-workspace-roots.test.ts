import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalWorkspaceRootRegistry } from "./local-workspace-roots.ts";

const PROJECT_ID = "f3b16568-80c7-45f7-9f14-1bfda4fc23c8";
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "promptlab-roots-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalWorkspaceRootRegistry", () => {
  it("persists multiple explicit roots per project without exposing paths in summaries", async () => {
    const home = await temporaryDirectory();
    const first = path.join(home, "first-project");
    const second = path.join(home, "course-notes");
    await mkdir(first);
    await mkdir(second);
    const registry = new LocalWorkspaceRootRegistry(
      path.join(home, ".promptlab"),
      home,
    );

    const registeredFirst = await registry.register(PROJECT_ID, first);
    const repeatedFirst = await registry.register(PROJECT_ID, first);
    const registeredSecond = await registry.register(PROJECT_ID, second);
    const roots = await registry.list(PROJECT_ID);
    const summaries = registry.summaries(roots);

    expect(repeatedFirst.rootId).toBe(registeredFirst.rootId);
    expect(roots).toHaveLength(2);
    expect(roots.every((root) => root.available)).toBe(true);
    expect(summaries.map((root) => root.displayName)).toEqual([
      "first-project",
      "course-notes",
    ]);
    expect(registeredSecond.displayName).toBe("course-notes");
    expect(JSON.stringify(summaries)).not.toContain(first);
    expect(JSON.stringify(summaries)).not.toContain(second);
  });

  it("rejects roots outside the owner home and symlink-selected roots", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const project = path.join(home, "project");
    const alias = path.join(home, "project-link");
    await mkdir(project);
    await symlink(project, alias, "dir");
    const registry = new LocalWorkspaceRootRegistry(
      path.join(home, ".promptlab"),
      home,
    );

    await expect(registry.register(PROJECT_ID, outside)).rejects.toThrow(
      "ROOT_REGISTRATION_INVALID",
    );
    await expect(registry.register(PROJECT_ID, alias)).rejects.toThrow(
      "ROOT_REGISTRATION_INVALID",
    );
    await expect(registry.register(PROJECT_ID, home)).rejects.toThrow(
      "ROOT_REGISTRATION_INVALID",
    );
  });

  it("revokes a durable registration and rejects a symlinked registry directory", async () => {
    const home = await temporaryDirectory();
    const project = path.join(home, "project");
    const registryDirectory = path.join(home, ".promptlab");
    await mkdir(project);
    const registry = new LocalWorkspaceRootRegistry(registryDirectory, home);
    const registered = await registry.register(PROJECT_ID, project);

    await expect(registry.revoke(PROJECT_ID, registered.rootId)).resolves.toBe(
      true,
    );
    await expect(registry.list(PROJECT_ID)).resolves.toEqual([]);

    const outsideRegistry = path.join(home, "external-config");
    await mkdir(outsideRegistry);
    await rm(registryDirectory, { recursive: true, force: true });
    await symlink(outsideRegistry, registryDirectory, "dir");
    await expect(registry.list(PROJECT_ID)).rejects.toThrow(
      "ROOT_REGISTRY_INVALID",
    );
  });
});
