import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createMonitoringRequestCsv,
  type MonitoringCsvRequest,
} from "../../apps/web/src/lib/monitoring-client.ts";
import { encodeMonitoringEventCursor } from "../../apps/web/src/lib/monitoring-event-cursor.ts";
import { createDatabaseClient } from "../../packages/db/src/index.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const WEB_ROOT = join(ROOT, "apps/web");
const DEFAULT_SOURCE_DIST = ".next-final-code-checks";
const SOURCE_DIST_ENV = "PROMPTLAB_V3_SOURCE_DIST";
const POSTGRES_IMAGE = "postgres:16-alpine";
interface SqlClient {
  connect(): Promise<void>;
  query<Row extends object = Record<string, unknown>>(
    query: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}
const { Client } = createRequire(join(ROOT, "packages/db/package.json"))(
  "pg",
) as {
  Client: new (config: Record<string, unknown>) => SqlClient;
};
const { sql } = createRequire(join(ROOT, "packages/db/package.json"))(
  "drizzle-orm",
) as {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
};
const PROJECT_ID = "0a111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "0f666666-6666-4666-8666-666666666666";
const RUN_ID = "0b222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "0c333333-3333-4333-8333-333333333333";
const EVENT_IDS = [
  "0d444444-4444-4444-8444-444444444441",
  "0d444444-4444-4444-8444-444444444442",
  "0d444444-4444-4444-8444-444444444443",
] as const;
const PAYLOAD_MARKER = "R5_FIXTURE_PAYLOAD_MUST_NOT_LEAK";

type JsonRecord = Record<string, unknown>;

function assertRuntime(): void {
  assert.equal(
    process.versions.node,
    "22.23.2",
    `Expected native Node 22.23.2; received ${process.versions.node}`,
  );
}

function executableEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
  };
}

function run(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxBuffer?: number;
  },
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 2_000_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status ?? "without a status"}: ${[
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(-8_000)}`,
    );
  }
  return result.stdout.trim();
}

function dockerArgs(configDir: string, args: string[]): string[] {
  return ["--config", configDir, ...args];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function productionSourceDist(): string {
  const configured = process.env[SOURCE_DIST_ENV];
  const requested =
    configured === undefined ? DEFAULT_SOURCE_DIST : configured.trim();
  assert.ok(requested, `${SOURCE_DIST_ENV} must not be empty.`);

  const sourceDist = resolve(WEB_ROOT, requested);
  const relativeDist = relative(WEB_ROOT, sourceDist);
  assert.ok(
    relativeDist &&
      relativeDist !== ".." &&
      !relativeDist.startsWith(`..${sep}`) &&
      !isAbsolute(relativeDist),
    `${SOURCE_DIST_ENV} must point inside apps/web.`,
  );
  assert.equal(
    dirname(relativeDist),
    ".",
    `${SOURCE_DIST_ENV} must name a direct apps/web child.`,
  );
  assert.match(
    basename(sourceDist),
    /^\.next-[a-z0-9][a-z0-9-]*$/u,
    `${SOURCE_DIST_ENV} must name a dedicated .next-* artifact, never .next.`,
  );
  const sourceStats = lstatSync(sourceDist);
  assert.ok(
    sourceStats.isDirectory() && !sourceStats.isSymbolicLink(),
    `${SOURCE_DIST_ENV} must name a real build directory, not a symlink.`,
  );
  return sourceDist;
}

function copyBuildToPrivateDist(
  sourceDist: string,
  privateDist: string,
): string {
  const buildIdPath = join(sourceDist, "BUILD_ID");
  const requiredFilesPath = join(sourceDist, "required-server-files.json");
  assert.ok(
    existsSync(buildIdPath),
    "The supplied production BUILD_ID is missing.",
  );
  assert.ok(
    existsSync(requiredFilesPath),
    "The supplied production server manifest is missing.",
  );
  const buildId = readFileSync(buildIdPath, "utf8").trim();
  const manifestHash = sha256(requiredFilesPath);
  const manifest = JSON.parse(readFileSync(requiredFilesPath, "utf8")) as {
    config?: { distDir?: string };
  };
  assert.equal(
    manifest.config?.distDir,
    basename(sourceDist),
    "The supplied build was not produced with the stated NEXT_DIST_DIR.",
  );

  cpSync(sourceDist, privateDist, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });

  assert.equal(readFileSync(buildIdPath, "utf8").trim(), buildId);
  assert.equal(sha256(requiredFilesPath), manifestHash);
  assert.equal(
    readFileSync(join(privateDist, "BUILD_ID"), "utf8").trim(),
    buildId,
  );
  assert.equal(
    sha256(join(privateDist, "required-server-files.json")),
    manifestHash,
  );
  return buildId;
}

async function chooseLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitForPostgres(
  port: number,
  user: string,
  database: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
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
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await sleep(400);
    }
  }
  throw new Error(
    `Fresh PostgreSQL did not become ready: ${String(lastError)}`,
  );
}

async function applyMigrations(
  databaseUrl: string,
  home: string,
): Promise<void> {
  run(process.execPath, ["--import", "tsx/esm", "packages/db/src/migrate.ts"], {
    cwd: ROOT,
    env: {
      ...executableEnv(home),
      PROMPTLAB_DATABASE_URL: databaseUrl,
    },
  });
}

async function seedTelemetry(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const publicTables = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'",
    );
    assert.ok(Number(publicTables.rows[0]?.count) > 0);

    const nowMs = Date.now();
    const startedAt = new Date(nowMs - 45_000);
    const finishedAt = new Date(nowMs - 5_000);
    const firstEventAt = new Date(nowMs - 40_000);
    const outputEventAt = new Date(nowMs - 35_000);
    const lastEventAt = new Date(nowMs - 30_000);

    await client.query(
      `INSERT INTO public.projects (id, name)
       VALUES ($1, 'R5 isolated HTTP fixture'), ($2, 'R5 isolated second project')`,
      [PROJECT_ID, OTHER_PROJECT_ID],
    );
    await client.query(
      `INSERT INTO public.runs
         (id, project_id, purpose, provider, requested_model, response_model,
          status, idempotency_key, started_at, finished_at)
       VALUES ($1, $2, 'target', 'fixture', '=R5_HTTP_FIXTURE',
               'offline-fixture-response', 'succeeded', 'r5-http-seed-run', $3, $4)`,
      [RUN_ID, PROJECT_ID, startedAt, finishedAt],
    );
    await client.query(
      `INSERT INTO public.model_attempts
         (id, project_id, run_id, attempt_number, provider, purpose,
          requested_model, response_model, status, remote_outcome_known,
          started_at, finished_at)
       VALUES ($1, $2, $3, 1, 'fixture', 'target', '=R5_HTTP_FIXTURE',
               'offline-fixture-response', 'succeeded', false, $4, $5)`,
      [ATTEMPT_ID, PROJECT_ID, RUN_ID, startedAt, finishedAt],
    );
    await client.query(
      `INSERT INTO public.usage_records
         (project_id, run_id, attempt_id, provider, purpose, usage_scope,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          provenance, completeness, mapper_version, sanitized_raw_usage,
          observed_at)
       VALUES ($1, $2, $3, 'fixture', 'target', 'response', 321, 57, 64, 0,
               'estimated', 'partial', 'r5-isolated-http-fixture-v1', NULL, $4)`,
      [PROJECT_ID, RUN_ID, ATTEMPT_ID, finishedAt],
    );
    await client.query(
      `INSERT INTO public.run_events
         (id, project_id, run_id, sequence, event_type, attempt_id, payload, created_at)
       VALUES
         ($1, $2, $3, 1, 'run.status', $4, '{"status":"succeeded"}'::jsonb, $5),
         ($6, $2, $3, 2, 'output.delta', $4,
          jsonb_build_object('fixtureMarker', $7::text, 'text', 'fixture output'), $8),
         ($9, $2, $3, 3, 'tool.completed', $4,
          '{"tool":"fixture-only"}'::jsonb, $10)`,
      [
        EVENT_IDS[0],
        PROJECT_ID,
        RUN_ID,
        ATTEMPT_ID,
        firstEventAt,
        EVENT_IDS[1],
        PAYLOAD_MARKER,
        outputEventAt,
        EVENT_IDS[2],
        lastEventAt,
      ],
    );

    const fixtureCounts = await client.query<{
      projects: string;
      attempts: string;
      events: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM public.projects WHERE id = $1) AS projects,
         (SELECT count(*)::text FROM public.model_attempts WHERE id = $2) AS attempts,
         (SELECT count(*)::text FROM public.run_events WHERE id = ANY($3::uuid[])) AS events,
         (SELECT count(*)::text FROM public.monitoring_event_outbox
           WHERE project_id = $1 AND event_id = ANY($3::uuid[])) AS outbox`,
      [PROJECT_ID, ATTEMPT_ID, [...EVENT_IDS]],
    );
    assert.deepEqual(fixtureCounts.rows[0], {
      projects: "1",
      attempts: "1",
      events: "3",
      outbox: "3",
    });
    const durablePage = await client.query<{
      high_water: string;
      ordinal: string;
      outbox_event_id: string;
      run_event_id: string;
      run_id: string;
      sequence: number;
      event_type: string;
      cursor_at: string;
    }>(
      `WITH selected_events AS (
         SELECT project_id, ordinal, event_id
         FROM public.monitoring_event_outbox
         WHERE project_id = $1::uuid
         ORDER BY ordinal DESC
         LIMIT $2
       )
       SELECT
         COALESCE((SELECT last_ordinal FROM public.monitoring_event_counters
                   WHERE project_id = $1::uuid), 0)::text AS high_water,
         selected_events.ordinal::text AS ordinal,
         selected_events.event_id::text AS outbox_event_id,
         run_events.id::text AS run_event_id,
         run_events.run_id::text AS run_id,
         run_events.sequence,
         run_events.event_type,
         run_events.created_at::text AS cursor_at
       FROM (SELECT 1) AS singleton
       LEFT JOIN selected_events ON TRUE
       LEFT JOIN public.run_events AS run_events
         ON run_events.project_id = selected_events.project_id
         AND run_events.id = selected_events.event_id
       ORDER BY selected_events.ordinal ASC NULLS LAST`,
      [PROJECT_ID, 100],
    );
    assert.deepEqual(
      durablePage.rows.map((row) => [
        row.high_water,
        row.ordinal,
        row.run_event_id,
      ]),
      [
        ["3", "1", EVENT_IDS[0]],
        ["3", "2", EVENT_IDS[1]],
        ["3", "3", EVENT_IDS[2]],
      ],
    );

    const routeDatabase = createDatabaseClient(databaseUrl);
    try {
      const selectedEvents = sql`
        SELECT project_id, ordinal, event_id
        FROM public.monitoring_event_outbox
        WHERE project_id = ${PROJECT_ID}::uuid
        ORDER BY ordinal DESC
        LIMIT ${100}
      `;
      const routePageQuery = sql`
        WITH selected_events AS (${selectedEvents})
        SELECT
          COALESCE((
            SELECT last_ordinal
            FROM public.monitoring_event_counters
            WHERE project_id = ${PROJECT_ID}::uuid
          ), 0)::text AS high_water,
          selected_events.ordinal::text AS ordinal,
          selected_events.event_id::text AS outbox_event_id,
          run_events.id::text AS run_event_id,
          run_events.run_id::text AS run_id,
          run_events.attempt_id::text AS attempt_id,
          run_events.sequence,
          run_events.event_type,
          run_events.created_at,
          run_events.created_at::text AS cursor_at
        FROM (SELECT 1) AS singleton
        LEFT JOIN selected_events ON TRUE
        LEFT JOIN public.run_events AS run_events
          ON run_events.project_id = selected_events.project_id
          AND run_events.id = selected_events.event_id
        ORDER BY selected_events.ordinal ASC NULLS LAST
      `;
      const routePage = await routeDatabase.db.execute(routePageQuery as never);
      const routeRows = routePage.rows as unknown as Array<{
        high_water: string;
        ordinal: string;
        outbox_event_id: string;
        run_event_id: string;
        run_id: string;
        attempt_id: string;
        sequence: number;
        event_type: string;
        created_at: Date;
        cursor_at: string;
      }>;
      assert.equal(routeRows.length, 3);
      for (const [index, row] of routeRows.entries()) {
        const rawCreatedAt: unknown = row.created_at;
        if (index === 0) {
          durableCursorCreatedAtType =
            rawCreatedAt instanceof Date ? "Date" : typeof rawCreatedAt;
        }
        assert.ok(
          rawCreatedAt instanceof Date || typeof rawCreatedAt === "string",
        );
        assert.ok(
          Number.isFinite(
            rawCreatedAt instanceof Date
              ? rawCreatedAt.getTime()
              : Date.parse(rawCreatedAt),
          ),
        );
        assert.equal(typeof row.cursor_at, "string");
        assert.equal(
          typeof encodeMonitoringEventCursor({
            version: 2,
            projectId: PROJECT_ID,
            ordinal: row.ordinal,
            eventId: row.outbox_event_id,
          }),
          "string",
        );
      }
    } finally {
      await routeDatabase.pool.end();
    }
  } finally {
    await client.end();
  }
}

function makeClockPreload(path: string): void {
  writeFileSync(
    path,
    `import { readFileSync } from "node:fs";\n` +
      `const realNow = Date.now.bind(Date);\n` +
      `const marker = process.env.PROMPTLAB_TEST_CLOCK_OFFSET_FILE;\n` +
      `Date.now = () => {\n` +
      `  if (!marker) return realNow();\n` +
      `  try {\n` +
      `    const offset = Number(readFileSync(marker, "utf8").trim());\n` +
      `    return realNow() + (Number.isSafeInteger(offset) ? offset : 0);\n` +
      `  } catch { return realNow(); }\n` +
      `};\n`,
    { mode: 0o600 },
  );
}

function startServer(
  appRoot: string,
  nextCli: string,
  preload: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
  port: number,
): ChildProcess {
  const fd = openSync(logPath, "a", 0o600);
  try {
    return spawn(
      process.execPath,
      [
        "--import",
        preload,
        nextCli,
        "start",
        ".",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: appRoot,
        env,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      },
    );
  } finally {
    closeSync(fd);
  }
}

function serverLogTail(path: string, replacements: string[]): string {
  if (!existsSync(path)) return "";
  let text = readFileSync(path, "utf8").slice(-6_000);
  for (const value of replacements) {
    if (value) text = text.replaceAll(value, "[temporary fixture path]");
  }
  return text;
}

async function waitForServer(
  server: ChildProcess,
  baseUrl: string,
  logPath: string,
  replacements: string[],
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `Isolated Next server exited ${server.exitCode}.\n${serverLogTail(logPath, replacements)}`,
      );
    }
    try {
      const response = await fetch(
        new URL(
          `/api/projects/${PROJECT_ID}/monitoring/summary?range=24h`,
          baseUrl,
        ),
        { cache: "no-store", signal: AbortSignal.timeout(3_000) },
      );
      lastStatus = response.status;
      if (response.status === 200) return;
      await response.body?.cancel();
    } catch {
      // The production server has not opened its loopback listener yet.
    }
    await sleep(350);
  }
  throw new Error(
    `Isolated Next server did not become ready (last status ${lastStatus}).\n${serverLogTail(logPath, replacements)}`,
  );
}

async function readJson(response: Response): Promise<JsonRecord> {
  const payload: unknown = await response.json();
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as JsonRecord;
}

async function apiRequest(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    origin?: string | null;
    fetchSite?: string;
  } = {},
): Promise<{ response: Response; payload: JsonRecord }> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.origin !== null)
    headers.set("Origin", options.origin ?? new URL(baseUrl).origin);
  headers.set("Sec-Fetch-Site", options.fetchSite ?? "same-origin");
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    cache: "no-store",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await readJson(response) };
}

function assertStatus(
  result: { response: Response; payload: JsonRecord },
  expected: number,
  expectedError?: string,
): void {
  assert.equal(
    result.response.status,
    expected,
    JSON.stringify(result.payload),
  );
  if (expectedError)
    assert.equal(result.payload.error ?? result.payload.code, expectedError);
}

function decodeSse(buffer: string): Array<{
  id: string | null;
  event: string | null;
  data: string | null;
}> {
  return buffer
    .split(/\r?\n\r?\n/u)
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      return {
        id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null,
        event:
          lines.find((line) => line.startsWith("event: "))?.slice(7) ?? null,
        data:
          lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n") || null,
      };
    });
}

async function readSseUntil(
  response: Response,
  controller: AbortController,
  expectedEvents: number,
): Promise<string> {
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/u,
  );
  assert.equal(response.headers.get("x-monitoring-cursor-mode"), "durable-v2");
  assert.ok(response.body);
  const reader = response.body.getReader();
  let text = "";
  const deadline = Date.now() + 12_000;
  try {
    while (
      decodeSse(text).filter((block) => block.event !== null).length <
      expectedEvents
    ) {
      const remaining = deadline - Date.now();
      assert.ok(
        remaining > 0,
        `Timed out while waiting for ${expectedEvents} SSE events.`,
      );
      let timeout: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out while waiting for ${expectedEvents} SSE events.`,
                ),
              ),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (result.done) break;
      text += new TextDecoder().decode(result.value);
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

async function stopChild(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null || server.killed) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) =>
      server.once("exit", () => resolveExit()),
    ),
    sleep(5_000),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

const checks: string[] = [];
let tempRoot: string | null = null;
let privateDist: string | null = null;
let containerName: string | null = null;
let dockerConfig: string | null = null;
let server: ChildProcess | null = null;
let serverLog = "";
let dockerAvailable = false;
let dbUrl = "";
let fixtureRoot = "";
let durableCursorCreatedAtType = "not observed";
const runtimeIssues: string[] = [];

try {
  assertRuntime();
  tempRoot = mkdtempSync(join(tmpdir(), "pbkk-r5-isolated-api-"));
  dockerConfig = join(tempRoot, "docker-config");
  mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });

  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const distName = `.next-r5-isolated-api-${suffix}`;
  privateDist = join(WEB_ROOT, distName);
  const sourceDist = productionSourceDist();
  const buildId = copyBuildToPrivateDist(sourceDist, privateDist);
  checks.push("production artifact copied and verified before server start");

  const appRoot = join(tempRoot, "apps", "web");
  mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  cpSync(join(WEB_ROOT, "next.config.ts"), join(appRoot, "next.config.ts"));
  cpSync(join(WEB_ROOT, "package.json"), join(appRoot, "package.json"));
  symlinkSync(
    join(WEB_ROOT, "node_modules"),
    join(appRoot, "node_modules"),
    "dir",
  );
  symlinkSync(privateDist, join(appRoot, distName), "dir");
  checks.push("isolated Next config has no workspace .env parent");

  const fixtureProjectRoot = join(tempRoot, "fixture-project");
  fixtureRoot = fixtureProjectRoot;
  mkdirSync(join(fixtureProjectRoot, "notes"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(fixtureProjectRoot, "notes", "readme.txt"),
    "workspace searchneedle fixture\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixtureProjectRoot, "notes", "approved.txt"),
    "before approval\n",
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(fixtureProjectRoot, "notes", "rejected.txt"),
    "keep unchanged\n",
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(fixtureProjectRoot, "notes", "rollback.txt"),
    "rollback before\n",
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(fixtureProjectRoot, "notes", "conflict.txt"),
    "before conflict\n",
    {
      mode: 0o600,
    },
  );
  writeFileSync(join(fixtureProjectRoot, ".env"), "fixture-secret-value\n", {
    mode: 0o600,
  });
  writeFileSync(
    join(fixtureProjectRoot, "notes", "credentials.txt"),
    "fixture-secret-value\n",
    { mode: 0o600 },
  );
  const outsideFixturePath = join(tempRoot, "outside-secret.txt");
  writeFileSync(outsideFixturePath, "R5_OUTSIDE_WORKSPACE_SECRET_MARKER\n", {
    mode: 0o600,
  });
  symlinkSync(
    outsideFixturePath,
    join(fixtureProjectRoot, "notes", "outside-link.txt"),
    "file",
  );

  const otherFixtureProjectRoot = join(tempRoot, "other-fixture-project");
  mkdirSync(join(otherFixtureProjectRoot, "notes"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(otherFixtureProjectRoot, "notes", "other-project.txt"),
    "second project fixture\n",
    { mode: 0o600 },
  );

  const imageEnv = executableEnv(tempRoot);
  run(
    "docker",
    dockerArgs(dockerConfig, ["image", "inspect", POSTGRES_IMAGE]),
    {
      cwd: ROOT,
      env: imageEnv,
    },
  );
  dockerAvailable = true;
  const databaseName = "r5_isolated";
  const databaseUser = "r5_isolated";
  containerName = `pbkk-r5-api-${suffix.toLowerCase()}`;
  const runOutput = run(
    "docker",
    dockerArgs(dockerConfig, [
      "run",
      "-d",
      "--pull=never",
      "--name",
      containerName,
      "--memory=1024m",
      "--cpus=1.5",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=768m",
      "-p",
      "127.0.0.1::5432",
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      POSTGRES_IMAGE,
    ]),
    { cwd: ROOT, env: imageEnv },
  );
  assert.match(runOutput, /^[0-9a-f]{12,64}$/u);

  const containerDetails = JSON.parse(
    run("docker", dockerArgs(dockerConfig, ["inspect", containerName]), {
      cwd: ROOT,
      env: imageEnv,
    }),
  ) as Array<{
    Config: { Image: string };
    HostConfig: {
      Binds: string[] | null;
      Tmpfs: Record<string, string> | null;
    };
    Mounts: Array<{ Type: string; Destination: string }>;
  }>;
  const container = containerDetails[0];
  assert.ok(container);
  assert.equal(container.Config.Image, POSTGRES_IMAGE);
  assert.deepEqual(container.HostConfig.Binds ?? [], []);
  assert.ok(container.HostConfig.Tmpfs?.["/var/lib/postgresql/data"]);
  assert.ok(
    container.Mounts.every(
      (mount) =>
        mount.Type === "tmpfs" || mount.Destination.startsWith("/dev/"),
    ),
    "The test container must not mount host or named-volume data.",
  );
  const portOutput = run(
    "docker",
    dockerArgs(dockerConfig, ["port", containerName, "5432/tcp"]),
    { cwd: ROOT, env: imageEnv },
  );
  const portMatch = portOutput.match(/^127\.0\.0\.1:(\d+)$/mu);
  assert.ok(portMatch, `PostgreSQL port was not loopback-only: ${portOutput}`);
  const databasePort = Number(portMatch[1]);
  dbUrl = `postgresql://${databaseUser}@127.0.0.1:${databasePort}/${databaseName}`;
  await waitForPostgres(databasePort, databaseUser, databaseName);
  const freshClient = new Client({ connectionString: dbUrl });
  await freshClient.connect();
  const emptyBeforeMigrations = await freshClient.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'",
  );
  await freshClient.end();
  assert.equal(emptyBeforeMigrations.rows[0]?.count, "0");
  await applyMigrations(dbUrl, tempRoot);
  checks.push(
    "all database migrations applied to a fresh PostgreSQL 16 tmpfs database",
  );

  await seedTelemetry(dbUrl);
  checks.push(
    "deterministic project, run, attempt, usage, events, and durable cursors seeded",
  );

  const markerFile = join(tempRoot, "clock-offset-ms");
  writeFileSync(markerFile, "0\n", { mode: 0o600 });
  const clockPreload = join(tempRoot, "clock-preload.mjs");
  makeClockPreload(clockPreload);
  serverLog = join(tempRoot, "next-server.log");
  const appPort = await chooseLoopbackPort();
  const serverEnv: NodeJS.ProcessEnv = {
    ...executableEnv(tempRoot),
    NODE_ENV: "production",
    NEXT_DIST_DIR: distName,
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(appPort),
    HOSTNAME: "127.0.0.1",
    PROMPTLAB_DATABASE_URL: dbUrl,
    PROMPTLAB_LOCAL_WORKSPACE_ROOTS: JSON.stringify([
      { projectId: PROJECT_ID, rootPath: fixtureProjectRoot },
      { projectId: OTHER_PROJECT_ID, rootPath: otherFixtureProjectRoot },
    ]),
    PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED: "1",
    PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS: JSON.stringify([PROJECT_ID]),
    PROMPTLAB_CAMPUS_API_KEY: "",
    PROMPTLAB_CAMPUS_MODEL: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    PROMPTLAB_TEST_CLOCK_OFFSET_FILE: markerFile,
  };
  const nextCli = join(WEB_ROOT, "node_modules/next/dist/bin/next");
  assert.ok(
    existsSync(nextCli),
    "The installed Next production CLI is missing.",
  );
  server = startServer(
    appRoot,
    nextCli,
    clockPreload,
    serverLog,
    serverEnv,
    appPort,
  );
  const baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForServer(server, baseUrl, serverLog, [dbUrl, fixtureProjectRoot]);
  checks.push(
    "isolated production Next server started from the private artifact copy",
  );

  const summaryResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/monitoring/summary?range=24h`,
  );
  assertStatus(summaryResult, 200);
  assert.equal(summaryResult.payload.projectId, PROJECT_ID);
  const summary = summaryResult.payload.summary as JsonRecord;
  const requestsSummary = summary.requests as JsonRecord;
  assert.equal(requestsSummary.total, 1);
  assert.equal(requestsSummary.succeeded, 1);
  const tokens = summary.tokens as JsonRecord;
  assert.equal((tokens.input as JsonRecord).estimated, 321);
  assert.equal((tokens.output as JsonRecord).estimated, 57);
  const agentActivity = summary.agentActivity as JsonRecord;
  assert.equal(agentActivity.eventsInRange, 1);
  checks.push(
    "HTTP Monitoring summary reflects persisted fixture telemetry and estimated provenance",
  );

  const logResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/monitoring/requests?range=24h&page=1&pageSize=20&status=all&provider=all&purpose=all`,
  );
  assertStatus(logResult, 200);
  assert.equal(logResult.payload.total, 1);
  const logRows = logResult.payload.requests as Array<JsonRecord>;
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0]?.attemptId, ATTEMPT_ID);
  assert.equal(logRows[0]?.runId, RUN_ID);
  assert.equal(logRows[0]?.provider, "fixture");
  assert.equal(logRows[0]?.remoteOutcomeKnown, false);
  const requestUsage = logRows[0]?.usage as JsonRecord;
  assert.deepEqual(requestUsage.inputTokens, {
    status: "estimated",
    value: 321,
  });
  assert.equal(
    JSON.stringify(logResult.payload).includes(PAYLOAD_MARKER),
    false,
  );
  const csv = createMonitoringRequestCsv(
    logRows as unknown as MonitoringCsvRequest[],
  );
  assert.equal(logRows[0]?.requestedModel, "=R5_HTTP_FIXTURE");
  assert.match(csv, /"'=R5_HTTP_FIXTURE"/u);
  assert.match(csv, /"321 \(estimated\)"/u);
  assert.equal(csv.includes(PAYLOAD_MARKER), false);
  checks.push(
    "HTTP request-log response serializes through the production CSV helper with formula escaping",
  );

  const initialController = new AbortController();
  const initialResponse = await fetch(
    new URL(`/api/projects/${PROJECT_ID}/monitoring/events`, baseUrl),
    { cache: "no-store", signal: initialController.signal },
  );
  const initialSse = await readSseUntil(initialResponse, initialController, 3);
  const initialBlocks = decodeSse(initialSse).filter(
    (block) => block.event !== null,
  );
  const initialIds = initialBlocks.flatMap((block) => {
    if (!block.data) return [];
    try {
      return [(JSON.parse(block.data) as JsonRecord).id];
    } catch {
      return [];
    }
  });
  const initialReplayPassed =
    initialBlocks.length === 3 &&
    initialBlocks.every((block) => block.event === "monitoring.activity") &&
    JSON.stringify(initialIds) === JSON.stringify([...EVENT_IDS]);
  if (initialReplayPassed) {
    assert.equal(initialSse.includes(PAYLOAD_MARKER), false);
  } else {
    runtimeIssues.push(
      `Durable SSE initial replay expected 3 persisted activity events but received ${JSON.stringify(initialBlocks)}; Drizzle raw created_at type=${durableCursorCreatedAtType}; stream body=${JSON.stringify(initialSse)}`,
    );
  }
  const firstCursorToken =
    initialBlocks.find((block) => block.id)?.id ??
    encodeMonitoringEventCursor({
      version: 2,
      projectId: PROJECT_ID,
      ordinal: "1",
      eventId: EVENT_IDS[0],
    });
  const firstCursor = JSON.parse(
    Buffer.from(firstCursorToken, "base64url").toString("utf8"),
  ) as JsonRecord;
  assert.equal(firstCursor.version, 2);
  assert.equal(firstCursor.projectId, PROJECT_ID);
  assert.equal(firstCursor.ordinal, "1");
  assert.equal(firstCursor.eventId, EVENT_IDS[0]);

  const reconnectController = new AbortController();
  const reconnectUrl = new URL(
    `/api/projects/${PROJECT_ID}/monitoring/events`,
    baseUrl,
  );
  reconnectUrl.searchParams.set("after", firstCursorToken);
  const reconnectResponse = await fetch(reconnectUrl, {
    cache: "no-store",
    signal: reconnectController.signal,
  });
  const reconnectSse = await readSseUntil(
    reconnectResponse,
    reconnectController,
    2,
  );
  const resumedBlocks = decodeSse(reconnectSse).filter(
    (block) => block.event !== null,
  );
  const resumedIds = resumedBlocks.flatMap((block) => {
    if (!block.data) return [];
    try {
      return [(JSON.parse(block.data) as JsonRecord).id];
    } catch {
      return [];
    }
  });
  const reconnectPassed =
    resumedBlocks.length === 2 &&
    resumedBlocks.every((block) => block.event === "monitoring.activity") &&
    JSON.stringify(resumedIds) === JSON.stringify([EVENT_IDS[1], EVENT_IDS[2]]);
  if (!reconnectPassed) {
    runtimeIssues.push(
      `Durable SSE reconnect expected ordinals 2 and 3 but received ${JSON.stringify(resumedBlocks)}; body=${JSON.stringify(reconnectSse)}`,
    );
  }
  if (reconnectSse.includes(PAYLOAD_MARKER)) {
    runtimeIssues.push(
      "Durable SSE replay emitted the fixture payload marker.",
    );
  }
  const crossProjectCursor = await apiRequest(
    baseUrl,
    `/api/projects/${OTHER_PROJECT_ID}/monitoring/events?after=${encodeURIComponent(firstCursorToken)}`,
  );
  assertStatus(crossProjectCursor, 409, "EVENT_CURSOR_PROJECT_MISMATCH");
  assert.equal(crossProjectCursor.payload.resync, true);
  checks.push("durable SSE cursor rejects a token bound to another project");
  if (initialReplayPassed && reconnectPassed) {
    checks.push(
      "durable SSE replay resumes from persisted fixture project ordinals 1 through 3",
    );
  }

  const statusResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace`,
  );
  assertStatus(statusResult, 200);
  assert.equal(statusResult.payload.projectConfigured, true);
  assert.equal(statusResult.payload.writeAvailable, true);
  assert.equal(statusResult.payload.databaseConfigured, true);
  const otherStatusResult = await apiRequest(
    baseUrl,
    `/api/projects/${OTHER_PROJECT_ID}/workspace`,
  );
  assertStatus(otherStatusResult, 200);
  assert.equal(otherStatusResult.payload.projectConfigured, true);
  assert.equal(otherStatusResult.payload.writeAvailable, false);

  const crossOriginGrant = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants`,
    {
      method: "POST",
      body: { approval: "read_only_project_root" },
      origin: "https://cross-origin.invalid",
      fetchSite: "cross-site",
    },
  );
  assertStatus(crossOriginGrant, 403, "ORIGIN_NOT_ALLOWED");

  const readGrantResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants`,
    { method: "POST", body: { approval: "read_only_project_root" } },
  );
  assertStatus(readGrantResult, 201);
  assert.equal(readGrantResult.payload.access, "read_only");
  assert.equal(readGrantResult.payload.scope, "project_root");
  const readGrantId = String(readGrantResult.payload.grantId);

  const listResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/list?path=notes`,
  );
  assertStatus(listResult, 200);
  const listedEntries = listResult.payload.entries as Array<JsonRecord>;
  assert.ok(listedEntries.some((entry) => entry.name === "readme.txt"));
  assert.equal(
    JSON.stringify(listResult.payload).includes(fixtureProjectRoot),
    false,
  );
  assert.equal(
    listedEntries.some(
      (entry) => entry.name === ".env" || entry.name === "credentials.txt",
    ),
    false,
  );
  assert.equal(
    listedEntries.some((entry) => entry.name === "outside-link.txt"),
    false,
  );

  const readResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/read?path=notes/readme.txt`,
  );
  assertStatus(readResult, 200);
  assert.equal(readResult.payload.content, "workspace searchneedle fixture\n");

  const traversalRead = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/read?path=${encodeURIComponent("../outside-secret.txt")}`,
  );
  assertStatus(traversalRead, 400, "INVALID_PATH");
  assert.equal(JSON.stringify(traversalRead.payload).includes(tempRoot), false);

  const absoluteRead = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/read?path=${encodeURIComponent(outsideFixturePath)}`,
  );
  assertStatus(absoluteRead, 400, "INVALID_PATH");
  assert.equal(JSON.stringify(absoluteRead.payload).includes(tempRoot), false);

  const secretRead = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/read?path=.env`,
  );
  assertStatus(secretRead, 404, "SECRET_PATH_DENIED");

  const symlinkRead = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/read?path=notes/outside-link.txt`,
  );
  assertStatus(symlinkRead, 404, "PATH_NOT_ALLOWED");

  const searchResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/search?q=searchneedle`,
  );
  assertStatus(searchResult, 200);
  const matches = searchResult.payload.matches as Array<JsonRecord>;
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.path, "notes/readme.txt");

  const outsideSearch = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/search?q=R5_OUTSIDE_WORKSPACE_SECRET_MARKER`,
  );
  assertStatus(outsideSearch, 200);
  assert.deepEqual(outsideSearch.payload.matches, []);

  const crossProjectFile = await apiRequest(
    baseUrl,
    `/api/projects/${OTHER_PROJECT_ID}/workspace/grants/${readGrantId}/list?path=notes`,
  );
  assertStatus(crossProjectFile, 404, "GRANT_NOT_FOUND");

  const otherGrantResult = await apiRequest(
    baseUrl,
    `/api/projects/${OTHER_PROJECT_ID}/workspace/grants`,
    { method: "POST", body: { approval: "read_only_project_root" } },
  );
  assertStatus(otherGrantResult, 201);
  const otherGrantId = String(otherGrantResult.payload.grantId);
  const reverseCrossProjectFile = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${otherGrantId}/list?path=notes`,
  );
  assertStatus(reverseCrossProjectFile, 404, "GRANT_NOT_FOUND");
  const otherProjectRead = await apiRequest(
    baseUrl,
    `/api/projects/${OTHER_PROJECT_ID}/workspace/grants/${otherGrantId}/read?path=notes/other-project.txt`,
  );
  assertStatus(otherProjectRead, 200);
  assert.equal(otherProjectRead.payload.content, "second project fixture\n");

  const readGrantWriteAttempt = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/patches`,
    {
      method: "POST",
      body: {
        path: "notes/approved.txt",
        content: "read grant cannot write\n",
        source: "user_editor",
      },
    },
  );
  assertStatus(readGrantWriteAttempt, 503, "WRITE_NOT_CONFIGURED");
  checks.push(
    "HTTP workspace list/read/search enforce traversal, absolute-path, symlink, secret-file, and project-bound grant protections",
  );

  const missingWriteApproval = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/write`,
    { method: "POST", body: {} },
  );
  assertStatus(missingWriteApproval, 400, "WRITE_APPROVAL_REQUIRED");

  const writeGrantResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/write`,
    {
      method: "POST",
      body: { approval: "workspace_write_project_root" },
    },
  );
  assertStatus(writeGrantResult, 201);
  assert.equal(writeGrantResult.payload.access, "workspace_write");
  assert.equal(writeGrantResult.payload.scope, "project_root");
  const writeGrantId = String(writeGrantResult.payload.grantId);
  const writeBase = `/api/projects/${PROJECT_ID}/workspace/grants/${writeGrantId}`;

  const approvedProposalResult = await apiRequest(
    baseUrl,
    `${writeBase}/patches`,
    {
      method: "POST",
      body: {
        path: "notes/approved.txt",
        content: "after approval\n",
        source: "user_editor",
      },
    },
  );
  assertStatus(approvedProposalResult, 201);
  const approvedProposal = approvedProposalResult.payload;
  const approvedPatchId = String(approvedProposal.patchId);
  assert.equal(approvedProposal.status, "proposed");
  assert.equal(approvedProposal.beforeContent, "before approval\n");
  assert.equal(approvedProposal.proposedContent, "after approval\n");

  const diffResult = await apiRequest(
    baseUrl,
    `${writeBase}/patches/${approvedPatchId}`,
  );
  assertStatus(diffResult, 200);
  assert.equal(diffResult.payload.patchId, approvedPatchId);
  assert.equal(typeof diffResult.payload.diff, "string");
  assert.match(String(diffResult.payload.diff), /before approval/u);
  assert.match(String(diffResult.payload.diff), /after approval/u);
  assert.equal(
    JSON.stringify(diffResult.payload).includes(fixtureProjectRoot),
    false,
  );

  const approveResult = await apiRequest(
    baseUrl,
    `${writeBase}/patches/${approvedPatchId}/approve`,
    { method: "POST", body: { approval: "apply_exact_patch" } },
  );
  assertStatus(approveResult, 200);
  const applied = approveResult.payload.patch as JsonRecord;
  assert.equal(applied.status, "approved");
  assert.equal(
    readFileSync(join(fixtureProjectRoot, "notes", "approved.txt"), "utf8"),
    "after approval\n",
  );

  const rejectedProposal = await apiRequest(baseUrl, `${writeBase}/patches`, {
    method: "POST",
    body: {
      path: "notes/rejected.txt",
      content: "must not be applied\n",
      source: "user_editor",
    },
  });
  assertStatus(rejectedProposal, 201);
  const rejectedPatchId = String(rejectedProposal.payload.patchId);
  const rejectResult = await apiRequest(
    baseUrl,
    `${writeBase}/patches/${rejectedPatchId}/reject`,
    { method: "POST", body: { decision: "reject_patch" } },
  );
  assertStatus(rejectResult, 200);
  assert.equal(rejectResult.payload.status, "rejected");
  assert.equal(
    readFileSync(join(fixtureProjectRoot, "notes", "rejected.txt"), "utf8"),
    "keep unchanged\n",
  );

  const rollbackProposal = await apiRequest(baseUrl, `${writeBase}/patches`, {
    method: "POST",
    body: {
      path: "notes/rollback.txt",
      content: "temporary approved content\n",
      source: "user_editor",
    },
  });
  assertStatus(rollbackProposal, 201);
  const rollbackPatchId = String(rollbackProposal.payload.patchId);
  const rollbackApprove = await apiRequest(
    baseUrl,
    `${writeBase}/patches/${rollbackPatchId}/approve`,
    { method: "POST", body: { approval: "apply_exact_patch" } },
  );
  assertStatus(rollbackApprove, 200);
  const rollbackResult = await apiRequest(
    baseUrl,
    `${writeBase}/patches/${rollbackPatchId}/rollback`,
    { method: "POST", body: { approval: "restore_exact_before_bytes" } },
  );
  assertStatus(rollbackResult, 200);
  const rolledBack = rollbackResult.payload.patch as JsonRecord;
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(
    readFileSync(join(fixtureProjectRoot, "notes", "rollback.txt"), "utf8"),
    "rollback before\n",
  );

  const conflictProposal = await apiRequest(baseUrl, `${writeBase}/patches`, {
    method: "POST",
    body: {
      path: "notes/conflict.txt",
      content: "proposed content\n",
      source: "user_editor",
    },
  });
  assertStatus(conflictProposal, 201);
  const conflictPatchId = String(conflictProposal.payload.patchId);
  writeFileSync(
    join(fixtureProjectRoot, "notes", "conflict.txt"),
    "concurrent fixture edit\n",
    { mode: 0o600 },
  );
  const conflictResult = await apiRequest(
    baseUrl,
    `${writeBase}/patches/${conflictPatchId}/approve`,
    { method: "POST", body: { approval: "apply_exact_patch" } },
  );
  assertStatus(conflictResult, 409, "PATCH_CONFLICT");
  assert.equal(
    readFileSync(join(fixtureProjectRoot, "notes", "conflict.txt"), "utf8"),
    "concurrent fixture edit\n",
  );
  checks.push(
    "HTTP workspace proposal diff, explicit approval, rejection, conflict protection, and rollback verified",
  );

  writeFileSync(markerFile, "900001\n", { mode: 0o600 });
  const expiredGrantResult = await apiRequest(
    baseUrl,
    `/api/projects/${PROJECT_ID}/workspace/grants/${readGrantId}/read?path=notes/readme.txt`,
  );
  assertStatus(expiredGrantResult, 410, "GRANT_EXPIRED");
  checks.push(
    "HTTP workspace expired grant rejected after isolated server clock advance",
  );

  assert.equal(serverEnv.PROMPTLAB_CAMPUS_API_KEY, "");
  assert.equal(serverEnv.OPENAI_API_KEY, "");
  assert.equal(serverEnv.ANTHROPIC_API_KEY, "");
  checks.push(
    "no worker or provider route invoked; provider credential variables blank or absent",
  );
  if (runtimeIssues.length > 0) process.exitCode = 1;

  process.stdout.write(
    `${JSON.stringify(
      {
        result: runtimeIssues.length === 0 ? "passed" : "failed",
        node: process.versions.node,
        buildId,
        postgresImage: POSTGRES_IMAGE,
        durableCursorCreatedAtType,
        database:
          "fresh tmpfs-only container, loopback publication, migrations applied",
        providerCalls: 0,
        checks,
        runtimeIssues,
        csvBoundary:
          "CSV is client-generated from the real HTTP request-log response; no CSV HTTP route exists.",
        cleanup:
          "owned Next server, PostgreSQL container, fixture directory, and private dist copy removed",
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`R5 isolated API integration failed:\n${message}\n`);
  process.stderr.write(
    `Partial verification state: ${JSON.stringify(
      { checks, durableCursorCreatedAtType, runtimeIssues },
      null,
      2,
    )}\n`,
  );
  if (serverLog) {
    const replacementPaths = [dbUrl, fixtureRoot, tempRoot ?? ""];
    const tail = serverLogTail(serverLog, replacementPaths);
    if (tail) process.stderr.write(`Isolated Next server log tail:\n${tail}\n`);
  }
  process.exitCode = 1;
} finally {
  await stopChild(server);
  if (containerName && dockerConfig && tempRoot && dockerAvailable) {
    try {
      run(
        "docker",
        dockerArgs(dockerConfig, ["stop", "--time", "3", containerName]),
        { cwd: ROOT, env: executableEnv(tempRoot) },
      );
    } catch {
      // Force removal below also stops a container that did not stop cleanly.
    }
    try {
      run("docker", dockerArgs(dockerConfig, ["rm", "-f", containerName]), {
        cwd: ROOT,
        env: executableEnv(tempRoot),
      });
    } catch {
      // The owned container may already have been removed.
    }
  }
  if (privateDist) rmSync(privateDist, { recursive: true, force: true });
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}
