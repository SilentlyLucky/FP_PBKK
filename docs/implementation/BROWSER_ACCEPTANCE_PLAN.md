# PromptLab browser acceptance plan

**Scope:** the PromptLab web shell and the controlled evaluation surface only. This plan uses Playwright route fixtures, so browser checks do not need provider inference, credentials, a user database, migrations, or a worker.

## Commands ready for the stabilized app

Run these from `/home/lenovo/FP_PBKK` after the separate app stabilization work is complete. They are intentionally listed here but were not run during this handoff.

```bash
# Discover the configured specs without opening a browser or starting webServer.
env -i PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH=/home/lenovo/.cache/ms-playwright PROMPTLAB_TEST_MODE=true NEXT_TELEMETRY_DISABLED=1 rtk /home/lenovo/FP_PBKK/node_modules/.bin/playwright test --config=playwright.config.ts --list

# Five-route shell smoke and responsive checks (one worker, deterministic report).
env -i PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH=/home/lenovo/.cache/ms-playwright PROMPTLAB_TEST_MODE=true NEXT_TELEMETRY_DISABLED=1 rtk /home/lenovo/FP_PBKK/node_modules/.bin/playwright test apps/web/e2e/r1-workspace-responsive.spec.ts --config=playwright.config.ts --workers=1 --reporter=list

# Existing one-case pilot plus the controlled evaluation fixture.
env -i PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH=/home/lenovo/.cache/ms-playwright PROMPTLAB_TEST_MODE=true NEXT_TELEMETRY_DISABLED=1 rtk /home/lenovo/FP_PBKK/node_modules/.bin/playwright test apps/web/e2e/experiments.spec.ts apps/web/e2e/controlled-evaluation.spec.ts --config=playwright.config.ts --workers=1 --reporter=list

# Controlled evaluation only.
env -i PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH=/home/lenovo/.cache/ms-playwright PROMPTLAB_TEST_MODE=true NEXT_TELEMETRY_DISABLED=1 rtk /home/lenovo/FP_PBKK/node_modules/.bin/playwright test apps/web/e2e/controlled-evaluation.spec.ts --config=playwright.config.ts --workers=1 --reporter=list
```

`playwright.config.ts` uses `127.0.0.1:3100`, starts the web app with test mode and blank database URLs, and retains traces only on failure. The controlled spec intercepts every `/api/**` request and fails unexpected requests, keeping the run offline and bounded. Do not replace these commands with provider smoke, database, migration, or stack-start commands for browser acceptance.

The root `test:e2e` script delegates to `playwright test`; these commands use the direct local binary to keep the isolated invocation explicit. `apps/web/package.json` exposes `dev:e2e` for a port-3100 Next process; do not invoke it as part of this deferred handoff.

## Five primary route fixtures

The existing shell smoke checks the five primary navigation links and their URLs. That smoke is separate from route-level API fixture coverage, which remains local to the spec that owns each behavior.

| Route          | Route-level fixture contract                                                                                                                                                                        | Fixture coverage                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/workspace`   | `GET /api/projects` can return an empty project list; detailed conversation fixtures intercept project, provider, prompt, knowledge, run, and event requests.                                       | `apps/web/e2e/r1-conversation-integrity.spec.ts`, `apps/web/e2e/workspace-codex.spec.ts` |
| `/sources`     | A project fixture supplies knowledge sources, graph snapshots, and workspace read grants; source and local-folder requests are intercepted.                                                         | `apps/web/e2e/r2-knowledge-workspace.spec.ts`                                            |
| `/experiments` | Project, provider catalog, prompt/version, knowledge/graph state, experiment history, run event SSE, and decision responses are fixtures; the controlled spec adds development/holdout report data. | `apps/web/e2e/experiments.spec.ts`, `apps/web/e2e/controlled-evaluation.spec.ts`         |
| `/monitoring`  | No route-level monitoring fixture is scheduled in this slice; add summary/provider/live-activity interception before asserting monitoring behavior.                                                 | Shell link/URL only in `apps/web/e2e/r1-workspace-responsive.spec.ts`                    |
| `/settings`    | Project prerequisite and provider catalog are fixtures; login/verification actions remain mocked and are never sent to a provider.                                                                  | `apps/web/e2e/provider-settings.spec.ts`                                                 |

The shell fixture deliberately exercises only the five primary links. Legacy `/optimize`, `/knowledge`, `/history`, and `/runs` pages are outside this acceptance slice.

## Controlled evaluation acceptance

`controlled-evaluation.spec.ts` keeps the dataset to two cases: one `development` case and one `holdout` case, with one `original` arm and fixed UUID/hash values. It asserts that:

- the controlled report renders both split labels and both baseline and candidate answers from a `run.completed` SSE fixture;
- the controlled report exposes the JSON export action while all API traffic stays inside the fixture router;
- acceptance stays disabled when the fixture reports incomplete evidence;
- an `inconclusive` decision can still be recorded through the mocked decision endpoint; and
- a complete, evidence-eligible fixture enables acceptance and records the accepted decision.

The test owns all request bodies it inspects and returns `501` for an unexpected API path or method. No fixture reads `.env`, process arguments, credentials, provider output, or database state.

## Verification boundary

No dev server, browser, provider inference, user database, migration, worker, or credentialed action was run while preparing this plan. Once the app worker signals that the controlled UI is ready, run the focused command first, then the five-route smoke command, and record the actual result here.
