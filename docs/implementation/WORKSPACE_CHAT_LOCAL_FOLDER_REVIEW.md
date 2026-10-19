# Workspace chat and local folder corrective review — October 17, 2026

**Status: focused offline verification passed.** The Workspace chat keeps a proposed prompt change visibly untested and appends it only to the unsent draft when selected. Folder registration and temporary read consent remain separate API operations, with a retry path if consent fails. Stale-grant responses clear the active folder state.

The browser spec now targets the folder disclosure as a native `<summary>`. It also matches the full empty-folder status and scopes the failed-grant alert so it does not collide with Next.js's empty route announcer. The first browser run exposed those locator mismatches; the corrected final run passed all seven tests.

## Verification

- Focused Vitest: 10 files, 81 tests passed.
- TypeScript: `apps/web`, `apps/worker`, `packages/agent`, `packages/tools`, and `packages/contracts` all passed `tsc --noEmit`.
- Playwright: `workspace-chat-local-folders.spec.ts`, 7 passed, 0 skipped. The offline fixtures cover direct Senopati chat, an unverified-provider refusal, no-op and untested recommendation outcomes, folder import and source selection, replacement of one registered root by another, stale-search cleanup and reconnection, failed-grant retry, and an unavailable remote picker.
- ESLint on the three changed components and the focused E2E spec: 0 errors, 1 warning (`refreshRootCatalog` is unused in `local-source-browser.tsx`).
- Prettier check on the same files: passed.
- Read-only requests to the existing preview returned HTTP 200 for `http://localhost:3000/workspace`, the project root catalog, and the project folder picker.

The E2E run used a separate Next dev server with `NEXT_DIST_DIR=.next-local-folder-review-20261017`, blank database variables, and fixture API responses. It did not call a provider or write to a user database. The live port-3000 server was not restarted: process inspection was limited to names and IDs, so its launch mode was not established. The repository supports `pnpm dev` for Next dev and `next start` after a build; the current port-3000 responses do not prove which mode is running or that it loaded the latest source. No service restart was attempted.

## Screenshots

- [Workspace chat response at 1440 px](./screenshots/workspace-chat-senopati-answer-1440.png)
- [Imported local file and selected context at 390 px](./screenshots/workspace-folder-source-context-390.png)
- [Folder reconnection at 390 px](./screenshots/workspace-folder-reconnect-390.png)

The screenshots show fixture data. The folder-flow test also checked horizontal overflow at 320, 360, 390, 768, 1024, and 1440 px.
