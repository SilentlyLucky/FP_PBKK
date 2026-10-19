# Monitoring database verification

**Checked:** 2026-10-16

## Result

Passed the durable cursor PostgreSQL integration test against a fresh throwaway database. The test applied migrations `0000_secret_madame_hydra.sql`, `0001_milky_vertigo.sql`, and `0002_shallow_tinkerer.sql` only inside that fixture.

The final command was:

```sh
MONITORING_CURSOR_TEST_PORT=48893 corepack pnpm --dir packages/db exec vitest run src/monitoring-event-outbox.integration.test.ts
```

Result: **1 test file passed, 1 test passed** (`vitest 5.0.3`).

## Isolated fixture

- No local `postgres`, `initdb`, or `pg_ctl` executable was found; `/usr/bin/psql` and `/usr/bin/docker` were present.
- Docker already had `postgres:16-alpine` available locally (`cf78e76683b9`); it was run with `--pull=never`.
- The new container was `monitoring-cursor-verification-20261016T112146-663020`. PostgreSQL was published only on `127.0.0.1:48893`.
- The container used a fresh `/var/lib/postgresql/data` tmpfs, no mounted volume, and `--rm`. It created only the test's fixed `monitoring_test` database and `monitoring_test` user, with trust authentication confined to the loopback-published fixture.
- The test code connects to `127.0.0.1` using that fixed database/user and the supplied port. No `.env`, existing database URL, application database, or existing container/volume was used.

## Covered behavior

- Historical events receive deterministic per-project ordinals ordered by `(created_at, id)`.
- The two pre-migration `run_events` rows retain every stored column through the migration: ID, project, run, sequence, type, attempt, payload, and timestamp. This assertion was expanded because the original test checked only IDs and sequences.
- A second transaction waits while the first holds the counter row lock; after commits, their outbox ordinals follow commit order.
- Rolling back an event also rolls back its outbox mapping and counter increment; the next committed event reuses the ordinal.
- Counters are isolated by project, and outbox metadata remains after the test deliberately deletes a source event to simulate retention.

This is a database-level verification of the durable replay source and ordering. It does not exercise the Monitoring HTTP/SSE route.

## Cleanup and database boundary

The disposable container was stopped by the command's cleanup trap and removed by Docker's `--rm`; its PostgreSQL data lived only in tmpfs. Migration `0002_shallow_tinkerer.sql` remains unapplied to any application or user database.
