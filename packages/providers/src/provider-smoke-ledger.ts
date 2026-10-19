import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type SmokeProvider = "campus_gateway" | "codex_app_server";
export type SmokeOutcome =
  | "succeeded"
  | "failed"
  | "blocked_missing_credentials_or_model"
  | "blocked_not_logged_in"
  | "blocked_no_active_projects"
  | "blocked_budget_exhausted";

export const MAX_INFERENCE_CALLS_PER_PROVIDER = 2 as const;
export const MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER = 110 as const;
export const DEFAULT_PROVIDER_VERIFICATION_CAMPAIGN_BUDGET = {
  campus_gateway: MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER,
  codex_app_server: MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER,
} as const;
const LEDGER_SESSION = "foundation-provider-spike-2026-10-11";
const CAMPAIGN_ENVIRONMENT_VARIABLE =
  "PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN";
const LEDGER_PATH_ENVIRONMENT_VARIABLE = "PROMPTLAB_PROVIDER_LEDGER_PATH";
const CAMPAIGN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{30}[a-z0-9])$/;

export function isProviderVerificationCampaignConfigured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(environment[CAMPAIGN_ENVIRONMENT_VARIABLE]?.trim());
}

interface ProviderLedgerEntry {
  reservedCalls: number;
  reconciledCalls?: number;
  lastOutcome: string;
  requestedModel: string | null;
  responseModel: string | null;
  usage: "reported" | "estimated" | "unknown";
  capabilitiesObserved: string[];
}

interface ProviderLedgerContents {
  session: string;
  maxInferenceCallsPerProvider: typeof MAX_INFERENCE_CALLS_PER_PROVIDER;
  providers: Record<SmokeProvider, ProviderLedgerEntry>;
}

interface CampaignLedgerContents {
  campaignId: string;
  maxInferenceCallsPerProvider: number;
  providers: Record<SmokeProvider, ProviderLedgerEntry>;
}

interface ProviderBudgetCampaignLedgerContents {
  campaignId: string;
  maxInferenceCallsByProvider: Record<SmokeProvider, number>;
  providers: Record<SmokeProvider, ProviderLedgerEntry>;
}

type SmokeLedger =
  | ProviderLedgerContents
  | CampaignLedgerContents
  | ProviderBudgetCampaignLedgerContents;
type CampaignSmokeLedger =
  CampaignLedgerContents | ProviderBudgetCampaignLedgerContents;

const PROJECT_PACKAGE_NAME = "promptlab-foundation";
const LEDGER_RELATIVE_PATH = join("docs", "PROVIDER_SMOKE_LEDGER.json");
const CAMPAIGN_LEDGER_DIRECTORY = "provider-verification-campaigns";
const MAX_PROJECT_ROOT_SEARCH_DEPTH = 6;

export function assertValidProviderVerificationCampaignId(
  campaignId: string,
): void {
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new Error(
      `${CAMPAIGN_ENVIRONMENT_VARIABLE} must be exactly 32 lowercase letters, digits, or internal hyphens; provider verification is unavailable`,
    );
  }
}

/**
 * Find the owning PromptLab root from the process working directory. Walking
 * upward keeps root CLI and apps/web runtimes on the same ledger even when a
 * bundler copies this module into .next. The bounded search never scans sibling
 * projects, and the canonical ledger must already exist.
 */
export function resolveDefaultProviderSmokeLedgerPath(
  startDirectory: string = process.cwd(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configuredLedgerPath = environment[LEDGER_PATH_ENVIRONMENT_VARIABLE];
  if (configuredLedgerPath !== undefined) {
    if (!isAbsolute(configuredLedgerPath)) {
      throw new Error(
        `${LEDGER_PATH_ENVIRONMENT_VARIABLE} must be an absolute path; provider verification is unavailable`,
      );
    }

    const ledgerPath = resolve(configuredLedgerPath);
    try {
      if (!statSync(ledgerPath).isFile()) {
        throw new Error(
          `Configured provider call ledger is not a file at ${ledgerPath}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new Error(
          `Configured provider call ledger is missing at ${ledgerPath}; refusing to create or reset it`,
        );
      }
      throw error;
    }
    return ledgerPath;
  }

  let candidate = resolve(startDirectory);

  for (let depth = 0; depth <= MAX_PROJECT_ROOT_SEARCH_DEPTH; depth += 1) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        readFileSync(join(candidate, "package.json"), "utf8"),
      ) as unknown;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    if (isRecord(manifest) && manifest.name === PROJECT_PACKAGE_NAME) {
      const projectRoot = realpathSync(candidate);
      const ledgerPath = join(projectRoot, LEDGER_RELATIVE_PATH);
      let ledgerIsFile = false;
      try {
        ledgerIsFile = statSync(ledgerPath).isFile();
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
      }
      if (!ledgerIsFile) {
        throw new Error(
          `Canonical provider call ledger is missing at ${ledgerPath}; refusing to create or use a bundled copy`,
        );
      }
      return ledgerPath;
    }

    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  throw new Error(
    `Could not locate ${PROJECT_PACKAGE_NAME} within ${MAX_PROJECT_ROOT_SEARCH_DEPTH} parent directories; provider call ledger unavailable`,
  );
}

/**
 * Resolve a named campaign beside the historical ledger under the owning
 * PromptLab root. The campaign ID is constrained to a single safe path slug.
 */
export function resolveProviderVerificationCampaignLedgerPath(
  campaignId: string,
  startDirectory: string = process.cwd(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  assertValidProviderVerificationCampaignId(campaignId);
  const canonicalLedgerPath = resolveDefaultProviderSmokeLedgerPath(
    startDirectory,
    environment,
  );
  return join(
    dirname(canonicalLedgerPath),
    CAMPAIGN_LEDGER_DIRECTORY,
    `${campaignId}.json`,
  );
}

const outcomeValues = new Set([
  "not_attempted",
  "reserved_before_network_request",
  "succeeded",
  "failed",
  "blocked_missing_credentials_or_model",
  "blocked_not_logged_in",
  "blocked_no_active_projects",
  "blocked_budget_exhausted",
]);
const providerValues: SmokeProvider[] = ["campus_gateway", "codex_app_server"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Provider call ledger has an invalid ${label} shape`);
  }
}

function validateLedger(
  value: unknown,
  expectedCampaignId?: string,
): SmokeLedger {
  if (!isRecord(value)) throw new Error("Provider call ledger root is invalid");
  let callLimits: Record<SmokeProvider, number>;
  if (expectedCampaignId === undefined) {
    assertExactKeys(
      value,
      ["session", "maxInferenceCallsPerProvider", "providers"],
      "root",
    );
    callLimits = {
      campus_gateway: MAX_INFERENCE_CALLS_PER_PROVIDER,
      codex_app_server: MAX_INFERENCE_CALLS_PER_PROVIDER,
    };
  } else {
    const hasSharedLimit = Object.hasOwn(value, "maxInferenceCallsPerProvider");
    const hasProviderLimits = Object.hasOwn(
      value,
      "maxInferenceCallsByProvider",
    );
    if (hasSharedLimit === hasProviderLimits) {
      throw new Error(
        "Provider call ledger campaign metadata is invalid; refusing any call",
      );
    }
    if (hasSharedLimit) {
      assertExactKeys(
        value,
        ["campaignId", "maxInferenceCallsPerProvider", "providers"],
        "campaign root",
      );
      const limit = value.maxInferenceCallsPerProvider;
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER
      ) {
        throw new Error(
          "Provider call ledger campaign metadata is invalid; refusing any call",
        );
      }
      callLimits = {
        campus_gateway: limit as number,
        codex_app_server: limit as number,
      };
    } else {
      assertExactKeys(
        value,
        ["campaignId", "maxInferenceCallsByProvider", "providers"],
        "campaign root",
      );
      const limits = value.maxInferenceCallsByProvider;
      if (!isRecord(limits)) {
        throw new Error(
          "Provider call ledger campaign metadata is invalid; refusing any call",
        );
      }
      assertExactKeys(limits, providerValues, "campaign provider limits");
      for (const provider of providerValues) {
        const limit = limits[provider];
        if (
          !Number.isInteger(limit) ||
          (limit as number) < 1 ||
          (limit as number) > MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER
        ) {
          throw new Error(
            "Provider call ledger campaign metadata is invalid; refusing any call",
          );
        }
      }
      callLimits = {
        campus_gateway: limits.campus_gateway as number,
        codex_app_server: limits.codex_app_server as number,
      };
    }
  }
  if (
    (expectedCampaignId === undefined
      ? value.session !== LEDGER_SESSION
      : value.campaignId !== expectedCampaignId) ||
    (expectedCampaignId === undefined &&
      value.maxInferenceCallsPerProvider !==
        MAX_INFERENCE_CALLS_PER_PROVIDER) ||
    !isRecord(value.providers)
  ) {
    throw new Error(
      expectedCampaignId === undefined
        ? "Provider call ledger metadata is invalid"
        : "Provider call ledger campaign metadata is invalid; refusing any call",
    );
  }
  assertExactKeys(value.providers, providerValues, "providers");

  for (const provider of providerValues) {
    const entry = value.providers[provider];
    if (!isRecord(entry))
      throw new Error(`Provider call ledger entry is invalid for ${provider}`);
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
    if (
      !Number.isInteger(entry.reservedCalls) ||
      (entry.reservedCalls as number) < 0 ||
      (entry.reservedCalls as number) +
        (entry.reconciledCalls === undefined
          ? 0
          : Number(entry.reconciledCalls)) >
        callLimits[provider] ||
      (entry.reconciledCalls !== undefined &&
        (!Number.isInteger(entry.reconciledCalls) ||
          (entry.reconciledCalls as number) < 0)) ||
      typeof entry.lastOutcome !== "string" ||
      !outcomeValues.has(entry.lastOutcome) ||
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
        `Provider call ledger values are invalid for ${provider}`,
      );
    }
  }

  return value as unknown as SmokeLedger;
}

function providerCallLimit(
  ledger: SmokeLedger,
  provider: SmokeProvider,
): number {
  if ("maxInferenceCallsByProvider" in ledger) {
    return ledger.maxInferenceCallsByProvider[provider];
  }
  return ledger.maxInferenceCallsPerProvider;
}

function providerCallsUsed(entry: ProviderLedgerEntry): number {
  return entry.reservedCalls + (entry.reconciledCalls ?? 0);
}

function parseLedgerContents(
  contents: string,
  expectedCampaignId?: string,
): SmokeLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Provider call ledger is corrupt JSON; refusing any call");
  }
  return validateLedger(parsed, expectedCampaignId);
}

async function readLedger(
  ledgerPath: string,
  expectedCampaignId?: string,
): Promise<SmokeLedger> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Provider call ledger is missing; refusing to create or reset it",
      );
    }
    throw error;
  }
  return parseLedgerContents(contents, expectedCampaignId);
}

type CampaignCallBudget = Readonly<Record<SmokeProvider, number>>;

function newCampaignLedger(
  campaignId: string,
  campaignBudget?: CampaignCallBudget,
): CampaignSmokeLedger {
  return {
    campaignId,
    ...(campaignBudget
      ? { maxInferenceCallsByProvider: { ...campaignBudget } }
      : { maxInferenceCallsPerProvider: MAX_INFERENCE_CALLS_PER_PROVIDER }),
    providers: {
      campus_gateway: {
        reservedCalls: 0,
        lastOutcome: "not_attempted",
        requestedModel: null,
        responseModel: null,
        usage: "unknown",
        capabilitiesObserved: [],
      },
      codex_app_server: {
        reservedCalls: 0,
        lastOutcome: "not_attempted",
        requestedModel: null,
        responseModel: null,
        usage: "unknown",
        capabilitiesObserved: [],
      },
    },
  };
}

function campaignInitializationMarkerPath(ledgerPath: string): string {
  return `${ledgerPath}.initialized`;
}

async function readAndValidateCampaignMarker(
  markerPath: string,
  campaignId: string,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(markerPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  if (contents !== `${campaignId}\n`) {
    throw new Error(
      "Provider verification campaign initialization record is invalid; refusing any call",
    );
  }
  return true;
}

async function writeCampaignMarker(
  markerPath: string,
  campaignId: string,
): Promise<void> {
  let marker: FileHandle | undefined;
  try {
    marker = await open(markerPath, "wx", 0o600);
    await marker.writeFile(`${campaignId}\n`, "utf8");
    await marker.sync();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  } finally {
    await marker?.close();
  }
  if (!(await readAndValidateCampaignMarker(markerPath, campaignId))) {
    throw new Error(
      "Provider verification campaign initialization record is missing; refusing any call",
    );
  }
}

/**
 * Campaign ledgers are initialized once under the same lock as reservations.
 * A durable sidecar records that initialization happened, so a removed ledger
 * cannot silently turn a used campaign back into a fresh budget.
 */
async function readOrInitializeCampaignLedger(
  ledgerPath: string,
  campaignId: string,
  campaignBudget?: CampaignCallBudget,
): Promise<CampaignSmokeLedger> {
  try {
    const ledger = (await readLedger(
      ledgerPath,
      campaignId,
    )) as CampaignSmokeLedger;
    await writeCampaignMarker(
      campaignInitializationMarkerPath(ledgerPath),
      campaignId,
    );
    return ledger;
  } catch (error) {
    if (!(
      error instanceof Error &&
      error.message ===
        "Provider call ledger is missing; refusing to create or reset it"
    ))
      throw error;
  }

  const markerPath = campaignInitializationMarkerPath(ledgerPath);
  if (await readAndValidateCampaignMarker(markerPath, campaignId)) {
    throw new Error(
      "Provider verification campaign ledger is missing after initialization; refusing to reset it",
    );
  }

  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  await writeCampaignMarker(markerPath, campaignId);
  const initialLedger = newCampaignLedger(campaignId, campaignBudget);
  validateLedger(initialLedger, campaignId);

  let handle: FileHandle | undefined;
  try {
    handle = await open(ledgerPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify(initialLedger, null, 2)}\n`,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return (await readLedger(ledgerPath, campaignId)) as CampaignSmokeLedger;
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return initialLedger;
}

async function locked<T>(
  lockPath: string,
  action: () => Promise<T>,
): Promise<T> {
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      await sleep(25);
    }
  }
  if (!lock)
    throw new Error(
      "Provider call ledger is locked; no inference call was made",
    );
  try {
    return await action();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function withCampaignLock<T>(
  ledgerPath: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  return locked(`${ledgerPath}.lock`, action);
}

async function writeLedger(
  ledgerPath: string,
  ledger: SmokeLedger,
  expectedCampaignId?: string,
): Promise<void> {
  validateLedger(ledger, expectedCampaignId);
  const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, ledgerPath);
}

export function createProviderSmokeLedger(
  ledgerPath: string,
  campaignId?: string,
  campaignBudget?: CampaignCallBudget,
) {
  if (campaignId !== undefined)
    assertValidProviderVerificationCampaignId(campaignId);
  if (campaignId === undefined && campaignBudget !== undefined) {
    throw new Error("A provider-specific budget requires a campaign ID");
  }
  const lockPath = `${ledgerPath}.lock`;

  return {
    async getSmokeLedgerSnapshot(): Promise<SmokeLedger> {
      if (campaignId === undefined)
        return structuredClone(await readLedger(ledgerPath));
      return withCampaignLock(ledgerPath, async () =>
        structuredClone(
          await readOrInitializeCampaignLedger(
            ledgerPath,
            campaignId,
            campaignBudget,
          ),
        ),
      );
    },

    async reserveInferenceCall(provider: SmokeProvider): Promise<number> {
      const lockAction = async () => {
        const ledger =
          campaignId === undefined
            ? await readLedger(ledgerPath)
            : await readOrInitializeCampaignLedger(
                ledgerPath,
                campaignId,
                campaignBudget,
              );
        const entry = ledger.providers[provider];
        if (providerCallsUsed(entry) >= providerCallLimit(ledger, provider)) {
          throw new Error(
            `Inference call cap reached for ${provider} at ${providerCallLimit(ledger, provider)}; no call was made`,
          );
        }
        entry.reservedCalls += 1;
        entry.lastOutcome = "reserved_before_network_request";
        await writeLedger(ledgerPath, ledger, campaignId);
        return entry.reservedCalls;
      };
      return campaignId === undefined
        ? locked(lockPath, lockAction)
        : withCampaignLock(ledgerPath, lockAction);
    },

    async reserveInferenceCalls(
      provider: SmokeProvider,
      count: number,
    ): Promise<number> {
      if (!Number.isSafeInteger(count) || count < 1 || count > 110) {
        throw new Error("Provider call reservation count is invalid");
      }
      const lockAction = async () => {
        const ledger =
          campaignId === undefined
            ? await readLedger(ledgerPath)
            : await readOrInitializeCampaignLedger(
                ledgerPath,
                campaignId,
                campaignBudget,
              );
        const entry = ledger.providers[provider];
        const limit = providerCallLimit(ledger, provider);
        if (providerCallsUsed(entry) + count > limit) {
          throw new Error(
            `Inference call cap reached for ${provider} at ${limit}; ${count} calls required and no call was made`,
          );
        }
        entry.reservedCalls += count;
        entry.lastOutcome = "reserved_before_network_request";
        await writeLedger(ledgerPath, ledger, campaignId);
        return entry.reservedCalls;
      };
      return campaignId === undefined
        ? locked(lockPath, lockAction)
        : withCampaignLock(ledgerPath, lockAction);
    },

    async recordInferenceOutcome(
      provider: SmokeProvider,
      update: {
        outcome: SmokeOutcome;
        requestedModel?: string | null;
        responseModel?: string | null;
        usage?: ProviderLedgerEntry["usage"];
        capabilitiesObserved?: string[];
      },
    ): Promise<void> {
      const lockAction = async () => {
        const ledger =
          campaignId === undefined
            ? await readLedger(ledgerPath)
            : await readOrInitializeCampaignLedger(
                ledgerPath,
                campaignId,
                campaignBudget,
              );
        const entry = ledger.providers[provider];
        entry.lastOutcome = update.outcome;
        if (update.requestedModel !== undefined)
          entry.requestedModel = update.requestedModel;
        if (update.responseModel !== undefined)
          entry.responseModel = update.responseModel;
        if (update.usage !== undefined) entry.usage = update.usage;
        if (update.capabilitiesObserved !== undefined)
          entry.capabilitiesObserved = update.capabilitiesObserved;
        await writeLedger(ledgerPath, ledger, campaignId);
      };
      if (campaignId === undefined) {
        await locked(lockPath, lockAction);
      } else {
        await withCampaignLock(ledgerPath, lockAction);
      }
    },
  };
}

function createUnavailableProviderSmokeLedger(
  failure: unknown,
): ReturnType<typeof createProviderSmokeLedger> {
  const error =
    failure instanceof Error
      ? failure
      : new Error("Provider verification ledger is unavailable");
  return {
    async getSmokeLedgerSnapshot() {
      throw error;
    },
    async reserveInferenceCall(_provider) {
      void _provider;
      throw error;
    },
    async reserveInferenceCalls(_provider, _count) {
      void _provider;
      void _count;
      throw error;
    },
    async recordInferenceOutcome(_provider, _update) {
      void _provider;
      void _update;
      throw error;
    },
  };
}

function createPersistedProviderSmokeLedger(): ReturnType<
  typeof createProviderSmokeLedger
> {
  const campaignId = process.env[CAMPAIGN_ENVIRONMENT_VARIABLE]?.trim();
  if (!campaignId) {
    return createProviderSmokeLedger(resolveDefaultProviderSmokeLedgerPath());
  }
  try {
    const ledgerPath =
      resolveProviderVerificationCampaignLedgerPath(campaignId);
    return createProviderSmokeLedger(
      ledgerPath,
      campaignId,
      DEFAULT_PROVIDER_VERIFICATION_CAMPAIGN_BUDGET,
    );
  } catch (error) {
    return createUnavailableProviderSmokeLedger(error);
  }
}

const persistedLedger = createPersistedProviderSmokeLedger();

export const reserveInferenceCall = persistedLedger.reserveInferenceCall;
export const reserveInferenceCalls = persistedLedger.reserveInferenceCalls;
export const recordInferenceOutcome = persistedLedger.recordInferenceOutcome;
export const getSmokeLedgerSnapshot = persistedLedger.getSmokeLedgerSnapshot;
