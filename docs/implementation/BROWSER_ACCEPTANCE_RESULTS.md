# PromptLab v3 browser acceptance results

Date: 2026-10-17

## Run setup

- Built the production app with native Node 22.23.2 into the isolated
  `apps/web/.next-browser-acceptance-20261017` directory. The existing `.next`
  and `.next-final-code-checks` directories were not used or changed.
- Served that build at `http://127.0.0.1:3210` with provider, database, Redis,
  and local-workspace environment values blank.
- Ran Playwright with `playwright.acceptance.config.ts` (one worker). Each
  exercised spec intercepted browser `/api/**` traffic with fixtures and
  failed unexpected API requests. No provider request or database connection
  was made by these browser checks.

Build command:

```bash
rtk env -i PATH=/home/lenovo/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin NEXT_DIST_DIR=.next-browser-acceptance-20261017 PROMPTLAB_DATABASE_URL= PROMPTLAB_REDIS_URL= PROMPTLAB_CAMPUS_API_KEY= PROMPTLAB_CAMPUS_MODEL= PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS= PROMPTLAB_LOCAL_WORKSPACE_ROOTS= PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED= PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS= NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production /home/lenovo/.nvm/versions/node/v22.23.2/bin/node node_modules/next/dist/bin/next build --webpack
```

Server command:

```bash
rtk env -i PATH=/home/lenovo/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin NEXT_DIST_DIR=.next-browser-acceptance-20261017 PROMPTLAB_DATABASE_URL= PROMPTLAB_REDIS_URL= PROMPTLAB_CAMPUS_API_KEY= PROMPTLAB_CAMPUS_MODEL= PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS= PROMPTLAB_LOCAL_WORKSPACE_ROOTS= PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED= PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS= NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production /home/lenovo/.nvm/versions/node/v22.23.2/bin/node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3210
```

Final consolidated Playwright command:

```bash
rtk env -i PATH=/home/lenovo/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin PLAYWRIGHT_BROWSERS_PATH=/home/lenovo/.cache/ms-playwright PROMPTLAB_ACCEPTANCE_BASE_URL=http://127.0.0.1:3210 NEXT_TELEMETRY_DISABLED=1 /home/lenovo/.nvm/versions/node/v22.23.2/bin/node node_modules/@playwright/test/cli.js test apps/web/e2e/controlled-evaluation.spec.ts apps/web/e2e/experiments.spec.ts apps/web/e2e/r1-conversation-integrity.spec.ts apps/web/e2e/r1-workspace-responsive.spec.ts apps/web/e2e/r2-knowledge-workspace.spec.ts apps/web/e2e/local-file-review.spec.ts apps/web/e2e/provider-settings.spec.ts --config=playwright.acceptance.config.ts --workers=1 --reporter=list
```

The final consolidated run passed all 20 tests. Earlier area-by-area runs were
also executed in the requested order: controlled evaluation/pilot, Workspace,
Sources, file review, then Settings.

## Results

| Acceptance area                             |                          Result | Coverage                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled evaluation and legacy pilot      |                    **4 passed** | Three controlled-evaluation cases, then the paired pilot and user decision.                                                                                                                                                              |
| Workspace integrity and responsive behavior |                    **8 passed** | Unknown-send idempotency recovery, follow-up/cancel flow, consent refresh failure, empty/disconnected states, narrow active-conversation header, shell reflow/focus/contrast, five-route navigation, and desktop/narrow route rendering. |
| Sources                                     |                    **2 passed** | Search, preview, removal, read, selection, import, and disconnected-state behavior.                                                                                                                                                      |
| Local file review                           |                    **3 passed** | Reject/approve/rollback, conflict reload, grant expiry, and project-switch cleanup.                                                                                                                                                      |
| Settings                                    |                    **3 passed** | Project prerequisite, lost Codex login session without inference, and bounded polling after transient errors.                                                                                                                            |
| **Total**                                   | **20 passed, 0 final failures** | One worker; API fixtures only.                                                                                                                                                                                                           |

The Workspace width checks covered 320, 360, 390, 768, 1024, and 1440 CSS px
for the active conversation header. The shell check covered 320, 360, 768,
1024, and 1440 px. Each of the five primary routes was captured and checked at
1440×900 and 390×900.

The regression fix lets the provider-status badge shrink and wrap within the
Workspace chat header on narrow screens. The new browser assertion injects a
long synthetic status label and verifies that the title/status do not overlap,
the header remains within the viewport, and the document does not gain
horizontal overflow. This covers the previously observed 390px header overflow
without applying a page-wide overflow mask.

The Sumber toolbar action only scrolls to the always-visible source form, so it
is now secondary. The form’s “Simpan sumber” remains the primary action; the
fixture-backed Sources test checks that the two controls render with distinct
background styles. Workspace also asserts that there is exactly one “Percakapan
baru” action.

Rendered Workspace contrast samples from the shell check were: heading
17.06:1, inactive navigation 10.29:1, active navigation 5.17:1, composer help
7.58:1, project-selector boundary 4.76:1 (3:1 minimum), and mobile navigation
focus indicator 11.28:1 (3:1 minimum). The keyboard check reached the skip link
and mobile navigation by Tab and verified a visible focus ring.

## Screenshots

All ten primary-route screenshots were opened and visually reviewed at desktop
and narrow sizes. The active-project Workspace regression capture was also
reviewed.

| Route      | 1440×900                                                       | 390×900                                                      |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Workspace  | [Desktop](screenshots/browser-acceptance-workspace-1440.png)   | [Narrow](screenshots/browser-acceptance-workspace-390.png)   |
| Sumber     | [Desktop](screenshots/browser-acceptance-sources-1440.png)     | [Narrow](screenshots/browser-acceptance-sources-390.png)     |
| Pengujian  | [Desktop](screenshots/browser-acceptance-experiments-1440.png) | [Narrow](screenshots/browser-acceptance-experiments-390.png) |
| Monitoring | [Desktop](screenshots/browser-acceptance-monitoring-1440.png)  | [Narrow](screenshots/browser-acceptance-monitoring-390.png)  |
| Pengaturan | [Desktop](screenshots/browser-acceptance-settings-1440.png)    | [Narrow](screenshots/browser-acceptance-settings-390.png)    |

The active-project 390px header capture is
[r1-conversation-integrity-390.png](screenshots/r1-conversation-integrity-390.png).

I compared the captures with the supplied v3 ZIP PNGs and `mockups.html`.
The five-route navigation, page purposes, workspace history/composer, source
management, controlled-evaluation setup, monitoring empty state, and runtime
settings follow the reference information architecture. The browser captures
use empty-project fixtures, so unavailable actions stay disabled and
Monitoring shows “Belum ada proyek aktif”; illustrative sample metrics and
provider health from the mockups are not presented as live data.

## Changed files

- `apps/web/src/components/workspace-conversation.module.css`: constrain and
  wrap the chat-header status badge at narrow widths.
- `apps/web/src/components/knowledge-workspace.tsx`: style the source-form jump
  control as secondary so it does not compete with “Simpan sumber”.
- `apps/web/e2e/r1-conversation-integrity.spec.ts`: add active-project header
  overflow checks at six widths, the long-status stress case, and a 390px
  screenshot.
- `apps/web/e2e/r1-workspace-responsive.spec.ts`: capture all five routes in
  clean focus states and open/close the collapsed mobile navigation while
  checking it.
- `apps/web/e2e/r2-knowledge-workspace.spec.ts`: assert that the jump control
  stays visually secondary to the source save action.

Focused verification after these edits passed:

- `rtk node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json`
- `rtk node_modules/.bin/eslint apps/web/src/components/workspace-conversation.tsx apps/web/src/components/knowledge-workspace.tsx apps/web/e2e/r1-conversation-integrity.spec.ts apps/web/e2e/r1-workspace-responsive.spec.ts apps/web/e2e/r2-knowledge-workspace.spec.ts`
- `rtk node_modules/.bin/prettier --check apps/web/src/components/workspace-conversation.module.css apps/web/src/components/knowledge-workspace.tsx apps/web/e2e/r1-conversation-integrity.spec.ts apps/web/e2e/r1-workspace-responsive.spec.ts apps/web/e2e/r2-knowledge-workspace.spec.ts`

## Failures, skips, and limits

- Two intermediate failures were test-harness assumptions and were corrected:
  the 320px status is intentionally stacked below the title, and the mobile
  navigation is hidden until its toggle opens. The corrected checks passed.
- This directory has no Git metadata, so `git diff --check` and a Git-based
  change summary were unavailable; the scoped ESLint, TypeScript, and
  Prettier checks passed.
- No Playwright test was skipped. There is no dedicated Monitoring behavior
  spec in `apps/web/e2e`; Monitoring received route, responsive, and screenshot
  coverage only. Telemetry behavior was not asserted.
- All API outcomes in these tests came from browser fixtures. This run does not
  establish real provider inference, backend HTTP behavior, database
  persistence, or live Monitoring telemetry.
