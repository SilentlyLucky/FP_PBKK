# Provider campaign ledger verification

## Result

The campaign selector `PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN` resolves a
valid campaign ID to the deterministic path
`<base-ledger-directory>/provider-verification-campaigns/<campaign-id>.json`.
Campaign IDs must contain exactly 32 lowercase letters, digits, or internal
hyphens, with a lowercase letter or digit at each end. Invalid IDs fail before
path resolution. A campaign ledger whose stored ID does not match the selected
ID fails closed without changing the ledger.

Campaign initialization is durable: the ledger is created once, and an
`.initialized` sidecar prevents a missing ledger from restoring a default
budget. The historical smoke ledger remains capped at two reserved calls per
provider. Named campaign ceilings are stored per provider in
`maxInferenceCallsByProvider`, support up to 110 calls per provider, and are
reserved before provider requests. Without the campaign variable, the
historical ledger is selected. Compose sets `PROMPTLAB_PROVIDER_LEDGER_PATH`
for web and worker to a shared persistent `provider-ledger-data` volume so the
runtime UID can read, lock, and update it across restarts. The local default
remains `docs/PROVIDER_SMOKE_LEDGER.json`.

The focused suite passed the campaign path, invalid ID, mismatched ID,
concurrent reservation, restart persistence, deleted-ledger, and import-time
selection checks. For the legacy check, it copies the canonical ledger bytes
into a temporary project and verifies the copy remains unchanged with no
campaign, an invalid campaign, and a valid campaign. The canonical ledger is
read only as fixture input by that test; the test writes to temporary paths.
No live provider inference was run.

The active Flow 1 follow-up campaign
`flow1-live-20261018-000000000001` was extended in place to Campus `8` and
Codex `9` reservations after the first incomplete live run. Existing counters
remain Campus `5` and Codex `3`; a rerun must use this ledger and those
remaining budgets. The Flow 2 campaign and historical smoke ledger are not
changed.

## Verification

Verification commands ran from `/home/lenovo/FP_PBKK` using the project-pinned
`corepack pnpm` command.

| Check                      | Command                                                                                                                                                                                                                                                                                                                                                                                                       | Result                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Focused ledger test        | `rtk proxy corepack pnpm exec vitest run tools/provider-smoke/ledger.test.mts`                                                                                                                                                                                                                                                                                                                                | Vitest 5.0.3: 1 test file passed; 19 tests passed; exit 0. Vite printed a non-failing config-loader warning. |
| Provider package typecheck | `rtk proxy corepack pnpm --filter @promptlab/providers typecheck`                                                                                                                                                                                                                                                                                                                                             | Exit 0; no diagnostics.                                                                                      |
| Focused lint               | `rtk proxy corepack pnpm exec eslint packages/providers/src/provider-smoke-ledger.ts tools/provider-smoke/ledger.test.mts evals/src/knowledge-shards.test.ts evals/src/knowledge-evaluation.test.ts evals/src/index.test.ts evals/src/knowledge-runtime.integration.test.ts`                                                                                                                                  | Exit 0; no diagnostics.                                                                                      |
| Focused formatting         | `rtk proxy corepack pnpm exec prettier --check packages/providers/src/provider-smoke-ledger.ts tools/provider-smoke/ledger.test.mts evals/src/knowledge-shards.test.ts evals/src/knowledge-evaluation.test.ts evals/src/index.test.ts evals/src/knowledge-runtime.integration.test.ts docs/implementation/FLOW0_EVALUATION_MANIFEST_REPORT_20261019.md docs/implementation/PROVIDER_CAMPAIGN_VERIFICATION.md` | Exit 0; all checked files use Prettier style.                                                                |

Source SHA-256 for `packages/providers/src/provider-smoke-ledger.ts`:

```text
e1b629c28eefb25ab34012414de522b8b947cd92a633cb36310af678268b456e
```
