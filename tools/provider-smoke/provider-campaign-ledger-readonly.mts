import { readFile } from "node:fs/promises";

export interface ReadOnlyProviderCampaignLedger {
  campaignId: string;
  maxInferenceCallsByProvider: {
    campus_gateway: number;
    codex_app_server: number;
  };
  providers: Record<
    "campus_gateway" | "codex_app_server",
    {
      reservedCalls: number;
      reconciledCalls?: number;
      lastOutcome: string;
      requestedModel: string | null;
      responseModel: string | null;
      usage: "reported" | "estimated" | "unknown";
      capabilitiesObserved: string[];
    }
  >;
}

type JsonRecord = Record<string, unknown>;

const providerNames = ["campus_gateway", "codex_app_server"] as const;
const outcomeNames = new Set([
  "not_attempted",
  "reserved_before_network_request",
  "succeeded",
  "failed",
  "blocked_missing_credentials_or_model",
  "blocked_not_logged_in",
  "blocked_no_active_projects",
  "blocked_budget_exhausted",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Provider campaign ledger has an invalid ${label} shape`);
  }
}

function validateCampaignLedger(
  value: unknown,
  campaignId: string,
): ReadOnlyProviderCampaignLedger {
  if (!isRecord(value)) {
    throw new Error("Provider campaign ledger root is invalid");
  }
  assertExactKeys(
    value,
    ["campaignId", "maxInferenceCallsByProvider", "providers"],
    "root",
  );
  if (value.campaignId !== campaignId) {
    throw new Error("Provider campaign ledger identity does not match");
  }

  const limits = value.maxInferenceCallsByProvider;
  if (!isRecord(limits)) {
    throw new Error("Provider campaign ledger limits are invalid");
  }
  assertExactKeys(limits, providerNames, "limits");
  for (const provider of providerNames) {
    const limit = limits[provider];
    if (
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 110
    ) {
      throw new Error(
        `Provider campaign ledger limit is invalid for ${provider}`,
      );
    }
  }

  const providers = value.providers;
  if (!isRecord(providers)) {
    throw new Error("Provider campaign ledger providers are invalid");
  }
  assertExactKeys(providers, providerNames, "providers");
  for (const provider of providerNames) {
    const entry = providers[provider];
    if (!isRecord(entry)) {
      throw new Error(
        `Provider campaign ledger entry is invalid for ${provider}`,
      );
    }
    assertExactKeys(
      entry,
      [
        "reservedCalls",
        ...(Object.hasOwn(entry, "reconciledCalls") ? ["reconciledCalls"] : []),
        "lastOutcome",
        "requestedModel",
        "responseModel",
        "usage",
        "capabilitiesObserved",
      ],
      `${provider} entry`,
    );
    const reservedCalls = entry.reservedCalls;
    const reconciledCalls = entry.reconciledCalls;
    if (
      !Number.isInteger(reservedCalls) ||
      (reservedCalls as number) < 0 ||
      (reconciledCalls !== undefined &&
        (!Number.isInteger(reconciledCalls) ||
          (reconciledCalls as number) < 0)) ||
      (reservedCalls as number) +
        (reconciledCalls === undefined ? 0 : (reconciledCalls as number)) >
        (limits[provider] as number) ||
      typeof entry.lastOutcome !== "string" ||
      !outcomeNames.has(entry.lastOutcome) ||
      !(
        entry.requestedModel === null ||
        typeof entry.requestedModel === "string"
      ) ||
      !(
        entry.responseModel === null || typeof entry.responseModel === "string"
      ) ||
      !["reported", "estimated", "unknown"].includes(String(entry.usage)) ||
      !Array.isArray(entry.capabilitiesObserved) ||
      !entry.capabilitiesObserved.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `Provider campaign ledger values are invalid for ${provider}`,
      );
    }
  }

  return value as unknown as ReadOnlyProviderCampaignLedger;
}

/**
 * Read a campaign ledger and its durable initialization marker without taking
 * the reservation API path, which may initialize missing campaign files.
 */
export async function readExistingProviderCampaignLedgerReadOnly(
  ledgerPath: string,
  campaignId: string,
): Promise<ReadOnlyProviderCampaignLedger> {
  const markerPath = `${ledgerPath}.initialized`;
  let ledgerContents: string;
  let markerContents: string;
  try {
    [ledgerContents, markerContents] = await Promise.all([
      readFile(ledgerPath, "utf8"),
      readFile(markerPath, "utf8"),
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Provider campaign ledger and initialization marker must already exist; read-only audit refuses to initialize them",
      );
    }
    throw error;
  }

  if (markerContents !== `${campaignId}\n`) {
    throw new Error(
      "Provider campaign ledger initialization marker is invalid",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ledgerContents) as unknown;
  } catch {
    throw new Error("Provider campaign ledger is corrupt JSON");
  }
  return validateCampaignLedger(parsed, campaignId);
}
