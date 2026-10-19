# Knowledge local service integration coverage

**Date:** 2026-10-19, Asia/Jakarta (checks completed at 04:21 UTC+07:00)

## Result

All 20 local PostgreSQL/Redis integration tests that were skipped by the opted-out root run passed when run individually with their service gates enabled. The two mixed files also passed their ordinary unit tests. Final targeted result: **41 passed, 0 failed, 0 skipped** across nine files (20 gated integration tests and 21 ordinary tests).

The latest full opted-out root run recorded in `/tmp/promptlab-final-regression-livefix-20261019.log` remains **650 passed, 20 skipped** across **81 passed and 7 skipped files**. Those 20 gated tests span nine files: seven files contain only gated tests and are reported as skipped files; the Graphify route and controlled-evaluation files also contain ordinary tests, so Vitest classifies those files as passed.

| Test file                                                                                                                 | Gated tests |               Targeted file result |
| ------------------------------------------------------------------------------------------------------------------------- | ----------: | ---------------------------------: |
| `packages/db/src/foundation.integration.test.ts`                                                                          |           1 |                           1 passed |
| `packages/db/src/monitoring-event-outbox.integration.test.ts`                                                             |           1 |                           1 passed |
| `apps/worker/src/queue.integration.test.ts`                                                                               |           1 |                           1 passed |
| `packages/db/src/graphify-import.integration.test.ts`                                                                     |           2 |                           2 passed |
| `packages/db/src/knowledge-lifecycle.integration.test.ts`                                                                 |           9 |                           9 passed |
| `apps/worker/src/graph-build.integration.test.ts`                                                                         |           3 |                           3 passed |
| `apps/web/src/app/api/projects/[projectId]/graph/graphify-import/route.test.ts`                                           |           1 |   7 passed (6 unit, 1 integration) |
| `apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/controlled-evaluation-eligibility.test.ts` |           1 | 16 passed (15 unit, 1 integration) |
| `evals/src/knowledge-runtime.integration.test.ts`                                                                         |           1 |                           1 passed |
| **Total**                                                                                                                 |      **20** |                      **41 passed** |

## Commands and gate configuration

Each file was run separately with:

```text
rtk proxy corepack pnpm exec vitest run --reporter=verbose <test-file>
```

Migrated disposable knowledge databases were prepared with:

```text
rtk proxy corepack pnpm --filter @promptlab/db db:migrate
```

The foundation test has a specific 22-table precondition. Its disposable database used `0000_secret_madame_hydra.sql` and `0001_milky_vertigo.sql`; migration `0002_shallow_tinkerer.sql` adds the two monitoring tables and is not part of that 22-table foundation fixture. The monitoring migration test used its own fresh `monitoring_test` database and applied its migrations itself.

The per-file environment gates were:

- Foundation: `PROMPTLAB_INTEGRATION_TESTS=1` and `PROMPTLAB_DATABASE_URL=postgresql://[credentials redacted]@127.0.0.1:56432/promptlab`.
- Monitoring outbox: `MONITORING_CURSOR_TEST_PORT=56432`.
- Redis queue: `PROMPTLAB_INTEGRATION_TESTS=1` and `PROMPTLAB_REDIS_URL=redis://[credentials redacted]@127.0.0.1:57379/0`.
- Graphify DB, knowledge lifecycle, graph build, Graphify route, and controlled evaluation: `PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS=1` and `PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL=postgresql://[credentials redacted]@127.0.0.1:56432/promptlab_knowledge_test_<32 hex>`.
- Runtime knowledge evaluation: `PROMPTLAB_KNOWLEDGE_EVALUATION_INTEGRATION_TESTS=1` and `PROMPTLAB_KNOWLEDGE_EVALUATION_TEST_DATABASE_URL=postgresql://[credentials redacted]@127.0.0.1:56432/promptlab_knowledge_eval_<32 hex>`.

All `PROMPTLAB_PROVIDER_*` opt-ins and Campus, Codex, and OpenAI credential/model variables were removed from test environments. `CODEX_HOME` pointed to an empty temporary directory. The provider verification campaign stayed unset. Graph-build and runtime-evaluation tests used injected mock providers; the queue test explicitly verifies a local job without invoking a provider. No live generation test ran.

## Services, isolation, and cleanup

- PostgreSQL 16 Alpine and Redis 7 Alpine were started from the digests pinned in `docker-compose.integration.yml`, each under a unique temporary container name and bound only to `127.0.0.1`.
- Ports 56432 and 57379 were free before startup and are required by the test guards. They were separate from the running app services on ports 55432 and 56379.
- PostgreSQL data used container-local temporary storage. Random passwords were kept in private temporary files/environment values; Redis configuration was readable only inside a mode-700 temporary directory. No credential value appeared in output or this report.
- The main run created and then dropped eight disposable databases: `promptlab`, `monitoring_test`, five UUID-named `promptlab_knowledge_test_*` databases, and one UUID-named `promptlab_knowledge_eval_*` database. A corrected foundation rerun used its own temporary `promptlab` database and dropped it.
- Both owned services, all owned databases, and temporary credential/config files were removed. A final check found ports 56432 and 57379 free. The pre-existing stopped container `promptlab-foundation-integration-postgres-1` was observed and left untouched.

One initial foundation attempt used the full current migration set and failed its setup guard because that set includes the two monitoring tables. The fixture was corrected to match the test's explicit 22-table precondition, and the foundation test then passed without changing code or assertions. Two earlier Redis setup probes also failed before any tests ran; their owned containers and temporary files were removed before the successful run.

The workspace has no Git metadata (`git status` reported “Not a git repository”), so no Git diff was available. No production or test source files were changed. Atlas reported a stale snapshot; it was not refreshed, and no vault writes were made.

## Remaining coverage

No safe local PostgreSQL/Redis knowledge-flow gate from the opted-out root suite remains skipped. Live Campus/Codex generation remains intentionally untested in this run; those tests were outside this local-service coverage and their opt-ins and credentials stayed disabled.
