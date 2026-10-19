# Settled validation — October 17, 2026

**Environment:** native Node.js 22.23.2; installed local tools; no dependency install.  
**Result:** package checks, offline unit tests, source lint, and the production build passed. The full current Playwright suite remains at 32/38 because six tests retain older UI expectations. Live provider validation remains unverified because its runner session could not be polled.

## Checks completed

| Check | Result |
| --- | --- |
| TypeScript | All 8 workspace packages and the root tools project passed. |
| Offline Vitest | **53 files, 390 tests passed.** Integration tests and `tools/provider-smoke/**` were excluded. |
| Source lint | **0 errors, 10 warnings.** Generated `.next-*` output directories were ignored. An unfiltered run included generated Next output and failed; it is not the source-lint result. |
| Production build | Passed with Next 16.4.0/Webpack; **15 static pages** generated at `apps/web/.next-settled-validation-20261017-004750`. |
| Focused recovery browser spec | **3/3 passed** after the alert locator fix. |
| Four requested focused browser specs | **14/14 passed.** |
| Full current browser suite | **32/38 passed; 6 failed** in `foundation.spec.ts`, `optimization.spec.ts`, and `workspace-codex.spec.ts`. |

The six remaining browser failures are legacy UI assumptions: checks still expect the old **Optimasi** destination or English **Settings** heading, and the blank-database foundation case expects a project-dependent control. The current shell shows **Workspace** and **Pengaturan**. These failures remain unresolved; no assertions were weakened. The earlier 20/20 fixture-browser result in [BROWSER_ACCEPTANCE_RESULTS.md](./BROWSER_ACCEPTANCE_RESULTS.md) is a separate historical acceptance run.

Vite emitted its existing native config-loader compatibility warning during tests. PDF.js emitted missing standard-font-data warnings. Both were non-fatal; the checks above completed successfully where reported as passed.

Screenshots for the monitoring review were captured in a temporary working directory and visually reviewed. Existing repository screenshots and `test-results` were left intact. The production build changed `apps/web/next-env.d.ts`; its original generated reference was restored. Next also refreshed the generated `apps/web/tsconfig.tsbuildinfo` cache.

## Live provider runner

No live inference result is claimed. Polling `write_stdin` session **79165** returned `Unknown process id`, and a process check found no process with that PID. The current live validation report still records the bounded rerun as pending, and the expected campaign ledger was absent at inspection. The offline checks in this report do not call providers, but the lost runner session leaves the bounded attempt's outcome unknown.

The running server started for browser checks was stopped, and port **34827** was free afterward. No dependency installation or user/application database migration was performed.
