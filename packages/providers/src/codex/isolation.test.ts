import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CODEX_EGRESS_SOCKET_IN_SANDBOX,
  CODEX_SANDBOX_CODEX_PACKAGE,
  CODEX_SANDBOX_CODEX_HOME,
  CODEX_SANDBOX_HOME,
  CODEX_SANDBOX_SCRATCH,
  codexRuntimeEnvironment,
  createCodexBwrapArgs,
  createCodexIsolationRuntime,
  preflightCodexBwrap,
  type CodexIsolationRuntime,
} from "./isolation.js";

const runtime: CodexIsolationRuntime = {
  bwrapPath: "/usr/bin/bwrap",
  codexPath: "/opt/codex/bin/codex.js",
  codexPackagePath: "/opt/codex",
  envPath: "/usr/bin/env",
  nodePath: "/usr/bin/node",
  authHomeHostPath: "/home/test/.local/share/promptlab/codex-auth",
  authHomeFingerprint: "a".repeat(64),
  trustBundlePath: "/etc/ssl/certs/ca-certificates.crt",
  runtimeMounts: [
    {
      sourcePath: "/usr/lib/libstdc++.so.6.0.30",
      targetPath: "/usr/lib/libstdc++.so.6",
    },
    {
      sourcePath: "/lib64/ld-linux-x86-64.so.2",
      targetPath: "/lib64/ld-linux-x86-64.so.2",
    },
  ],
  runtimeDirectory: "/tmp/promptlab-codex-run-test",
  scratchHostPath: "/tmp/promptlab-codex-run-test/scratch",
  egressDirectoryHostPath: "/tmp/promptlab-codex-run-test/egress",
  egressSocketHostPath: "/tmp/promptlab-codex-run-test/egress/egress.sock",
  async close() {},
};

function hasPair(
  args: readonly string[],
  flag: string,
  first: string,
  second: string,
) {
  return args.some(
    (value, index) =>
      value === flag && args[index + 1] === first && args[index + 2] === second,
  );
}

describe("Codex bubblewrap profile", () => {
  it("mounts only the dedicated home, empty run scratch, egress socket, and read-only runtime", () => {
    const args = createCodexBwrapArgs(runtime, ["app-server", "--stdio"]);

    expect(args).toContain("--unshare-all");
    expect(args).toContain("--new-session");
    expect(args[args.indexOf("--proc") + 1]).toBe("/proc");
    expect(args[args.indexOf("--dev") + 1]).toBe("/dev");
    expect(hasPair(args, "--ro-bind", runtime.envPath, "/usr/bin/env")).toBe(
      true,
    );
    expect(
      hasPair(
        args,
        "--ro-bind",
        runtime.codexPackagePath,
        CODEX_SANDBOX_CODEX_PACKAGE,
      ),
    ).toBe(true);
    expect(args).toContain(`${CODEX_SANDBOX_CODEX_PACKAGE}/bin/codex.js`);
    expect(
      hasPair(
        args,
        "--ro-bind",
        "/usr/lib/libstdc++.so.6.0.30",
        "/usr/lib/libstdc++.so.6",
      ),
    ).toBe(true);
    expect(
      hasPair(
        args,
        "--ro-bind",
        "/lib64/ld-linux-x86-64.so.2",
        "/lib64/ld-linux-x86-64.so.2",
      ),
    ).toBe(true);
    expect(args).toContain("/usr/lib/libstdc++.so.6");
    expect(hasPair(args, "--ro-bind", "/usr/lib", "/usr/lib")).toBe(false);
    expect(hasPair(args, "--ro-bind", "/lib", "/lib")).toBe(false);
    expect(hasPair(args, "--ro-bind", "/lib64", "/lib64")).toBe(false);
    expect(
      hasPair(
        args,
        "--bind",
        runtime.authHomeHostPath,
        CODEX_SANDBOX_CODEX_HOME,
      ),
    ).toBe(true);
    expect(
      hasPair(args, "--bind", runtime.scratchHostPath, CODEX_SANDBOX_SCRATCH),
    ).toBe(true);
    expect(
      hasPair(
        args,
        "--ro-bind",
        runtime.egressDirectoryHostPath,
        "/promptlab/egress",
      ),
    ).toBe(true);
    expect(
      args.some((value) => value.includes(CODEX_EGRESS_SOCKET_IN_SANDBOX)),
    ).toBe(true);
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/home");
    expect(args).toContain("--clearenv");
    expect(args).toContain("--chdir");
    expect(args[args.indexOf("--chdir") + 1]).toBe(CODEX_SANDBOX_SCRATCH);
    expect(hasPair(args, "--ro-bind", "/home/test", "/home/test")).toBe(false);
    expect(args).not.toContain("/home/lenovo");
    expect(args).not.toContain("/home/lenovo/FP_PBKK");
    expect(args).not.toContain("--share-net");
    const relayScript = args[args.indexOf("-e") + 1];
    expect(relayScript).toContain("input.length - boundary - 4 > maxQueued");
    expect(relayScript).toContain(
      'net.createConnection({ host: "127.0.0.1", port: proxyPort })',
    );
    expect(relayScript).toContain("net.createConnection(brokerPath)");
  });

  it("creates empty private scratch and a private per-run broker socket", async () => {
    const fixtureDirectory = await mkdtemp(
      join(tmpdir(), "codex-isolation-test-"),
    );
    const authHome = join(fixtureDirectory, "auth-home");
    const codexPackagePath = join(fixtureDirectory, "codex-package");
    await mkdir(join(codexPackagePath, "bin"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(codexPackagePath, "package.json"),
      JSON.stringify({ name: "@openai/codex" }),
    );
    await writeFile(join(codexPackagePath, "bin", "codex.js"), "");
    await mkdir(authHome, { mode: 0o700 });
    await chmod(fixtureDirectory, 0o700);
    let runtime: Awaited<
      ReturnType<typeof createCodexIsolationRuntime>
    > | null = null;
    try {
      runtime = await createCodexIsolationRuntime(
        { PATH: "/test" } as NodeJS.ProcessEnv,
        {
          resolveExecutable: async (name) =>
            name === "codex"
              ? join(codexPackagePath, "bin", "codex.js")
              : `/test/${name}`,
          authHome: async () => ({
            path: authHome,
            fingerprint: "a".repeat(64),
          }),
        },
      );

      expect(runtime.codexPackagePath).toBe(codexPackagePath);
      expect(runtime.envPath).toBe("/test/env");
      expect(await readdir(runtime.scratchHostPath)).toEqual([]);
      expect((await stat(runtime.scratchHostPath)).mode & 0o777).toBe(0o700);
      expect((await stat(runtime.egressDirectoryHostPath)).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(runtime.egressSocketHostPath)).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await runtime?.close();
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("passes only the dedicated runtime environment", () => {
    expect(codexRuntimeEnvironment()).toMatchObject({
      HOME: CODEX_SANDBOX_HOME,
      CODEX_HOME: CODEX_SANDBOX_CODEX_HOME,
      PATH: "/promptlab/bin",
      TMPDIR: "/tmp",
      HTTPS_PROXY: "http://127.0.0.1:18765",
      NO_PROXY: "",
    });
    expect(Object.keys(codexRuntimeEnvironment()).sort()).toEqual(
      [
        "ALL_PROXY",
        "CODEX_HOME",
        "HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "PATH",
        "TMPDIR",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ].sort(),
    );
  });

  it("proves the sandbox can run the pinned Codex version before inference", () => {
    const spawnSyncProcess = vi.fn(() => ({
      error: undefined,
      status: 0,
      stdout: "codex-cli 0.160.1\n",
      stderr: "",
    })) as never;

    expect(preflightCodexBwrap(runtime, { spawnSyncProcess })).toBe("0.160.1");
    expect(spawnSyncProcess).toHaveBeenCalledWith(
      runtime.bwrapPath,
      expect.arrayContaining(["--unshare-all", "--version"]),
      expect.objectContaining({ env: {} }),
    );
  });

  it("fails capability preflight closed when bubblewrap cannot start", () => {
    const spawnSyncProcess = vi.fn(() => ({
      error: new Error("injected bwrap failure"),
      status: null,
      stdout: "",
      stderr: "",
    })) as never;

    expect(() => preflightCodexBwrap(runtime, { spawnSyncProcess })).toThrow(
      "Bubblewrap capability preflight failed; no inference was attempted.",
    );
  });
});
