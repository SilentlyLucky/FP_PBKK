import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runIsolatedWorkspaceEvaluation,
  validateWorkspaceEvaluationCommand,
  type WorkspaceEvaluationCommand,
} from "./workspace-evaluation-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(contents = "baseline\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "promptlab-evaluation-fixture-"));
  roots.push(root);
  await writeFile(join(root, "sample.txt"), contents, "utf8");
  return root;
}

function command(
  args: readonly string[],
  timeoutMs?: number,
): WorkspaceEvaluationCommand {
  return {
    id: "fixture",
    label: "Isolated fixture check",
    executable: process.execPath,
    args,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

describe("isolated workspace evaluation runner", () => {
  it("runs independent baseline and candidate snapshots without host data or network", async () => {
    const root = await fixtureRoot();
    const before = "baseline\n";
    const candidate = "candidate\n";
    const originalSentinel = process.env.PROMPTLAB_RUNNER_TEST_SECRET;
    process.env.PROMPTLAB_RUNNER_TEST_SECRET = "must-not-enter-sandbox";
    const script = [
      "const fs = require('fs');",
      "const os = require('os');",
      "const net = require('net');",
      `const sourceRoot = ${JSON.stringify(root)};`,
      "const value = fs.readFileSync('sample.txt', 'utf8');",
      "const processLimit = fs.readFileSync('/proc/self/limits', 'utf8').match(/^Max processes\\s+(\\d+)\\s+(\\d+)/m);",
      "const result = { value, processLimit: processLimit ? [Number(processLimit[1]), Number(processLimit[2])] : null, sourceRootVisible: fs.existsSync(sourceRoot), homeVisible: fs.existsSync('/home/lenovo'), secretVisible: process.env.PROMPTLAB_RUNNER_TEST_SECRET !== undefined, networkInterfaces: Object.keys(os.networkInterfaces()).filter((name) => name !== 'lo') };",
      "fs.writeFileSync('sample.txt', 'mutated only inside this arm');",
      "const socket = net.createConnection({ host: '1.1.1.1', port: 53, timeout: 500 });",
      "socket.once('connect', () => { socket.destroy(); process.exit(22); });",
      "socket.once('error', () => { process.stdout.write(JSON.stringify(result)); process.exit(0); });",
      "socket.once('timeout', () => { socket.destroy(); process.stdout.write(JSON.stringify(result)); process.exit(0); });",
    ].join("\n");
    try {
      const report = await runIsolatedWorkspaceEvaluation({
        workspaceRoot: root,
        patchPath: "sample.txt",
        expectedBeforeHash: createHash("sha256").update(before).digest("hex"),
        candidateContent: candidate,
        command: command(["-e", script]),
      });

      expect(report).toMatchObject({
        status: "completed",
        assessment: "pass",
        reasonCode: null,
        filesPerSnapshot: 1,
        bytesPerSnapshot: Buffer.byteLength(before),
        baseline: { status: "completed", exitCode: 0 },
        candidate: { status: "completed", exitCode: 0 },
      });
      const baselineOutput = JSON.parse(report.baseline.stdout) as {
        value: string;
        processLimit: number[] | null;
        sourceRootVisible: boolean;
        homeVisible: boolean;
        secretVisible: boolean;
        networkInterfaces: string[];
      };
      const candidateOutput = JSON.parse(
        report.candidate.stdout,
      ) as typeof baselineOutput;
      expect(baselineOutput).toEqual({
        value: before,
        processLimit: [256, 256],
        sourceRootVisible: false,
        homeVisible: false,
        secretVisible: false,
        networkInterfaces: [],
      });
      expect(candidateOutput).toEqual({
        ...baselineOutput,
        value: candidate,
        processLimit: [256, 256],
      });
      expect(report.baselineSnapshotHash).toBe(report.startingSnapshotHash);
      expect(report.candidateSnapshotHash).not.toBe(
        report.baselineSnapshotHash,
      );
      await expect(readFile(join(root, "sample.txt"), "utf8")).resolves.toBe(
        before,
      );
    } finally {
      if (originalSentinel === undefined) {
        delete process.env.PROMPTLAB_RUNNER_TEST_SECRET;
      } else {
        process.env.PROMPTLAB_RUNNER_TEST_SECRET = originalSentinel;
      }
    }
  });

  it("reports output limits and timeouts as inconclusive evidence", async () => {
    const root = await fixtureRoot();
    const beforeHash = createHash("sha256").update("baseline\n").digest("hex");
    const output = await runIsolatedWorkspaceEvaluation({
      workspaceRoot: root,
      patchPath: "sample.txt",
      expectedBeforeHash: beforeHash,
      candidateContent: "candidate\n",
      command: command(["-e", "process.stdout.write('x'.repeat(70_000))"]),
    });
    expect(output).toMatchObject({
      status: "completed",
      assessment: "inconclusive",
      baseline: { status: "output_limit", stdout: "x".repeat(64 * 1024) },
      candidate: { status: "output_limit" },
    });

    const timeout = await runIsolatedWorkspaceEvaluation({
      workspaceRoot: root,
      patchPath: "sample.txt",
      expectedBeforeHash: beforeHash,
      candidateContent: "candidate\n",
      command: command(["-e", "setInterval(() => {}, 1_000)"], 1_000),
    });
    expect(timeout).toMatchObject({
      status: "completed",
      assessment: "inconclusive",
      baseline: { status: "timed_out", reasonCode: "isolated_test_timeout" },
      candidate: { status: "timed_out", reasonCode: "isolated_test_timeout" },
    });
  });

  it("rejects shell executables and unbounded command configuration", async () => {
    const root = await fixtureRoot();
    const shell = await runIsolatedWorkspaceEvaluation({
      workspaceRoot: root,
      patchPath: "sample.txt",
      expectedBeforeHash: createHash("sha256")
        .update("baseline\n")
        .digest("hex"),
      candidateContent: "candidate\n",
      command: {
        id: "shell",
        label: "Shell command",
        executable: "/bin/sh",
        args: ["-c", "echo unsafe"],
      },
    });
    expect(shell).toMatchObject({
      status: "unavailable",
      reasonCode: "verified_isolated_project_test_runner_unavailable",
      baseline: { status: "unavailable" },
      candidate: { status: "unavailable" },
    });
    expect(() =>
      validateWorkspaceEvaluationCommand({
        id: "too-many-args",
        label: "Invalid command",
        executable: "/usr/bin/node",
        args: Array.from({ length: 65 }, () => "x"),
      }),
    ).toThrow("invalid_workspace_evaluation_command");
  });
});
