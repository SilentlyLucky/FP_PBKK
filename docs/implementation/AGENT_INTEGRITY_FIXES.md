# R3 Agent Integrity Fixes

Date: 2026-10-16

This note records the bounded fixes for audit findings I-03, I-05, I-06, and
the iteration-default evidence. The bounded agent, run lifecycle, existing hard
caps, and approval checks remain in place.

## Files changed

- `packages/agent/src/prompt-optimization-auto.ts`
- `packages/agent/src/prompt-optimization-auto.test.ts`
- `packages/agent/src/index.ts` (exports the new revision result types)
- `packages/providers/src/codex/app-server.ts`
- `packages/providers/src/codex/app-server.test.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`
- `docs/implementation/AGENT_INTEGRITY_FIXES.md`

## Changes

- The automatic optimizer returns a deeply frozen, insertion-ordered
  `candidates[]` history. Each revision carries its own outcome, prompt text,
  validation state, exact bound evaluation evidence, and draft version ID.
  `latestCandidateId` identifies the last proposal; `reviewableCandidateId`
  identifies the most recent fully ready revision. A later incomplete or
  rejected proposal does not replace evidence or the draft for an earlier ready
  revision.
- The legacy `candidate` field keeps its existing shape and identifies the
  reviewable ready revision when one exists; otherwise it identifies the latest
  revision. Existing `candidate_ready` approval guards therefore continue to
  receive the ready candidate and its matching evidence. Draft persistence
  stores a ready revision only and does not activate it.
- Explicit planner completion without a candidate and a candidate whose text is
  exactly the original prompt produce `no_change_recommended` when there is no
  earlier ready selection. Exact no-op candidates are not re-evaluated, saved,
  compared, or presented as improvements. Deterministic invariant or fixture
  failures can produce `candidate_rejected`; incomplete work and exhausted
  budgets remain `incomplete`. Provider execution failures and cancellation
  remain in the run lifecycle.
- Codex checks cancellation before remote setup and at setup boundaries. An
  abort before `turn/start` prevents the remote turn. The adapter watches the
  signal during generation setup and turn startup; if a turn starts, it sends
  `turn/interrupt` as soon as the turn ID is available and reports an
  interrupted error with `outcomeMayBeUnknown: true`. Cancellation before a
  remote turn starts reports a known local interruption.
- `maxIterations` now defaults to 2, allowing one candidate and one refinement.
  The existing hard maximum remains 2; tool, decision, candidate, revision, and
  duration caps are unchanged.

## API contract additions

- `PromptOptimizationOutcomeSchema` keeps `candidate_ready`, `incomplete`, and
  `clarification_required`, and adds `no_change_recommended` and
  `candidate_rejected`.
- `PromptOptimizationRevisionOutcomeSchema` defines the same candidate-level
  outcomes without `clarification_required`.
- `AutomaticPromptOptimizationResult` adds immutable `candidates[]`,
  `latestCandidateId`, and `reviewableCandidateId`. Each candidate revision
  adds an `outcome`. The legacy `candidate` field remains available.
- `PromptOptimizationRequestSchema` retains explicit `maxIterations: 1` for
  callers that request it and defaults omitted values to 2.

## Verification

The following checks passed using the existing local binaries; they run offline
and use mocked provider sessions:

- `rtk proxy node_modules/.bin/vitest run packages/agent/src/prompt-optimization-auto.test.ts packages/agent/src/index.test.ts packages/contracts/src/index.test.ts packages/providers/src/codex/app-server.test.ts`
- `rtk proxy node_modules/.bin/tsc --noEmit -p packages/contracts/tsconfig.json`
- `rtk proxy node_modules/.bin/tsc --noEmit -p packages/agent/tsconfig.json`
- `rtk proxy node_modules/.bin/tsc --noEmit -p packages/providers/tsconfig.json`

A first package-manager check entered pnpm's automatic workspace dependency
status step and failed with a Windows-store `EPERM`; no installation completed.
All credited checks were run directly through the local binaries.

## Remaining audit gaps

- I-01, optimization manifest binding and evidence eligibility, remains open.
- I-02, consistent vote/history/apply/experiment eligibility, remains open.
- I-04, selected graph evidence flowing into target-evaluation requests, remains
  open.

These fixes do not establish app, worker, database, migration, live-provider, or
provider-inference behavior.
