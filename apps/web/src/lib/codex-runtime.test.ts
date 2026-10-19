import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectCodexAppServer, readCodexAccount } = vi.hoisted(() => ({
  connectCodexAppServer: vi.fn(),
  readCodexAccount: vi.fn(),
}));

vi.mock("@promptlab/providers/codex", async () => {
  const actual = await vi.importActual<
    typeof import("@promptlab/providers/codex")
  >("@promptlab/providers/codex");
  return { ...actual, connectCodexAppServer, readCodexAccount };
});

import { CodexProviderError } from "@promptlab/providers/codex";

import { inspectCodexRuntime } from "./codex-runtime.ts";

beforeEach(() => {
  vi.resetAllMocks();
});

function mockAccountReadError(rpcErrorCode: number) {
  const close = vi.fn();
  connectCodexAppServer.mockResolvedValue({
    session: { close },
    cliVersion: "0.160.1",
    codexHomeFingerprint: "a".repeat(64),
    isolationPolicyVersion: "codex-bwrap-bounded-native-v2",
  });
  readCodexAccount.mockRejectedValue(
    new CodexProviderError(
      "app_server_protocol_error",
      "private server detail",
      false,
      rpcErrorCode,
    ),
  );
  return close;
}

describe("inspectCodexRuntime", () => {
  it("returns an actionable app-server protocol failure without exposing raw details", async () => {
    connectCodexAppServer.mockRejectedValue(
      new CodexProviderError(
        "app_server_protocol_error",
        "private child process detail",
      ),
    );

    await expect(inspectCodexRuntime()).resolves.toEqual({
      status: "unavailable",
      reason:
        "Handshake Codex app-server tidak cocok dengan protokol yang didukung PromptLab.",
      models: [],
    });
  });

  it("explains a standard unsupported account RPC without exposing server details", async () => {
    const close = mockAccountReadError(-32601);

    await expect(inspectCodexRuntime()).resolves.toEqual({
      status: "unavailable",
      reason:
        "Codex app-server tidak mendukung pembacaan akun yang diperlukan. Periksa kecocokan versi Codex CLI.",
      models: [],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a generic account RPC internal failure without exposing server details", async () => {
    const close = mockAccountReadError(-32603);

    await expect(inspectCodexRuntime()).resolves.toEqual({
      status: "unavailable",
      reason:
        "Codex app-server mengalami error internal saat membaca akun. Status login Codex belum dapat diverifikasi.",
      models: [],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the explicit login instruction for an unauthenticated account", async () => {
    const close = vi.fn();
    connectCodexAppServer.mockResolvedValue({
      session: { close },
      cliVersion: "0.160.1",
      codexHomeFingerprint: "a".repeat(64),
      isolationPolicyVersion: "codex-bwrap-bounded-native-v2",
    });
    readCodexAccount.mockRejectedValue(
      new CodexProviderError("codex_not_logged_in", "private server detail"),
    );

    await expect(inspectCodexRuntime()).resolves.toEqual({
      status: "not_logged_in",
      reason:
        "Dedicated auth home PromptLab belum terhubung ke akun ChatGPT. Gunakan tombol Login Codex.",
      models: [],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps unclassified runtime errors generic", async () => {
    connectCodexAppServer.mockRejectedValue(
      new Error("private runtime detail"),
    );

    await expect(inspectCodexRuntime()).resolves.toEqual({
      status: "unavailable",
      reason: "Codex app-server belum dapat diperiksa.",
      models: [],
    });
  });
});
