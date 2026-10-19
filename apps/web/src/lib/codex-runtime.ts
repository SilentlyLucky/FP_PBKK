import {
  CODEX_ISOLATION_POLICY_VERSION,
  CodexAppServerSession,
  CodexProviderError,
  codexAccountFingerprintFromSnapshot,
  codexVerificationMatchesConfiguration,
  connectCodexAppServer,
  isOfficialCodexLoginUrl,
  listCodexModels,
  readCodexAccount,
  startCodexDeviceLogin as startOfficialDeviceLogin,
  type CodexAccountSnapshot,
  type CodexModel,
} from "@promptlab/providers/codex";

export type CodexRuntimeSnapshot =
  | { status: "unavailable"; reason: string; models: CodexModel[] }
  | { status: "not_logged_in"; reason: string; models: CodexModel[] }
  | { status: "unsupported_account"; reason: string; models: CodexModel[] }
  | {
      status: "ready";
      account: CodexAccountSnapshot;
      models: CodexModel[];
      codexHomeFingerprint: string;
      isolationPolicyVersion: typeof CODEX_ISOLATION_POLICY_VERSION;
    };

interface LoginFlow {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  status: "pending" | "succeeded" | "failed" | "expired";
  session: CodexAppServerSession;
  expiryTimer: NodeJS.Timeout;
  closeTimer: NodeJS.Timeout | null;
  unsubscribe: (() => void) | null;
}

interface LoginFlowView {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  status: LoginFlow["status"];
}

type CodexGlobal = typeof globalThis & {
  __promptLabCodexLoginFlows?: Map<string, LoginFlow>;
};

function loginFlows(): Map<string, LoginFlow> {
  const root = globalThis as CodexGlobal;
  root.__promptLabCodexLoginFlows ??= new Map();
  return root.__promptLabCodexLoginFlows;
}

function flowView(flow: LoginFlow): LoginFlowView {
  return {
    loginId: flow.loginId,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    status: flow.status,
  };
}

async function closeFlow(flow: LoginFlow): Promise<void> {
  clearTimeout(flow.expiryTimer);
  if (flow.closeTimer) clearTimeout(flow.closeTimer);
  flow.unsubscribe?.();
  flow.unsubscribe = null;
  await flow.session.close();
}

export async function inspectCodexRuntime(): Promise<CodexRuntimeSnapshot> {
  let connected: Awaited<ReturnType<typeof connectCodexAppServer>> | null =
    null;
  let inspectionStage: "connect" | "account" | "models" = "connect";
  try {
    connected = await connectCodexAppServer();
    let account: CodexAccountSnapshot;
    inspectionStage = "account";
    try {
      account = await readCodexAccount(
        connected.session,
        connected.codexHomeFingerprint,
      );
    } catch (error) {
      if (
        error instanceof CodexProviderError &&
        error.code === "codex_not_logged_in"
      ) {
        return {
          status: "not_logged_in",
          reason:
            "Dedicated auth home PromptLab belum terhubung ke akun ChatGPT. Gunakan tombol Login Codex.",
          models: [],
        };
      }
      if (
        error instanceof CodexProviderError &&
        error.code === "codex_subscription_required"
      ) {
        return {
          status: "unsupported_account",
          reason:
            "Codex harus memakai login ChatGPT subscription; API key tidak diizinkan.",
          models: [],
        };
      }
      throw error;
    }
    inspectionStage = "models";
    const models = await listCodexModels(connected.session);
    return {
      status: "ready",
      account,
      models,
      codexHomeFingerprint: connected.codexHomeFingerprint,
      isolationPolicyVersion: connected.isolationPolicyVersion,
    };
  } catch (error) {
    const reason = codexRuntimeFailureReason(error, inspectionStage);
    return { status: "unavailable", reason, models: [] };
  } finally {
    await connected?.session.close();
  }
}

function codexRuntimeFailureReason(
  error: unknown,
  stage: "connect" | "account" | "models",
): string {
  if (!(error instanceof CodexProviderError))
    return "Codex app-server belum dapat diperiksa.";

  switch (error.code) {
    case "codex_cli_unavailable":
      return "Codex CLI tidak tersedia pada server lokal.";
    case "codex_cli_version_unsupported":
      return "Versi Codex CLI berbeda dari protokol yang dipatok PromptLab.";
    case "codex_isolation_unavailable":
      return "Profil bubblewrap bounded-native belum dapat disiapkan; account dan model probe tidak dijalankan.";
    case "app_server_unavailable":
      return stage === "connect"
        ? "Codex app-server gagal dijalankan atau tidak merespons saat handshake."
        : "Codex app-server berhenti merespons saat memeriksa akun atau model.";
    case "app_server_protocol_error":
      if (stage === "account" && error.rpcErrorCode === -32601)
        return "Codex app-server tidak mendukung pembacaan akun yang diperlukan. Periksa kecocokan versi Codex CLI.";
      if (stage === "account" && error.rpcErrorCode === -32602)
        return "Codex app-server menolak parameter pembacaan akun. Adapter perlu diselaraskan dengan protokol aktif.";
      if (stage === "account" && error.rpcErrorCode === -32603)
        return "Codex app-server mengalami error internal saat membaca akun. Status login Codex belum dapat diverifikasi.";
      return stage === "connect"
        ? "Handshake Codex app-server tidak cocok dengan protokol yang didukung PromptLab."
        : stage === "account"
          ? "Respons pemeriksaan akun Codex app-server tidak cocok dengan protokol yang didukung PromptLab."
          : "Respons daftar model Codex app-server tidak cocok dengan protokol yang didukung PromptLab.";
    case "codex_not_logged_in":
      return "Dedicated auth home PromptLab belum terhubung ke akun ChatGPT. Gunakan tombol Login Codex.";
    case "codex_subscription_required":
      return "Codex harus memakai login ChatGPT subscription; API key tidak diizinkan.";
    case "codex_model_unavailable":
      return "Daftar model Codex tidak tersedia dari app-server.";
    case "codex_policy_unverified":
      return "Kebijakan isolasi Codex belum berhasil diverifikasi.";
    case "codex_turn_timeout":
      return "Pemeriksaan Codex melewati batas waktu.";
    case "codex_turn_interrupted":
      return "Pemeriksaan Codex terhenti sebelum selesai.";
    case "codex_turn_failed":
      return "Pemeriksaan Codex gagal sebelum konfigurasi siap.";
    case "codex_reasoning_effort_unavailable":
      return "Konfigurasi effort Codex tidak tersedia pada runtime ini.";
    case "codex_output_invalid":
      return "Respons pemeriksaan Codex tidak memenuhi format yang didukung.";
  }
}

export async function startCodexLogin(): Promise<LoginFlowView> {
  const existing = [...loginFlows().values()].find(
    (flow) => flow.status === "pending",
  );
  if (existing) return flowView(existing);

  const attempt = await startOfficialDeviceLogin();
  if (!isOfficialCodexLoginUrl(attempt.verificationUrl)) {
    await attempt.session.close();
    throw new CodexProviderError(
      "app_server_protocol_error",
      "Codex returned a non-official login URL.",
    );
  }

  const flow: LoginFlow = {
    loginId: attempt.loginId,
    verificationUrl: attempt.verificationUrl,
    userCode: attempt.userCode,
    status: "pending",
    session: attempt.session,
    expiryTimer: setTimeout(() => {
      flow.status = "expired";
      void closeFlow(flow);
    }, 10 * 60_000),
    closeTimer: null,
    unsubscribe: null,
  };
  flow.unsubscribe = attempt.session.onNotification((message) => {
    if (message.method !== "account/login/completed") return;
    if (
      !message.params ||
      typeof message.params !== "object" ||
      Array.isArray(message.params)
    ) {
      return;
    }
    const params = message.params as Record<string, unknown>;
    if (params.loginId !== flow.loginId) return;
    flow.status = params.success === true ? "succeeded" : "failed";
    flow.closeTimer = setTimeout(() => void closeFlow(flow), 1_000);
  });
  loginFlows().set(flow.loginId, flow);
  return flowView(flow);
}

export function codexLoginStatus(loginId: unknown): LoginFlowView | null {
  if (typeof loginId !== "string" || loginId.length > 100) return null;
  const flow = loginFlows().get(loginId);
  return flow ? flowView(flow) : null;
}

export function codexReceiptMatchesRuntime(
  snapshot: unknown,
  requestedModel: string,
  runtime: CodexRuntimeSnapshot,
): boolean {
  if (runtime.status !== "ready") return false;
  return (
    runtime.models.some((model) => model.id === requestedModel) &&
    codexVerificationMatchesConfiguration(
      snapshot,
      requestedModel,
      runtime.codexHomeFingerprint,
    ) &&
    codexAccountFingerprintFromSnapshot(snapshot) ===
      runtime.account.identityFingerprint
  );
}
