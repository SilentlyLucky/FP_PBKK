import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkspaceEvaluationSnapshots,
  WorkspaceSnapshotError,
} from "./workspace-evaluation-snapshots.js";

let workspaceRoot: string | undefined;

afterEach(async () => {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("isolated workspace evaluation snapshots", () => {
  it("keeps candidate changes independent from baseline and the original workspace", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "promptlab-eval-source-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(
      join(workspaceRoot, "src", "answer.ts"),
      "export const answer = 41;\n",
    );
    await writeFile(
      join(workspaceRoot, ".env"),
      "API_KEY=must-not-be-copied\n",
    );
    const originalInode = (await lstat(join(workspaceRoot, "src", "answer.ts")))
      .ino;

    const snapshots = await createWorkspaceEvaluationSnapshots({
      workspaceRoot,
      patchPath: "src/answer.ts",
      expectedBeforeHash: sha256("export const answer = 41;\n"),
      candidateContent: "export const answer = 42;\n",
    });
    try {
      const baselineFile = join(
        snapshots.baselineDirectory,
        "src",
        "answer.ts",
      );
      const candidateFile = join(
        snapshots.candidateDirectory,
        "src",
        "answer.ts",
      );
      expect(snapshots.baselineDirectory).not.toBe(
        snapshots.candidateDirectory,
      );
      expect(snapshots.startingSnapshotHash).toBe(
        snapshots.baselineSnapshotHash,
      );
      expect(snapshots.candidateSnapshotHash).not.toBe(
        snapshots.baselineSnapshotHash,
      );
      expect(snapshots.entriesExcludedByPolicy).toBe(1);
      expect(
        await readFile(join(snapshots.baselineDirectory, ".env")).catch(
          () => null,
        ),
      ).toBeNull();
      expect(await readFile(baselineFile, "utf8")).toBe(
        "export const answer = 41;\n",
      );
      expect(await readFile(candidateFile, "utf8")).toBe(
        "export const answer = 42;\n",
      );
      const baselineInode = (await lstat(baselineFile)).ino;
      const candidateInode = (await lstat(candidateFile)).ino;
      expect(baselineInode).not.toBe(originalInode);
      expect(candidateInode).not.toBe(originalInode);
      expect(candidateInode).not.toBe(baselineInode);

      await writeFile(candidateFile, "test runner mutation\n");
      expect(await readFile(baselineFile, "utf8")).toBe(
        "export const answer = 41;\n",
      );
      expect(
        await readFile(join(workspaceRoot, "src", "answer.ts"), "utf8"),
      ).toBe("export const answer = 41;\n");
    } finally {
      await snapshots.cleanup();
    }
  });

  it("refuses stale source text and unsafe patch paths", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "promptlab-eval-source-"));
    await writeFile(join(workspaceRoot, "answer.txt"), "current\n");

    await expect(
      createWorkspaceEvaluationSnapshots({
        workspaceRoot,
        patchPath: "answer.txt",
        expectedBeforeHash: sha256("stale\n"),
        candidateContent: "candidate\n",
      }),
    ).rejects.toMatchObject<Partial<WorkspaceSnapshotError>>({
      code: "SOURCE_CHANGED",
    });

    await expect(
      createWorkspaceEvaluationSnapshots({
        workspaceRoot,
        patchPath: "../outside.txt",
        expectedBeforeHash: sha256("current\n"),
        candidateContent: "candidate\n",
      }),
    ).rejects.toMatchObject<Partial<WorkspaceSnapshotError>>({
      code: "INVALID_INPUT",
    });
  });

  it("refuses a patch path that traverses an internal symlink", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "promptlab-eval-source-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "answer.txt"), "current\n");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink("src", join(workspaceRoot!, "source-link")),
    );

    await expect(
      createWorkspaceEvaluationSnapshots({
        workspaceRoot,
        patchPath: "source-link/answer.txt",
        expectedBeforeHash: sha256("current\n"),
        candidateContent: "candidate\n",
      }),
    ).rejects.toMatchObject<Partial<WorkspaceSnapshotError>>({
      code: "INVALID_INPUT",
    });
  });
});
