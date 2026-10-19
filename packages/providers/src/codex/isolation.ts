import { createHash } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";

import {
  CODEX_EGRESS_POLICY_VERSION,
  CODEX_PROXY_LOOPBACK_PORT,
  startCodexEgressBroker,
} from "./network-egress.ts";

export const CODEX_ISOLATION_POLICY_VERSION =
  "codex-bwrap-bounded-native-v2" as const;
export const CODEX_SANDBOX_HOME = "/home/promptlab" as const;
export const CODEX_SANDBOX_CODEX_HOME = "/promptlab/codex-home" as const;
export const CODEX_SANDBOX_SCRATCH = "/promptlab/scratch" as const;
export const CODEX_SANDBOX_CODEX_PACKAGE = "/promptlab/codex-package" as const;
export const CODEX_EGRESS_SOCKET_IN_SANDBOX =
  "/promptlab/egress/egress.sock" as const;
export const CODEX_PROXY_URL =
  `http://127.0.0.1:${CODEX_PROXY_LOOPBACK_PORT}` as const;

const trustBundleCandidates = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
] as const;

export class CodexIsolationError extends Error {
  constructor(
    readonly code: "codex_isolation_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CodexIsolationError";
  }
}

export interface CodexIsolationPaths {
  bwrapPath: string;
  codexPath: string;
  codexPackagePath: string;
  envPath: string;
  nodePath: string;
  authHomeHostPath: string;
  authHomeFingerprint: string;
  trustBundlePath: string;
  runtimeMounts: CodexRuntimeMount[];
}

export interface CodexRuntimeMount {
  sourcePath: string;
  targetPath: string;
}

export interface CodexIsolationRuntime extends CodexIsolationPaths {
  runtimeDirectory: string;
  scratchHostPath: string;
  egressDirectoryHostPath: string;
  egressSocketHostPath: string;
  close(): Promise<void>;
}

export interface CodexIsolationResolvers {
  resolveExecutable?: (
    name: string,
    pathValue: string | undefined,
  ) => Promise<string>;
  authHome?: () => Promise<{ path: string; fingerprint: string }>;
  spawnSyncProcess?: typeof spawnSync;
  egressLookup?: NonNullable<
    Parameters<typeof startCodexEgressBroker>[1]
  >["lookup"];
}

export async function createCodexIsolationRuntime(
  env: NodeJS.ProcessEnv = process.env,
  resolvers: CodexIsolationResolvers = {},
): Promise<CodexIsolationRuntime> {
  if (process.platform !== "linux") {
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Codex bounded-native execution requires Linux bubblewrap isolation.",
    );
  }

  const resolveExecutable = resolvers.resolveExecutable ?? findExecutable;
  let bwrapPath: string;
  let codexPath: string;
  let codexPackagePath: string;
  let envPath: string;
  let authHome: { path: string; fingerprint: string };
  let trustBundlePath: string;
  let runtimeMounts: CodexRuntimeMount[];
  try {
    [bwrapPath, codexPath, envPath] = await Promise.all([
      resolveExecutable("bwrap", env.PATH),
      resolveExecutable("codex", env.PATH),
      resolveExecutable("env", env.PATH),
    ]);
    codexPackagePath = dirname(dirname(codexPath));
    const codexPackage = JSON.parse(
      await readFile(join(codexPackagePath, "package.json"), "utf8"),
    ) as { name?: unknown };
    if (codexPackage.name !== "@openai/codex") {
      throw new Error("Codex CLI package metadata is unavailable.");
    }
    authHome = await (resolvers.authHome ?? ensurePromptLabCodexHome)();
    trustBundlePath = await findExistingPath(trustBundleCandidates);
    runtimeMounts = await currentNodeRuntimeMounts();
  } catch {
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Codex isolation prerequisites are unavailable; no provider process was started.",
    );
  }

  const runtimeDirectory = await mkdtemp(
    join(tmpdir(), "promptlab-codex-run-"),
  );
  const scratchHostPath = join(runtimeDirectory, "scratch");
  const egressDirectoryHostPath = join(runtimeDirectory, "egress");
  const egressSocketHostPath = join(egressDirectoryHostPath, "egress.sock");
  let broker: Awaited<ReturnType<typeof startCodexEgressBroker>> | undefined;
  try {
    await mkdir(scratchHostPath, { mode: 0o700 });
    await mkdir(egressDirectoryHostPath, { mode: 0o700 });
    broker = await startCodexEgressBroker(egressSocketHostPath, {
      ...(resolvers.egressLookup ? { lookup: resolvers.egressLookup } : {}),
    });
    const nodePath = await realpath(process.execPath);
    const runtime: CodexIsolationRuntime = {
      bwrapPath,
      codexPath,
      codexPackagePath,
      envPath,
      nodePath,
      authHomeHostPath: authHome.path,
      authHomeFingerprint: authHome.fingerprint,
      trustBundlePath,
      runtimeMounts,
      runtimeDirectory,
      scratchHostPath,
      egressDirectoryHostPath,
      egressSocketHostPath,
      async close() {
        await broker?.close();
        await rm(runtimeDirectory, { recursive: true, force: true });
      },
    };
    return runtime;
  } catch (error) {
    await broker?.close().catch(() => undefined);
    await rm(runtimeDirectory, { recursive: true, force: true });
    if (error instanceof CodexIsolationError) throw error;
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Codex isolation setup failed; no provider process was started.",
    );
  }
}

export function createCodexBwrapArgs(
  runtime: CodexIsolationRuntime,
  codexArgs: readonly string[],
): string[] {
  const codexPackageEntryPath = relative(
    runtime.codexPackagePath,
    runtime.codexPath,
  );
  if (
    !codexPackageEntryPath ||
    codexPackageEntryPath.startsWith("..") ||
    codexPackageEntryPath.startsWith("/")
  ) {
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Codex CLI entrypoint is outside its package directory.",
    );
  }
  const sandboxCodexPath = join(
    CODEX_SANDBOX_CODEX_PACKAGE,
    codexPackageEntryPath,
  );
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--dir",
    CODEX_SANDBOX_HOME,
    "--dir",
    "/promptlab",
    "--dir",
    "/promptlab/bin",
    "--dir",
    CODEX_SANDBOX_CODEX_PACKAGE,
    "--dir",
    CODEX_SANDBOX_CODEX_HOME,
    "--dir",
    CODEX_SANDBOX_SCRATCH,
    "--dir",
    "/promptlab/certs",
    "--ro-bind",
    runtime.nodePath,
    "/promptlab/bin/node",
    "--ro-bind",
    runtime.codexPackagePath,
    CODEX_SANDBOX_CODEX_PACKAGE,
    "--bind",
    runtime.authHomeHostPath,
    CODEX_SANDBOX_CODEX_HOME,
    "--bind",
    runtime.scratchHostPath,
    CODEX_SANDBOX_SCRATCH,
    "--dir",
    "/promptlab/egress",
    "--ro-bind",
    runtime.egressDirectoryHostPath,
    "/promptlab/egress",
    "--ro-bind",
    runtime.trustBundlePath,
    "/promptlab/certs/ca-bundle.pem",
    "--chdir",
    CODEX_SANDBOX_SCRATCH,
    "--clearenv",
    "--setenv",
    "HOME",
    CODEX_SANDBOX_HOME,
    "--setenv",
    "CODEX_HOME",
    CODEX_SANDBOX_CODEX_HOME,
    "--setenv",
    "PATH",
    "/promptlab/bin",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "SSL_CERT_FILE",
    "/promptlab/certs/ca-bundle.pem",
    "--setenv",
    "HTTP_PROXY",
    CODEX_PROXY_URL,
    "--setenv",
    "HTTPS_PROXY",
    CODEX_PROXY_URL,
    "--setenv",
    "ALL_PROXY",
    CODEX_PROXY_URL,
    "--setenv",
    "http_proxy",
    CODEX_PROXY_URL,
    "--setenv",
    "https_proxy",
    CODEX_PROXY_URL,
    "--setenv",
    "all_proxy",
    CODEX_PROXY_URL,
    "--setenv",
    "NO_PROXY",
    "",
    "--setenv",
    "no_proxy",
    "",
    "--",
    "/promptlab/bin/node",
    "-e",
    CODEX_INNER_PROXY_RELAY_SCRIPT,
    sandboxCodexPath,
    ...codexArgs,
  ];

  let insertBeforeChdir = args.indexOf("--chdir");
  const runtimeMounts = [
    { sourcePath: runtime.envPath, targetPath: "/usr/bin/env" },
    ...runtime.runtimeMounts,
  ];
  const runtimeDirectories = runtimeMountDirectories(runtimeMounts);
  for (const directory of runtimeDirectories) {
    args.splice(insertBeforeChdir, 0, "--dir", directory);
    insertBeforeChdir += 2;
  }
  for (const mount of runtimeMounts) {
    args.splice(
      insertBeforeChdir,
      0,
      "--ro-bind",
      mount.sourcePath,
      mount.targetPath,
    );
    insertBeforeChdir += 3;
  }
  return args;
}

export function preflightCodexBwrap(
  runtime: CodexIsolationRuntime,
  options: {
    spawnSyncProcess?: typeof spawnSync;
  } = {},
): string {
  const run = options.spawnSyncProcess ?? spawnSync;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = run(
      runtime.bwrapPath,
      createCodexBwrapArgs(runtime, ["--version"]),
      {
        encoding: "utf8",
        timeout: 8_000,
        windowsHide: true,
        maxBuffer: 256_000,
        env: {} as NodeJS.ProcessEnv,
      },
    );
  } catch {
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Bubblewrap capability preflight failed; no inference was attempted.",
    );
  }
  if (result.error || result.status !== 0) {
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Bubblewrap capability preflight failed; no inference was attempted.",
    );
  }
  const versionText = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
  const version = versionText.match(/codex-cli\s+(\d+\.\d+\.\d+)/i)?.[1];
  if (!version) {
    throw new CodexIsolationError(
      "codex_isolation_unavailable",
      "Codex did not start inside the bounded bubblewrap profile; no inference was attempted.",
    );
  }
  return version;
}

export function spawnCodexAppServer(
  runtime: CodexIsolationRuntime,
  args: readonly string[],
  options: {
    spawnProcess?: typeof spawn;
    stdio?: SpawnOptions["stdio"];
  } = {},
): ChildProcess {
  const spawnProcess = options.spawnProcess ?? spawn;
  return spawnProcess(runtime.bwrapPath, createCodexBwrapArgs(runtime, args), {
    stdio: options.stdio ?? ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: {} as NodeJS.ProcessEnv,
  });
}

export function codexRuntimeEnvironment(): Record<string, string> {
  return {
    HOME: CODEX_SANDBOX_HOME,
    CODEX_HOME: CODEX_SANDBOX_CODEX_HOME,
    PATH: "/promptlab/bin",
    TMPDIR: "/tmp",
    HTTP_PROXY: CODEX_PROXY_URL,
    HTTPS_PROXY: CODEX_PROXY_URL,
    ALL_PROXY: CODEX_PROXY_URL,
    http_proxy: CODEX_PROXY_URL,
    https_proxy: CODEX_PROXY_URL,
    all_proxy: CODEX_PROXY_URL,
    NO_PROXY: "",
    no_proxy: "",
  };
}

async function ensurePromptLabCodexHome(): Promise<{
  path: string;
  fingerprint: string;
}> {
  const canonicalHome = await realpath(homedir());
  const path = join(
    canonicalHome,
    ".local",
    "share",
    "promptlab",
    "codex-auth",
  );
  await mkdir(path, { recursive: true, mode: 0o700 });
  const linkInfo = await lstat(path);
  if (!linkInfo.isDirectory() || linkInfo.isSymbolicLink()) {
    throw new Error("Dedicated Codex home must be a real directory.");
  }
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) {
    throw new Error("Dedicated Codex home cannot resolve through symlinks.");
  }
  if ((linkInfo.mode & 0o077) !== 0) {
    throw new Error("Dedicated Codex home permissions must be owner-only.");
  }
  const metadata = await stat(path);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        isolationPolicy: CODEX_ISOLATION_POLICY_VERSION,
        egressPolicy: CODEX_EGRESS_POLICY_VERSION,
        path: canonicalPath,
        device: metadata.dev,
        inode: metadata.ino,
      }),
    )
    .digest("hex");
  return { path, fingerprint };
}

async function findExecutable(
  name: string,
  pathValue: string | undefined,
): Promise<string> {
  if (!pathValue) throw new Error("PATH unavailable");
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !directory.startsWith("/")) continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      if (info.isFile() && !info.isSymbolicLink()) return canonical;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} unavailable`);
}

async function findExistingPath(paths: readonly string[]): Promise<string> {
  for (const path of paths) {
    try {
      const canonical = await realpath(path);
      const info = await stat(canonical);
      if (info.isFile()) return canonical;
    } catch {
      continue;
    }
  }
  throw new Error("TLS trust bundle unavailable");
}

async function currentNodeRuntimeMounts(): Promise<CodexRuntimeMount[]> {
  const report = process.report.getReport() as {
    sharedObjects?: unknown;
  };
  if (
    !Array.isArray(report.sharedObjects) ||
    !report.sharedObjects.every((path) => typeof path === "string")
  ) {
    throw new Error("Node runtime shared objects are unavailable");
  }

  const mounts: CodexRuntimeMount[] = [];
  const targets = new Set<string>();
  for (const targetPath of report.sharedObjects as string[]) {
    if (
      !targetPath.startsWith("/") ||
      !isSystemLibraryPath(targetPath) ||
      targets.has(targetPath)
    ) {
      continue;
    }
    try {
      const sourcePath = await realpath(targetPath);
      if (
        !isSystemLibraryPath(sourcePath) ||
        !(await stat(sourcePath)).isFile()
      ) {
        continue;
      }
      mounts.push({ sourcePath, targetPath });
      targets.add(targetPath);
    } catch {
      continue;
    }
  }
  return mounts;
}

function isSystemLibraryPath(path: string): boolean {
  return ["/lib", "/lib64", "/usr/lib", "/usr/lib64"].some((root) => {
    const relativePath = path.slice(root.length);
    return (
      path === root ||
      (path.startsWith(`${root}/`) &&
        relativePath.length > 1 &&
        !relativePath.split("/").some((part) => part === ".."))
    );
  });
}

function runtimeMountDirectories(
  mounts: readonly CodexRuntimeMount[],
): string[] {
  const directories = new Set<string>();
  for (const mount of mounts) {
    let directory = mount.targetPath.slice(
      0,
      mount.targetPath.lastIndexOf("/"),
    );
    while (directory && directory !== "/") {
      directories.add(directory);
      const parent = directory.slice(0, directory.lastIndexOf("/"));
      directory = parent || "/";
    }
  }
  return [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length,
  );
}

const CODEX_INNER_PROXY_RELAY_SCRIPT = String.raw`
const net = require("node:net");
const { spawn } = require("node:child_process");
const allowed = new Set(["api.openai.com", "auth.openai.com", "chatgpt.com"]);
const brokerPath = "/promptlab/egress/egress.sock";
const proxyPort = ${CODEX_PROXY_LOOPBACK_PORT};
const maxHeader = 8192;
const maxQueued = 65536;
const sockets = new Set();
let codexChild;
const relay = net.createServer((client) => {
  sockets.add(client);
  client.once("close", () => sockets.delete(client));
  client.once("error", () => client.destroy());
  let input = Buffer.alloc(0);
  const onHead = (chunk) => {
    if (input.length + chunk.length > maxHeader + maxQueued) {
      client.destroy();
      return;
    }
    input = Buffer.concat([input, chunk]);
    if (input.length > maxHeader && input.indexOf("\r\n\r\n") < 0) {
      client.destroy();
      return;
    }
    const boundary = input.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    if (boundary + 4 > maxHeader || input.length - boundary - 4 > maxQueued) {
      client.destroy();
      return;
    }
    const header = input.subarray(0, boundary + 4).toString("latin1");
    const lines = header.slice(0, -4).split("\r\n");
    const request = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift() || "");
    if (!request || header.includes("\0") || /\r(?!\n)|(?<!\r)\n/.test(header)) {
      client.destroy();
      return;
    }
    const authority = request[1];
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*):443$/.exec(authority);
    const host = match ? match[1].toLowerCase() : "";
    if (!allowed.has(host) || !match) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const headers = new Map();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 1 || /^[ \t]/.test(line)) { client.destroy(); return; }
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (headers.has(name) || !["host", "proxy-connection", "user-agent"].includes(name)) {
        client.destroy();
        return;
      }
      headers.set(name, value);
    }
    if (headers.get("host") !== authority) { client.destroy(); return; }
    const early = input.subarray(boundary + 4);
    if (early.length && early[0] !== 0x16) { client.destroy(); return; }
    client.pause();
    client.off("data", onHead);
    const broker = net.createConnection(brokerPath);
    sockets.add(broker);
    broker.once("close", () => sockets.delete(broker));
    broker.once("error", () => client.destroy());
    const queued = early.length ? [early] : [];
    let queuedLength = early.length;
    let response = Buffer.alloc(0);
    let connected = false;
    const onPending = (data) => {
      queuedLength += data.length;
      if (queuedLength > maxQueued) { client.destroy(); broker.destroy(); return; }
      queued.push(data);
    };
    client.on("data", onPending);
    client.resume();
    broker.on("connect", () => {
      broker.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n");
    });
    broker.on("data", (data) => {
      if (connected) return;
      response = Buffer.concat([response, data]);
      if (response.length > maxHeader && response.indexOf("\r\n\r\n") < 0) {
        client.destroy(); broker.destroy(); return;
      }
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = /^HTTP\/1\.[01] 200 Connection Established\r\n/.test(response.toString("latin1", 0, end + 2));
      client.write(response);
      if (!status) { client.end(); broker.end(); return; }
      connected = true;
      client.off("data", onPending);
      for (const part of queued) broker.write(part);
      client.pipe(broker);
      broker.pipe(client);
      client.resume();
    });
  };
  client.on("data", onHead);
});
relay.on("error", () => process.exit(126));
relay.listen(proxyPort, "127.0.0.1", () => {
  const [codexPath, ...args] = process.argv.slice(1);
  if (!codexPath) process.exit(126);

  const failPreflight = () => {
    for (const socket of sockets) socket.destroy();
    relay.close();
    process.exit(126);
  };
  const startCodex = () => {
    codexChild = spawn(codexPath, args, { stdio: "inherit", env: process.env });
    codexChild.once("error", () => { relay.close(); process.exit(127); });
    codexChild.once("exit", (code, signal) => {
      for (const socket of sockets) socket.destroy();
      relay.close();
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code === null ? 1 : code;
    });
  };

  const loopbackProbe = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  loopbackProbe.once("error", failPreflight);
  loopbackProbe.once("connect", () => {
    loopbackProbe.destroy();
    const brokerProbe = net.createConnection(brokerPath);
    brokerProbe.once("error", failPreflight);
    brokerProbe.once("connect", () => {
      brokerProbe.destroy();
      startCodex();
    });
  });
});
process.once("SIGTERM", () => codexChild?.kill("SIGTERM"));
process.once("SIGINT", () => codexChild?.kill("SIGINT"));
`;
