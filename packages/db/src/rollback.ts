import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const connectionString = process.env.PROMPTLAB_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "Set PROMPTLAB_DATABASE_URL to the isolated local PromptLab database before rollback.",
  );
}
if (process.env.PROMPTLAB_ALLOW_DESTRUCTIVE_ROLLBACK !== "1") {
  throw new Error(
    "Rollback requires PROMPTLAB_ALLOW_DESTRUCTIVE_ROLLBACK=1 after verifying the isolated target.",
  );
}

const databaseUrl = new URL(connectionString);
const port = databaseUrl.port || "5432";
if (
  !["127.0.0.1", "localhost", "::1"].includes(databaseUrl.hostname) ||
  databaseUrl.pathname !== "/promptlab" ||
  !["55432", "56432"].includes(port)
) {
  throw new Error(
    "Rollback is restricted to the project-local promptlab database on loopback port 55432 or 56432.",
  );
}
if (
  port === "56432" &&
  process.env.PROMPTLAB_CONFIRM_DISPOSABLE_INTEGRATION !== "1"
) {
  throw new Error(
    "Port 56432 is reserved for the disposable docker-compose.integration.yml database; set PROMPTLAB_CONFIRM_DISPOSABLE_INTEGRATION=1 only for that isolated volume.",
  );
}

const expectedTables = [
  "chunks",
  "document_versions",
  "documents",
  "graph_active_snapshots",
  "graph_assertion_versions",
  "graph_assertions",
  "graph_builds",
  "graph_entities",
  "graph_evidence",
  "graph_mentions",
  "graph_query_traces",
  "graph_snapshot_assertions",
  "graph_snapshots",
  "model_attempts",
  "outbox",
  "projects",
  "prompt_versions",
  "prompts",
  "provider_connections",
  "run_events",
  "runs",
  "usage_records",
];

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
const client = await pool.connect();

try {
  const migrationTable = await client.query<{ exists: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations') as exists",
  );
  if (!migrationTable.rows[0]?.exists) {
    throw new Error(
      "Rollback refused: the PromptLab migration journal is absent.",
    );
  }
  const migrationCount = await client.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations",
  );
  if (migrationCount.rows[0]?.count !== "1") {
    throw new Error(
      "Rollback refused: expected exactly the single foundation migration.",
    );
  }
  const tables = await client.query<{ tablename: string }>(
    `select tablename from pg_tables
     where schemaname = 'public' and tablename <> '__drizzle_migrations'
     order by tablename`,
  );
  const actualTables = tables.rows.map((row) => row.tablename);
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new Error(
      "Rollback refused: public schema contains tables outside the reviewed foundation migration.",
    );
  }

  const rollbackSql = await readFile(
    fileURLToPath(
      new URL(
        "../drizzle/rollback/0000_secret_madame_hydra.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  await client.query(rollbackSql);
  process.stdout.write(
    "PromptLab foundation rollback applied to the guarded local database.\n",
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  const message =
    error instanceof Error ? error.message : "unknown rollback error";
  process.stderr.write(`PromptLab rollback stopped safely: ${message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
