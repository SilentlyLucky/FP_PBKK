import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testPort = process.env.MONITORING_CURSOR_TEST_PORT;
const projectId = "10111111-1111-4111-8111-111111111111";
const runId = "20222222-2222-4222-8222-222222222222";
const secondProjectId = "30333333-3333-4333-8333-333333333333";
const secondRunId = "40444444-4444-4444-8444-444444444444";
const oldEventA = "50555555-5555-4555-8555-555555555551";
const oldEventB = "50555555-5555-4555-8555-555555555552";
const delayedEvent = "60666666-6666-4666-8666-666666666661";
const waitingEvent = "60666666-6666-4666-8666-666666666662";
const rolledBackEvent = "70777777-7777-4777-8777-777777777771";
const committedAfterRollbackEvent = "70777777-7777-4777-8777-777777777772";
const secondProjectEvent = "80888888-8888-4888-8888-888888888881";

async function insertEvent(
  client: PoolClient,
  id: string,
  sequence: number,
  createdAt?: string,
) {
  await client.query(
    `INSERT INTO public.run_events
       (id, project_id, run_id, sequence, event_type, created_at)
     VALUES ($1, $2, $3, $4, 'run.status', COALESCE($5::timestamptz, now()))`,
    [id, projectId, runId, sequence, createdAt ?? null],
  );
}

describe.skipIf(!testPort)(
  "monitoring event outbox PostgreSQL migration",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({
        host: "127.0.0.1",
        port: Number(testPort),
        user: "monitoring_test",
        database: "monitoring_test",
        max: 4,
        connectionTimeoutMillis: 3_000,
      });
      const client = await pool.connect();
      try {
        const database = await client.query<{ current_database: string }>(
          "SELECT current_database()",
        );
        if (database.rows[0]?.current_database !== "monitoring_test") {
          throw new Error(
            "The migration test requires its isolated test database.",
          );
        }
        const existingSchema = await client.query<{ table_count: number }>(
          "SELECT count(*)::int AS table_count FROM pg_tables WHERE schemaname = 'public'",
        );
        if (existingSchema.rows[0]?.table_count !== 0) {
          throw new Error(
            "The migration test refuses to run unless the database is fresh.",
          );
        }

        for (const migration of [
          "0000_secret_madame_hydra.sql",
          "0001_milky_vertigo.sql",
        ]) {
          const contents = await readFile(
            new URL(`../drizzle/${migration}`, import.meta.url),
            "utf8",
          );
          await client.query(contents);
        }

        await client.query(
          `INSERT INTO public.projects (id, name)
         VALUES ($1, 'outbox migration fixture')`,
          [projectId],
        );
        await client.query(
          `INSERT INTO public.runs
           (id, project_id, purpose, provider, requested_model, idempotency_key)
         VALUES ($1, $2, 'target', 'fixture', 'migration-test', 'outbox-fixture-1')`,
          [runId, projectId],
        );
        await insertEvent(client, oldEventA, 1, "2024-01-02T00:00:00Z");
        await insertEvent(client, oldEventB, 2, "2024-01-01T00:00:00Z");

        const migration = await readFile(
          new URL("../drizzle/0002_shallow_tinkerer.sql", import.meta.url),
          "utf8",
        );
        await client.query("BEGIN");
        try {
          await client.query(migration);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } finally {
        client.release();
      }
    }, 20_000);

    afterAll(async () => {
      await pool?.end();
    });

    it("backfills deterministically and serializes commits with rollback-safe ordinals", async () => {
      const before = await pool.query<{
        id: string;
        project_id: string;
        run_id: string;
        sequence: number;
        event_type: string;
        attempt_id: string | null;
        payload: string;
        created_at: string;
      }>(
        `SELECT id::text, project_id::text, run_id::text, sequence,
                event_type, attempt_id::text, payload::text,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM public.run_events
       WHERE project_id = $1 ORDER BY sequence`,
        [projectId],
      );
      expect(before.rows).toEqual([
        {
          id: oldEventA,
          project_id: projectId,
          run_id: runId,
          sequence: 1,
          event_type: "run.status",
          attempt_id: null,
          payload: "{}",
          created_at: "2024-01-02T00:00:00Z",
        },
        {
          id: oldEventB,
          project_id: projectId,
          run_id: runId,
          sequence: 2,
          event_type: "run.status",
          attempt_id: null,
          payload: "{}",
          created_at: "2024-01-01T00:00:00Z",
        },
      ]);

      const backfilled = await pool.query<{
        ordinal: string;
        event_id: string;
      }>(
        `SELECT ordinal::text, event_id::text
       FROM public.monitoring_event_outbox
       WHERE project_id = $1 ORDER BY ordinal`,
        [projectId],
      );
      expect(backfilled.rows).toEqual([
        { ordinal: "1", event_id: oldEventB },
        { ordinal: "2", event_id: oldEventA },
      ]);

      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query("BEGIN");
        await insertEvent(first, delayedEvent, 3);
        await second.query("BEGIN");
        let secondInsertSettled = false;
        const waitingInsert = insertEvent(second, waitingEvent, 4).then(() => {
          secondInsertSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const waitedForFirstCommit = !secondInsertSettled;

        await first.query("COMMIT");
        await waitingInsert;
        await second.query("COMMIT");
        expect(waitedForFirstCommit).toBe(true);

        const ordered = await pool.query<{
          ordinal: string;
          event_id: string;
        }>(
          `SELECT ordinal::text, event_id::text
         FROM public.monitoring_event_outbox
         WHERE project_id = $1 AND event_id = ANY($2::uuid[])
         ORDER BY ordinal`,
          [projectId, [delayedEvent, waitingEvent]],
        );
        expect(ordered.rows).toEqual([
          { ordinal: "3", event_id: delayedEvent },
          { ordinal: "4", event_id: waitingEvent },
        ]);

        await first.query("BEGIN");
        await insertEvent(first, rolledBackEvent, 5);
        const pendingOrdinal = await first.query<{ ordinal: string }>(
          `SELECT ordinal::text FROM public.monitoring_event_outbox
         WHERE project_id = $1 AND event_id = $2`,
          [projectId, rolledBackEvent],
        );
        expect(pendingOrdinal.rows[0]?.ordinal).toBe("5");
        await first.query("ROLLBACK");

        const afterRollback = await pool.query<{
          last_ordinal: string;
          event_count: string;
        }>(
          `SELECT counters.last_ordinal::text,
                (SELECT count(*)::text FROM public.monitoring_event_outbox
                 WHERE project_id = $1 AND event_id = $2) AS event_count
         FROM public.monitoring_event_counters AS counters
         WHERE counters.project_id = $1`,
          [projectId, rolledBackEvent],
        );
        expect(afterRollback.rows[0]).toEqual({
          last_ordinal: "4",
          event_count: "0",
        });

        await insertEvent(first, committedAfterRollbackEvent, 5);
        const reusedOrdinal = await pool.query<{ ordinal: string }>(
          `SELECT ordinal::text FROM public.monitoring_event_outbox
         WHERE project_id = $1 AND event_id = $2`,
          [projectId, committedAfterRollbackEvent],
        );
        expect(reusedOrdinal.rows[0]?.ordinal).toBe("5");

        await pool.query(
          `INSERT INTO public.projects (id, name)
         VALUES ($1, 'outbox second project fixture')`,
          [secondProjectId],
        );
        await pool.query(
          `INSERT INTO public.runs
           (id, project_id, purpose, provider, requested_model, idempotency_key)
         VALUES ($1, $2, 'target', 'fixture', 'migration-test', 'outbox-fixture-2')`,
          [secondRunId, secondProjectId],
        );
        await pool.query(
          `INSERT INTO public.run_events
           (id, project_id, run_id, sequence, event_type)
         VALUES ($1, $2, $3, 1, 'run.status')`,
          [secondProjectEvent, secondProjectId, secondRunId],
        );
        const scopedCounters = await pool.query<{
          project_id: string;
          last_ordinal: string;
        }>(
          `SELECT project_id::text, last_ordinal::text
         FROM public.monitoring_event_counters
         WHERE project_id = ANY($1::uuid[]) ORDER BY project_id`,
          [[projectId, secondProjectId]],
        );
        expect(scopedCounters.rows).toEqual([
          { project_id: projectId, last_ordinal: "5" },
          { project_id: secondProjectId, last_ordinal: "1" },
        ]);

        await pool.query("DELETE FROM public.run_events WHERE id = $1", [
          oldEventB,
        ]);
        const retainedMetadata = await pool.query<{ event_id: string }>(
          `SELECT event_id::text FROM public.monitoring_event_outbox
         WHERE project_id = $1 AND event_id = $2`,
          [projectId, oldEventB],
        );
        expect(retainedMetadata.rows).toEqual([{ event_id: oldEventB }]);
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        first.release();
        second.release();
      }
    }, 20_000);
  },
);
