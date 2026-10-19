# PromptLab v3 R1 acceptance and visual review

**Review date:** 2026-10-16  
**Mode:** Read-only source review and inspection of existing PNGs. No browser, build, test, server, provider, database, or migration was run.

## Findings

### P1 — A saved source selection can outlive its current sharing permission

`workspace-conversation.tsx:314-315` restores source IDs from the saved conversation. The source picker only displays active, eligible, versioned sources (`342-347`, `1418-1453`), but the send guard checks only that Gateway campus is selected (`659-667`) and the run request forwards every saved ID (`783-786`). A source that becomes local-only, deleted, or ineligible can therefore remain selected without a usable checkbox; the request still includes its ID. The egress notice is also based on the saved ID count (`1464-1468`). Revalidate saved IDs against the current source snapshot before sending, and block or visibly remove any ID lacking current permission.

### P2 — A follow-up can omit the still-running assistant turn

After run creation, `sending` is cleared in `workspace-conversation.tsx:795-840`, and `composerDisabled` does not consider pending turns (`929-935`). If the user sends again before the first run completes, `buildConversationPrompt` includes the earlier user text but includes assistant text only when it has arrived (`workspace-conversations.ts:67-72`). Serialize follow-ups until completion or otherwise ensure the pending turn's result is included before dispatch.

### P2 — The context limit can truncate the current request

`workspace-conversations.ts:67-83` places up to eight prior turns before the current request, then truncates the assembled prompt to 24,000 characters. A long prior assistant response can consume that budget and cut off or remove the new request at the end. Reserve space for the current request and budget history from the newest turns backward.

### P2 — The mobile chat panel leaves too little room for conversation content

At 320px and 360px, the existing screenshots show the composer occupying most of the chat panel and the empty-state guidance clipped behind it. The panel clips overflow and has a fixed/minimum height (`workspace-conversation.module.css:237-242`, `790-793`); the composer stacks controls vertically at narrow widths (`862-889`). Preserve a useful minimum viewport for messages or let the panel grow with its stacked composer.

### P2 — “Percakapan baru” is offered in two panels at once

The page-heading button (`workspace-conversation.tsx:959-966`) and the separate new-conversation icon in the history header (`983-992`) invoke the same action. The 1440px and 1024px screenshots visibly show both. The v3 QA README calls for one primary action per state and no duplicated CTAs across panels; keep one visible entry point.

## Checks that passed within scope

- Primary navigation contains exactly **Workspace, Sumber, Pengujian, Monitoring, Pengaturan** (`app-shell.tsx:28-34`).
- Conversation and active-conversation storage keys include the project ID (`workspace-conversations.ts:50-56`); reload snapshots read those keys (`236-277`) and browser storage changes are subscribed per project (`210-234`). The UI also discloses that conversation grouping is stored in this browser (`workspace-conversation.tsx:1064-1067`).
- Normal completed follow-ups include recent user and assistant turns in the prompt sent for a saved run (`workspace-conversation.tsx:697-701`; `workspace-conversations.ts:62-83`).
- Source options identify local-only permissions and selected-source egress. The composer shows loading/unavailable provider states and disables sending without a verified chat provider (`workspace-conversation.tsx:1123-1132`, `1318-1368`).
- The shell has a skip link and global visible focus styling (`app-shell.tsx:259-260`; `globals.css:88-114`); the mobile navigation toggle exposes expanded state and returns focus on Escape (`app-shell.tsx:244-255`, `278-287`).
- No filesystem-edit action or claim is present in the reviewed Workspace flow.

## Screenshot evidence and limits

Inspected existing artifacts:

- `docs/implementation/screenshots/workspace-1440.png`
- `docs/implementation/screenshots/workspace-1024.png`
- `docs/implementation/screenshots/workspace-768.png`
- `docs/implementation/screenshots/workspace-360.png`
- `docs/implementation/screenshots/workspace-320.png`

The screenshots show a disconnected first-run state: no project is available because the local database is not configured, and the Codex target is unavailable. They demonstrate those empty/disconnected UI states, not a live provider conversation, source retrieval, or run result. The v3 `README_QA.md` also identifies its mockups and sample states as static and illustrative. No new screenshots were captured, so this review does not establish current browser rendering beyond the inspected artifacts.
