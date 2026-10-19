import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkspaceEvaluationSnapshots,
  WorkspaceSnapshotError,
} from "./workspace-evaluation-snapshots.js";

export interface WorkspaceEvaluationCommand {
  /** Stable key selected from server configuration; never supplied as argv. */
  readonly id: string;
  readonly label: string;
  /** Absolute path to a server-selected ELF runtime, never browser argv. */
  readonly executable: string;
  /** Fixed argv from server configuration. No shell is invoked. */
  readonly args: readonly string[];
  /** Optional system runtime data directories, limited to /usr and /lib. */
  readonly runtimePaths?: readonly string[];
  /** Wall time per arm, bounded to 60 seconds. */
  readonly timeoutMs?: number;
}

export type WorkspaceCommandRunStatus =
  "completed" | "timed_out" | "output_limit" | "unavailable";

export type WorkspaceEvaluationAssessment =
  | "pass"
  | "candidate_regression"
  | "candidate_improved"
  | "baseline_failing"
  | "inconclusive";

export interface WorkspaceCommandRun {
  readonly status: WorkspaceCommandRunStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly reasonCode: string | null;
}

export interface WorkspaceEvaluationReport {
  readonly status: "completed" | "unavailable";
  readonly reasonCode: string | null;
  readonly assessment: WorkspaceEvaluationAssessment;
  readonly commandId: string;
  readonly commandLabel: string;
  readonly startingSnapshotHash: string | null;
  readonly baselineSnapshotHash: string | null;
  readonly candidateSnapshotHash: string | null;
  readonly filesPerSnapshot: number | null;
  readonly bytesPerSnapshot: number | null;
  readonly entriesExcludedByPolicy: number | null;
  readonly baseline: WorkspaceCommandRun;
  readonly candidate: WorkspaceCommandRun;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const CPU_LIMIT_SECONDS = 45;
const ADDRESS_SPACE_LIMIT_BYTES = 1_073_741_824;
const PROCESS_LIMIT = 256;
const FILE_SIZE_LIMIT_BYTES = 67_108_864;
const OPEN_FILE_LIMIT = 128;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
const MAX_ARGS = 64;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

const SAFE_HOST_ENV = {
  HOME: "/nonexistent",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "test" as const,
  TZ: "UTC",
};
const FORBIDDEN_EXECUTABLE_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "sh",
  "zsh",
]);

interface RuntimeMount {
  readonly source: string;
  readonly target: string;
  readonly directory: boolean;
}

interface WorkspaceRunnerRuntime {
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly executablePath: string;
  readonly timeoutMs: number;
  readonly mounts: readonly RuntimeMount[];
}

type ProcessCompletion =
  | {
      readonly kind: "complete";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "timeout";
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "output_limit";
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "unavailable";
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    };
type ProcessCompletionInput =
  | {
      readonly kind: "complete";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "timeout" | "output_limit" | "unavailable";
      readonly stdout: string;
      readonly stderr: string;
    };

/**
 * Run the same server-allowlisted command against independent baseline and
 * candidate copies. This fails closed unless bubblewrap, prlimit, and the
 * command's runtime can be mounted without exposing the source project or home.
 */
export async function runIsolatedWorkspaceEvaluation(input: {
  readonly workspaceRoot: string;
  readonly patchPath: string;
  readonly expectedBeforeHash: string;
  readonly candidateContent: string;
  readonly command: WorkspaceEvaluationCommand;
}): Promise<WorkspaceEvaluationReport> {
  const command = validateWorkspaceEvaluationCommand(input.command);
  let snapshots: Awaited<
    ReturnType<typeof createWorkspaceEvaluationSnapshots>
  > | null = null;
  let runtime: WorkspaceRunnerRuntime;
  try {
    runtime = prepareRunnerRuntime(command);
    await verifyBubblewrapProfile(runtime);
    snapshots = await createWorkspaceEvaluationSnapshots({
      workspaceRoot: input.workspaceRoot,
      patchPath: input.patchPath,
      expectedBeforeHash: input.expectedBeforeHash,
      candidateContent: input.candidateContent,
    });
  } catch (error) {
    const reasonCode =
      error instanceof WorkspaceSnapshotError
        ? `workspace_snapshot_${error.code.toLowerCase()}`
        : "verified_isolated_project_test_runner_unavailable";
    return unavailableReport(command, reasonCode);
  }

  try {
    const baseline = await runOneArm(
      runtime,
      snapshots.baselineDirectory,
      command.args,
    );
    const candidate = await runOneArm(
      runtime,
      snapshots.candidateDirectory,
      command.args,
    );
    const unavailable =
      baseline.status === "unavailable" || candidate.status === "unavailable";
    return {
      status: unavailable ? "unavailable" : "completed",
      reasonCode: unavailable
        ? "verified_isolated_project_test_runner_unavailable"
        : null,
      assessment: assessWorkspaceEvaluation(baseline, candidate),
      commandId: command.id,
      commandLabel: command.label,
      startingSnapshotHash: snapshots.startingSnapshotHash,
      baselineSnapshotHash: snapshots.baselineSnapshotHash,
      candidateSnapshotHash: snapshots.candidateSnapshotHash,
      filesPerSnapshot: snapshots.filesPerSnapshot,
      bytesPerSnapshot: snapshots.bytesPerSnapshot,
      entriesExcludedByPolicy: snapshots.entriesExcludedByPolicy,
      baseline,
      candidate,
    };
  } finally {
    await snapshots.cleanup();
  }
}

/** Check the host sandbox profile without running project code. */
export async function probeWorkspaceEvaluationCommand(
  commandInput: WorkspaceEvaluationCommand,
): Promise<{
  readonly available: boolean;
  readonly reasonCode: string | null;
}> {
  try {
    const command = validateWorkspaceEvaluationCommand(commandInput);
    const runtime = prepareRunnerRuntime(command);
    await verifyBubblewrapProfile(runtime);
    return { available: true, reasonCode: null };
  } catch {
    return {
      available: false,
      reasonCode: "verified_isolated_project_test_runner_unavailable",
    };
  }
}

function assessWorkspaceEvaluation(
  baseline: WorkspaceCommandRun,
  candidate: WorkspaceCommandRun,
): WorkspaceEvaluationAssessment {
  if (
    baseline.status !== "completed" ||
    candidate.status !== "completed" ||
    baseline.exitCode === null ||
    candidate.exitCode === null
  ) {
    return "inconclusive";
  }
  if (baseline.exitCode === 0 && candidate.exitCode === 0) return "pass";
  if (baseline.exitCode === 0 && candidate.exitCode !== 0) {
    return "candidate_regression";
  }
  if (baseline.exitCode !== 0 && candidate.exitCode === 0) {
    return "candidate_improved";
  }
  return "baseline_failing";
}

export function validateWorkspaceEvaluationCommand(
  command: WorkspaceEvaluationCommand,
): WorkspaceEvaluationCommand {
  if (
    !command ||
    typeof command !== "object" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(command.id) ||
    typeof command.label !== "string" ||
    command.label.trim() !== command.label ||
    command.label.length < 1 ||
    command.label.length > 120 ||
    typeof command.executable !== "string" ||
    !isAbsolute(command.executable) ||
    !Array.isArray(command.args) ||
    command.args.length > MAX_ARGS ||
    command.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.includes("\0") ||
        Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES,
    ) ||
    command.args.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    ) > MAX_TOTAL_ARGUMENT_BYTES ||
    (command.timeoutMs !== undefined &&
      (!Number.isSafeInteger(command.timeoutMs) ||
        command.timeoutMs < 1_000 ||
        command.timeoutMs > MAX_TIMEOUT_MS)) ||
    (command.runtimePaths !== undefined &&
      (!Array.isArray(command.runtimePaths) ||
        command.runtimePaths.length > 16 ||
        command.runtimePaths.some(
          (runtimePath) =>
            typeof runtimePath !== "string" ||
            !isAbsolute(runtimePath) ||
            runtimePath.includes("\0"),
        )))
  ) {
    throw new Error("invalid_workspace_evaluation_command");
  }
  return {
    id: command.id,
    label: command.label,
    executable: command.executable,
    args: [...command.args],
    ...(command.runtimePaths
      ? { runtimePaths: [...command.runtimePaths] }
      : {}),
    ...(command.timeoutMs === undefined
      ? {}
      : { timeoutMs: command.timeoutMs }),
  };
}

function prepareRunnerRuntime(
  command: WorkspaceEvaluationCommand,
): WorkspaceRunnerRuntime {
  if (process.platform !== "linux") throw new Error("linux_required");
  const bwrapPath = resolveSystemExecutable("bwrap");
  const prlimitPath = resolveSystemExecutable("prlimit");
  const lddPath = resolveSystemExecutable("ldd");
  const executablePath = realpathSync(command.executable);
  const executableFd = openSync(executablePath, "r");
  const executableHeader = Buffer.alloc(ELF_MAGIC.length);
  try {
    readSync(executableFd, executableHeader, 0, executableHeader.length, 0);
  } finally {
    // The binary is server-selected and mounted read-only in the runner.
    closeSync(executableFd);
  }
  if (
    !isAllowedCommandExecutable(executablePath) ||
    !statSync(executablePath).isFile() ||
    FORBIDDEN_EXECUTABLE_NAMES.has(executablePath.split("/").at(-1) ?? "") ||
    !executableHeader.equals(ELF_MAGIC)
  ) {
    throw new Error("workspace_command_executable_unsupported");
  }

  const mounts = new Map<string, RuntimeMount>();
  const addFileMount = (
    sourcePath: string,
    targetPath = sourcePath,
    allowTrustedCommand = false,
  ) => {
    const source = realpathSync(sourcePath);
    if (
      (!isWithinSystemRuntime(source) && !allowTrustedCommand) ||
      !statSync(source).isFile()
    ) {
      throw new Error("workspace_runtime_dependency_unsupported");
    }
    mounts.set(resolve(targetPath), {
      source,
      target: resolve(targetPath),
      directory: false,
    });
  };

  addFileMount(executablePath, "/runtime/runner", true);
  addFileMount(prlimitPath, "/runtime/prlimit", true);
  for (const dependency of executableDependencies(lddPath, executablePath)) {
    addFileMount(dependency.source, dependency.target);
  }
  for (const dependency of executableDependencies(lddPath, prlimitPath)) {
    addFileMount(dependency.source, dependency.target);
  }
  for (const runtimePath of command.runtimePaths ?? []) {
    const source = realpathSync(runtimePath);
    if (!isWithinSystemRuntimeData(source)) {
      throw new Error("workspace_runtime_path_unsupported");
    }
    const stats = statSync(source);
    mounts.set(source, {
      source,
      target: source,
      directory: stats.isDirectory(),
    });
  }

  const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    bwrapPath,
    prlimitPath,
    executablePath,
    timeoutMs,
    mounts: [...mounts.values()],
  };
}

function executableDependencies(
  lddPath: string,
  executablePath: string,
): readonly { source: string; target: string }[] {
  const output = execFileSync(lddPath, [executablePath], {
    cwd: "/",
    encoding: "utf8",
    env: SAFE_HOST_ENV,
    timeout: 2_000,
    maxBuffer: 128_000,
  });
  if (output.includes("not found")) {
    throw new Error("workspace_runtime_dependency_missing");
  }
  const dependencies = new Map<string, { source: string; target: string }>();
  for (const line of output.split("\n")) {
    const mapped = line.match(/=>\s+(\/[^\s(]+)\s+\(/u)?.[1];
    const direct = line.match(/^\s*(\/[^\s(]+)\s+\(/u)?.[1];
    const target = mapped ?? direct;
    if (!target) continue;
    const source = realpathSync(target);
    if (!isWithinSystemRuntime(source)) {
      throw new Error("workspace_runtime_dependency_unsupported");
    }
    dependencies.set(target, { source, target });
  }
  return [...dependencies.values()];
}

async function verifyBubblewrapProfile(
  runtime: WorkspaceRunnerRuntime,
): Promise<void> {
  const truePath = realpathSync(resolveSystemExecutable("true"));
  const lddPath = resolveSystemExecutable("ldd");
  const probeMounts = new Map<string, RuntimeMount>();
  for (const mount of runtime.mounts) probeMounts.set(mount.target, mount);
  for (const dependency of executableDependencies(lddPath, truePath)) {
    probeMounts.set(dependency.target, {
      source: dependency.source,
      target: dependency.target,
      directory: false,
    });
  }
  probeMounts.set("/runtime/probe", {
    source: truePath,
    target: "/runtime/probe",
    directory: false,
  });
  const emptyWorkspace = await mkdtemp(
    join(tmpdir(), "promptlab-workspace-runner-probe-"),
  );
  try {
    const args = createBubblewrapArgs(
      runtime,
      [...probeMounts.values()],
      emptyWorkspace,
      ["/runtime/probe"],
    );
    const result = await runBoundedProcess(runtime, args, {
      timeoutMs: 2_000,
      stdoutLimitBytes: 2_048,
      stderrLimitBytes: 2_048,
    });
    if (result.kind !== "complete" || result.exitCode !== 0) {
      throw new Error("verified_isolated_project_test_runner_unavailable");
    }
  } finally {
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
}

async function runOneArm(
  runtime: WorkspaceRunnerRuntime,
  snapshotDirectory: string,
  commandArgs: readonly string[],
): Promise<WorkspaceCommandRun> {
  const startedAt = performance.now();
  try {
    const args = createBubblewrapArgs(
      runtime,
      runtime.mounts,
      snapshotDirectory,
      ["/runtime/runner", ...commandArgs],
    );
    const completion = await runBoundedProcess(runtime, args, {
      timeoutMs: runtime.timeoutMs,
      stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
      stderrLimitBytes: STDERR_LIMIT_BYTES,
    });
    if (completion.kind === "timeout") {
      return {
        status: "timed_out",
        exitCode: null,
        signal: null,
        stdout: completion.stdout,
        stderr: completion.stderr,
        durationMs: completion.durationMs,
        reasonCode: "isolated_test_timeout",
      };
    }
    if (completion.kind === "output_limit") {
      return {
        status: "output_limit",
        exitCode: null,
        signal: null,
        stdout: completion.stdout,
        stderr: completion.stderr,
        durationMs: completion.durationMs,
        reasonCode: "isolated_test_output_limit",
      };
    }
    if (completion.kind === "unavailable") {
      return unavailableRun(performance.now() - startedAt);
    }
    return {
      status: "completed",
      exitCode: completion.exitCode,
      signal: completion.signal,
      stdout: completion.stdout,
      stderr: completion.stderr,
      durationMs: completion.durationMs,
      reasonCode: null,
    };
  } catch {
    return unavailableRun(performance.now() - startedAt);
  }
}

function createBubblewrapArgs(
  runtime: WorkspaceRunnerRuntime,
  mounts: readonly RuntimeMount[],
  snapshotDirectory: string,
  command: readonly string[],
): string[] {
  const directories = new Set<string>(["/runtime", "/workspace"]);
  for (const mount of mounts) {
    let directory = mount.directory ? mount.target : dirname(mount.target);
    while (directory !== "/" && directory !== ".") {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  const orderedDirectories = [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length,
  );
  const args = [
    runtime.bwrapPath,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
  ];
  for (const directory of orderedDirectories) args.push("--dir", directory);
  args.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--bind",
    snapshotDirectory,
    "/workspace",
  );
  for (const mount of mounts) {
    args.push("--ro-bind", mount.source, mount.target);
  }
  args.push(
    "--chdir",
    "/workspace",
    "--clearenv",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "PATH",
    "/runtime",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--setenv",
    "NODE_ENV",
    "test",
    "--setenv",
    "TZ",
    "UTC",
    "--",
    // RLIMIT_NPROC counts tasks for the host real UID. Apply it after bwrap
    // creates the sandbox user namespace so unrelated host workers do not
    // consume the test process budget.
    "/runtime/prlimit",
    `--nproc=${PROCESS_LIMIT}:${PROCESS_LIMIT}`,
    "--",
    ...command,
  );
  return args;
}

function runBoundedProcess(
  runtime: WorkspaceRunnerRuntime,
  bubblewrapArgs: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly stdoutLimitBytes: number;
    readonly stderrLimitBytes: number;
  },
): Promise<ProcessCompletion> {
  const args = [
    `--cpu=${CPU_LIMIT_SECONDS}:${CPU_LIMIT_SECONDS + 2}`,
    `--as=${ADDRESS_SPACE_LIMIT_BYTES}:${ADDRESS_SPACE_LIMIT_BYTES}`,
    `--fsize=${FILE_SIZE_LIMIT_BYTES}:${FILE_SIZE_LIMIT_BYTES}`,
    `--nofile=${OPEN_FILE_LIMIT}:${OPEN_FILE_LIMIT}`,
    "--",
    ...bubblewrapArgs,
  ];
  const startedAt = performance.now();
  const child = spawn(runtime.prlimitPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cwd: "/",
    env: SAFE_HOST_ENV,
  });
  return collectBoundedProcess(child, {
    ...options,
    startedAt,
  });
}

function collectBoundedProcess(
  child: ChildProcess,
  options: {
    readonly timeoutMs: number;
    readonly stdoutLimitBytes: number;
    readonly stderrLimitBytes: number;
    readonly startedAt: number;
  },
): Promise<ProcessCompletion> {
  return new Promise((resolvePromise) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (result: ProcessCompletionInput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ...result,
        durationMs: Math.max(
          0,
          Math.round(performance.now() - options.startedAt),
        ),
      } as ProcessCompletion);
    };
    const onTimeout = () => {
      killGroup();
      finish({
        kind: "timeout",
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    };
    const timer = setTimeout(onTimeout, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.byteLength + chunk.byteLength > options.stdoutLimitBytes) {
        const allowed = Math.max(
          0,
          options.stdoutLimitBytes - stdout.byteLength,
        );
        stdout = Buffer.concat([stdout, chunk.subarray(0, allowed)]);
        killGroup();
        finish({
          kind: "output_limit",
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.byteLength + chunk.byteLength > options.stderrLimitBytes) {
        const allowed = Math.max(
          0,
          options.stderrLimitBytes - stderr.byteLength,
        );
        stderr = Buffer.concat([stderr, chunk.subarray(0, allowed)]);
        killGroup();
        finish({
          kind: "output_limit",
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.once("error", () => {
      finish({
        kind: "unavailable",
        stdout: "",
        stderr: "",
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        kind: "complete",
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function resolveSystemExecutable(name: string): string {
  for (const directory of ["/usr/bin", "/bin"]) {
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("workspace_system_runner_unavailable");
}

function isWithinSystemRuntime(pathname: string): boolean {
  return ["/usr", "/lib", "/lib64", "/bin"].some((root) => {
    const relativePath = relative(root, pathname);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    );
  });
}

function isAllowedCommandExecutable(pathname: string): boolean {
  if (isWithinSystemRuntime(pathname)) return true;
  if (pathname === realpathSync(process.execPath)) return true;
  return /^\/home\/[^/]+\/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin\/node$/u.test(
    pathname,
  );
}

function isWithinSystemRuntimeData(pathname: string): boolean {
  return ["/usr/lib", "/usr/share", "/lib", "/lib64"].some((root) => {
    const relativePath = relative(root, pathname);
    return (
      relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath)
    );
  });
}

function unavailableRun(durationMs = 0): WorkspaceCommandRun {
  return {
    status: "unavailable",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: Math.max(0, Math.round(durationMs)),
    reasonCode: "verified_isolated_project_test_runner_unavailable",
  };
}

function unavailableReport(
  command: WorkspaceEvaluationCommand,
  reasonCode: string,
): WorkspaceEvaluationReport {
  const run = unavailableRun();
  return {
    status: "unavailable",
    reasonCode,
    assessment: "inconclusive",
    commandId: command.id,
    commandLabel: command.label,
    startingSnapshotHash: null,
    baselineSnapshotHash: null,
    candidateSnapshotHash: null,
    filesPerSnapshot: null,
    bytesPerSnapshot: null,
    entriesExcludedByPolicy: null,
    baseline: run,
    candidate: run,
  };
}
