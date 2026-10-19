# Live provider readiness

**Checked:** 2026-10-17  
**Live inference:** none. No PromptLab web server, worker, container, or user database was started. The Codex app-server subprocess did run for the no-generation authentication/model probe.

## Provider status

| Provider | Evidence and status |
| --- | --- |
| Senopati (`campus_gateway`) | `.env` contains the names `PROMPTLAB_CAMPUS_API_KEY` and `PROMPTLAB_CAMPUS_MODEL`. No values were displayed or used for provider verification, so the configured model ID and live credential validity remain unverified. The repository has no non-generation Senopati auth probe. |
| Codex (`codex_app_server`) | The no-generation app-server probe succeeded: authenticated, protocol schema `v0.160.1` matched, and seven models were listed. Available IDs: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. No project model is selected. |

The Codex check used `account/read` and `model/list`; the account read requests `refreshToken: false`. It ran against a temporary copy of PromptLab's dedicated auth home, which was removed after the probe. The adapter mounts that home writable inside bubblewrap, so a later strict read-only check should keep using a disposable copy. A direct probe from the current home also returned `logged_in`, seven models, and `generationAttempted: false`; it uses the same writable mount.

Only environment-variable names and presence are reported. The project `.env` names also include `PROMPTLAB_DATABASE_URL` and `PROMPTLAB_REDIS_URL`. `PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS` is absent there; the code default is 90 seconds, with a 150-second maximum. No environment value was printed. The actual Senopati model ID is intentionally omitted under the names-only constraint.

## Existing checks and harnesses

- [`ISOLATED_API_VERIFICATION.md`](ISOLATED_API_VERIFICATION.md) reports 13 HTTP checks passed with zero provider calls. Its runner, [`v3-isolated-api-integration.mts`](../../tools/verification/v3-isolated-api-integration.mts), copies a production build into a private dist, starts Next on loopback, uses a fresh PostgreSQL 16 tmpfs container, synthetic project files, and a temporary app root without a repository `.env` parent, then cleans up. It deliberately blanks provider credentials and does not start Redis or the worker, so it does not verify a live provider journey.
- [`tools/verification/api-foundation-integration.mjs`](../../tools/verification/api-foundation-integration.mjs) defaults to `http://127.0.0.1:3000`; it creates project and prompt rows and submits paused runs. It makes no inference, but is safe only when its target is a disposable server/database.
- `tools/dev-stack.mjs` loads the repository `.env`, runs Compose and migrations, then starts Next and the worker. Both `docker-compose.yml` and `docker-compose.integration.yml` use named persistent volumes. These are not isolated-runner substitutes.
- The worker requires `PROMPTLAB_DATABASE_URL` and `PROMPTLAB_REDIS_URL`; BullMQ is configured for one attempt. A full queued run therefore needs a separate disposable Redis and worker in addition to PostgreSQL.
- Direct `node --version` is `v22.23.2`, matching the isolated runner. A separate package-manager wrapper invocation warned about Node `22.21.0` and timed out at 30 seconds; use native Node for the isolated harness.

## API behavior and bounds

- `GET /api/providers` is the app-level no-generation preflight. It reads provider state from PostgreSQL and performs the Codex account/model probe; it does not validate Senopati credentials against the gateway.
- `POST /api/providers` with an empty JSON object verifies Senopati through one chat-completions inference, capped at 16 output tokens, with the adapter's 30-second default timeout and no retry. It writes provider receipts to the database and reserves/updates the repository's fixed `docs/PROVIDER_SMOKE_LEDGER.json`.
- `POST /api/providers` with `action: "codex-verify"` makes one Codex generation with a 30-second timeout, then writes a receipt and updates the same ledger. The turn has an output schema but no explicit output-token cap.
- The existing smoke ledger allows two inference reservations per provider. Its current snapshot is Campus `1/2` (`succeeded`) and Codex `2/2` (`blocked_budget_exhausted`). Do not reset or bypass these counts. A Codex verifier request is currently blocked by the cap; even its blocked path updates the ledger.
- A full optimization run adds worker calls: up to five Senopati calls at 2,048 output tokens each, and up to nine Codex target calls under the worker's iteration/test-case bound. Codex target turns have a 150-second default timeout but no explicit output-token cap. Thus a full journey currently has no defensible total Codex token ceiling.

## Safe next harness

There is no existing command that runs the full provider journey safely. The reproducible approach is to adapt the isolated API runner in a separate temporary harness, without changing application code:

1. Use a unique private Docker config and fresh `--pull=never` PostgreSQL and Redis containers with tmpfs data directories, dynamically assigned loopback-only ports, and no host bind or named volumes. Apply migrations only to that PostgreSQL instance. Remove both containers and all temporary build, fixture, auth-copy, and app-root directories in `finally` cleanup.
2. Copy the known production build into a unique private dist and start Next from a temporary app root with no repository `.env` parent. Start the worker directly with native Node and an explicit environment allowlist. Set the database and Redis URLs to the disposable services; read only the two Senopati variables needed by the app in memory and never echo them. Set `HOME` to a temporary directory containing a private copy of the dedicated Codex auth home.
3. Put a temporary root `package.json` named `promptlab-foundation` under that temporary root. If a later inference budget is separately approved, use a separate fresh temporary smoke ledger capped at two reservations per provider; do not copy, reset, or otherwise change the canonical ledger. The ledger resolver searches from `process.cwd()` and has no path override, so the temporary ledger keeps API writes out of the checkout.
4. Create one synthetic project through `/api/projects`, a prompt version through the prompt APIs, and a project root with synthetic files under the temporary fixture directory. Map only that project in `PROMPTLAB_LOCAL_WORKSPACE_ROOTS`; exercise workspace status/list/read with a read-only grant. Start with `GET /api/providers` and stop before either verifier POST or a queued run.
5. A possible later simple API check is capped at four generations total: at most two per provider, with one verifier and one simple run per provider and no optimization run. Campus calls would each have a 30-second timeout, with at most 16 output tokens for the verifier and 512 for the simple run. Codex calls would have a 30-second verifier timeout and the target run's 150-second default timeout, but neither API sets an explicit output-token cap; there is no numeric total-token ceiling, so do not run a token-bounded Codex journey under current code. If run sequentially, the provider-call timeout envelope is four minutes total, excluding harness startup and database work. This proposal requires a separately approved call/token budget and a fresh temporary ledger capped at two reservations per provider. The canonical ledger currently remains Campus `1/2` and Codex `2/2` and must stay unchanged.

The direct adapter smoke (`tools/provider-smoke/campus-smoke.mts`) and the full app journey are different checks. The former makes one inference directly and updates the canonical ledger; it does not test database receipts, HTTP routes, Redis, or the worker. The app journey exercises those layers but requires provider verification receipts and may generate multiple calls. Neither was run here.

No cost or billing estimate is asserted. Provider usage and billing behavior remain unverified.
