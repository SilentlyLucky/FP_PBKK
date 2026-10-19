# R1 conversation integrity review fixes

**Date:** 2026-10-16  
**Scope:** The five concrete findings in `R1_REVIEW.md`.

## Changes

1. **Source consent:** Selected IDs are checked against active, versioned, eligible sources with `campus_indexer_allowed` permission. The send path refreshes the knowledge snapshot before saving a turn and again before creating a run. Failed refreshes, revoked permission, deleted or unavailable sources, and unversioned sources block egress and remain visible with a removal or retry action. Run creation still relies on the backend's permission check.
2. **Follow-up ordering:** Pending, action-required, and unresolved `interrupted_unknown` turns hold follow-ups. The composer explains the wait and offers the supported run cancellation action when the backend permits it; paused and interrupted runs expose their existing settings/detail links. Failed, canceled, and completed turns release the gate.
3. **Context budget:** The complete current request and preference envelope are composed first. History is budgeted newest turn backward and included as complete labeled blocks. The composer bounds a message at 10,000 characters and states that limit.
4. **Narrow layout:** At widths up to 640px, the chat panel grows with its composer and preserves at least 240px for messages. Desktop keeps its fixed-height layout.
5. **History and CTA:** The page heading keeps the single “Percakapan baru” action. History remains available through the labeled history panel and its mobile toggle.

## Files

- `apps/web/src/components/workspace-conversation.tsx`
- `apps/web/src/components/workspace-conversation.module.css`
- `apps/web/src/lib/workspace-conversations.ts`
- `apps/web/src/lib/workspace-conversations.test.ts`
- `apps/web/src/lib/workspace-conversation-consent.ts`
- `apps/web/src/lib/workspace-conversation-consent.test.ts`
- `apps/web/e2e/r1-conversation-integrity.spec.ts`
- `docs/implementation/R1_REVIEW_FIXES.md`

## Verification

- Focused unit tests: **10 passed** across the prompt, turn-gating, and consent tests using the installed Vitest entrypoint directly.
- Web TypeScript check: `rtk tsc --noEmit -p apps/web/tsconfig.json` — **passed**.
- New Playwright spec TypeScript check: **passed** using the installed TypeScript entrypoint directly.
- Playwright browser runs and screenshot review are pending while the separate R3 executor is active. The R1 executor and any R1 build/test process had finished; the long-lived Playwright test service was idle on port 45337, with no active `playwright test`, `next dev`, or build process. The required serial run is the new integrity spec followed by `r1-workspace-responsive.spec.ts` with one worker.

## Remaining gaps

- Browser assertions use offline route fixtures; they verify client behavior without provider calls or database access. Backend source permission validation remains authoritative if permissions change after the final client refresh.
- Screenshot filenames and visual findings will be recorded here after the serial Playwright run and image review.
