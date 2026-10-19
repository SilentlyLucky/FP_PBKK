# Integration fixes

Date: 2026-10-16

## Changes

- `apps/web/src/lib/optimization-result.ts` now preserves candidate order,
  `latestCandidateId`, `reviewableCandidateId`, and each revision's outcome.
  It validates that the latest ID matches the last revision, the reviewable ID
  matches the newest ready revision, and a supplied legacy `candidate` matches
  the declared revision. Inconsistent or incomplete selection metadata leaves
  the revision history readable but produces no selected candidate. Legacy
  single-candidate results remain supported when their ready state is clear.
- `apps/web/src/components/workspace-prompt-optimization.tsx` uses the selected
  reviewable revision for comparison, quality voting, and apply controls. It
  shows ordered revision context, including the outcome and details of a later
  incomplete or rejected revision, without replacing an earlier ready
  selection. `no_change_recommended`, `candidate_rejected`, and `incomplete`
  have distinct Indonesian status text; a result with no reviewable revision
  has no vote or apply controls.
- `apps/worker/src/main.ts` delegates remote-outcome classification to a pure
  helper. Only a `CodexProviderError`'s trusted `outcomeMayBeUnknown: false`
  overrides the conservative interrupted-request classification. Missing
  flags and other uncertain remote failure codes remain unknown. The existing
  terminal status and compare-and-set transition path is unchanged.

## Regression coverage

- The web parser tests cover incomplete A followed by ready B, ready A followed
  by rejected B, distinct no-change and incomplete outcomes, inconsistent
  reviewable selection, legacy candidate compatibility, and apply eligibility.
- The worker helper tests cover trusted known pre-turn interruption, started or
  missing-flag interruption, other uncertain remote failures, and a local
  failure without an active remote request.

## Verification

Run with existing local binaries; no package installation or provider calls:

- `rtk proxy node_modules/.bin/vitest run apps/web/src/components/workspace-prompt-optimization.test.ts apps/worker/src/remote-failure-classification.test.ts` — passed, 2 files and 13 tests.
- `rtk proxy node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json` — passed.
- `rtk proxy node_modules/.bin/tsc --noEmit -p apps/worker/tsconfig.json` — passed.

Vitest emitted a non-failing warning that the current CommonJS-loaded
`vitest.config.ts` uses ESM syntax with the native config loader.

Playwright, build, and server-backed E2E checks were not run because the other
executor owns the shared `.next` and server harness during this work. The
worker was not started; no database, migrations, provider inference, or live
provider calls were used.
