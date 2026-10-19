# Web type stabilization

Date: 2026-10-16

## Scope and changes

- Fixed experiment creation typing in `apps/web/src/app/api/projects/[projectId]/experiments/route.ts` by narrowing pilot and controlled-evaluation metadata separately. Controlled runs are checked against the saved baseline, each arm's requested model and reasoning effort, and the stored controlled-evaluation configuration. Decision values retain the declared accepted/rejected/inconclusive union.
- Fixed workspace conversation typing in `workspace-conversation.tsx` and `workspace-conversations.ts`: the async cross-tab send failure path keeps a typed turn context, persisted run-create requests remain explicitly nullable for unknown-send reconciliation, and absent optional `updatedAt` values are omitted from parsed turns.
- Updated the workspace conversation test fixtures to satisfy the required nullable `runCreateRequest` field. No provider, database, migration, worker, or user workspace data was accessed.

## Verification

- Initial live web typecheck reproduced 10 diagnostics: five in the experiments route, one in `workspace-conversation.tsx`, three in `workspace-conversations.test.ts`, and one in `workspace-conversations.ts`.
- `rtk node_modules/.bin/vitest run apps/web/src/lib/workspace-conversations.test.ts apps/web/src/lib/experiment-pilot.test.ts 'apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.test.ts' --reporter=dot`: **passed**, 3 files and 30 tests.
- `rtk corepack pnpm --dir apps/web typecheck`: **passed**.
- ESLint over the owned API, component, helper, and test files: **passed**.

  ```bash
  rtk node_modules/.bin/eslint 'apps/web/src/app/api/projects/[projectId]/experiments/route.ts' 'apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/route.ts' 'apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.ts' 'apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/controlled-evaluation-eligibility.ts' 'apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.test.ts' apps/web/src/components/workspace-conversation.tsx apps/web/src/lib/workspace-conversations.ts apps/web/src/lib/workspace-conversations.test.ts
  ```

- A preliminary ESLint attempt using a glob with literal bracketed route segments matched no files; the successful run above used explicit route paths.

## Concurrent ownership and remaining diagnostics

- The concurrent worker's `experiments-workspace.tsx`, `controlled-evaluation-components.tsx`/CSS, and `controlled-evaluation-ui.ts`/tests were not edited. The live pre-fix and final web typechecks reported no diagnostics in those files. The earlier checkpoint's `experiments-workspace.tsx` diagnostics at lines 510, 638, and 722 were already absent from the live pre-fix run.
- Lint was deliberately limited to this task's owned files. The checkpoint's latest whole-repository lint result remains a separate report: three errors in `local-file-review.tsx:187`, `local-source-browser.tsx:299`, and `local-workspace-status.tsx:56`, plus 16 warnings. Whole-repository lint was not rerun.
