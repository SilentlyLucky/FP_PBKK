import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CodexProviderError,
  connectCodexAppServer,
  listCodexModels,
  readCodexAccount,
} from "../../packages/providers/src/codex/app-server.js";

const protocolVersion = "v0.160.1";
const protocolRoot = new URL(
  `../../packages/providers/src/codex/protocol/generated/${protocolVersion}/`,
  import.meta.url,
);

async function protocolSchemasMatch(): Promise<boolean> {
  try {
    const [initializeParamsText, initializeResponseText, notificationText] =
      await Promise.all([
        readFile(
          fileURLToPath(new URL("InitializeParams.json", protocolRoot)),
          "utf8",
        ),
        readFile(
          fileURLToPath(new URL("InitializeResponse.json", protocolRoot)),
          "utf8",
        ),
        readFile(
          fileURLToPath(new URL("ClientNotification.json", protocolRoot)),
          "utf8",
        ),
      ]);
    const initializeParams = JSON.parse(initializeParamsText) as {
      required?: string[];
    };
    const initializeResponse = JSON.parse(initializeResponseText) as {
      required?: string[];
    };
    const notifications = JSON.parse(notificationText) as {
      oneOf?: Array<{ properties?: { method?: { enum?: string[] } } }>;
    };
    return Boolean(
      initializeParams.required?.includes("clientInfo") &&
      initializeResponse.required?.includes("userAgent") &&
      notifications.oneOf?.some((entry) =>
        entry.properties?.method?.enum?.includes("initialized"),
      ),
    );
  } catch {
    return false;
  }
}

const schemasMatch = await protocolSchemasMatch();
let connected: Awaited<ReturnType<typeof connectCodexAppServer>> | null = null;
let authentication:
  "logged_in" | "not_logged_in" | "unsupported_account" | "unknown" = "unknown";
let initialize: { status: string; reason: string | null } = {
  status: "not_attempted",
  reason: schemasMatch ? null : "protocol_schema_mismatch",
};
let modelCount = 0;
let effectiveProvider = "unverified";
let isolationPolicyVersion: string | null = null;

if (schemasMatch) {
  try {
    connected = await connectCodexAppServer();
    initialize = { status: "succeeded", reason: null };
    isolationPolicyVersion = connected.isolationPolicyVersion;
    const account = await readCodexAccount(
      connected.session,
      connected.codexHomeFingerprint,
    );
    authentication = "logged_in";
    effectiveProvider = account.type === "chatgpt" ? "openai" : "unverified";
    modelCount = (await listCodexModels(connected.session)).length;
  } catch (error) {
    initialize = {
      status: "failed",
      reason: error instanceof CodexProviderError ? error.code : "probe_failed",
    };
    if (
      error instanceof CodexProviderError &&
      error.code === "codex_not_logged_in"
    ) {
      authentication = "not_logged_in";
    } else if (
      error instanceof CodexProviderError &&
      error.code === "codex_subscription_required"
    ) {
      authentication = "unsupported_account";
    }
  } finally {
    await connected?.session.close();
  }
}

process.stdout.write(
  `${JSON.stringify({
    authentication: {
      status: authentication,
      source: "isolated app-server account/read",
    },
    initialize: {
      ...initialize,
      protocolSchema: schemasMatch ? "matched" : "mismatch_or_unavailable",
      protocolSchemaVersion: protocolVersion,
    },
    modelProbe: {
      status: authentication === "logged_in" ? "succeeded" : "not_attempted",
      availableModelCount: modelCount,
    },
    generationAttempted: false,
    generationVerified: false,
    effectiveProvider,
    effectiveModel: "unselected",
    isolationPolicyVersion,
    nativeToolPolicy: connected ? "bounded-native" : "unverified",
  })}\n`,
);
