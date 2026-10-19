import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import {
  assertValidProviderVerificationCampaignId,
  MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER,
  resolveProviderVerificationCampaignLedgerPath,
} from "../../packages/providers/src/provider-smoke-ledger.ts";
import { isControlledEvaluationConfigurationValid } from "../../packages/agent/src/controlled-evaluation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_ROOT = join(ROOT, "apps", "web");
const NODE_BINARY = "/home/lenovo/.nvm/versions/node/v22.23.2/bin/node";
const CAMPAIGN_ID = "v3-live-validation-20261017-a-01";
const CONTROLLED_EVALUATION_CASE_COUNT = 2;
const CONTROLLED_EVALUATION_ARM_COUNT = 3;
const CONTROLLED_EVALUATION_TARGET_CALLS =
  CONTROLLED_EVALUATION_CASE_COUNT * CONTROLLED_EVALUATION_ARM_COUNT * 2;
const CODEX_SMOKE_TARGET_CALLS = 1;
const CODEX_VERIFICATION_CALLS = 1;
const EXPECTED_CODEX_CAMPAIGN_CALLS =
  CONTROLLED_EVALUATION_TARGET_CALLS +
  CODEX_SMOKE_TARGET_CALLS +
  CODEX_VERIFICATION_CALLS;
const CAMPUS_VERIFICATION_CALLS = 1;
const MAX_GRAPH_BUILD_MODEL_CALLS = 2;
const MAX_NEW_CAMPUS_CALLS =
  CAMPUS_VERIFICATION_CALLS + MAX_GRAPH_BUILD_MODEL_CALLS;
const CODEX_CAMPAIGN_HEADROOM = 0;
const CAMPAIGN_REMAINING_BUDGET = {
  campus_gateway: MAX_NEW_CAMPUS_CALLS,
  codex_app_server: EXPECTED_CODEX_CAMPAIGN_CALLS + CODEX_CAMPAIGN_HEADROOM,
} as const;
const CAMPAIGN_LEDGER_RELATIVE_PATH = join(
  "docs",
  "provider-verification-campaigns",
  CAMPAIGN_ID + ".json",
);
const DEFAULT_SOURCE_DIST = ".next-flow2-live-validation-20261018-1030";
const SOURCE_DIST_ENV = "PROMPTLAB_V3_SOURCE_DIST";
const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";
const CODEX_MODEL = "gpt-6-luna";
const HARD_WALL_MS = 15 * 60_000;
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "paused_auth_required",
  "paused_provider_unavailable",
]);

interface SqlClient {
  connect(): Promise<void>;
  query<Row extends object = Record<string, unknown>>(
    query: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

interface RedisClient {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface HttpResult {
  status: number;
  payload: JsonRecord;
}

interface ChildSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}

interface ProviderLedgerSummary {
  reservedCalls: number;
  reconciledCalls: number;
  callsUsed: number;
  lastOutcome: string;
  requestedModel: string | null;
  responseModel: string | null;
  usage: string;
}

interface CampaignLedgerSummary {
  maxInferenceCallsByProvider: {
    campus_gateway: number;
    codex_app_server: number;
  };
  campus_gateway: ProviderLedgerSummary | null;
  codex_app_server: ProviderLedgerSummary | null;
}

interface ControlledEvaluationJourneySummary {
  runId: string | null;
  status: string | null;
  evidenceComplete: boolean;
  candidateVerificationPassed: boolean;
  experimentRegistered: boolean;
  evidenceEligible: boolean | null;
  expectedTargetCalls: number;
  persistedTargetUsageRecords: number;
  successfulTargetAnswers: number;
  verificationPassesByArm: Record<
    string,
    { baseline: number; candidate: number }
  >;
  candidateVerificationByPair: Array<{
    arm: string;
    caseId: string;
    baselineAnswerPreview: string | null;
    answerPreview: string | null;
    answerStatus: string | null;
    verificationStatus: string | null;
    reasonCode: string | null;
    expectedCount: string | null;
    expectedSum: string | null;
    actualCount: string | null;
    actualSum: string | null;
    errorCode: string | null;
  }>;
  graphSnapshotId: string | null;
  graphFallbacks: number;
  frozenSourceMatched: boolean;
  runAttempts: RunAttemptSummary[];
}

interface RunAttemptSummary {
  provider: string;
  purpose: string;
  requestedModel: string;
  responseModel: string | null;
  status: string;
  remoteOutcomeKnown: boolean;
}

interface UsageSummary {
  provider: string;
  purpose: string;
  usageScope: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  provenance: string;
  completeness: string;
  mapperVersion: string | null;
}

interface WorkerQueueCounts {
  wait: number;
  active: number;
  delayed: number;
  paused: number;
  waitingChildren: number;
  prioritized: number;
  completed: number;
  failed: number;
}

class JourneyStop extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    readonly blocked = true,
  ) {
    super(code);
    this.name = "JourneyStop";
  }
}

function stop(code: string, stage: string, blocked = true): never {
  throw new JourneyStop(code, stage, blocked);
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function assertRuntime(): void {
  if (
    process.versions.node !== "22.23.2" ||
    resolve(process.execPath) !== resolve(NODE_BINARY)
  ) {
    stop("native_node_22_23_2_required", "runtime_preflight");
  }
}

function selectedSourceDist(): string {
  const configured = process.env[SOURCE_DIST_ENV];
  const requested =
    configured === undefined ? DEFAULT_SOURCE_DIST : configured.trim();
  if (!requested) stop("source_dist_empty", "artifact_preflight");

  const sourceDist = resolve(WEB_ROOT, requested);
  const relativeDist = relative(WEB_ROOT, sourceDist);
  if (
    !relativeDist ||
    relativeDist === ".." ||
    relativeDist.startsWith(".." + sep) ||
    isAbsolute(relativeDist) ||
    dirname(relativeDist) !== "."
  ) {
    stop("source_dist_must_be_direct_apps_web_child", "artifact_preflight");
  }
  if (!/^\.next-[a-z0-9][a-z0-9-]*$/u.test(basename(sourceDist))) {
    stop("source_dist_must_be_dedicated_build", "artifact_preflight");
  }

  let stats;
  try {
    stats = lstatSync(sourceDist);
  } catch {
    stop("production_artifact_missing", "artifact_preflight");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    stop("production_artifact_not_real_directory", "artifact_preflight");
  }

  const buildIdPath = join(sourceDist, "BUILD_ID");
  const manifestPath = join(sourceDist, "required-server-files.json");
  const routeBundlePath = join(
    sourceDist,
    "server",
    "app",
    "api",
    "providers",
    "route.js",
  );
  if (
    !existsSync(buildIdPath) ||
    !existsSync(manifestPath) ||
    !existsSync(routeBundlePath)
  ) {
    stop("production_artifact_incomplete", "artifact_preflight");
  }
  const buildId = readFileSync(buildIdPath, "utf8").trim();
  if (!buildId)
    stop("production_artifact_build_id_empty", "artifact_preflight");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    config?: { distDir?: string };
  };
  if (manifest.config?.distDir !== basename(sourceDist)) {
    stop("production_artifact_dist_dir_mismatch", "artifact_preflight");
  }
  const providerBundle = readFileSync(routeBundlePath, "utf8");
  if (!providerBundle.includes("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN")) {
    stop("production_artifact_missing_campaign_verifier", "artifact_preflight");
  }
  return sourceDist;
}

function campaignLedgerPath(): string {
  try {
    assertValidProviderVerificationCampaignId(CAMPAIGN_ID);
  } catch {
    stop("invalid_campaign_id", "campaign_preflight");
  }

  const canonicalRoot = realpathSync(ROOT);
  const path = resolveProviderVerificationCampaignLedgerPath(
    CAMPAIGN_ID,
    canonicalRoot,
  );
  const expectedPath = join(canonicalRoot, CAMPAIGN_LEDGER_RELATIVE_PATH);
  if (
    path !== expectedPath ||
    dirname(path) !==
      join(canonicalRoot, "docs", "provider-verification-campaigns")
  ) {
    stop("campaign_ledger_not_under_canonical_project", "campaign_preflight");
  }
  const ledgerExists = existsSync(path);
  const markerPath = path + ".initialized";
  const markerExists = existsSync(markerPath);
  if (ledgerExists !== markerExists) {
    stop("campaign_initialization_state_inconsistent", "campaign_preflight");
  }
  if (!ledgerExists) {
    stop("campaign_resume_ledger_required", "campaign_preflight");
  }
  if (readFileSync(markerPath, "utf8") !== `${CAMPAIGN_ID}\n`) {
    stop("campaign_initialization_marker_invalid", "campaign_preflight");
  }
  const ledger = readCampaignLedger(path);
  if (!ledger) stop("campaign_ledger_unavailable", "campaign_preflight");
  for (const provider of ["campus_gateway", "codex_app_server"] as const) {
    const entry = ledger[provider];
    const remaining =
      ledger.maxInferenceCallsByProvider[provider] - (entry?.callsUsed ?? 0);
    if (remaining < CAMPAIGN_REMAINING_BUDGET[provider]) {
      stop("campaign_remaining_budget_mismatch", "campaign_preflight");
    }
  }
  return path;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyBuildToPrivateDist(
  sourceDist: string,
  privateDist: string,
): string {
  const buildIdPath = join(sourceDist, "BUILD_ID");
  const manifestPath = join(sourceDist, "required-server-files.json");
  const expectedBuildId = readFileSync(buildIdPath, "utf8").trim();
  const expectedManifestHash = sha256(manifestPath);

  cpSync(sourceDist, privateDist, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });

  if (
    readFileSync(join(privateDist, "BUILD_ID"), "utf8").trim() !==
      expectedBuildId ||
    sha256(join(privateDist, "required-server-files.json")) !==
      expectedManifestHash
  ) {
    stop("private_build_copy_integrity_failed", "artifact_isolation");
  }
  return expectedBuildId;
}

function executableSearchPath(originalHome: string): string[] {
  return [
    dirname(NODE_BINARY),
    join(originalHome, ".local", "bin"),
    join(originalHome, "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

function findExecutable(name: string, directories: string[]): string {
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      const resolvedPath = realpathSync(candidate);
      const stats = lstatSync(resolvedPath);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.mode & 0o111) {
        return resolvedPath;
      }
    } catch {
      // Continue through the fixed, clean executable search path.
    }
  }
  stop("required_executable_unavailable", "runtime_preflight");
}

function copyPrivateDirectory(source: string, destination: string): void {
  let sourceStats;
  try {
    sourceStats = lstatSync(source);
  } catch {
    stop("dedicated_codex_auth_home_missing", "codex_auth_preflight");
  }
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    stop(
      "dedicated_codex_auth_home_not_private_directory",
      "codex_auth_preflight",
    );
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  for (const name of readdirSync(source)) {
    const sourceEntry = join(source, name);
    const destinationEntry = join(destination, name);
    const entryStats = lstatSync(sourceEntry);
    if (entryStats.isSymbolicLink()) {
      stop(
        "dedicated_codex_auth_home_contains_symlink",
        "codex_auth_preflight",
      );
    }
    if (entryStats.isDirectory()) {
      copyPrivateDirectory(sourceEntry, destinationEntry);
    } else if (entryStats.isFile()) {
      copyFileSync(sourceEntry, destinationEntry);
      chmodSync(destinationEntry, 0o600);
    } else {
      stop(
        "dedicated_codex_auth_home_contains_special_file",
        "codex_auth_preflight",
      );
    }
  }
}

function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "\r")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

function campusCredentialSubset(): { apiKey: string; requestedModel: string } {
  const wanted = new Set([
    "PROMPTLAB_CAMPUS_API_KEY",
    "PROMPTLAB_CAMPUS_MODEL",
  ]);
  const parsed = new Map<string, string>();
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
      const match = line.match(
        /^\s*(PROMPTLAB_CAMPUS_API_KEY|PROMPTLAB_CAMPUS_MODEL)\s*=\s*(.*?)\s*$/u,
      );
      if (match && wanted.has(match[1] ?? "")) {
        parsed.set(match[1] ?? "", parseDotEnvValue(match[2] ?? ""));
      }
    }
  }
  const apiKey =
    process.env.PROMPTLAB_CAMPUS_API_KEY?.trim() ||
    parsed.get("PROMPTLAB_CAMPUS_API_KEY")?.trim() ||
    "";
  const requestedModel =
    process.env.PROMPTLAB_CAMPUS_MODEL?.trim() ||
    parsed.get("PROMPTLAB_CAMPUS_MODEL")?.trim() ||
    "";
  if (!apiKey || !requestedModel) {
    stop("campus_credential_or_model_unavailable", "provider_preflight");
  }
  return { apiKey, requestedModel };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  maxBuffer = 2_000_000,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    stop("isolated_subprocess_failed", "isolation_setup");
  }
  return result.stdout.trim();
}

function chooseLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("loopback_port_unavailable"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function dockerArgs(configDir: string, args: string[]): string[] {
  return ["--config", configDir, ...args];
}

async function waitForPostgres(
  port: number,
  user: string,
  database: string,
): Promise<void> {
  const { Client } = createRequire(
    join(ROOT, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({
      host: "127.0.0.1",
      port,
      user,
      database,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await sleep(400);
    }
  }
  stop("isolated_postgres_not_ready", "database_start");
}

async function waitForRedis(url: string): Promise<void> {
  const Redis = createRequire(join(ROOT, "apps", "worker", "package.json"))(
    "ioredis",
  ) as new (url: string, options: Record<string, unknown>) => RedisClient;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new Redis(url, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      if ((await client.ping()) === "PONG") {
        await client.quit();
        return;
      }
    } catch {
      await client.quit().catch(() => undefined);
    }
    await sleep(300);
  }
  stop("isolated_redis_not_ready", "redis_start");
}

async function applyMigrations(
  databaseUrl: string,
  home: string,
  pathValue: string,
): Promise<void> {
  runCommand(
    process.execPath,
    ["--import", "tsx/esm", "packages/db/src/migrate.ts"],
    ROOT,
    {
      PATH: pathValue,
      HOME: home,
      LANG: "C.UTF-8",
      PROMPTLAB_DATABASE_URL: databaseUrl,
    },
  );
}

function startChild(spec: ChildSpec): ChildProcess {
  const fd = openSync(spec.logPath, "a", 0o600);
  try {
    return spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    sleep(5_000),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      ),
      sleep(2_000),
    ]);
  }
}

interface JourneyState {
  stage: string;
  sourceDist: string | null;
  buildId: string | null;
  campaignPath: string | null;
  tempRoot: string | null;
  privateDist: string | null;
  dockerConfig: string | null;
  postgresContainer: string | null;
  redisContainer: string | null;
  dockerReady: boolean;
  server: ChildProcess | null;
  serverLogPath: string | null;
  serverLogTail: string[];
  serverExitCode: number | null;
  serverExitSignal: string | null;
  serverSpawnError: string | null;
  lastReadinessFailure: string | null;
  lastReadinessStatus: number | null;
  worker: ChildProcess | null;
  workerLogPath: string | null;
  home: string | null;
  dbUrl: string | null;
  redisUrl: string | null;
  baseUrl: string | null;
  appHttpRequests: number;
  appHttpRequestsByLabel: Map<string, number>;
  providerVerificationsAttempted: {
    campus_gateway: number;
    codex_app_server: number;
  };
  providerVerificationResults: {
    campus_gateway: { status: number | null; outcome: string | null };
    codex_app_server: { status: number | null; outcome: string | null };
  };
  targetRunPosts: number;
  workerQueueCounts: WorkerQueueCounts | null;
  workerPendingJobsObserved: number;
  remoteOutcomeUncertain: boolean;
  firstInferenceAt: number | null;
  hardDeadlineAt: number | null;
  campaignLedger: CampaignLedgerSummary | null;
  campaignLedgerBefore: CampaignLedgerSummary | null;
  runId: string | null;
  runStatus: string | null;
  requestedModel: string | null;
  responseModel: string | null;
  completionValidator: {
    expected: "non-empty output persisted identically";
    observedCharacters: number;
    databaseObservedCharacters: number;
    outputPresent: boolean;
    streamDatabaseMatch: boolean;
    passed: boolean;
  } | null;
  controlledEvaluationFailure: {
    status: string;
    errorCode: string | null;
    errorSummary: string | null;
    attemptStatus: string | null;
    attemptErrorCode: string | null;
  } | null;
  attempts: RunAttemptSummary[];
  usage: UsageSummary[];
  runEventTypes: string[];
  monitoring: {
    summaryStatus: number | null;
    summaryRequests: number | null;
    requestLogStatus: number | null;
    requestLogRows: number | null;
  };
  graphBuild: {
    buildId: string | null;
    runId: string | null;
    state: string | null;
    snapshotId: string | null;
    sourceChunks: number | null;
    entityCount: number | null;
    assertionCount: number | null;
    supportedAssertionCount: number | null;
    needsReviewCount: number | null;
    rejectedAssertionCount: number | null;
    maxModelCalls: number | null;
    callsUsed: number | null;
    spanCorrections: { entities: number; relations: number } | null;
    activeState: string | null;
    activeCurrent: boolean | null;
    activeManifestEntries: number | null;
    activeSourceDocumentMatched: boolean | null;
    activeSourceVersionIdMatched: boolean | null;
    activeSourceVersionMatched: boolean | null;
    activeSourceChecksumMatched: boolean | null;
    activeSnapshotSourceMatched: boolean | null;
    buildCallBudgetValid: boolean | null;
    failedChunks: Array<{ chunkId: string; reason: string }>;
    runErrorCode: string | null;
    activeSnapshotCurrent: boolean;
    sourceManifestMatched: boolean;
  };
  controlledEvaluation: ControlledEvaluationJourneySummary | null;
  graphEvaluationPreflight: Array<{
    caseId: string;
    selectedSourceIds: string[];
    matchedSourceIds: string[];
    strategyUsed: string | null;
    fallbackReason: string | null;
    selectedSnapshotMatched: boolean;
    evidenceCount: number;
    graphPathCount: number;
    seedLabels: string[];
    lexicalHits: number | null;
    graphScanClipped: boolean | null;
    invalidQuoteCount: number | null;
  }>;
  lexicalEvaluationPreflight: Array<{
    caseId: string;
    httpStatus: number;
    status: "passed" | "failed";
    errorCode: string | null;
    selectedSourceIds: string[];
    matchedSourceIds: string[];
    corpusEvidenceCount: number;
    strategyUsed: string | null;
    fallbackReason: string | null;
    evidenceCount: number;
    sourceEvidenceCount: number;
    lexicalHits: number | null;
    passed: boolean;
  }>;
  cleanupChecks: {
    ownedContainersAbsent: boolean;
    privateBuildRemoved: boolean;
    temporaryRootRemoved: boolean;
  };
  cleanupFailures: string[];
}

function createJourneyState(): JourneyState {
  return {
    stage: "initializing",
    sourceDist: null,
    buildId: null,
    campaignPath: null,
    tempRoot: null,
    privateDist: null,
    dockerConfig: null,
    postgresContainer: null,
    redisContainer: null,
    dockerReady: false,
    server: null,
    serverLogPath: null,
    serverLogTail: [],
    serverExitCode: null,
    serverExitSignal: null,
    serverSpawnError: null,
    lastReadinessFailure: null,
    lastReadinessStatus: null,
    worker: null,
    workerLogPath: null,
    home: null,
    dbUrl: null,
    redisUrl: null,
    baseUrl: null,
    appHttpRequests: 0,
    appHttpRequestsByLabel: new Map(),
    providerVerificationsAttempted: {
      campus_gateway: 0,
      codex_app_server: 0,
    },
    providerVerificationResults: {
      campus_gateway: { status: null, outcome: null },
      codex_app_server: { status: null, outcome: null },
    },
    targetRunPosts: 0,
    workerQueueCounts: null,
    workerPendingJobsObserved: 0,
    remoteOutcomeUncertain: false,
    firstInferenceAt: null,
    hardDeadlineAt: null,
    campaignLedger: null,
    campaignLedgerBefore: null,
    runId: null,
    runStatus: null,
    requestedModel: null,
    responseModel: null,
    completionValidator: null,
    controlledEvaluationFailure: null,
    attempts: [],
    usage: [],
    runEventTypes: [],
    monitoring: {
      summaryStatus: null,
      summaryRequests: null,
      requestLogStatus: null,
      requestLogRows: null,
    },
    graphBuild: {
      buildId: null,
      runId: null,
      state: null,
      snapshotId: null,
      sourceChunks: null,
      entityCount: null,
      assertionCount: null,
      supportedAssertionCount: null,
      needsReviewCount: null,
      rejectedAssertionCount: null,
      maxModelCalls: null,
      callsUsed: null,
      spanCorrections: null,
      activeState: null,
      activeCurrent: null,
      activeManifestEntries: null,
      activeSourceDocumentMatched: null,
      activeSourceVersionIdMatched: null,
      activeSourceVersionMatched: null,
      activeSourceChecksumMatched: null,
      activeSnapshotSourceMatched: null,
      buildCallBudgetValid: null,
      failedChunks: [],
      runErrorCode: null,
      activeSnapshotCurrent: false,
      sourceManifestMatched: false,
    },
    controlledEvaluation: null,
    graphEvaluationPreflight: [],
    lexicalEvaluationPreflight: [],
    cleanupChecks: {
      ownedContainersAbsent: false,
      privateBuildRemoved: false,
      temporaryRootRemoved: false,
    },
    cleanupFailures: [],
  };
}

function controlledEvaluationCases() {
  return [
    {
      id: "development-alpha",
      split: "development",
      input:
        "Hitung bilangan bulat genap dari 1 sampai 10, termasuk kedua batas. Berikan count dan sum.",
      label: "Development: inclusive range 1 through 10.",
      verification: {
        kind: "divisibility",
        startInclusive: 1,
        endInclusive: 10,
        includeDivisors: [2],
        excludeDivisors: [],
        expected: { count: "5", sum: "30" },
      },
    },
    {
      id: "holdout-omega",
      split: "holdout",
      input:
        "Hitung bilangan bulat genap dari 11 sampai 20, termasuk kedua batas. Berikan count dan sum.",
      label: "Holdout: inclusive range 11 through 20.",
      verification: {
        kind: "divisibility",
        startInclusive: 11,
        endInclusive: 20,
        includeDivisors: [2],
        excludeDivisors: [],
        expected: { count: "5", sum: "80" },
      },
    },
  ];
}

async function requestJson(
  label: string,
  url: URL,
  init: RequestInit,
  state: JourneyState,
  options: {
    timeoutMs?: number;
    inferenceRequest?: "campus_gateway" | "codex_app_server" | "target";
  } = {},
): Promise<HttpResult> {
  if (
    state.firstInferenceAt !== null &&
    state.hardDeadlineAt !== null &&
    Date.now() >= state.hardDeadlineAt
  ) {
    stop("five_minute_inference_wall_reached", label);
  }
  state.appHttpRequests += 1;
  state.appHttpRequestsByLabel.set(
    label,
    (state.appHttpRequestsByLabel.get(label) ?? 0) + 1,
  );
  if (options.inferenceRequest === "campus_gateway") {
    state.providerVerificationsAttempted.campus_gateway += 1;
  } else if (options.inferenceRequest === "codex_app_server") {
    state.providerVerificationsAttempted.codex_app_server += 1;
  } else if (options.inferenceRequest === "target") {
    state.targetRunPosts += 1;
  }
  const remaining =
    state.hardDeadlineAt === null
      ? (options.timeoutMs ?? 15_000)
      : Math.max(
          1,
          Math.min(
            options.timeoutMs ?? HARD_WALL_MS,
            state.hardDeadlineAt - Date.now(),
          ),
        );
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(remaining),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      stop("app_http_non_json_response", label, false);
    }
    const parsed = record(payload);
    if (!parsed) stop("app_http_invalid_json_shape", label, false);
    return { status: response.status, payload: parsed };
  } catch (error) {
    if (options.inferenceRequest) state.remoteOutcomeUncertain = true;
    if (error instanceof JourneyStop) throw error;
    stop("app_http_request_failed", label, false);
  }
}

function assertHttpStatus(
  result: HttpResult,
  expectedStatus: number,
  stage: string,
): void {
  if (result.status !== expectedStatus) {
    stop("unexpected_app_http_status_" + result.status, stage, false);
  }
}

function providerOutcome(payload: JsonRecord): string | null {
  return textValue(payload.outcome);
}

function readCampaignLedger(path: string): JourneyState["campaignLedger"] {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    stop("campaign_ledger_corrupt", "campaign_audit");
  }
  const ledger = record(parsed);
  if (!ledger || ledger.campaignId !== CAMPAIGN_ID) {
    stop("campaign_ledger_metadata_invalid", "campaign_audit");
  }
  const limits = record(ledger.maxInferenceCallsByProvider);
  if (!limits) stop("campaign_ledger_budget_invalid", "campaign_audit");
  const maxInferenceCallsByProvider = {
    campus_gateway: integerValue(limits.campus_gateway),
    codex_app_server: integerValue(limits.codex_app_server),
  };
  if (
    !maxInferenceCallsByProvider.campus_gateway ||
    !maxInferenceCallsByProvider.codex_app_server ||
    maxInferenceCallsByProvider.campus_gateway >
      MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER ||
    maxInferenceCallsByProvider.codex_app_server >
      MAX_CAMPAIGN_INFERENCE_CALLS_PER_PROVIDER
  ) {
    stop("campaign_ledger_budget_invalid", "campaign_audit");
  }
  const providers = record(ledger.providers);
  if (!providers) stop("campaign_ledger_shape_invalid", "campaign_audit");

  const summaryFor = (
    provider: "campus_gateway" | "codex_app_server",
  ): ProviderLedgerSummary | null => {
    const entry = record(providers[provider]);
    if (!entry) return null;
    const reservedCalls = integerValue(entry.reservedCalls) ?? 0;
    const reconciledCalls = integerValue(entry.reconciledCalls) ?? 0;
    return {
      reservedCalls,
      reconciledCalls,
      callsUsed: reservedCalls + reconciledCalls,
      lastOutcome: textValue(entry.lastOutcome) ?? "unknown",
      requestedModel: textValue(entry.requestedModel),
      responseModel: textValue(entry.responseModel),
      usage: textValue(entry.usage) ?? "unknown",
    };
  };
  return {
    maxInferenceCallsByProvider: {
      campus_gateway: maxInferenceCallsByProvider.campus_gateway!,
      codex_app_server: maxInferenceCallsByProvider.codex_app_server!,
    },
    campus_gateway: summaryFor("campus_gateway"),
    codex_app_server: summaryFor("codex_app_server"),
  };
}

function decodeSseBlock(block: string): {
  event: string | null;
  data: string | null;
} {
  const lines = block.split(/\r?\n/u);
  return {
    event:
      lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() ?? null,
    data:
      lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n") || null,
  };
}

function eventPayload(data: string | null): JsonRecord | null {
  if (!data) return null;
  try {
    return record(JSON.parse(data) as unknown);
  } catch {
    return null;
  }
}

function outputTextFromEvent(
  eventName: string | null,
  payload: JsonRecord | null,
): string | null {
  if (!eventName || !payload) return null;
  const eventBody = record(payload.payload) ?? payload;
  if (eventName === "output.delta" || eventName.endsWith(".delta")) {
    return textValue(eventBody.text) ?? textValue(eventBody.delta);
  }
  if (eventName === "run.completed") {
    return textValue(eventBody.text) ?? textValue(eventBody.output);
  }
  return null;
}

async function readRunEvents(
  state: JourneyState,
  projectId: string,
  runId: string,
): Promise<string> {
  const baseUrl = state.baseUrl;
  if (!baseUrl) stop("app_url_unavailable", "run_events");
  const url = new URL(
    "/api/projects/" + projectId + "/runs/" + runId + "/events?after=0",
    baseUrl,
  );
  state.appHttpRequests += 1;
  state.appHttpRequestsByLabel.set(
    "run_events_sse",
    (state.appHttpRequestsByLabel.get("run_events_sse") ?? 0) + 1,
  );
  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    stop("run_events_request_failed", "run_events", false);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    stop("run_events_http_status_" + response.status, "run_events", false);
  }
  if (!response.body) stop("run_events_body_missing", "run_events", false);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let outputDeltas = "";
  let completedOutput: string | null = null;
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("run_events_read_timeout")),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.trim()) continue;
        const decoded = decodeSseBlock(block);
        if (decoded.event) state.runEventTypes.push(decoded.event);
        const payload = eventPayload(decoded.data);
        const eventOutput = outputTextFromEvent(decoded.event, payload);
        if (
          decoded.event === "output.delta" ||
          decoded.event?.endsWith(".delta")
        ) {
          outputDeltas += eventOutput ?? "";
        }
        if (decoded.event === "run.completed") {
          completedOutput = eventOutput;
          return completedOutput ?? outputDeltas;
        }
        if (
          decoded.event === "run.status" &&
          TERMINAL_RUN_STATUSES.has(textValue(payload?.status) ?? "")
        ) {
          // Continue until the persisted completion event carries the final text.
        }
      }
    }
  } catch {
    // The isolated database read below remains authoritative for terminal state.
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  if (pending.trim()) {
    const decoded = decodeSseBlock(pending);
    if (decoded.event) state.runEventTypes.push(decoded.event);
    const eventOutput = outputTextFromEvent(
      decoded.event,
      eventPayload(decoded.data),
    );
    if (decoded.event === "run.completed") completedOutput = eventOutput;
    else if (
      decoded.event === "output.delta" ||
      decoded.event?.endsWith(".delta")
    ) {
      outputDeltas += eventOutput ?? "";
    }
  }
  return completedOutput ?? outputDeltas;
}

async function waitForServer(
  baseUrl: string,
  state: JourneyState,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (
      state.server?.exitCode !== null &&
      state.server?.exitCode !== undefined
    ) {
      state.serverExitCode = state.server.exitCode;
      state.serverExitSignal = state.server.signalCode;
      stop("isolated_next_server_exited", "app_start");
    }
    try {
      const result = await requestJson(
        "readiness_health",
        new URL("/api/health", baseUrl),
        { method: "GET" },
        state,
        { timeoutMs: 3_000 },
      );
      state.lastReadinessStatus = result.status;
      if (result.status === 200) {
        state.lastReadinessFailure = null;
        return;
      }
    } catch (error) {
      state.lastReadinessFailure =
        error instanceof JourneyStop ? error.code : "readiness_request_failed";
      // Only loopback readiness requests are retried before any provider call.
    }
    await sleep(350);
  }
  stop("isolated_next_server_not_ready", "app_start");
}

async function waitForRun(
  state: JourneyState,
  projectId: string,
  idempotencyKey: string,
): Promise<{ runId: string; status: string }> {
  const baseUrl = state.baseUrl;
  if (!baseUrl || !state.hardDeadlineAt) {
    stop("run_poll_precondition_failed", "run_poll");
  }
  let lastStatus = "queued";
  while (Date.now() < state.hardDeadlineAt) {
    const url = new URL(
      "/api/projects/" +
        projectId +
        "/runs?idempotencyKey=" +
        encodeURIComponent(idempotencyKey),
      baseUrl,
    );
    const result = await requestJson(
      "run_status_poll",
      url,
      { method: "GET" },
      state,
      { timeoutMs: 5_000 },
    );
    assertHttpStatus(result, 200, "run_poll");
    const run = record(result.payload.run);
    const status = textValue(run?.status);
    const runId = textValue(run?.id);
    if (!status || !runId) stop("run_poll_response_invalid", "run_poll");
    lastStatus = status;
    if (TERMINAL_RUN_STATUSES.has(status)) return { runId, status };
    await sleep(500);
  }
  state.remoteOutcomeUncertain = true;
  state.runStatus = lastStatus;
  stop("target_run_not_terminal_before_hard_wall", "run_poll", false);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function loadRunAudit(
  state: JourneyState,
  databaseUrl: string,
  projectId: string,
  runId: string,
): Promise<void> {
  const { Client } = createRequire(
    join(ROOT, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const runResult = await client.query<{
      status: string;
      requested_model: string;
      response_model: string | null;
    }>(
      "SELECT status, requested_model, response_model " +
        "FROM public.runs WHERE project_id = $1 AND id = $2",
      [projectId, runId],
    );
    const run = runResult.rows[0];
    if (run) {
      state.runStatus = run.status;
      state.requestedModel = run.requested_model;
      state.responseModel = run.response_model;
    }

    const attemptResult = await client.query<{
      provider: string;
      purpose: string;
      requested_model: string;
      response_model: string | null;
      status: string;
      remote_outcome_known: boolean;
    }>(
      "SELECT provider, purpose, requested_model, response_model, status, " +
        "remote_outcome_known FROM public.model_attempts " +
        "WHERE project_id = $1 AND run_id = $2 ORDER BY attempt_number ASC",
      [projectId, runId],
    );
    state.attempts = attemptResult.rows.map((row) => ({
      provider: row.provider,
      purpose: row.purpose,
      requestedModel: row.requested_model,
      responseModel: row.response_model,
      status: row.status,
      remoteOutcomeKnown: row.remote_outcome_known,
    }));

    const usageResult = await client.query<{
      provider: string;
      purpose: string;
      usage_scope: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      cache_write_tokens: number | null;
      provenance: string;
      completeness: string;
      mapper_version: string | null;
    }>(
      "SELECT provider, purpose, usage_scope, input_tokens, output_tokens, " +
        "cache_read_tokens, cache_write_tokens, provenance, completeness, " +
        "mapper_version FROM public.usage_records " +
        "WHERE project_id = $1 AND run_id = $2 ORDER BY observed_at ASC",
      [projectId, runId],
    );
    state.usage = usageResult.rows.map((row) => ({
      provider: row.provider,
      purpose: row.purpose,
      usageScope: row.usage_scope,
      inputTokens: numberOrNull(row.input_tokens),
      outputTokens: numberOrNull(row.output_tokens),
      cacheReadTokens: numberOrNull(row.cache_read_tokens),
      cacheWriteTokens: numberOrNull(row.cache_write_tokens),
      provenance: row.provenance,
      completeness: row.completeness,
      mapperVersion: row.mapper_version,
    }));

    const eventResult = await client.query<{ event_type: string }>(
      "SELECT event_type FROM public.run_events " +
        "WHERE project_id = $1 AND run_id = $2 ORDER BY sequence ASC",
      [projectId, runId],
    );
    state.runEventTypes = [
      ...new Set([
        ...state.runEventTypes,
        ...eventResult.rows.map((row) => row.event_type),
      ]),
    ];
  } finally {
    await client.end();
  }
}

async function readRunEventOutputFromDatabase(
  databaseUrl: string,
  projectId: string,
  runId: string,
): Promise<string> {
  const { Client } = createRequire(
    join(ROOT, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const result = await client.query<{
      event_type: string;
      payload: unknown;
    }>(
      "SELECT event_type, payload FROM public.run_events " +
        "WHERE project_id = $1 AND run_id = $2 ORDER BY sequence ASC",
      [projectId, runId],
    );
    const completion = result.rows
      .filter((row) => row.event_type === "run.completed")
      .map((row) => record(row.payload))
      .at(-1);
    const completionText =
      textValue(completion?.text) ?? textValue(completion?.output);
    if (completionText !== null) return completionText;
    return result.rows
      .filter((row) => row.event_type === "output.delta")
      .map((row) => {
        const payload = record(row.payload);
        return textValue(payload?.text) ?? textValue(payload?.delta) ?? "";
      })
      .join("");
  } finally {
    await client.end();
  }
}

async function readControlledEvaluationFailure(
  databaseUrl: string,
  projectId: string,
  runId: string,
): Promise<NonNullable<JourneyState["controlledEvaluationFailure"]> | null> {
  const { Client } = createRequire(
    join(ROOT, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const result = await client.query<{
      status: string;
      errorCode: string | null;
      errorSummary: string | null;
      attemptStatus: string | null;
      attemptErrorCode: string | null;
    }>(
      'SELECT r.status, r.error_code AS "errorCode", ' +
        'r.error_summary AS "errorSummary", ' +
        'a.status AS "attemptStatus", ' +
        'a.error_code AS "attemptErrorCode" ' +
        "FROM public.runs r LEFT JOIN LATERAL (" +
        "SELECT status, error_code FROM public.model_attempts " +
        "WHERE project_id = r.project_id AND run_id = r.id " +
        "ORDER BY attempt_number DESC LIMIT 1" +
        ") a ON true WHERE r.project_id = $1 AND r.id = $2",
      [projectId, runId],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

interface ControlledEvaluationDatabaseAudit {
  runStatus: string | null;
  requestedModel: string | null;
  responseModel: string | null;
  attempts: RunAttemptSummary[];
  targetUsageRecords: number;
  targetRequestTraces: number;
  targetResponseTraces: number;
  eventTypes: string[];
  completionPayload: JsonRecord | null;
}

async function loadControlledEvaluationDatabaseAudit(
  databaseUrl: string,
  projectId: string,
  runId: string,
): Promise<ControlledEvaluationDatabaseAudit> {
  const { Client } = createRequire(
    join(ROOT, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const runResult = await client.query<{
      status: string;
      requested_model: string;
      response_model: string | null;
    }>(
      "SELECT status, requested_model, response_model " +
        "FROM public.runs WHERE project_id = $1 AND id = $2",
      [projectId, runId],
    );
    const attemptResult = await client.query<{
      provider: string;
      purpose: string;
      requested_model: string;
      response_model: string | null;
      status: string;
      remote_outcome_known: boolean;
    }>(
      "SELECT provider, purpose, requested_model, response_model, status, " +
        "remote_outcome_known FROM public.model_attempts " +
        "WHERE project_id = $1 AND run_id = $2 ORDER BY attempt_number ASC",
      [projectId, runId],
    );
    const usageResult = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.usage_records " +
        "WHERE project_id = $1 AND run_id = $2 " +
        "AND provider = 'codex_app_server' AND purpose = 'target'",
      [projectId, runId],
    );
    const traceResult = await client.query<{
      event_type: string;
      payload: unknown;
    }>(
      "SELECT event_type, payload FROM public.run_events " +
        "WHERE project_id = $1 AND run_id = $2 ORDER BY sequence ASC",
      [projectId, runId],
    );
    const tracePayloads = traceResult.rows
      .filter((row) => row.event_type === "agent.action")
      .map((row) => record(row.payload))
      .filter((payload): payload is JsonRecord => payload !== null)
      .filter((payload) => payload.mode === "controlled_evaluation");
    const completions = traceResult.rows.filter(
      (row) => row.event_type === "run.completed",
    );
    const completionPayload = record(completions.at(-1)?.payload);
    const run = runResult.rows[0];
    return {
      runStatus: run?.status ?? null,
      requestedModel: run?.requested_model ?? null,
      responseModel: run?.response_model ?? null,
      attempts: attemptResult.rows.map((row) => ({
        provider: row.provider,
        purpose: row.purpose,
        requestedModel: row.requested_model,
        responseModel: row.response_model,
        status: row.status,
        remoteOutcomeKnown: row.remote_outcome_known,
      })),
      targetUsageRecords: integerValue(usageResult.rows[0]?.count) ?? 0,
      targetRequestTraces: tracePayloads.filter(
        (payload) => payload.phase === "target_request_started",
      ).length,
      targetResponseTraces: tracePayloads.filter(
        (payload) => payload.phase === "target_response_recorded",
      ).length,
      eventTypes: [...new Set(traceResult.rows.map((row) => row.event_type))],
      completionPayload,
    };
  } finally {
    await client.end();
  }
}

function summarizeControlledEvaluation(
  reportValue: unknown,
  input: {
    runId: string;
    databaseAudit: ControlledEvaluationDatabaseAudit;
    graphSources: SyntheticSourceVersion[];
    ragSources: SyntheticSourceVersion[];
    graphSnapshotId: string;
  },
): ControlledEvaluationJourneySummary {
  const report = record(reportValue);
  const manifest = record(report?.manifest);
  const rawPairs = Array.isArray(report?.pairs) ? report.pairs : [];
  const pairs = rawPairs.map((value) => record(value));
  const expectedArms = new Set(["original", "rag", "graphrag"]);
  const expectedCases = new Map([
    ["development-alpha", "development"],
    ["holdout-omega", "holdout"],
  ]);
  const seenPairs = new Set<string>();
  let successfulTargetAnswers = 0;
  let graphFallbacks = 0;
  const candidateVerificationByPair: ControlledEvaluationJourneySummary["candidateVerificationByPair"] =
    [];
  const verificationPassesByArm: Record<
    string,
    { baseline: number; candidate: number }
  > = {
    original: { baseline: 0, candidate: 0 },
    rag: { baseline: 0, candidate: 0 },
    graphrag: { baseline: 0, candidate: 0 },
  };

  for (const pair of pairs) {
    if (!pair) continue;
    const arm = textValue(pair.arm);
    const caseId = textValue(pair.caseId);
    const split = textValue(pair.split);
    if (
      !arm ||
      !caseId ||
      !expectedArms.has(arm) ||
      expectedCases.get(caseId) !== split
    ) {
      continue;
    }
    seenPairs.add(`${arm}:${caseId}`);
    for (const subject of ["baseline", "candidate"] as const) {
      const answer = record(pair[subject]);
      if (subject === "candidate") {
        const evidence = record(answer?.verificationEvidence);
        const expected = record(evidence?.expected);
        const actual = record(evidence?.actual);
        const baselineAnswer = record(pair.baseline);
        candidateVerificationByPair.push({
          arm,
          caseId,
          baselineAnswerPreview:
            textValue(baselineAnswer?.text)?.slice(0, 300) ?? null,
          answerPreview: textValue(answer?.text)?.slice(0, 300) ?? null,
          answerStatus: textValue(answer?.status),
          verificationStatus: textValue(evidence?.status),
          reasonCode: textValue(evidence?.reasonCode),
          expectedCount: textValue(expected?.count),
          expectedSum: textValue(expected?.sum),
          actualCount: textValue(actual?.count),
          actualSum: textValue(actual?.sum),
          errorCode: textValue(answer?.errorCode),
        });
      }
      if (
        answer?.status === "succeeded" &&
        answer.provider === "codex_app_server" &&
        textValue(answer.responseId) !== null &&
        textValue(answer.responseModel) === CODEX_MODEL
      ) {
        successfulTargetAnswers += 1;
        const evidence = record(answer.verificationEvidence);
        if (evidence?.status === "passed") {
          verificationPassesByArm[arm]![subject] += 1;
        }
      }
    }
  }

  const manifestArms = Array.isArray(manifest?.arms)
    ? manifest.arms
        .map((value) => record(value))
        .filter((item) => item !== null)
    : [];
  const graphragManifest = manifestArms.find((arm) => arm?.arm === "graphrag");
  const ragManifest = manifestArms.find((arm) => arm?.arm === "rag");
  const originalManifest = manifestArms.find((arm) => arm?.arm === "original");
  const expectedSourceManifest = (
    value: unknown,
    expectedSources: SyntheticSourceVersion[],
  ): boolean => {
    const sourceRows = Array.isArray(value)
      ? value.map((item) => record(item)).filter((item) => item !== null)
      : [];
    return (
      sourceRows.length === expectedSources.length &&
      expectedSources.every((source) =>
        sourceRows.some(
          (row) =>
            row?.documentId === source.sourceId &&
            row.documentVersionId === source.versionId &&
            row.documentVersion === source.version &&
            row.checksum === source.checksum,
        ),
      )
    );
  };
  const evidencePacks = (arm: JsonRecord | undefined) =>
    Array.isArray(arm?.evidencePacks)
      ? arm.evidencePacks
          .map((value) => record(value))
          .filter((item) => item !== null)
      : [];
  const ragPacks = evidencePacks(ragManifest);
  const graphPacks = evidencePacks(graphragManifest);
  const originalPacks = evidencePacks(originalManifest);
  const originalRetrieval = record(originalManifest?.retrieval);
  const originalArmMatched =
    originalRetrieval?.strategy === "lexical" &&
    Array.isArray(originalRetrieval.sourceIds) &&
    originalRetrieval.sourceIds.length === 0 &&
    originalRetrieval.snapshotId === null &&
    Array.isArray(originalManifest?.sources) &&
    originalManifest.sources.length === 0 &&
    originalPacks.length === CONTROLLED_EVALUATION_CASE_COUNT &&
    originalPacks.every(
      (pack) =>
        pack?.requestedStrategy === "none" &&
        pack.strategyUsed === "none" &&
        pack.selectedSnapshotId === null &&
        pack.usedSnapshotId === null &&
        pack.fallbackReason === null &&
        Array.isArray(pack.selectedSourceIds) &&
        pack.selectedSourceIds.length === 0 &&
        Array.isArray(pack.sourceManifest) &&
        pack.sourceManifest.length === 0,
    );
  const sourceManifestMatched =
    ragPacks.length === CONTROLLED_EVALUATION_CASE_COUNT &&
    graphPacks.length === CONTROLLED_EVALUATION_CASE_COUNT &&
    ragPacks.every((pack) =>
      expectedSourceManifest(pack?.sourceManifest, input.ragSources),
    ) &&
    graphPacks.every((pack) =>
      expectedSourceManifest(pack?.sourceManifest, input.graphSources),
    );
  const selectedSources = (
    arm: JsonRecord | undefined,
    expectedSources: SyntheticSourceVersion[],
  ) => {
    const selection = record(arm?.retrieval);
    const sourceIds = Array.isArray(selection?.sourceIds)
      ? selection.sourceIds
      : [];
    return (
      sourceIds.length === expectedSources.length &&
      expectedSources.every((source) => sourceIds.includes(source.sourceId)) &&
      Array.isArray(arm?.sources) &&
      expectedSourceManifest(arm.sources, expectedSources)
    );
  };
  const retrievalConfigurationMatched =
    ragManifest?.retrieval !== null &&
    record(ragManifest?.retrieval)?.strategy === "lexical" &&
    record(ragManifest?.retrieval)?.snapshotId === null &&
    selectedSources(ragManifest, input.ragSources) &&
    graphragManifest?.retrieval !== null &&
    record(graphragManifest?.retrieval)?.strategy === "graph" &&
    record(graphragManifest?.retrieval)?.snapshotId === input.graphSnapshotId &&
    selectedSources(graphragManifest, input.graphSources);
  const graphFallbackCount = graphPacks.filter(
    (pack) =>
      pack?.requestedStrategy !== "graph" ||
      pack.strategyUsed !== "graph" ||
      pack.selectedSnapshotId !== input.graphSnapshotId ||
      pack.usedSnapshotId !== input.graphSnapshotId ||
      pack.fallbackReason !== null,
  ).length;
  graphFallbacks = graphFallbackCount;

  const audit = input.databaseAudit;
  const completed = record(audit.completionPayload?.controlledEvaluation);
  const allPairsPresent =
    seenPairs.size ===
    CONTROLLED_EVALUATION_ARM_COUNT * CONTROLLED_EVALUATION_CASE_COUNT;
  const graphSnapshotMatches =
    graphragManifest?.retrieval !== null &&
    record(graphragManifest?.retrieval)?.snapshotId === input.graphSnapshotId;
  const caseManifest = Array.isArray(manifest?.cases)
    ? manifest.cases
        .map((value) => record(value))
        .filter((item) => item !== null)
    : [];
  const caseManifestMatched =
    caseManifest.length === CONTROLLED_EVALUATION_CASE_COUNT &&
    caseManifest.some(
      (item) =>
        item?.caseId === "development-alpha" && item.split === "development",
    ) &&
    caseManifest.some(
      (item) => item?.caseId === "holdout-omega" && item.split === "holdout",
    );
  const attemptAuditPassed =
    audit.attempts.length === 1 &&
    audit.attempts[0]?.provider === "codex_app_server" &&
    audit.attempts[0]?.purpose === "target" &&
    audit.attempts[0]?.status === "succeeded" &&
    audit.attempts[0]?.remoteOutcomeKnown === true;
  const targetCallEvidencePassed =
    audit.targetUsageRecords === CONTROLLED_EVALUATION_TARGET_CALLS &&
    audit.targetRequestTraces === CONTROLLED_EVALUATION_TARGET_CALLS &&
    audit.targetResponseTraces === CONTROLLED_EVALUATION_TARGET_CALLS;
  const passed =
    report?.mode === "controlled_evaluation" &&
    report.status === "complete" &&
    report.runId === input.runId &&
    report.expectedRequestCount === CONTROLLED_EVALUATION_TARGET_CALLS &&
    rawPairs.length ===
      CONTROLLED_EVALUATION_ARM_COUNT * CONTROLLED_EVALUATION_CASE_COUNT &&
    manifestArms.length === CONTROLLED_EVALUATION_ARM_COUNT &&
    caseManifestMatched &&
    originalArmMatched &&
    allPairsPresent &&
    successfulTargetAnswers === CONTROLLED_EVALUATION_TARGET_CALLS &&
    audit.runStatus === "succeeded" &&
    audit.requestedModel === CODEX_MODEL &&
    audit.responseModel === CODEX_MODEL &&
    attemptAuditPassed &&
    targetCallEvidencePassed &&
    completed?.status === "complete" &&
    sourceManifestMatched &&
    retrievalConfigurationMatched &&
    graphSnapshotMatches &&
    graphFallbacks === 0;
  const candidateVerificationPassed = Object.values(
    verificationPassesByArm,
  ).every((passes) => passes.candidate === CONTROLLED_EVALUATION_CASE_COUNT);

  return {
    runId: input.runId,
    status: textValue(report?.status),
    evidenceComplete: passed,
    candidateVerificationPassed,
    experimentRegistered: false,
    evidenceEligible: null,
    expectedTargetCalls: CONTROLLED_EVALUATION_TARGET_CALLS,
    persistedTargetUsageRecords: audit.targetUsageRecords,
    successfulTargetAnswers,
    verificationPassesByArm,
    candidateVerificationByPair,
    graphSnapshotId: input.graphSnapshotId,
    graphFallbacks,
    frozenSourceMatched: sourceManifestMatched,
    runAttempts: audit.attempts,
  };
}

async function readRedisJobCounts(url: string): Promise<WorkerQueueCounts> {
  const Redis = createRequire(join(ROOT, "apps", "worker", "package.json"))(
    "ioredis",
  ) as new (
    url: string,
    options: Record<string, unknown>,
  ) => RedisClient & {
    llen(key: string): Promise<number>;
    zcard(key: string): Promise<number>;
  };
  const client = new Redis(url, {
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    const [
      wait,
      active,
      delayed,
      paused,
      waitingChildren,
      prioritized,
      completed,
      failed,
    ] = await Promise.all([
      client.llen("bull:promptlab-work:wait"),
      client.llen("bull:promptlab-work:active"),
      client.zcard("bull:promptlab-work:delayed"),
      client.llen("bull:promptlab-work:paused"),
      client.zcard("bull:promptlab-work:waiting-children"),
      client.zcard("bull:promptlab-work:prioritized"),
      client.zcard("bull:promptlab-work:completed"),
      client.zcard("bull:promptlab-work:failed"),
    ]);
    return {
      wait,
      active,
      delayed,
      paused,
      waitingChildren,
      prioritized,
      completed,
      failed,
    };
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function readGraphBuildRunErrorCode(
  databaseUrl: string,
  projectId: string,
  runId: string,
): Promise<string | null> {
  const { Client } = createRequire(
    join(ROOT, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ errorCode: string | null }>(
      'SELECT error_code AS "errorCode" FROM runs WHERE project_id = $1 AND id = $2 LIMIT 1',
      [projectId, runId],
    );
    return textValue(result.rows[0]?.errorCode);
  } finally {
    await client.end();
  }
}

function assertCampaignRemaining(
  state: JourneyState,
  expected: { campus_gateway: number; codex_app_server: number },
  stage: string,
): void {
  if (!state.campaignPath) stop("campaign_path_unavailable", stage);
  const ledger = readCampaignLedger(state.campaignPath);
  if (!ledger) stop("campaign_ledger_unavailable", stage);
  for (const provider of ["campus_gateway", "codex_app_server"] as const) {
    const remaining =
      ledger.maxInferenceCallsByProvider[provider] -
      (ledger[provider]?.callsUsed ?? 0);
    if (remaining < expected[provider]) {
      stop("campaign_remaining_budget_insufficient", stage);
    }
  }
}

interface SyntheticSourceVersion {
  displayName: string;
  sourceId: string;
  versionId: string;
  version: number;
  checksum: string;
}

interface SyntheticSourceSet {
  graph: SyntheticSourceVersion;
  corpus: SyntheticSourceVersion;
}

async function createSyntheticSource(
  state: JourneyState,
  projectId: string,
): Promise<SyntheticSourceSet> {
  if (!state.baseUrl) stop("app_url_unavailable", "source_create");
  const definitions = [
    {
      key: "graph" as const,
      displayName: "Synthetic flow 2 graph facts.md",
      content: "Bilangan genap defines bilangan bulat yang habis dibagi 2.",
    },
    {
      key: "corpus" as const,
      displayName: "Synthetic flow 2 prompt corpus.md",
      content: controlledEvaluationCases()
        .map((testCase) => testCase.input)
        .join("\n"),
    },
  ];
  const created: Partial<SyntheticSourceSet> = {};
  for (const definition of definitions) {
    const form = new FormData();
    form.set("displayName", definition.displayName);
    form.set("content", definition.content);
    form.set("permission", "campus_indexer_allowed");
    form.set("sourceKind", "paste");
    const result = await requestJson(
      "synthetic_source_create",
      new URL(
        "/api/projects/" + projectId + "/knowledge/sources",
        state.baseUrl,
      ),
      { method: "POST", body: form },
      state,
    );
    assertHttpStatus(result, 201, "source_create");
    const source = record(result.payload.source);
    const sourceId = textValue(source?.sourceId);
    const versionId = textValue(source?.versionId);
    const version = integerValue(source?.version);
    const checksum = textValue(source?.checksum);
    if (
      !sourceId ||
      !versionId ||
      !version ||
      !checksum ||
      source?.chunkCount !== 1
    ) {
      stop("synthetic_source_snapshot_invalid", "source_create", false);
    }
    created[definition.key] = {
      displayName: definition.displayName,
      sourceId,
      versionId,
      version,
      checksum,
    };
  }
  if (!created.graph || !created.corpus) {
    stop("synthetic_source_set_incomplete", "source_create", false);
  }
  return { graph: created.graph, corpus: created.corpus };
}

async function buildSyntheticGraph(
  state: JourneyState,
  projectId: string,
  sources: SyntheticSourceVersion[],
  requestedModel: string,
): Promise<string> {
  if (!state.baseUrl || !state.redisUrl || !state.campaignPath) {
    stop("graph_build_precondition_failed", "graph_build");
  }
  const previewResult = await requestJson(
    "graph_build_preview",
    new URL(
      "/api/projects/" + projectId + "/graph/build-preview",
      state.baseUrl,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceIds: sources.map((source) => source.sourceId),
        maxModelCalls: MAX_GRAPH_BUILD_MODEL_CALLS,
      }),
    },
    state,
  );
  assertHttpStatus(previewResult, 200, "graph_build_preview");
  const preview = record(previewResult.payload.preview);
  const chunkCount = integerValue(preview?.chunkCount);
  const maxModelCalls = integerValue(preview?.selectedMaxModelCalls);
  if (
    preview?.ready !== true ||
    preview.providerReady !== true ||
    preview.requestedModel !== requestedModel ||
    chunkCount !== sources.length ||
    preview.minModelCalls !== sources.length ||
    maxModelCalls !== MAX_GRAPH_BUILD_MODEL_CALLS
  ) {
    stop("graph_build_two_call_preflight_failed", "graph_build", false);
  }
  state.graphBuild.sourceChunks = chunkCount;
  state.graphBuild.maxModelCalls = maxModelCalls;

  const enqueueResult = await requestJson(
    "graph_build_enqueue",
    new URL("/api/projects/" + projectId + "/graph/builds", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceIds: sources.map((source) => source.sourceId),
        maxModelCalls: MAX_GRAPH_BUILD_MODEL_CALLS,
        idempotencyKey: randomUUID(),
        allowCampusEgress: true,
      }),
    },
    state,
  );
  assertHttpStatus(enqueueResult, 201, "graph_build_enqueue");
  const enqueue = record(enqueueResult.payload.build);
  const buildId = textValue(enqueue?.buildId);
  if (!buildId) stop("graph_build_enqueue_response_invalid", "graph_build");
  state.graphBuild.buildId = buildId;

  const deadline = Math.min(
    Date.now() + 180_000,
    state.hardDeadlineAt ?? Date.now() + 180_000,
  );
  let terminalState: string | null = null;
  while (Date.now() < deadline) {
    const buildResult = await requestJson(
      "graph_build_poll",
      new URL(
        "/api/projects/" + projectId + "/graph/builds/" + buildId,
        state.baseUrl,
      ),
      { method: "GET" },
      state,
      { timeoutMs: 5_000 },
    );
    assertHttpStatus(buildResult, 200, "graph_build_poll");
    const build = record(buildResult.payload.build);
    const buildState = textValue(build?.state);
    if (!buildState) stop("graph_build_status_invalid", "graph_build", false);
    state.graphBuild.state = buildState;
    const budget = record(build?.budget);
    state.graphBuild.callsUsed = integerValue(budget?.callsUsed);
    const spanCorrections = record(budget?.spanCorrections);
    state.graphBuild.spanCorrections = spanCorrections
      ? {
          entities: integerValue(spanCorrections.entities) ?? 0,
          relations: integerValue(spanCorrections.relations) ?? 0,
        }
      : null;
    const runId = textValue(budget?.runId);
    if (runId) state.graphBuild.runId = runId;
    state.graphBuild.failedChunks = Array.isArray(budget?.failedChunks)
      ? budget.failedChunks.flatMap((item) => {
          const failedChunk = record(item);
          const chunkId = textValue(failedChunk?.chunkId);
          const reason = textValue(failedChunk?.reason);
          return chunkId && reason ? [{ chunkId, reason }] : [];
        })
      : [];
    if (["active", "partial", "failed", "cancelled"].includes(buildState)) {
      terminalState = buildState;
      if (buildState !== "active" && runId && state.dbUrl) {
        state.graphBuild.runErrorCode = await readGraphBuildRunErrorCode(
          state.dbUrl,
          projectId,
          runId,
        );
      }
      break;
    }
    await sleep(500);
  }
  if (terminalState !== "active") {
    stop(
      terminalState ? "graph_build_did_not_activate" : "graph_build_timeout",
      "graph_build",
      false,
    );
  }

  const snapshotsResult = await requestJson(
    "graph_active_snapshot_audit",
    new URL("/api/projects/" + projectId + "/graph/snapshots", state.baseUrl),
    { method: "GET" },
    state,
  );
  assertHttpStatus(snapshotsResult, 200, "graph_snapshot_audit");
  const activeSnapshot = record(snapshotsResult.payload.activeSnapshot);
  const snapshotId = textValue(activeSnapshot?.id);
  const snapshotRows = Array.isArray(snapshotsResult.payload.snapshots)
    ? snapshotsResult.payload.snapshots.map((item) => record(item))
    : [];
  const snapshotRow = snapshotRows.find((item) => item?.id === snapshotId);
  const sourceManifest = Array.isArray(activeSnapshot?.sourceManifest)
    ? activeSnapshot.sourceManifest.map((item) => record(item))
    : [];
  const coverage =
    record(activeSnapshot?.coverage) ?? record(snapshotRow?.coverage);
  const sourceDocumentMatched = sources.every((source) =>
    sourceManifest.some((row) => row?.documentId === source.sourceId),
  );
  const sourceVersionIdMatched = sources.every((source) =>
    sourceManifest.some(
      (row) =>
        row?.documentId === source.sourceId &&
        row.documentVersionId === source.versionId,
    ),
  );
  const sourceVersionMatched = sources.every((source) =>
    sourceManifest.some(
      (row) =>
        row?.documentId === source.sourceId && row.version === source.version,
    ),
  );
  const sourceChecksumMatched = sources.every((source) =>
    sourceManifest.some(
      (row) =>
        row?.documentId === source.sourceId && row.checksum === source.checksum,
    ),
  );
  const sourceManifestMatched =
    sourceManifest.length === sources.length &&
    sourceDocumentMatched &&
    sourceVersionIdMatched &&
    sourceVersionMatched &&
    sourceChecksumMatched;
  const activeSnapshotCurrent =
    activeSnapshot?.state === "active" && activeSnapshot.current === true;
  const buildCallBudgetValid =
    state.graphBuild.callsUsed !== null &&
    state.graphBuild.callsUsed >= 1 &&
    state.graphBuild.callsUsed <= MAX_GRAPH_BUILD_MODEL_CALLS;
  state.graphBuild.snapshotId = snapshotId;
  state.graphBuild.entityCount = integerValue(coverage?.entityCount);
  state.graphBuild.assertionCount = integerValue(coverage?.assertionCount);
  state.graphBuild.supportedAssertionCount = integerValue(
    coverage?.supportedCount,
  );
  state.graphBuild.needsReviewCount = integerValue(coverage?.needsReviewCount);
  state.graphBuild.rejectedAssertionCount = integerValue(
    coverage?.rejectedCount,
  );
  state.graphBuild.activeState = textValue(activeSnapshot?.state);
  state.graphBuild.activeCurrent =
    typeof activeSnapshot?.current === "boolean"
      ? activeSnapshot.current
      : null;
  state.graphBuild.activeManifestEntries = sourceManifest.length;
  state.graphBuild.activeSourceDocumentMatched = sourceDocumentMatched;
  state.graphBuild.activeSourceVersionIdMatched = sourceVersionIdMatched;
  state.graphBuild.activeSourceVersionMatched = sourceVersionMatched;
  state.graphBuild.activeSourceChecksumMatched = sourceChecksumMatched;
  state.graphBuild.activeSnapshotSourceMatched = sourceManifestMatched;
  state.graphBuild.buildCallBudgetValid = buildCallBudgetValid;
  if (
    !snapshotId ||
    !sourceManifestMatched ||
    !activeSnapshotCurrent ||
    !buildCallBudgetValid
  ) {
    stop(
      "active_graph_snapshot_evidence_invalid",
      "graph_snapshot_audit",
      false,
    );
  }
  state.graphBuild.activeSnapshotCurrent = activeSnapshotCurrent;
  state.graphBuild.sourceManifestMatched = sourceManifestMatched;
  assertCampaignRemaining(
    state,
    {
      campus_gateway:
        MAX_NEW_CAMPUS_CALLS -
        CAMPUS_VERIFICATION_CALLS -
        (state.graphBuild.callsUsed ?? MAX_GRAPH_BUILD_MODEL_CALLS),
      codex_app_server:
        EXPECTED_CODEX_CAMPAIGN_CALLS -
        CODEX_VERIFICATION_CALLS +
        CODEX_CAMPAIGN_HEADROOM,
    },
    "graph_build_campaign_audit",
  );
  return snapshotId;
}

async function runControlledEvaluation(
  state: JourneyState,
  projectId: string,
  prompt: { id: string; promptId: string; text: string },
  candidate: { id: string; text: string },
  sources: SyntheticSourceSet,
  graphSnapshotId: string,
): Promise<void> {
  if (!state.baseUrl || !state.dbUrl || !state.campaignPath) {
    stop("controlled_evaluation_precondition_failed", "controlled_evaluation");
  }
  const ragSources = [sources.graph, sources.corpus];
  const graphSources = [sources.graph, sources.corpus];
  const sourceReference = (source: SyntheticSourceVersion) => ({
    documentId: source.sourceId,
    title: source.displayName,
    documentVersionId: source.versionId,
    documentVersion: source.version,
    checksum: source.checksum,
  });
  const cases = controlledEvaluationCases();
  const arms = [
    {
      arm: "original",
      provider: "codex_app_server",
      requestedModel: CODEX_MODEL,
      reasoningEffort: "low",
      retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
      sources: [],
    },
    {
      arm: "rag",
      provider: "codex_app_server",
      requestedModel: CODEX_MODEL,
      reasoningEffort: "low",
      retrieval: {
        strategy: "lexical",
        sourceIds: ragSources.map((source) => source.sourceId),
        snapshotId: null,
      },
      sources: ragSources.map(sourceReference),
    },
    {
      arm: "graphrag",
      provider: "codex_app_server",
      requestedModel: CODEX_MODEL,
      reasoningEffort: "low",
      retrieval: {
        strategy: "graph",
        sourceIds: graphSources.map((source) => source.sourceId),
        snapshotId: graphSnapshotId,
      },
      sources: graphSources.map(sourceReference),
    },
  ];
  const evaluation = {
    mode: "controlled_evaluation",
    format: "promptlab-controlled-evaluation-v1",
    datasetName: "Flow 2 synthetic development and holdout",
    datasetVersion: "v1",
    promptId: prompt.promptId,
    baselinePromptVersionId: prompt.id,
    baselinePromptHash: createHash("sha256").update(prompt.text).digest("hex"),
    candidatePromptVersionId: candidate.id,
    candidatePromptHash: createHash("sha256")
      .update(candidate.text)
      .digest("hex"),
    cases,
    arms,
  };
  const plannedTargetCalls = arms.length * cases.length * 2;
  if (
    cases.length !== CONTROLLED_EVALUATION_CASE_COUNT ||
    arms.length !== CONTROLLED_EVALUATION_ARM_COUNT ||
    plannedTargetCalls !== CONTROLLED_EVALUATION_TARGET_CALLS
  ) {
    stop("controlled_evaluation_call_matrix_invalid", "controlled_evaluation");
  }
  if (
    !isControlledEvaluationConfigurationValid(
      evaluation as Parameters<
        typeof isControlledEvaluationConfigurationValid
      >[0],
    )
  ) {
    stop(
      "controlled_evaluation_configuration_invalid",
      "controlled_evaluation_configuration_preflight",
      false,
    );
  }
  assertCampaignRemaining(
    state,
    {
      campus_gateway:
        MAX_NEW_CAMPUS_CALLS -
        CAMPUS_VERIFICATION_CALLS -
        (state.graphBuild.callsUsed ?? MAX_GRAPH_BUILD_MODEL_CALLS),
      codex_app_server:
        EXPECTED_CODEX_CAMPAIGN_CALLS -
        CODEX_VERIFICATION_CALLS -
        CODEX_SMOKE_TARGET_CALLS +
        CODEX_CAMPAIGN_HEADROOM,
    },
    "controlled_evaluation_campaign_preflight",
  );

  const idempotencyKey = randomUUID();
  const createRun = await requestJson(
    "controlled_evaluation_run_create",
    new URL("/api/projects/" + projectId + "/runs", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        promptVersionId: prompt.id,
        purpose: "target",
        provider: "codex_app_server",
        requestedModel: CODEX_MODEL,
        reasoningEffort: "low",
        retrieval: { strategy: "lexical", sourceIds: [] },
        idempotencyKey,
        controlledEvaluation: evaluation,
      }),
    },
    state,
    { inferenceRequest: "target", timeoutMs: 15_000 },
  );
  if (createRun.status !== 201) {
    state.controlledEvaluationFailure = {
      status: `http_${createRun.status}`,
      errorCode: textValue(createRun.payload.error),
      errorSummary: textValue(createRun.payload.message),
      attemptStatus: null,
      attemptErrorCode: null,
    };
    stop(
      "controlled_evaluation_run_create_failed_http_" + createRun.status,
      "controlled_evaluation_run_create",
      false,
    );
  }
  const created = record(createRun.payload.run);
  const runId = textValue(created?.id);
  if (!runId)
    stop("controlled_evaluation_run_invalid", "controlled_evaluation", false);
  const terminal = await waitForRun(state, projectId, idempotencyKey);
  if (terminal.runId !== runId || terminal.status !== "succeeded") {
    state.controlledEvaluationFailure = await readControlledEvaluationFailure(
      state.dbUrl,
      projectId,
      runId,
    );
    state.runStatus = terminal.status;
    stop(
      "controlled_evaluation_run_not_succeeded",
      "controlled_evaluation",
      false,
    );
  }
  const databaseAudit = await loadControlledEvaluationDatabaseAudit(
    state.dbUrl,
    projectId,
    runId,
  );
  const summary = summarizeControlledEvaluation(
    databaseAudit.completionPayload?.controlledEvaluation,
    {
      runId,
      databaseAudit,
      graphSources,
      ragSources,
      graphSnapshotId,
    },
  );
  state.controlledEvaluation = summary;
  state.runEventTypes = [
    ...new Set([...state.runEventTypes, ...databaseAudit.eventTypes]),
  ];
  if (!summary.evidenceComplete || !summary.candidateVerificationPassed) {
    stop(
      "controlled_evaluation_acceptance_evidence_incomplete",
      "evaluation_audit",
      false,
    );
  }

  const experimentResult = await requestJson(
    "controlled_evaluation_register",
    new URL("/api/projects/" + projectId + "/experiments", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, metadata: evaluation }),
    },
    state,
  );
  if (![201, 200].includes(experimentResult.status)) {
    state.controlledEvaluationFailure = {
      status: `http_${experimentResult.status}`,
      errorCode: textValue(experimentResult.payload.error),
      errorSummary: textValue(experimentResult.payload.message),
      attemptStatus: null,
      attemptErrorCode: null,
    };
    stop(
      "controlled_evaluation_registration_failed",
      "experiment_registration",
      false,
    );
  }
  const experimentsResult = await requestJson(
    "controlled_evaluation_registration_audit",
    new URL("/api/projects/" + projectId + "/experiments", state.baseUrl),
    { method: "GET" },
    state,
  );
  assertHttpStatus(experimentsResult, 200, "experiment_registration_audit");
  const experiments = Array.isArray(experimentsResult.payload.experiments)
    ? experimentsResult.payload.experiments.map((item) => record(item))
    : [];
  const registered = experiments.find(
    (experiment) => experiment?.runId === runId,
  );
  summary.experimentRegistered = Boolean(registered);
  summary.evidenceEligible = registered?.evidenceEligible === true;
  if (!summary.experimentRegistered || summary.evidenceEligible !== true) {
    stop(
      "controlled_evaluation_experiment_not_eligible",
      "experiment_registration_audit",
      false,
    );
  }
  assertCampaignRemaining(
    state,
    {
      campus_gateway:
        MAX_NEW_CAMPUS_CALLS -
        CAMPUS_VERIFICATION_CALLS -
        (state.graphBuild.callsUsed ?? MAX_GRAPH_BUILD_MODEL_CALLS),
      codex_app_server: CODEX_CAMPAIGN_HEADROOM,
    },
    "controlled_evaluation_campaign_audit",
  );
}

async function preflightGraphEvaluationEvidence(
  state: JourneyState,
  projectId: string,
  sources: SyntheticSourceSet,
  snapshotId: string,
): Promise<void> {
  if (!state.baseUrl) stop("app_url_unavailable", "graph_evaluation_preflight");
  const sourceIds = [sources.graph.sourceId, sources.corpus.sourceId];
  for (const testCase of controlledEvaluationCases()) {
    const lexicalResult = await requestJson(
      "controlled_evaluation_lexical_retrieval_preflight",
      new URL("/api/projects/" + projectId + "/graph/retrieval", state.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: testCase.input,
          strategy: "lexical",
          sourceIds,
        }),
      },
      state,
    );
    if (lexicalResult.status !== 200) {
      state.lexicalEvaluationPreflight.push({
        caseId: testCase.id,
        httpStatus: lexicalResult.status,
        status: "failed",
        errorCode: textValue(lexicalResult.payload.error),
        selectedSourceIds: sourceIds,
        matchedSourceIds: [],
        corpusEvidenceCount: 0,
        strategyUsed: null,
        fallbackReason: null,
        evidenceCount: 0,
        sourceEvidenceCount: 0,
        lexicalHits: null,
        passed: false,
      });
      stop(
        "lexical_evaluation_preflight_http_" + lexicalResult.status,
        "lexical_evaluation_preflight",
        false,
      );
    }
    const lexicalRetrieval = record(lexicalResult.payload.retrieval);
    const lexicalEvidence = Array.isArray(lexicalRetrieval?.evidence)
      ? lexicalRetrieval.evidence
          .map((item) => record(item))
          .filter((item) => item !== null)
      : [];
    const lexicalMatchedSourceIds = sourceIds.filter((sourceId) =>
      lexicalEvidence.some((evidence) => evidence?.documentId === sourceId),
    );
    const sourceEvidenceCount = lexicalEvidence.filter((evidence) =>
      sourceIds.includes(textValue(evidence?.documentId) ?? ""),
    ).length;
    const corpusEvidenceCount = lexicalEvidence.filter(
      (evidence) => evidence?.documentId === sources.corpus.sourceId,
    ).length;
    const lexicalClipping = record(lexicalRetrieval?.clipping);
    const lexicalPreflightPassed =
      lexicalRetrieval?.requestedStrategy === "lexical" &&
      lexicalRetrieval.strategyUsed === "lexical" &&
      lexicalRetrieval.fallbackReason === null &&
      sourceEvidenceCount > 0 &&
      corpusEvidenceCount > 0 &&
      (integerValue(lexicalClipping?.lexicalHits) ?? 0) > 0;
    state.lexicalEvaluationPreflight.push({
      caseId: testCase.id,
      httpStatus: lexicalResult.status,
      status: lexicalPreflightPassed ? "passed" : "failed",
      errorCode: null,
      selectedSourceIds: sourceIds,
      matchedSourceIds: lexicalMatchedSourceIds,
      corpusEvidenceCount,
      strategyUsed: textValue(lexicalRetrieval?.strategyUsed),
      fallbackReason: textValue(lexicalRetrieval?.fallbackReason),
      evidenceCount: lexicalEvidence.length,
      sourceEvidenceCount,
      lexicalHits: integerValue(lexicalClipping?.lexicalHits),
      passed: lexicalPreflightPassed,
    });
    if (!lexicalPreflightPassed) {
      stop(
        "controlled_evaluation_lexical_evidence_preflight_failed",
        "lexical_evaluation_preflight",
        false,
      );
    }

    const result = await requestJson(
      "controlled_evaluation_graph_retrieval_preflight",
      new URL("/api/projects/" + projectId + "/graph/retrieval", state.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: testCase.input,
          strategy: "graph",
          sourceIds,
          snapshotId,
        }),
      },
      state,
    );
    assertHttpStatus(result, 200, "graph_evaluation_preflight");
    const retrieval = record(result.payload.retrieval);
    const strategyUsed = textValue(retrieval?.strategyUsed);
    const fallbackReason = textValue(retrieval?.fallbackReason);
    const selectedSnapshotMatched = retrieval?.snapshotId === snapshotId;
    const clipping = record(retrieval?.clipping);
    const evidenceCount = Array.isArray(retrieval?.evidence)
      ? retrieval.evidence.length
      : 0;
    const retrievalEvidence = Array.isArray(retrieval?.evidence)
      ? retrieval.evidence
          .map((item) => record(item))
          .filter((item) => item !== null)
      : [];
    const graphMatchedSourceIds = sourceIds.filter((sourceId) =>
      retrievalEvidence.some((evidence) => evidence?.documentId === sourceId),
    );
    const graphPathCount = Array.isArray(retrieval?.paths)
      ? retrieval.paths.length
      : 0;
    const seedLabels = Array.isArray(retrieval?.seeds)
      ? retrieval.seeds.flatMap((item) => {
          const seed = record(item);
          const label = textValue(seed?.label);
          return label ? [label] : [];
        })
      : [];
    state.graphEvaluationPreflight.push({
      caseId: testCase.id,
      selectedSourceIds: sourceIds,
      matchedSourceIds: graphMatchedSourceIds,
      strategyUsed,
      fallbackReason,
      selectedSnapshotMatched,
      evidenceCount,
      graphPathCount,
      seedLabels,
      lexicalHits: integerValue(clipping?.lexicalHits),
      graphScanClipped:
        typeof clipping?.graphScanClipped === "boolean"
          ? clipping.graphScanClipped
          : null,
      invalidQuoteCount: integerValue(clipping?.invalidQuoteCount),
    });
    if (
      strategyUsed !== "graph" ||
      fallbackReason !== null ||
      !selectedSnapshotMatched ||
      graphPathCount < 1 ||
      evidenceCount < 1 ||
      !graphMatchedSourceIds.includes(sources.graph.sourceId)
    ) {
      stop(
        "controlled_evaluation_graph_evidence_preflight_failed",
        "graph_evaluation_preflight",
        false,
      );
    }
  }
}

async function runJourney(state: JourneyState): Promise<void> {
  state.stage = "runtime_preflight";
  assertRuntime();

  state.stage = "artifact_preflight";
  state.sourceDist = selectedSourceDist();
  state.buildId = readFileSync(
    join(state.sourceDist, "BUILD_ID"),
    "utf8",
  ).trim();

  state.stage = "campaign_preflight";
  state.campaignPath = campaignLedgerPath();

  const canonicalRoot = realpathSync(ROOT);
  if (
    state.campaignPath !== join(canonicalRoot, CAMPAIGN_LEDGER_RELATIVE_PATH)
  ) {
    stop("campaign_ledger_path_not_canonical", "campaign_preflight");
  }
  state.campaignLedgerBefore = readCampaignLedger(state.campaignPath);
  if (!state.campaignLedgerBefore) {
    stop("campaign_resume_snapshot_missing", "campaign_preflight");
  }

  const originalHome = realpathSync(homedir());
  const executableDirectories = executableSearchPath(originalHome);
  const pathValue = executableDirectories.join(sep === "\\" ? ";" : ":");
  const dockerBinary = findExecutable("docker", executableDirectories);
  findExecutable("codex", executableDirectories);
  findExecutable("bwrap", executableDirectories);
  const credentials = campusCredentialSubset();

  state.stage = "codex_auth_preflight";
  const localRoot = join(canonicalRoot, ".local");
  const localRootStats = lstatSync(localRoot);
  if (!localRootStats.isDirectory() || localRootStats.isSymbolicLink()) {
    stop("temporary_root_parent_invalid", "isolation_setup");
  }
  state.tempRoot = mkdtempSync(join(localRoot, ".v3-live-provider-"));
  const tempRoot = state.tempRoot;
  const home = join(tempRoot, "isolated-home");
  state.home = home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const originalCodexHome = join(
    originalHome,
    ".local",
    "share",
    "promptlab",
    "codex-auth",
  );
  const isolatedCodexHome = join(
    home,
    ".local",
    "share",
    "promptlab",
    "codex-auth",
  );
  copyPrivateDirectory(originalCodexHome, isolatedCodexHome);

  state.dockerConfig = join(tempRoot, "docker-config");
  mkdirSync(state.dockerConfig, { recursive: true, mode: 0o700 });
  const cleanDockerEnv: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: tempRoot,
  };
  runCommand(
    dockerBinary,
    dockerArgs(state.dockerConfig, ["image", "inspect", POSTGRES_IMAGE]),
    canonicalRoot,
    cleanDockerEnv,
  );
  runCommand(
    dockerBinary,
    dockerArgs(state.dockerConfig, ["image", "inspect", REDIS_IMAGE]),
    canonicalRoot,
    cleanDockerEnv,
  );
  state.dockerReady = true;

  const suffix = process.pid + "-" + randomUUID().slice(0, 8);
  const distName = ".next-v3-live-provider-" + suffix.toLowerCase();
  state.privateDist = join(WEB_ROOT, distName);
  const privateBuildId = copyBuildToPrivateDist(
    state.sourceDist,
    state.privateDist,
  );
  if (privateBuildId !== state.buildId) {
    stop("private_build_id_mismatch", "artifact_isolation");
  }

  const appRoot = join(tempRoot, "apps", "web");
  mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  cpSync(join(WEB_ROOT, "next.config.ts"), join(appRoot, "next.config.ts"));
  cpSync(join(WEB_ROOT, "package.json"), join(appRoot, "package.json"));
  const nodeModules = join(WEB_ROOT, "node_modules");
  if (!existsSync(nodeModules)) {
    stop("workspace_node_modules_missing", "isolation_setup");
  }
  const { symlinkSync } = await import("node:fs");
  symlinkSync(nodeModules, join(appRoot, "node_modules"), "dir");
  symlinkSync(state.privateDist, join(appRoot, distName), "dir");

  const postgresName = "pbkk-v3-live-pg-" + suffix.toLowerCase();
  const redisName = "pbkk-v3-live-redis-" + suffix.toLowerCase();
  state.postgresContainer = postgresName;
  state.redisContainer = redisName;
  const postgresId = runCommand(
    dockerBinary,
    dockerArgs(state.dockerConfig, [
      "run",
      "-d",
      "--pull=never",
      "--name",
      postgresName,
      "--memory=1024m",
      "--cpus=1.5",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=768m",
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_USER=pbkk_live",
      "-e",
      "POSTGRES_DB=pbkk_live",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      POSTGRES_IMAGE,
    ]),
    canonicalRoot,
    cleanDockerEnv,
  );
  if (!/^[0-9a-f]{12,64}$/u.test(postgresId)) {
    stop("postgres_container_start_unconfirmed", "database_start");
  }

  const redisId = runCommand(
    dockerBinary,
    dockerArgs(state.dockerConfig, [
      "run",
      "-d",
      "--pull=never",
      "--name",
      redisName,
      "--memory=512m",
      "--cpus=1",
      "--tmpfs",
      "/data:rw,nosuid,nodev,noexec,size=256m",
      "-p",
      "127.0.0.1::6379",
      REDIS_IMAGE,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "128mb",
      "--maxmemory-policy",
      "noeviction",
    ]),
    canonicalRoot,
    cleanDockerEnv,
  );
  if (!/^[0-9a-f]{12,64}$/u.test(redisId)) {
    stop("redis_container_start_unconfirmed", "redis_start");
  }

  for (const [name, destination, image] of [
    [postgresName, "5432/tcp", POSTGRES_IMAGE],
    [redisName, "6379/tcp", REDIS_IMAGE],
  ] as const) {
    const inspectText = runCommand(
      dockerBinary,
      dockerArgs(state.dockerConfig, ["inspect", name]),
      canonicalRoot,
      cleanDockerEnv,
    );
    const details = JSON.parse(inspectText) as Array<{
      Config: { Image: string };
      HostConfig: {
        Binds: string[] | null;
        Tmpfs: Record<string, string> | null;
      };
      Mounts: Array<{ Type: string; Destination: string }>;
    }>;
    const container = details[0];
    if (
      !container ||
      container.Config.Image !== image ||
      (container.HostConfig.Binds ?? []).length !== 0 ||
      !container.HostConfig.Tmpfs ||
      !container.Mounts.every(
        (mount) =>
          mount.Type === "tmpfs" || mount.Destination.startsWith("/dev/"),
      )
    ) {
      stop("container_isolation_check_failed", "container_preflight");
    }
    const portOutput = runCommand(
      dockerBinary,
      dockerArgs(state.dockerConfig, ["port", name, destination]),
      canonicalRoot,
      cleanDockerEnv,
    );
    if (!/^127\.0\.0\.1:\d+$/u.test(portOutput)) {
      stop("container_port_not_loopback_only", "container_preflight");
    }
    const port = portOutput.split(":").at(-1);
    if (destination === "5432/tcp") {
      state.dbUrl = "postgresql://pbkk_live@127.0.0.1:" + port + "/pbkk_live";
    } else {
      state.redisUrl = "redis://127.0.0.1:" + port;
    }
  }
  if (!state.dbUrl || !state.redisUrl) {
    stop("container_connection_url_missing", "container_preflight");
  }
  await waitForPostgres(
    Number(new URL(state.dbUrl).port),
    "pbkk_live",
    "pbkk_live",
  );
  await waitForRedis(state.redisUrl);

  const { Client } = createRequire(
    join(canonicalRoot, "packages", "db", "package.json"),
  )("pg") as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  const databaseClient = new Client({ connectionString: state.dbUrl });
  await databaseClient.connect();
  const emptyPublicSchema = await databaseClient.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'",
  );
  await databaseClient.end();
  if (emptyPublicSchema.rows[0]?.count !== "0") {
    stop("isolated_database_not_empty_before_migrations", "database_preflight");
  }
  await applyMigrations(state.dbUrl, home, pathValue);

  const nextCli = join(WEB_ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli)) stop("next_cli_missing", "app_start");
  const appPort = await chooseLoopbackPort();
  state.baseUrl = "http://127.0.0.1:" + appPort;
  const serverEnv: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: tempRoot,
    NODE_ENV: "production",
    NEXT_DIST_DIR: distName,
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(appPort),
    HOSTNAME: "127.0.0.1",
    PROMPTLAB_DATABASE_URL: state.dbUrl,
    PROMPTLAB_REDIS_URL: state.redisUrl,
    PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN: CAMPAIGN_ID,
    PROMPTLAB_CAMPUS_API_KEY: credentials.apiKey,
    PROMPTLAB_CAMPUS_MODEL: credentials.requestedModel,
    PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS: "30000",
    CODEX_HOME: isolatedCodexHome,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
  state.server = startChild({
    command: process.execPath,
    args: [
      nextCli,
      "start",
      ".",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    cwd: appRoot,
    env: serverEnv,
    logPath: (state.serverLogPath = join(tempRoot, "next-server.log")),
  });
  state.server.once("error", (error) => {
    state.serverSpawnError =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name;
  });
  await waitForServer(state.baseUrl, state);

  if (process.argv.includes("--preflight-only")) {
    state.stage = "preflight_only_complete";
    return;
  }

  state.stage = "codex_no_generation_probe";
  const providerState = await requestJson(
    "providers_no_generation_probe",
    new URL("/api/providers", state.baseUrl),
    { method: "GET" },
    state,
  );
  assertHttpStatus(providerState, 200, "codex_no_generation_probe");
  const catalog = Array.isArray(providerState.payload.codexModels)
    ? providerState.payload.codexModels.map((item) => record(item))
    : [];
  if (!catalog.some((model) => model?.id === CODEX_MODEL)) {
    stop("codex_model_missing_from_no_generation_catalog", "codex_preflight");
  }

  const projectResult = await requestJson(
    "synthetic_project_create",
    new URL("/api/projects", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic live provider validation",
        objective:
          "Validasi provider dengan prompt sintetis tanpa berkas atau retrieval.",
      }),
    },
    state,
  );
  assertHttpStatus(projectResult, 201, "synthetic_project_create");
  const project = record(projectResult.payload.project);
  const projectId = textValue(project?.id);
  if (!projectId) stop("synthetic_project_response_invalid", "project_create");

  const promptResult = await requestJson(
    "synthetic_prompt_create",
    new URL("/api/projects/" + projectId + "/prompts", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Tiny Indonesian OK response",
        text: "Balas persis dengan satu kata dan tanpa tambahan: OK",
        invariants: ["Balas persis dengan satu kata: OK."],
      }),
    },
    state,
  );
  assertHttpStatus(promptResult, 201, "synthetic_prompt_create");
  const prompt = record(promptResult.payload.prompt);
  const promptVersionId = textValue(prompt?.currentVersionId);
  const promptId = textValue(prompt?.id);
  const promptText = textValue(prompt?.text);
  if (!promptVersionId || !promptId || !promptText)
    stop("synthetic_prompt_response_invalid", "prompt_create");
  const candidatePromptText =
    'Solve the arithmetic request exactly. The range endpoints are inclusive. For this evaluation, "bilangan genap" means an integer divisible by 2; use retrieved evidence only to interpret that definition. Count every matching integer in the requested range and calculate their sum. Return exactly one JSON object with string values for count and sum, such as {"count":"5","sum":"30"}. Do not include Markdown, explanation, or text outside the JSON object.';
  const candidatePromptResult = await requestJson(
    "synthetic_candidate_prompt_create",
    new URL(
      "/api/projects/" + projectId + "/prompts/" + promptId + "/versions",
      state.baseUrl,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: candidatePromptText,
        invariants: [
          "Return one valid JSON object with string fields count and sum.",
          "Compute using the inclusive integer range in the question.",
        ],
        parentVersionId: promptVersionId,
      }),
    },
    state,
  );
  assertHttpStatus(candidatePromptResult, 201, "candidate_prompt_create");
  const candidatePrompt = record(candidatePromptResult.payload.prompt);
  const candidatePromptVersionId = textValue(candidatePrompt?.currentVersionId);
  if (!candidatePromptVersionId)
    stop("synthetic_candidate_prompt_response_invalid", "prompt_create");

  state.stage = "campus_verification";
  assertCampaignRemaining(
    state,
    CAMPAIGN_REMAINING_BUDGET,
    "provider_verification_campaign_preflight",
  );
  state.firstInferenceAt = Date.now();
  state.hardDeadlineAt = state.firstInferenceAt + HARD_WALL_MS;
  const campusResult = await requestJson(
    "campus_provider_verifier",
    new URL("/api/providers", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    state,
    {
      inferenceRequest: "campus_gateway",
      timeoutMs: HARD_WALL_MS,
    },
  );
  state.providerVerificationResults.campus_gateway = {
    status: campusResult.status,
    outcome: providerOutcome(campusResult.payload),
  };
  if (providerOutcome(campusResult.payload) !== "verified") {
    stop(
      "campus_provider_verification_not_verified",
      "campus_verification",
      false,
    );
  }
  assertCampaignRemaining(
    state,
    {
      campus_gateway: MAX_NEW_CAMPUS_CALLS - CAMPUS_VERIFICATION_CALLS + 0,
      codex_app_server: EXPECTED_CODEX_CAMPAIGN_CALLS + CODEX_CAMPAIGN_HEADROOM,
    },
    "campus_verification_campaign_audit",
  );

  state.stage = "codex_verification";
  const codexResult = await requestJson(
    "codex_provider_verifier",
    new URL("/api/providers", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "codex-verify", model: CODEX_MODEL }),
    },
    state,
    {
      inferenceRequest: "codex_app_server",
      timeoutMs: HARD_WALL_MS,
    },
  );
  state.providerVerificationResults.codex_app_server = {
    status: codexResult.status,
    outcome: providerOutcome(codexResult.payload),
  };
  if (providerOutcome(codexResult.payload) !== "verified") {
    stop(
      "codex_provider_verification_not_verified",
      "codex_verification",
      false,
    );
  }
  assertCampaignRemaining(
    state,
    {
      campus_gateway: MAX_NEW_CAMPUS_CALLS - CAMPUS_VERIFICATION_CALLS,
      codex_app_server:
        EXPECTED_CODEX_CAMPAIGN_CALLS -
        CODEX_VERIFICATION_CALLS +
        CODEX_CAMPAIGN_HEADROOM,
    },
    "codex_verification_campaign_audit",
  );

  state.stage = "graph_source_and_indexing";
  const source = await createSyntheticSource(state, projectId);
  state.workerLogPath = join(tempRoot, "worker.log");
  const workerEnv: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: tempRoot,
    PROMPTLAB_DATABASE_URL: state.dbUrl,
    PROMPTLAB_REDIS_URL: state.redisUrl,
    PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN: CAMPAIGN_ID,
    CODEX_HOME: isolatedCodexHome,
    PROMPTLAB_CAMPUS_API_KEY: credentials.apiKey,
    PROMPTLAB_CAMPUS_MODEL: credentials.requestedModel,
    PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS: "120000",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
  state.worker = startChild({
    command: process.execPath,
    args: ["--import", "tsx/esm", "apps/worker/src/main.ts"],
    cwd: canonicalRoot,
    env: workerEnv,
    logPath: state.workerLogPath,
  });

  state.stage = "graph_build";
  const graphSnapshotId = await buildSyntheticGraph(
    state,
    projectId,
    [source.graph, source.corpus],
    credentials.requestedModel,
  );
  state.stage = "graph_evaluation_preflight";
  await preflightGraphEvaluationEvidence(
    state,
    projectId,
    source,
    graphSnapshotId,
  );

  state.stage = "target_run";
  assertCampaignRemaining(
    state,
    {
      campus_gateway:
        MAX_NEW_CAMPUS_CALLS -
        CAMPUS_VERIFICATION_CALLS -
        (state.graphBuild.callsUsed ?? MAX_GRAPH_BUILD_MODEL_CALLS),
      codex_app_server:
        EXPECTED_CODEX_CAMPAIGN_CALLS -
        CODEX_VERIFICATION_CALLS +
        CODEX_CAMPAIGN_HEADROOM,
    },
    "smoke_target_campaign_preflight",
  );
  const idempotencyKey = randomUUID();
  const runResult = await requestJson(
    "single_codex_target_run",
    new URL("/api/projects/" + projectId + "/runs", state.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        promptVersionId,
        purpose: "target",
        provider: "codex_app_server",
        requestedModel: CODEX_MODEL,
        reasoningEffort: "low",
        retrieval: { strategy: "lexical", sourceIds: [] },
        idempotencyKey,
      }),
    },
    state,
    { inferenceRequest: "target", timeoutMs: 15_000 },
  );
  assertHttpStatus(runResult, 201, "target_run");
  const createdRun = record(runResult.payload.run);
  state.runId = textValue(createdRun?.id);
  if (!state.runId) stop("target_run_response_invalid", "target_run", false);

  const terminal = await waitForRun(state, projectId, idempotencyKey);
  state.runId = terminal.runId;
  state.runStatus = terminal.status;
  if (terminal.status !== "succeeded") {
    stop("smoke_target_run_not_succeeded", "target_run", false);
  }
  const streamedOutput = await readRunEvents(state, projectId, terminal.runId);
  await loadRunAudit(state, state.dbUrl, projectId, terminal.runId);
  const outputFromEvents = await readRunEventOutputFromDatabase(
    state.dbUrl,
    projectId,
    terminal.runId,
  );
  const outputPresent = streamedOutput.trim().length > 0;
  const streamDatabaseMatch = streamedOutput.trim() === outputFromEvents.trim();
  state.completionValidator = {
    expected: "non-empty output persisted identically",
    observedCharacters: streamedOutput.length,
    databaseObservedCharacters: outputFromEvents.length,
    outputPresent,
    streamDatabaseMatch,
    passed: outputPresent && streamDatabaseMatch,
  };
  if (!state.completionValidator.passed) {
    stop("smoke_target_output_delivery_mismatch", "target_run", false);
  }
  assertCampaignRemaining(
    state,
    {
      campus_gateway:
        MAX_NEW_CAMPUS_CALLS -
        CAMPUS_VERIFICATION_CALLS -
        (state.graphBuild.callsUsed ?? MAX_GRAPH_BUILD_MODEL_CALLS),
      codex_app_server:
        EXPECTED_CODEX_CAMPAIGN_CALLS -
        CODEX_VERIFICATION_CALLS -
        CODEX_SMOKE_TARGET_CALLS +
        CODEX_CAMPAIGN_HEADROOM,
    },
    "smoke_target_campaign_audit",
  );

  state.stage = "controlled_evaluation";
  await runControlledEvaluation(
    state,
    projectId,
    { id: promptVersionId, promptId, text: promptText },
    { id: candidatePromptVersionId, text: candidatePromptText },
    source,
    graphSnapshotId,
  );

  state.stage = "monitoring";
  const summaryResult = await requestJson(
    "monitoring_summary",
    new URL(
      "/api/projects/" + projectId + "/monitoring/summary?range=24h",
      state.baseUrl,
    ),
    { method: "GET" },
    state,
  );
  state.monitoring.summaryStatus = summaryResult.status;
  const summary = record(summaryResult.payload.summary);
  const requestsSummary = record(summary?.requests);
  state.monitoring.summaryRequests = integerValue(requestsSummary?.total);

  const requestLogResult = await requestJson(
    "monitoring_request_log",
    new URL(
      "/api/projects/" +
        projectId +
        "/monitoring/requests?range=24h&page=1&pageSize=20&status=all&provider=all&purpose=all",
      state.baseUrl,
    ),
    { method: "GET" },
    state,
  );
  state.monitoring.requestLogStatus = requestLogResult.status;
  state.monitoring.requestLogRows = Array.isArray(
    requestLogResult.payload.requests,
  )
    ? requestLogResult.payload.requests.length
    : null;

  state.campaignLedger = readCampaignLedger(state.campaignPath);
  state.workerQueueCounts = await readRedisJobCounts(state.redisUrl);
  // BullMQ retains terminal jobs for history; only executable/pending states
  // should block the isolated-queue audit.
  state.workerPendingJobsObserved =
    state.workerQueueCounts.wait +
    state.workerQueueCounts.active +
    state.workerQueueCounts.delayed +
    state.workerQueueCounts.paused +
    state.workerQueueCounts.waitingChildren +
    state.workerQueueCounts.prioritized;
  if (state.attempts.some((attempt) => !attempt.remoteOutcomeKnown)) {
    state.remoteOutcomeUncertain = true;
  }
  if (state.workerPendingJobsObserved !== 0) {
    stop("isolated_worker_jobs_remain", "post_run_audit", false);
  }
  assertCampaignRemaining(
    state,
    {
      campus_gateway:
        MAX_NEW_CAMPUS_CALLS -
        CAMPUS_VERIFICATION_CALLS -
        (state.graphBuild.callsUsed ?? MAX_GRAPH_BUILD_MODEL_CALLS),
      codex_app_server: CODEX_CAMPAIGN_HEADROOM,
    },
    "final_campaign_audit",
  );
  state.stage = "journey_complete";
}

async function cleanup(state: JourneyState): Promise<void> {
  state.serverLogTail = sanitizedLogTail(state.serverLogPath);
  await stopChild(state.worker).catch(() =>
    state.cleanupFailures.push("worker_stop_failed"),
  );
  await stopChild(state.server).catch(() =>
    state.cleanupFailures.push("server_stop_failed"),
  );
  if (state.dockerReady && state.dockerConfig && state.tempRoot) {
    const directories = executableSearchPath(state.home ?? ROOT);
    let dockerBinary: string;
    try {
      dockerBinary = findExecutable("docker", directories);
    } catch {
      state.cleanupFailures.push("docker_binary_missing_during_cleanup");
      dockerBinary = "";
    }
    if (dockerBinary) {
      let allContainersAbsent = true;
      for (const containerName of [
        state.redisContainer,
        state.postgresContainer,
      ]) {
        if (!containerName) continue;
        const environment: NodeJS.ProcessEnv = {
          PATH: directories.join(sep === "\\" ? ";" : ":"),
          HOME: state.home ?? state.tempRoot,
          LANG: "C.UTF-8",
          TMPDIR: state.tempRoot,
        };
        try {
          runCommand(
            dockerBinary,
            dockerArgs(state.dockerConfig, [
              "stop",
              "--time",
              "3",
              containerName,
            ]),
            ROOT,
            environment,
          );
        } catch {
          // Removal below targets only the container name created by this run.
        }
        spawnSync(
          dockerBinary,
          dockerArgs(state.dockerConfig, ["rm", "-f", containerName]),
          { cwd: ROOT, env: environment, encoding: "utf8", windowsHide: true },
        );
        const inspected = spawnSync(
          dockerBinary,
          dockerArgs(state.dockerConfig, ["inspect", containerName]),
          { cwd: ROOT, env: environment, encoding: "utf8", windowsHide: true },
        );
        const inspectionText =
          `${inspected.stdout ?? ""}\n${inspected.stderr ?? ""}`.toLowerCase();
        const absent =
          !inspected.error &&
          inspected.status === 1 &&
          /(no such object|no such container|not found)/u.test(inspectionText);
        if (!absent) {
          allContainersAbsent = false;
          state.cleanupFailures.push(
            inspected.status === 0
              ? "owned_container_remains_after_cleanup"
              : "owned_container_absence_unverified",
          );
        }
      }
      state.cleanupChecks.ownedContainersAbsent = allContainersAbsent;
    } else {
      state.cleanupChecks.ownedContainersAbsent = false;
    }
  } else {
    state.cleanupChecks.ownedContainersAbsent =
      state.redisContainer === null && state.postgresContainer === null;
  }
  if (state.privateDist && existsSync(state.privateDist)) {
    try {
      rmSync(state.privateDist, { recursive: true, force: true });
    } catch {
      state.cleanupFailures.push("private_build_copy_removal_failed");
    }
  }
  state.cleanupChecks.privateBuildRemoved =
    state.privateDist === null || !existsSync(state.privateDist);
  if (!state.cleanupChecks.privateBuildRemoved) {
    state.cleanupFailures.push("private_build_copy_remains_after_cleanup");
  }
  if (state.tempRoot && existsSync(state.tempRoot)) {
    try {
      rmSync(state.tempRoot, { recursive: true, force: true });
    } catch {
      state.cleanupFailures.push("temporary_root_removal_failed");
    }
  }
  state.cleanupChecks.temporaryRootRemoved =
    state.tempRoot === null || !existsSync(state.tempRoot);
  if (!state.cleanupChecks.temporaryRootRemoved) {
    state.cleanupFailures.push("temporary_root_remains_after_cleanup");
  }
}

function ledgerRequestCounts(ledger: JourneyState["campaignLedger"]): {
  campus_gateway: number;
  codex_app_server: number;
} {
  return {
    campus_gateway: ledger?.campus_gateway?.callsUsed ?? 0,
    codex_app_server: ledger?.codex_app_server?.callsUsed ?? 0,
  };
}

async function main(): Promise<void> {
  const state = createJourneyState();
  let status = "failed";
  let stopCode: string | null = null;
  let stopStage: string | null = null;
  let blocked = false;
  try {
    await runJourney(state);
    status = "completed";
  } catch (error) {
    if (error instanceof JourneyStop) {
      stopCode = error.code;
      stopStage = error.stage;
      blocked = error.blocked;
      status = blocked ? "blocked_" + error.code : "failed_" + error.code;
      state.stage = error.stage;
    } else {
      stopCode = error instanceof Error ? error.name : "unknown_error";
      stopStage = state.stage;
      status = "failed_unexpected_error";
    }
  } finally {
    await cleanup(state);
  }

  if (state.campaignPath && existsSync(state.campaignPath)) {
    try {
      state.campaignLedger = readCampaignLedger(state.campaignPath);
    } catch {
      state.campaignLedger = null;
      state.remoteOutcomeUncertain = true;
    }
  }
  if (state.attempts.some((attempt) => !attempt.remoteOutcomeKnown)) {
    state.remoteOutcomeUncertain = true;
  }
  const reserved = ledgerRequestCounts(state.campaignLedger);
  const beforeCounts = ledgerRequestCounts(state.campaignLedgerBefore);
  const campaignCallDelta = {
    campus_gateway: reserved.campus_gateway - beforeCounts.campus_gateway,
    codex_app_server: reserved.codex_app_server - beforeCounts.codex_app_server,
  };
  const expectedCampusCalls =
    state.graphBuild.callsUsed === null
      ? null
      : CAMPUS_VERIFICATION_CALLS + state.graphBuild.callsUsed;
  const callMatrixMatched =
    expectedCampusCalls !== null &&
    state.graphBuild.callsUsed !== null &&
    state.graphBuild.callsUsed >= 1 &&
    state.graphBuild.callsUsed <= MAX_GRAPH_BUILD_MODEL_CALLS &&
    campaignCallDelta.campus_gateway === expectedCampusCalls &&
    campaignCallDelta.codex_app_server === EXPECTED_CODEX_CAMPAIGN_CALLS;
  const preflightOnly = process.argv.includes("--preflight-only");
  if (status === "completed" && !preflightOnly && !callMatrixMatched) {
    status = "failed_provider_call_matrix_mismatch";
    stopCode = "provider_call_matrix_mismatch";
    stopStage = "campaign_audit";
  }
  const totalTargetAttempts = state.attempts.filter(
    (attempt) =>
      attempt.provider === "codex_app_server" && attempt.purpose === "target",
  ).length;
  const report = {
    mode: process.argv.includes("--preflight-only")
      ? "preflight_only"
      : "live_provider_journey",
    status:
      state.cleanupFailures.length > 0 && status === "completed"
        ? "completed_with_cleanup_issue"
        : status,
    nodeVersion: process.versions.node,
    campaign: {
      id: CAMPAIGN_ID,
      idLength: CAMPAIGN_ID.length,
      requiredLength: 32,
      ledgerRelativePath: CAMPAIGN_LEDGER_RELATIVE_PATH,
      resumeMode: "existing_campaign_only",
      ledgerResumed: state.campaignLedgerBefore !== null,
      maxInferenceCallsByProvider:
        state.campaignLedger?.maxInferenceCallsByProvider ?? null,
      providerEntries: state.campaignLedger,
    },
    preflight: {
      productionArtifact: state.sourceDist ? basename(state.sourceDist) : null,
      buildId: state.buildId,
      campaignAwareRoutePresent: state.sourceDist !== null,
      status: stopCode === null ? "passed" : blocked ? "blocked" : "failed",
      lastReadinessStatus: state.lastReadinessStatus,
      lastReadinessFailure: state.lastReadinessFailure,
      serverExitCode: state.serverExitCode,
      serverExitSignal: state.serverExitSignal,
      serverSpawnError: state.serverSpawnError,
      serverLogTail: state.serverLogTail,
    },
    activity: {
      appHttpRequests: state.appHttpRequests,
      appHttpRequestsByLabel: Object.fromEntries(state.appHttpRequestsByLabel),
      verificationRequestsSubmitted: state.providerVerificationsAttempted,
      verificationResults: state.providerVerificationResults,
      campaignCallBudget: {
        initialCallsUsed: beforeCounts,
        newCallsExpected: {
          campus_gateway: {
            minimum: CAMPUS_VERIFICATION_CALLS + 1,
            maximum: MAX_NEW_CAMPUS_CALLS,
            graphBuildCallsUsed: state.graphBuild.callsUsed,
          },
          codex_app_server: EXPECTED_CODEX_CAMPAIGN_CALLS,
        },
        newCallsUsed: campaignCallDelta,
        finalCallsUsed: reserved,
        matrixMatched: preflightOnly ? null : callMatrixMatched,
      },
      providerInferenceCalls: {
        campus_gateway: reserved.campus_gateway,
        codex_app_server: reserved.codex_app_server,
      },
      targetRunPosts: state.targetRunPosts,
      smokeTargetAttempts: totalTargetAttempts,
      controlledEvaluationTargetCalls:
        state.controlledEvaluation?.persistedTargetUsageRecords ?? 0,
      totalSuccessfulCodexTargetCalls:
        totalTargetAttempts +
        (state.controlledEvaluation?.successfulTargetAnswers ?? 0),
      workerPendingJobsObserved: state.workerPendingJobsObserved,
      workerQueueCounts: state.workerQueueCounts,
      containersStarted:
        Number(state.postgresContainer !== null) +
        Number(state.redisContainer !== null),
      appServerStarted: state.server !== null,
      workerStarted: state.worker !== null,
    },
    journey: {
      verification: state.campaignLedger,
      targetRun: {
        requestedModel: state.requestedModel,
        responseModel: state.responseModel,
        status: state.runStatus,
        attempts: state.attempts,
        usage: state.usage,
        eventTypes: state.runEventTypes,
        completionValidator: state.completionValidator,
      },
      graphBuild: state.graphBuild,
      controlledEvaluation: state.controlledEvaluation,
      controlledEvaluationFailure: state.controlledEvaluationFailure,
      lexicalEvaluationPreflight: state.lexicalEvaluationPreflight,
      graphEvaluationPreflight: state.graphEvaluationPreflight,
      monitoring: state.monitoring,
      optimization: "not_part_of_flow_2_controlled_evaluation",
      flow2EvaluationVerified:
        !preflightOnly &&
        status === "completed" &&
        callMatrixMatched &&
        state.controlledEvaluation?.evidenceComplete === true &&
        state.controlledEvaluation.experimentRegistered &&
        state.controlledEvaluation.evidenceEligible === true,
      remainingOptimizationJourneyVerified: false,
      targetCompletionValidated: state.completionValidator?.passed === true,
      qualityImprovementClaim: false,
      remoteOutcomeMayBeUnknown: state.remoteOutcomeUncertain,
    },
    stop: stopCode
      ? {
          code: stopCode,
          stage: stopStage,
        }
      : null,
    cleanup: {
      ownedResourcesRemoved:
        state.cleanupFailures.length === 0 &&
        state.cleanupChecks.ownedContainersAbsent &&
        state.cleanupChecks.privateBuildRemoved &&
        state.cleanupChecks.temporaryRootRemoved,
      checks: state.cleanupChecks,
      campaignLedgerState: state.campaignLedger ? "preserved" : "not_created",
      failures: state.cleanupFailures,
    },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (
    state.cleanupFailures.length > 0 ||
    !state.cleanupChecks.ownedContainersAbsent ||
    !state.cleanupChecks.privateBuildRemoved ||
    !state.cleanupChecks.temporaryRootRemoved ||
    status.startsWith("failed")
  ) {
    process.exitCode = 1;
  } else if (status.startsWith("blocked")) {
    process.exitCode = 2;
  }
}

function sanitizedLogTail(path: string | null): string[] {
  if (!path || !existsSync(path)) return [];
  const allLines = readFileSync(path, "utf8").split(/\r?\n/u);
  const lines = [...allLines.slice(0, 18), ...allLines.slice(-18)].filter(
    (line, index, values) => values.indexOf(line) === index,
  );
  return lines
    .map((line) =>
      line
        .replace(
          /((?:api[-_ ]?key|authorization|bearer)\s*[:=]\s*)[^\s,;"']+/giu,
          "$1[redacted]",
        )
        .replace(/(postgres(?:ql)?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[redacted]@")
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[redacted-key]"),
    )
    .map((line) => line.slice(0, 600));
}

void main();
