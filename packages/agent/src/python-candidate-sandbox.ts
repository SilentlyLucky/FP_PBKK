import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface PythonCandidateFixture {
  id: string;
  n: number;
  blocked: readonly { row: number; column: number }[];
  expectedOutput: string;
  expectedMatchesReference: boolean;
}

export interface PythonCandidateFixtureExecution {
  id: string;
  actualOutput: string | null;
  reasonCode:
    | "candidate_execution_error"
    | "candidate_execution_timeout"
    | "invalid_fixture"
    | null;
}

export interface PythonCandidateExecution {
  status: "passed" | "failed" | "unavailable";
  reasonCode:
    | "candidate_answer_missing"
    | "candidate_code_ambiguous"
    | "candidate_execution_error"
    | "candidate_execution_timeout"
    | "sandbox_output_limit"
    | "verified_isolated_python_runner_unavailable"
    | null;
  fixtures: PythonCandidateFixtureExecution[];
}

const WALL_LIMIT_MS = 8_000;
const PYTHON_CASE_LIMIT_SECONDS = 1;
const STDOUT_LIMIT_BYTES = 256_000;
const STDERR_LIMIT_BYTES = 8_000;
const MAX_PROCESS_LIMIT = 2_048;
const MAX_ADDRESS_SPACE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_OPEN_FILES = 32;

const SAFE_HOST_ENV = {
  NODE_ENV: "production" as const,
  HOME: "/nonexistent",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
};

const CHILD_RUNNER = String.raw`
import json, os, resource, sys

request = json.loads(sys.stdin.read())
protocol_fd = os.dup(1)
null_fd = os.open(os.devnull, os.O_WRONLY)
os.dup2(null_fd, 1)
os.dup2(null_fd, 2)
sys.stdout = open(os.devnull, "w")
sys.stderr = open(os.devnull, "w")
result = {"ok": False, "output": None, "reasonCode": "candidate_execution_error"}
try:
    resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
except BaseException:
    result = {"ok": False, "output": None, "reasonCode": "sandbox_setup_error"}
else:
    try:
        namespace = {"__name__": "__candidate__"}
        exec(compile(request["source"], "<candidate>", "exec"), namespace, namespace)
        function = namespace.get("count_paths")
        if not callable(function):
            raise TypeError("count_paths is not defined")
        # Fixture JSON uses coordinate objects; normalize it to the read-only
        # coordinate-set input described by the public problem contract.
        blocked = {
            (cell["row"], cell["column"])
            for cell in request["blocked"]
        }
        value = function(request["n"], blocked)
        if type(value) is not int or value < 0:
            raise TypeError("count_paths must return a nonnegative integer")
        result = {"ok": True, "output": str(value), "reasonCode": None}
    except BaseException:
        pass
os.write(protocol_fd, json.dumps(result, separators=(",", ":")).encode("utf-8"))
`;

const OUTER_RUNNER = String.raw`
import json, os, selectors, signal, subprocess, sys, time

request = json.loads(sys.stdin.read())
results = []
execution_status = "completed"
overall_reason = None
safe_env = {
    "HOME": "/nonexistent",
    "PATH": "/usr/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PYTHONNOUSERSITE": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
}

def stop_child(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

def communicate_bounded(child, input_bytes, timeout_seconds):
    output = bytearray()
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + timeout_seconds
    input_offset = 0
    if child.stdin is None or child.stdout is None:
        stop_child(child)
        return None, "error"
    os.set_blocking(child.stdin.fileno(), False)
    os.set_blocking(child.stdout.fileno(), False)
    selector.register(child.stdout, selectors.EVENT_READ, "stdout")
    if input_bytes:
        selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")
    else:
        child.stdin.close()
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stop_child(child)
                child.wait()
                return None, "timeout"
            events = selector.select(remaining)
            if not events:
                stop_child(child)
                child.wait()
                return None, "timeout"
            for key, _ in events:
                if key.data == "stdin":
                    try:
                        written = os.write(
                            child.stdin.fileno(),
                            input_bytes[input_offset : input_offset + 16_384],
                        )
                    except BrokenPipeError:
                        written = 0
                        input_offset = len(input_bytes)
                    input_offset += written
                    if input_offset >= len(input_bytes):
                        selector.unregister(child.stdin)
                        child.stdin.close()
                else:
                    read_limit = 4097 - len(output)
                    chunk = os.read(child.stdout.fileno(), max(1, read_limit))
                    if not chunk:
                        selector.unregister(child.stdout)
                        child.stdout.close()
                    else:
                        output.extend(chunk)
                        if len(output) > 4096:
                            stop_child(child)
                            child.wait()
                            return None, "output_limit"
        child.wait(timeout=max(0, deadline - time.monotonic()))
        return bytes(output), "complete"
    except subprocess.TimeoutExpired:
        stop_child(child)
        child.wait()
        return None, "timeout"
    except (OSError, ValueError):
        stop_child(child)
        child.wait()
        return None, "error"
    finally:
        selector.close()

for fixture in request["fixtures"]:
    if not fixture["expectedMatchesReference"]:
        results.append({"id": fixture["id"], "actualOutput": None, "reasonCode": "invalid_fixture"})
        continue
    child_request = json.dumps({
        "source": request["source"],
        "n": fixture["n"],
        "blocked": fixture["blocked"],
    }, separators=(",", ":"))
    child = subprocess.Popen(
        [sys.executable, "-I", "-S", "-c", request["childRunner"]],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=safe_env,
        start_new_session=True,
    )
    stdout, completion = communicate_bounded(
        child,
        child_request.encode("utf-8"),
        request["caseTimeoutSeconds"],
    )
    if completion == "timeout":
        results.append({"id": fixture["id"], "actualOutput": None, "reasonCode": "candidate_execution_timeout"})
        execution_status = "failed"
        overall_reason = "candidate_execution_timeout"
        break
    if completion != "complete" or stdout is None:
        results.append({"id": fixture["id"], "actualOutput": None, "reasonCode": "candidate_execution_error"})
        execution_status = "failed"
        overall_reason = "candidate_execution_error"
        break
    if child.returncode != 0 or len(stdout) > 4096:
        results.append({"id": fixture["id"], "actualOutput": None, "reasonCode": "candidate_execution_error"})
        execution_status = "failed"
        overall_reason = "candidate_execution_error"
        continue
    try:
        outcome = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        outcome = None
    if not isinstance(outcome, dict) or outcome.get("ok") is not True or not isinstance(outcome.get("output"), str):
        if isinstance(outcome, dict) and outcome.get("reasonCode") == "sandbox_setup_error":
            results.append({"id": fixture["id"], "actualOutput": None, "reasonCode": "candidate_execution_error"})
            execution_status = "unavailable"
            overall_reason = "verified_isolated_python_runner_unavailable"
            break
        results.append({"id": fixture["id"], "actualOutput": None, "reasonCode": "candidate_execution_error"})
        execution_status = "failed"
        overall_reason = "candidate_execution_error"
        continue
    results.append({"id": fixture["id"], "actualOutput": outcome["output"], "reasonCode": None})
print(json.dumps({"status": execution_status, "reasonCode": overall_reason, "fixtures": results}, separators=(",", ":")))
`;

interface RuntimeMount {
  source: string;
  target: string;
  directory: boolean;
}

interface PythonRuntime {
  bwrapPath: string;
  prlimitPath: string;
  pythonPath: string;
  mounts: RuntimeMount[];
  processLimit: number;
}

let cachedRuntime: Promise<PythonRuntime> | null = null;

export async function runPythonCandidateIsolated(input: {
  answer: string | null;
  fixtures: readonly PythonCandidateFixture[];
  signal?: AbortSignal;
}): Promise<PythonCandidateExecution> {
  if (input.answer === null || input.answer.trim().length === 0) {
    return {
      status: "failed",
      reasonCode: "candidate_answer_missing",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_error"
          : "invalid_fixture",
      })),
    };
  }

  const source = extractCandidateSource(input.answer);
  if (source === null) {
    return {
      status: "failed",
      reasonCode: "candidate_code_ambiguous",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_error"
          : "invalid_fixture",
      })),
    };
  }

  let runtime: PythonRuntime;
  try {
    runtime = await (cachedRuntime ??= preparePythonRuntime());
  } catch {
    cachedRuntime = null;
    return {
      status: "unavailable",
      reasonCode: "verified_isolated_python_runner_unavailable",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_error"
          : "invalid_fixture",
      })),
    };
  }

  const request = JSON.stringify({
    source,
    childRunner: CHILD_RUNNER,
    caseTimeoutSeconds: PYTHON_CASE_LIMIT_SECONDS,
    fixtures: input.fixtures,
  });
  const args = createSandboxArgs(runtime);
  const process = spawn(runtime.prlimitPath, args, {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: "/",
    env: SAFE_HOST_ENV,
  });
  const completion = await collectBoundedProcess(process, {
    input: request,
    ...(input.signal ? { signal: input.signal } : {}),
    timeoutMs: WALL_LIMIT_MS,
    stdoutLimitBytes: STDOUT_LIMIT_BYTES,
    stderrLimitBytes: STDERR_LIMIT_BYTES,
  });
  if (completion.kind === "aborted") {
    throw input.signal?.reason ?? new DOMException("Aborted", "AbortError");
  }
  if (completion.kind === "timeout") {
    return {
      status: "failed",
      reasonCode: "candidate_execution_timeout",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_timeout"
          : "invalid_fixture",
      })),
    };
  }
  if (completion.kind === "output_limit") {
    return {
      status: "failed",
      reasonCode: "sandbox_output_limit",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_error"
          : "invalid_fixture",
      })),
    };
  }
  if (completion.exitCode !== 0) {
    return {
      status: "unavailable",
      reasonCode: "verified_isolated_python_runner_unavailable",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_error"
          : "invalid_fixture",
      })),
    };
  }

  let result: unknown;
  try {
    result = JSON.parse(completion.stdout);
  } catch {
    return {
      status: "unavailable",
      reasonCode: "verified_isolated_python_runner_unavailable",
      fixtures: input.fixtures.map((fixture) => ({
        id: fixture.id,
        actualOutput: null,
        reasonCode: fixture.expectedMatchesReference
          ? "candidate_execution_error"
          : "invalid_fixture",
      })),
    };
  }
  return normalizeOuterResult(result, input.fixtures);
}

function extractCandidateSource(answer: string): string | null {
  const blocks = [...answer.matchAll(/```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/giu)];
  if (blocks.length > 1) return null;
  return (blocks[0]?.[1] ?? answer).trim() || null;
}

function normalizeOuterResult(
  raw: unknown,
  fixtures: readonly PythonCandidateFixture[],
): PythonCandidateExecution {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unavailableExecution(fixtures);
  }
  const record = raw as Record<string, unknown>;
  if (
    (record.status !== "completed" &&
      record.status !== "failed" &&
      record.status !== "unavailable") ||
    !Array.isArray(record.fixtures)
  ) {
    return unavailableExecution(fixtures);
  }
  if (record.status === "unavailable") return unavailableExecution(fixtures);
  const results = new Map<string, PythonCandidateFixtureExecution>();
  for (const item of record.fixtures) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return unavailableExecution(fixtures);
    }
    const fixture = item as Record<string, unknown>;
    if (
      typeof fixture.id !== "string" ||
      !(fixture.actualOutput === null || typeof fixture.actualOutput === "string") ||
      !(
        fixture.reasonCode === null ||
        fixture.reasonCode === "invalid_fixture" ||
        fixture.reasonCode === "candidate_execution_error" ||
        fixture.reasonCode === "candidate_execution_timeout"
      )
    ) {
      return unavailableExecution(fixtures);
    }
    results.set(fixture.id, {
      id: fixture.id,
      actualOutput: fixture.actualOutput,
      reasonCode: fixture.reasonCode,
    });
  }
  const normalized = fixtures.map((fixture) => {
    const found = results.get(fixture.id);
    const missingReasonCode: PythonCandidateFixtureExecution["reasonCode"] =
      fixture.expectedMatchesReference
        ? record.status === "failed"
          ? "candidate_execution_timeout"
          : "candidate_execution_error"
        : "invalid_fixture";
    return (
      found ?? {
        id: fixture.id,
        actualOutput: null,
        reasonCode: missingReasonCode,
      }
    );
  });
  const reasonCode =
    record.reasonCode === "candidate_execution_error" ||
    record.reasonCode === "candidate_execution_timeout"
      ? record.reasonCode
      : null;
  return {
    status: record.status === "failed" || reasonCode ? "failed" : "passed",
    reasonCode,
    fixtures: normalized,
  };
}

function unavailableExecution(
  fixtures: readonly PythonCandidateFixture[],
): PythonCandidateExecution {
  return {
    status: "unavailable",
    reasonCode: "verified_isolated_python_runner_unavailable",
    fixtures: fixtures.map((fixture) => ({
      id: fixture.id,
      actualOutput: null,
      reasonCode: fixture.expectedMatchesReference
        ? "candidate_execution_error"
        : "invalid_fixture",
    })),
  };
}

function createSandboxArgs(runtime: PythonRuntime): string[] {
  const dirs = new Set<string>();
  for (const mount of runtime.mounts) {
    let directory = mount.directory ? mount.target : dirname(mount.target);
    while (directory !== "/" && directory !== ".") {
      dirs.add(directory);
      directory = dirname(directory);
    }
  }
  const orderedDirs = [...dirs].sort(
    (left, right) => left.split("/").length - right.split("/").length,
  );
  const args = [
    `--cpu=${2}:${3}`,
    `--as=${MAX_ADDRESS_SPACE_BYTES}:${MAX_ADDRESS_SPACE_BYTES}`,
    `--nproc=${runtime.processLimit}:${runtime.processLimit}`,
    `--fsize=${MAX_FILE_BYTES}:${MAX_FILE_BYTES}`,
    `--nofile=${MAX_OPEN_FILES}:${MAX_OPEN_FILES}`,
    "--",
    runtime.bwrapPath,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
  ];
  for (const directory of orderedDirs) args.push("--dir", directory);
  args.push("--dev", "/dev");
  for (const mount of runtime.mounts) {
    args.push("--ro-bind", mount.source, mount.target);
  }
  args.push(
    "--chdir",
    "/",
    "--clearenv",
    "--setenv",
    "HOME",
    "/nonexistent",
    "--setenv",
    "PATH",
    "/usr/bin",
    "--setenv",
    "TMPDIR",
    "/nonexistent",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--setenv",
    "PYTHONNOUSERSITE",
    "1",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
    "--",
    runtime.pythonPath,
    "-I",
    "-S",
    "-c",
    OUTER_RUNNER,
  );
  return args;
}

async function preparePythonRuntime(): Promise<PythonRuntime> {
  if (process.platform !== "linux") throw new Error("Linux is required");
  const bwrapPath = resolveSystemExecutable("bwrap");
  const prlimitPath = resolveSystemExecutable("prlimit");
  const pythonPath = resolveSystemExecutable("python3");
  const lddPath = resolveSystemExecutable("ldd");
  const configText = execFileSync(
    pythonPath,
    [
      "-I",
      "-S",
      "-c",
      "import json,sysconfig; print(json.dumps({'stdlib':sysconfig.get_paths()['stdlib'],'dynload':sysconfig.get_config_var('DESTSHARED')}))",
    ],
    { cwd: "/", encoding: "utf8", env: SAFE_HOST_ENV, timeout: 2_000 },
  );
  const config = JSON.parse(configText) as {
    stdlib?: unknown;
    dynload?: unknown;
  };
  if (
    typeof config.stdlib !== "string" ||
    !isAbsolute(config.stdlib) ||
    typeof config.dynload !== "string" ||
    !isAbsolute(config.dynload)
  ) {
    throw new Error("Python runtime paths are invalid");
  }
  const pythonRealPath = realpathSync(pythonPath);
  const stdlibRealPath = realpathSync(config.stdlib);
  const dynloadRealPath = realpathSync(config.dynload);
  if (!statSync(stdlibRealPath).isDirectory()) {
    throw new Error("Python standard library is unavailable");
  }
  const mounts = new Map<string, RuntimeMount>();
  const addMount = (sourcePath: string, targetPath = sourcePath) => {
    const source = realpathSync(sourcePath);
    const directory = statSync(source).isDirectory();
    const target = resolve(targetPath);
    mounts.set(target, { source, target, directory });
  };
  addMount(pythonRealPath);
  addMount(stdlibRealPath, config.stdlib);
  const runtimeFiles = [
    pythonRealPath,
    ...readdirSync(dynloadRealPath)
      .filter((name) => name.includes(".so"))
      .map((name) => resolve(dynloadRealPath, name)),
  ];
  for (const filePath of runtimeFiles) {
    const output = runLdd(lddPath, filePath);
    for (const dependency of parseLibraryPaths(output)) {
      addMount(dependency);
    }
  }
  return {
    bwrapPath,
    prlimitPath,
    pythonPath: pythonRealPath,
    mounts: [...mounts.values()],
    processLimit: MAX_PROCESS_LIMIT,
  };
}

function resolveSystemExecutable(name: string): string {
  for (const directory of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`Missing executable: ${name}`);
}

function runLdd(lddPath: string, filePath: string): string {
  let output = "";
  try {
    output = execFileSync(lddPath, [filePath], {
      cwd: "/",
      encoding: "utf8",
      env: SAFE_HOST_ENV,
      timeout: 2_000,
      maxBuffer: 64_000,
    });
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { stdout?: string | Buffer };
    output = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : (result.stdout ?? "");
    if (!output.includes("statically linked")) throw error;
  }
  if (output.includes("not found")) {
    throw new Error("Python runtime dependency is unavailable");
  }
  return output;
}

function parseLibraryPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.includes("not found")) throw new Error("Missing runtime library");
    const resolved = line.match(/=>\s+(\/[^\s(]+)/u)?.[1];
    const direct = line.match(/^\s*(\/[^\s(]+)\s+\(/u)?.[1];
    const library = resolved ?? direct;
    if (library) paths.add(library);
  }
  return [...paths];
}

function collectBoundedProcess(
  child: ChildProcess,
  options: {
    input: string;
    signal?: AbortSignal;
    timeoutMs: number;
    stdoutLimitBytes: number;
    stderrLimitBytes: number;
  },
): Promise<
  | { kind: "complete"; exitCode: number | null; stdout: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "output_limit" }
> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderrBytes = 0;
    let outputExceeded = false;
    let settled = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (
      result:
        | { kind: "complete"; exitCode: number | null; stdout: string }
        | { kind: "timeout" | "aborted" | "output_limit" },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const onAbort = () => {
      killGroup();
      finish({ kind: "aborted" });
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({ kind: "timeout" });
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.length > options.stdoutLimitBytes) {
        outputExceeded = true;
        killGroup();
        finish({ kind: "output_limit" });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.stderrLimitBytes) {
        outputExceeded = true;
        killGroup();
        finish({ kind: "output_limit" });
      }
    });
    child.once("error", () => {
      if (!settled) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        rejectPromise(new Error("Sandbox runner could not start"));
      }
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      finish({
        kind: outputExceeded ? "output_limit" : "complete",
        exitCode,
        stdout,
      });
    });
    child.stdin?.end(options.input);
  });
}
