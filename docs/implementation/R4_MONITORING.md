# R4 — Monitoring

**Date:** 2026-10-16  
**Status:** Monitoring source slice implemented; focused offline tests, formatting, and lint checks pass. Live database and browser behavior remain unverified.

This report uses the coordination label R4. The v3 PRD describes the feature in §9, while its roadmap table labels the Monitoring phase R5.

## Implemented

- The summary API reads project model attempts, response-scope usage, run output events, agent/tool events, and active run states. It supports 1h, 24h, 7d, and 30d windows plus explicit ranges up to 90 days.
- Aggregates keep reported, estimated, and unknown usage distinct. Unknown values remain unavailable; error rate excludes canceled and unknown outcomes; cache share uses only compatible reported input/cache records. Latency, TTFT, and TPS are grouped by provider and purpose. Per-attempt TTFT uses stored output events; TPS is present only with one response usage record containing reported output tokens and a valid generation interval.
- Request logs have server-side pagination, search, time range, status, provider, and purpose filters. Rows show attempt/run IDs, model, remote-outcome knowledge, per-metric usage provenance, TTFT/TPS when supported, duration, and error code. CSV export is limited to the visible page and excludes prompts and outputs; text cells that could be interpreted as spreadsheet formulas are escaped.
- The live activity endpoint replays the latest 100 stored events, resumes from a validated `(createdAt, id)` high-water cursor, polls for new rows, and emits keep-alives. It also scans a five-minute timestamp overlap in pages of at most 100 rows to find rows that became visible behind the cursor. Event payloads are not selected or emitted; event types are allowlisted. The server bounds per-connection replay deduplication to 20,000 IDs and the client bounds reconnect deduplication to 2,000 events.
- Live activity has a manual latest-100 resync path. Summary and request-log queries refresh from stored data every 15 seconds, independently reconciling telemetry if the live stream misses a late row.
- Requested/response model labels redact recognized credential patterns and sanitize error codes. CSV remains limited to the visible page, excludes prompt/output fields, quotes cells, and prefixes formula-like text.
- The Monitoring view combines summary cards, stored provider readiness, expandable diagnostics, live activity, filtered request logs, and the existing run trace panel. Provider quota remains unknown unless capability evidence exists.
- No database schema or migration was added.

## Changed paths

- `apps/web/src/lib/monitoring-telemetry.ts`
- `apps/web/src/lib/monitoring-telemetry.test.ts`
- `apps/web/src/lib/monitoring-event-cursor.ts`
- `apps/web/src/lib/monitoring-event-cursor.test.ts`
- `apps/web/src/lib/monitoring-event-stream.ts`
- `apps/web/src/lib/monitoring-event-stream.test.ts`
- `apps/web/src/lib/monitoring-client.ts`
- `apps/web/src/lib/monitoring-client.test.ts`
- `apps/web/src/app/api/projects/[projectId]/monitoring/summary/route.ts`
- `apps/web/src/app/api/projects/[projectId]/monitoring/requests/route.ts`
- `apps/web/src/app/api/projects/[projectId]/monitoring/monitoring-routes.test.ts`
- `apps/web/src/app/api/projects/[projectId]/monitoring/events/route.ts`
- `apps/web/src/components/monitoring-workspace.tsx`
- `apps/web/src/components/monitoring-workspace.module.css`
- `apps/web/src/components/monitoring-live-activity.tsx`
- `apps/web/src/components/monitoring-live-activity.module.css`
- `apps/web/src/components/monitoring-request-logs.tsx`
- `apps/web/src/components/monitoring-request-logs.module.css`

## Verification

- `rtk node_modules/.bin/vitest run apps/web/src/lib/monitoring-event-cursor.test.ts apps/web/src/lib/monitoring-event-stream.test.ts apps/web/src/lib/monitoring-client.test.ts apps/web/src/lib/monitoring-telemetry.test.ts 'apps/web/src/app/api/projects/[projectId]/monitoring/monitoring-routes.test.ts'`: **5 files, 31 tests passed**. Coverage includes cursor precision/validation, reconnect deduplication, abort cleanup, project isolation, delayed-commit visibility within the replay window, its explicit outside-window boundary, route validation/unavailable DB, client query scoping, CSV redaction/formula escaping, and telemetry calculations. Vitest printed its existing non-failing ESM/CommonJS config warning.
- `rtk node_modules/.bin/eslint 'apps/web/src/lib/monitoring-event-*' 'apps/web/src/lib/monitoring-client*' 'apps/web/src/app/api/projects/[projectId]/monitoring' apps/web/src/components/monitoring-live-activity.tsx apps/web/src/components/monitoring-request-logs.tsx apps/web/src/components/monitoring-workspace.tsx`: **passed**.
- `rtk node_modules/.bin/prettier --check 'apps/web/src/lib/monitoring-event-*' 'apps/web/src/lib/monitoring-client*' 'apps/web/src/app/api/projects/[projectId]/monitoring' apps/web/src/components/monitoring-live-activity.tsx apps/web/src/components/monitoring-request-logs.tsx apps/web/src/components/monitoring-workspace.tsx docs/implementation/R4_MONITORING.md`: **passed**.
- `rtk node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json`: **not clean in the current shared tree**. It reported diagnostics only in non-R4 paths: `apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.test.ts` and `packages/agent/src/python-candidate-sandbox.ts`. It reported no diagnostics in the Monitoring paths.
- `rtk pnpm exec vitest run apps/web/src/lib/monitoring-event-cursor.test.ts apps/web/src/lib/monitoring-event-stream.test.ts apps/web/src/lib/monitoring-client.test.ts apps/web/src/lib/monitoring-telemetry.test.ts 'apps/web/src/app/api/projects/[projectId]/monitoring/monitoring-routes.test.ts'`: could not start because pnpm attempted a workspace install and failed with `EPERM` while renaming an entry in the Windows pnpm store. Running the already-installed local Vitest binary succeeded; no dependency or lockfile change was made.
- The supplied project directory has no `.git` metadata, so Git status/diff could not be collected here.
- No build, browser test, API request, database/provider request, worker startup, migration, or production operation was run.

## Limits and evidence boundary

- The current schema has no persisted session ID, so Monitoring counts model attempts and active runs; it does not claim unique active sessions.
- No separate agent or worker heartbeat is persisted. Agent activity can be observed from run events, but agent health, worker health, Redis/PostgreSQL reachability, and BullMQ backlog remain unavailable. No filesystem-audit or knowledge/index health feed is wired into Monitoring, and evaluation analytics remain in the Pengujian flow.
- Request records expose attempt/run correlation, not PRD fields that are absent from the active attempt schema such as session ID, reasoning effort, or transport. There is no aggregate CSV export; the current export is the selected request-log page.
- `run_events.created_at` uses PostgreSQL `now()`, which is transaction-scoped; an event inserted in a long-running worker transaction can commit after a later timestamp/UUID cursor has already been emitted. Without a persisted commit-order cursor or schema migration, arbitrary-late commits cannot be covered durably. Reconnect reconciliation is bounded to five minutes and 100-row pages; explicit resync is bounded to the latest 100 events. A commit older than the replay window and outside that latest-100 tail may not appear in live activity. Periodic summary/request-log refresh reads current stored rows and reconciles those authoritative views, but does not repair a missing live event.
- The replay tests use an injected in-memory ledger and mocked route database responses. They do not claim exactly-once delivery or verify live PostgreSQL visibility/transaction behavior.
- The Monitoring UI reads provider status through the existing `/api/providers` endpoint. Source inspection shows its Codex readiness path inspects the app-server account/model catalogue; this audit did not call that endpoint or send inference.

Runtime health and unique session telemetry remain deferred because the active schema does not persist the required heartbeat or session identities.
