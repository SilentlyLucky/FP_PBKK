# Monitoring durable cursor

**Status:** Implementation and isolated PostgreSQL verification are ready. Applying migration `0002_shallow_tinkerer.sql` to an existing application database remains pending authorization.

## Design

The additive migration creates `monitoring_event_counters` and `monitoring_event_outbox`. The outbox contains only the event ID, project ID, and a per-project `bigint` ordinal. It does not replace `run_events`, read event payloads, or require changes to event writers.

An `AFTER INSERT` trigger updates the project's counter and inserts the outbox mapping in the caller's transaction. The counter row lock remains held through commit or rollback. A later transaction for the same project waits before allocating its ordinal, so it cannot commit a higher ordinal before the transaction holding the lower ordinal commits. A rollback removes both the `run_events` insertion and its counter/outbox changes.

The migration takes a `SHARE ROW EXCLUSIVE` lock on `run_events` before backfill. This blocks event writes while existing visible rows are assigned ordinals in `(created_at, id)` order and counters are initialized; reads remain available. The current Drizzle PostgreSQL migrator executes each migration in a transaction, so the lock remains until the trigger is installed and the migration commits. The migration does not update or delete historical events or other user data.

Outbox mappings intentionally have no foreign key to `run_events`. If event retention removes an event row, the mapping remains and the stream reports `EVENT_RETAINED`. Missing ordinals, missing trailing mappings, and cursors from another project also produce an explicit resync state instead of silently advancing.

## Runtime behavior

The events route checks for both outbox tables before selecting a mode. Its `x-monitoring-cursor-mode` response header is `durable-v2` only when the required schema exists; without it, the route uses the current bounded legacy stream and reports `bounded-legacy`.

Durable cursor tokens contain version `2`, `projectId`, the outbox `eventId`, and an exact decimal `ordinal`. The decimal value is validated against PostgreSQL's signed `bigint` range and stays a string through JSON and SQL boundaries. Reconnects validate the project and stored outbox mapping. Legacy timestamp cursors can be translated to an outbox ordinal within the resolved project. A durable token received before the migration is available returns `DURABLE_EVENT_CURSOR_UNSUPPORTED`; a cursor that cannot be resolved returns a resync response.

The durable stream compares each requested ordinal against an ordered outbox page and its high-water value read in the same SQL statement. It emits `monitoring.resync-required` with `resync: true` if it detects a retention gap. Reconnects use the durable ordinal and do not depend on `created_at` ordering. The bounded legacy behavior remains available for databases where the migration has not been applied.

## Verification

- Cursor and stream unit tests cover exact ordinals above JavaScript's safe integer range, malformed/out-of-range values, project binding, missing ordinals, removed event rows, and legacy reconnect behavior.
- Route tests cover schema detection, the bounded fallback header, unsupported durable tokens, project mismatch, and translation of a legacy cursor into the durable mode.
- `packages/db/src/monitoring-event-outbox.integration.test.ts` is opt-in through `MONITORING_CURSOR_TEST_PORT`. It connects only to the fixed `monitoring_test` database on loopback and refuses to migrate unless the `public` schema has no tables. It verifies deterministic backfill, project isolation, real PostgreSQL lock ordering for a delayed transaction, rollback atomicity and ordinal reuse, and retention metadata.
- Verification uses a uniquely named disposable PostgreSQL container. No existing application database, worker, provider, or current service data is used or modified.

Until an authorized deployment applies the migration, the route remains on bounded legacy replay and cannot guarantee delivery for arbitrarily late commits. The durable mode is ready to activate automatically after the migration is applied.
