import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalWorkspaceDirectoryPicker } from "./local-workspace-picker.js";

const PROJECT_A = "2f16c962-4cd5-4839-a633-6a2c4c2988ab";
const PROJECT_B = "b85685af-03c4-4f4c-a423-49ef79fdf63d";
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "promptlab-picker-"));
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

describe("LocalWorkspaceDirectoryPicker", () => {
  it("lists only bounded directory metadata and returns opaque project-scoped tokens", async () => {
    const home = await temporaryDirectory();
    const project = path.join(home, "FP_PBKK");
    await mkdir(path.join(project, "docs"), { recursive: true });
    await mkdir(path.join(home, ".ssh"));
    await mkdir(path.join(home, "credentials"));
    await writeFile(path.join(home, "notes.md"), "not a directory");
    await symlink(project, path.join(home, "project-alias"), "dir");

    const picker = new LocalWorkspaceDirectoryPicker(() => home);
    const homeListing = await picker.begin(PROJECT_A);
    expect(homeListing.currentToken).toBeNull();
    expect(homeListing.directories.map((entry) => entry.name)).toEqual([
      "FP_PBKK",
    ]);
    expect(JSON.stringify(homeListing)).not.toContain(home);
    expect(JSON.stringify(homeListing)).not.toContain("notes.md");

    const projectToken = homeListing.directories[0]?.token;
    expect(projectToken).toBeTruthy();
    const projectListing = await picker.browse(PROJECT_A, projectToken!);
    expect(projectListing.currentName).toBe("FP_PBKK");
    expect(projectListing.breadcrumbs).toEqual(["FP_PBKK"]);
    expect(projectListing.currentToken).toBe(projectToken);
    expect(projectListing.directories.map((entry) => entry.name)).toEqual([
      "docs",
    ]);

    await expect(
      picker.resolveSelection(PROJECT_A, projectToken!),
    ).resolves.toMatchObject({
      rootPath: project,
      displayName: "FP_PBKK",
    });
  });

  it("rejects tokens from another project and arbitrary path strings", async () => {
    const home = await temporaryDirectory();
    await mkdir(path.join(home, "project"));
    const picker = new LocalWorkspaceDirectoryPicker(() => home);
    const listing = await picker.begin(PROJECT_A);
    const token = listing.directories[0]!.token;

    await expect(picker.browse(PROJECT_B, token)).rejects.toMatchObject({
      code: "GRANT_NOT_FOUND",
    });
    await expect(
      picker.browse(PROJECT_A, path.join(home, "project")),
    ).rejects.toMatchObject({
      code: "GRANT_NOT_FOUND",
    });
  });

  it("does not expose or select a symlink that leaves the owner home", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(path.join(outside, "private-project"));
    await symlink(outside, path.join(home, "outside-link"), "dir");
    const picker = new LocalWorkspaceDirectoryPicker(() => home);
    const listing = await picker.begin(PROJECT_A);

    expect(listing.directories).toEqual([]);
    expect(JSON.stringify(listing)).not.toContain(outside);
  });

  it("expires chooser tokens", async () => {
    const home = await temporaryDirectory();
    await mkdir(path.join(home, "project"));
    let now = 1_000;
    const picker = new LocalWorkspaceDirectoryPicker(
      () => home,
      () => now,
    );
    const listing = await picker.begin(PROJECT_A);
    now += 10 * 60 * 1_000;

    await expect(
      picker.browse(PROJECT_A, listing.directories[0]!.token),
    ).rejects.toMatchObject({ code: "GRANT_NOT_FOUND" });
  });
});
