# Live provider validation

**Checked:** 2026-10-17  
**Outcome:** both provider verifiers and one Codex target run succeeded; the exact target text assertion remains unverified because the runner initially read the SSE event envelope at the wrong level.

## Bounded campaign

Campaign `v3-live-validation-20261017-a-01` is exactly 32 characters. Its durable ledger is `docs/provider-verification-campaigns/v3-live-validation-20261017-a-01.json` under the canonical PromptLab root. The ledger is retained as an audit record. Each provider used one of its two allowed verification reservations; the historical `docs/PROVIDER_SMOKE_LEDGER.json` was not modified.

The runner used the existing production artifact `.next-settled-validation-20261017-004750` (`BUILD_ID` `BwBHonIWg_PBxuTghNNtD`) and its campaign-aware `/api/providers` route. It created a fresh PostgreSQL 16 and Redis 7 pair using tmpfs-only storage and loopback ports, applied migrations only to that disposable database, started the production Next server and the real worker, then removed all owned resources. Credentials were read only for the selected provider and copied Codex auth ran from a private temporary `HOME`; no credential value is included here.

## Live result

| Activity                         |             Requests / jobs | Model                       | Result                                       |
| -------------------------------- | --------------------------: | --------------------------- | -------------------------------------------- |
| App HTTP                         |                          21 | —                           | All local journey requests completed         |
| Campus verifier                  |               1 reservation | `qwen3:14b` → `qwen3:14b`   | Verified; usage reported                     |
| Codex verifier                   |               1 reservation | `gpt-6-luna` → `gpt-6-luna` | Verified; usage reported                     |
| Codex target run                 | 1 POST, 1 persisted attempt | `gpt-6-luna` → `gpt-6-luna` | Run status `succeeded`; remote outcome known |
| Worker                           |              1 observed job | —                           | Processed target run                         |
| Monitoring summary / request log |                       1 / 1 | —                           | Both HTTP 200; one request visible           |

The target emitted `run.status`, `agent.action`, `usage.snapshot`, `run.completed`, and `run.stream.ended`. Its usage record had reported provenance and complete metadata, while individual token values were unavailable (`null`). The exact `OK` completion check did not pass: this runner version looked for text at the top level of the SSE envelope, while the live route nests it under `payload.text`. The parser now reads the nested body. The campaign was not repeated, so the stored result remains `observedCharacters: 0` and `exactMatch: false`; we do not claim the answer matched `OK`.

The five-minute wall covered the verifier and target requests. No timeout or unknown remote outcome occurred. The runner sent at most one verifier generation to each provider and one product generation, did not retry, did not run prompt optimization, and makes no quality-improvement claim.

## Harness fixes and preflight evidence

The first attempt used an invalid 29-character campaign ID and stopped before app startup. Later startup-only preflights found two harness defects: the Next server was launched with an unnecessary `tsx/esm` loader, then its temporary app linked to the monorepo root `node_modules` instead of `apps/web/node_modules`. Both were corrected. The final `--preflight-only` run got HTTP 200 from `/api/health`, sent zero provider requests, and cleaned up its temporary resources.

## Cleanup and remaining limit

The completed live run reported `ownedResourcesRemoved: true` with no cleanup failures. Its campaign ledger was preserved; the temporary app server, worker, database, Redis container, private build copy, and temporary home were removed. No project database or existing build output was changed.

Live Campus and Codex connectivity, Codex worker execution, persisted attempts/usage/events, and Monitoring aggregation are verified for this synthetic journey. Exact output capture needs a future bounded run to validate after the nested SSE parser fix. Optimization behavior, file changes, GraphRAG retrieval, and quality improvement were outside this run and remain unverified here.
