# PromptLab v3 isolated HTTP/API verification

**Status:** passed 2026-10-17. This verifies the production Next HTTP routes against disposable fixtures. It does not verify a live provider.

## Run boundary

- Native Node **22.23.2** and Next **16.4.0** with Webpack.
- The final run built `apps/web/.next-codex-isolated-api-20261017-9a1` with database and provider settings blank. Build ID: `0rhzPz8dxIgx9U6AmqKnl`.
- The script copied and hash-checked that artifact into a unique private dist before starting Next. It started Next on a fresh loopback port, with a temporary app root that has no repository `.env` parent.
- PostgreSQL used the already-present `postgres:16-alpine` image with `--pull=never`, a fresh database on tmpfs, and loopback-only port publication. Migrations and fixture rows were applied only to that disposable database.
- Workspace roots and files, including an outside-root symlink target, lived under a unique temporary directory. Provider credentials were blank or absent; no worker or provider route was invoked.
- The temporary source build, private dist, Next server, PostgreSQL container, and fixture directory were removed after verification. Cleanup inspection also found and removed **11 stopped containers** left by earlier runs of this script; they had no bind mounts and only the script's tmpfs database mount. The script now always removes its container after stopping it. The existing `.next-final-code-checks` and other workers' build outputs were preserved.

The script defaults to the existing `apps/web/.next-final-code-checks`. `PROMPTLAB_V3_SOURCE_DIST` can select another source artifact; it must be a real, direct `apps/web/.next-*` directory, and its `required-server-files.json` must declare the same `distDir`. The script copies the artifact before serving and does not remove the supplied source directory.

## HTTP checks

All **13** isolated checks passed with **0 runtime issues**:

1. Fresh database migrations and deterministic project, run, attempt, usage, event, and durable-cursor fixtures.
2. Monitoring summary totals and estimated token provenance from persisted rows.
3. Monitoring request-log JSON and client CSV helper serialization, including spreadsheet-formula escaping and marker redaction. CSV is client-generated; there is no CSV HTTP endpoint.
4. Durable SSE initial replay and reconnect from persisted ordinals 1 through 3; payload marker exclusion; wrong-project cursor rejection.
5. Workspace status and same-origin grant issuance; cross-origin grant rejection.
6. Workspace list, read, and search; traversal, absolute path, symlink escape, and secret-file protections.
7. Search does not follow the outside-root symlink, and returned workspace data does not expose fixture roots.
8. Grants are isolated between two configured projects in both directions; a project-scoped grant is rejected with `GRANT_NOT_FOUND` under the other project.
9. Read-only grants cannot escalate to workspace writes.
10. Write proposal diff and explicit approval apply the exact reviewed content.
11. Rejection leaves the original file unchanged.
12. Concurrent-edit conflict protection and approved-patch rollback.
13. Expired grant rejection after advancing only the isolated server clock.

The durable query returned `created_at` as a **string** in this run. Initial replay and reconnect both serialized successfully after the fix described below. The script checks the route boundary and the actual SSE response.

## Runtime fixes

### Next.js same-origin workspace requests

The first HTTP pass returned `ORIGIN_NOT_ALLOWED` for a same-origin workspace status request. Next 16.4 reconstructs the internal request URL with `localhost` while preserving the incoming loopback `Host` (here `127.0.0.1:<port>`) and adds matching `x-forwarded-host`, `x-forwarded-proto`, and `x-forwarded-port` headers. The old guard compared `Host` directly with the reconstructed URL host and rejected normal production traffic.

The guard now validates both hosts as loopback, requires matching ports and consistent forwarded host/protocol/port values, and compares Origin or Referer with the validated incoming Host authority. It continues rejecting the standardized `Forwarded` header, cross-site fetches, non-loopback hosts, and mismatched forwarded values. Route tests cover the reconstructed-host case and each rejection.

### Durable Monitoring SSE timestamps

Raw Drizzle SQL returned `run_events.created_at` as a string, but the durable stream encoder called `toISOString()` as if every value were a `Date`. The stream consequently emitted `MONITORING_STREAM_UNAVAILABLE` for both initial replay and reconnect.

The events route now converts valid `Date` or string values to a `Date` at the query boundary. Invalid or missing values become an absent event entry, which triggers the stream's retained-event resync response instead of throwing during serialization. A route regression test feeds the raw string form and checks the emitted activity timestamp.

## Verification results

- Isolated HTTP/API script: **13 checks passed**, **0 runtime issues**, provider calls **0**; `durableCursorCreatedAtType` was `string`.
- Focused Vitest suites: **2 files passed, 34 tests passed** (workspace route guards and Monitoring routes). Vitest emitted the existing native-config-loader compatibility warning.
- Root typecheck: **passed** across all 8 workspace packages and the root tools TypeScript project.
- Changed-file ESLint: **passed**.
- Root ESLint with generated Next outputs excluded (`--ignore-pattern '**/.next-*/**'`): **0 errors, 10 existing warnings**.
- The unfiltered `pnpm run lint` also ran. It failed while linting generated bundles under `.next-browser-acceptance-20261017` (owned by the browser worker) and the temporary build output; those minified artifacts produced **8,742 errors and 28,108 warnings**. No generated outputs were changed to address this; the source-only lint run above passed.

No full application test suite or live-provider call is claimed by this verification.
