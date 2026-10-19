# Monitoring browser acceptance

**Status:** passed 2026-10-17. Four browser acceptance tests passed against the existing production build.

## Boundary

- Served the existing `apps/web/.next-browser-acceptance-20261017` artifact on `127.0.0.1:43187` with native Node **22.23.2** and `NEXT_DIST_DIR` pointed at that artifact. The build was not rebuilt or edited.
- The server process had database, Redis, provider credential/model, and local workspace variables explicitly blank. Playwright intercepted every same-origin `/api/` request and supplied offline fixtures. Requests outside the local origin were blocked; no unexpected requests were recorded.
- The project name and provider/request data identify themselves as offline test fixtures. The displayed values are not production telemetry, and no provider was called.
- This browser run is separate from [ISOLATED_API_VERIFICATION.md](ISOLATED_API_VERIFICATION.md). That report documents real Next HTTP route checks against disposable database fixtures: **13 check groups passed, 0 runtime issues, 0 provider calls**. The browser fixtures here did not exercise those HTTP routes and do not add to that count.

## Browser coverage

All **4 of 4** tests passed using the existing one-worker acceptance config:

1. **Summary provenance and layout:** checked 21 attempts and their status totals; input usage showed 1,200 reported plus 400 estimated, output showed 480 reported, and cache metrics/share stayed unavailable. Changed the range to 7 days, checked the summary request, used **Muat ulang**, and verified summary and request-log refreshes. Captured the populated [desktop screenshot](../../apps/web/e2e/screenshots/monitoring-desktop.png) and [390px narrow screenshot](../../apps/web/e2e/screenshots/monitoring-narrow.png). The document and body stayed within the 390px viewport; any wider request table content remained inside its scroll wrapper.
2. **Request logs and CSV:** opened request details and checked remote-outcome and unknown cache values; changed status, provider, and purpose filters; searched; moved to page 2 and back; and verified the corresponding API query values and displayed rows. Downloaded the current page as CSV and confirmed a formula-prefixed model was apostrophe-escaped. CSV export was client-side.
3. **Live activity recovery:** received a fixture `monitoring.error`, observed the reconnecting state, clicked **Resinkronkan event terbaru**, and verified the `?resync=1&attempt=1` request returned the stored fixture event `#2`.
4. **No-data and unavailable states:** returned a zero-attempt summary with null token metrics and an empty request list, then returned 503 fixture responses after **Muat ulang**. The page showed unavailable values and errors instead of inventing zero-valued usage.

The API request guard recorded **0 unexpected requests** across the four tests. No application source or existing e2e test was changed.

## Checks

- Browser acceptance: **4 passed, 0 failed**.
- ESLint on `apps/web/e2e/monitoring.spec.ts`: passed.
- TypeScript check on the new spec: passed.
- Prettier check on the new spec and this report: passed.
- No full application suite or live-provider request was run.

The server was stopped after the browser run, and port `43187` was verified clear.
