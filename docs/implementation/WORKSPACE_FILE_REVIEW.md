# Workspace file review

**Date:** 2026-10-16  
**Result:** Not accepted yet. One P1 follow-up integrity defect and several P2 scope, resource, and UX defects remain.

## Scope and basis

Reviewed `LOCAL_FILE_REVIEW.md`, `R1_REVIEW_FIXES.md`, and `R2_KNOWLEDGE_WORKSPACE.md`, plus the source and focused test files those notes identify. The unfinished R3 scope was not reviewed. No app source was edited, and no tests, browser, build, provider, database, worker, or project-file operation was run. The documented focused tests were inspected but not rerun. This directory is not a Git worktree, so changed-path scope came from the implementation notes.

## Blocking finding

### P1 — An uncertain run-creation response releases the follow-up gate

**Evidence:** `apps/web/src/components/workspace-conversation.tsx:1029-1049,1097-1105`; `apps/web/src/lib/workspace-conversations.ts:71-77`.

After the run POST is sent, every caught error marks the turn `preparation_failed`. That status is treated as non-blocking. The idempotency key is generated inline and is not saved for recovery.

**Repro:** Let the server create and queue a run, then drop the HTTP response before the browser receives its run ID. The catch path marks the turn failed even though the provider work may be active. The composer then accepts another message, and the conversation has no run ID with which to reconcile the first request.

Treat an unconfirmed POST outcome as unresolved and keep the turn blocked until the run is reconciled. Reserve `preparation_failed` for failures known to have happened before run creation or for a response that confirms no run was created.

## Findings to address

### P2 — Cross-tab sends can bypass follow-up ordering and overwrite a turn

**Evidence:** `apps/web/src/components/workspace-conversation.tsx:238-256,555-571,853-895`; `apps/web/src/lib/workspace-conversations.ts:252-270`.

The send lock is a component-local ref. Storage events update other tabs asynchronously, and `commitConversation` replaces the stored conversation with the snapshot captured by the sender.

**Repro:** Open the same completed conversation in two tabs and submit follow-ups before either tab observes the other's storage event. Both pass the empty blocking-turn check and create separate runs. Each later writes a conversation snapshot built from the same old turn list, so one submitted turn can disappear from browser history while its run still exists.

Use a cross-tab or server-side conversation lock and merge turns against the latest stored value before replacing it.

### P2 — A pending R2 approval can restore a grant for the previous project

**Evidence:** `apps/web/src/components/local-source-browser.tsx:250-305,317-342`; call site `apps/web/src/components/knowledge-workspace.tsx:1812`.

Project changes clear the current state and revoke a grant already in `grantRef`, but the approval request is not aborted or checked against the current project when it completes. The browser component is not keyed by project. A late response stores the old project ID and then loads that project's directory into the still-mounted component. The subsequent file operations use `grant.projectId`, not the currently selected project.

**Repro:** Start approval for project A, switch to project B while the request is pending, then let A's response complete. The panel can show and operate on A's files while the header selects B; an import is still sent to A. The server's project-bound grant prevents cross-root access, but the visible project and the project receiving the import disagree.

Cancel or invalidate pending operations on project change, and apply state only when the captured project and grant are still current.

### P2 — Expired and duplicate grants can consume the 128-grant cap permanently

**Evidence:** `packages/tools/src/local-workspace.ts:518-520,535-547`; `apps/web/src/lib/local-workspace.ts:154-184`; `apps/web/src/components/local-file-review.tsx:217-224`; `apps/web/src/components/local-source-browser.tsx:134-152,317-342,513-520`.

Grant issuance checks the raw in-memory map size without pruning expired records. The file-review panel clears an expired write grant from UI state without revoking it. The R2 source browser also leaves its approval button enabled while the request is pending; rapid repeated clicks can issue several grants, but only the last response remains in `grantRef`. If its best-effort revoke fails, the browser drops the grant ID while the server retains it.

**Repro:** Repeatedly let a five-minute write grant expire in the file-review panel and request another, or double-click R2 approval while the first request is pending. At the default 128 stored-grant limit, new grants fail even though the stranded grants are expired or unreachable from the UI. They remain counted until a request or DELETE happens to clean them up, or the process restarts.

Prune expired gateway and service grants before issuing, and disable approval while a request is in flight. The default cap is useful only if expired entries stop counting.

### P2 — Common key filenames pass the secret-path filter

**Evidence:** `packages/tools/src/local-workspace.ts:302-317,1445-1459`.

The filter blocks `.key` extensions and exact SSH key basenames, but it does not block names such as `api-key.txt`, `private-key.txt`, or `id_rsa.backup`.

**Repro:** Put a private key or API credential in `api-key.txt` at an allowed project root. The path predicate accepts it, so the file can appear in listing, read, and search results.

This exposes the file in the local browser; it is not automatic provider egress, and the R2 import path still requires a per-file sharing choice. Extend the deny rules to cover common key-name variants and test them.

### P2 — Reject can race an in-flight approval

**Evidence:** `packages/tools/src/local-workspace.ts:848-901`.

Approval serializes by path while it writes, but `rejectPatch` changes the same patch status without taking that lock. If rejection arrives after approval has passed its proposed-state check but before the rename finishes, rejection can return `status: rejected`; approval then writes the file and changes the final status to `approved`.

**Repro:** Send the approve and reject requests concurrently with the same write grant and patch ID, with the reject landing during the temporary-file write. The reject response says the original file is unchanged even though approval can subsequently replace it. This does not bypass the explicit approval marker, but it makes rejection an unreliable state transition.

Serialize reject with approve and rollback, or make the state transition atomic before beginning the write and prevent rejected proposals from committing.

### P2 — The full-file diff is visually misleading and has no rendered-line cap

**Evidence:** `packages/tools/src/local-workspace.ts:1226-1247`; `apps/web/src/components/local-file-review.tsx:910-943`; the implementation note acknowledges the full-replacement format at `docs/implementation/LOCAL_FILE_REVIEW.md:26`.

Every before line is emitted as removed and every proposed line as added, while the UI calls it simply “Diff yang ditinjau.” A one-character edit therefore makes unchanged lines look deleted and re-added, hiding the actual change. The UI does not explain this format. The 1 MiB byte limit does not bound line count: a newline-heavy text file can expand into roughly two million diff-line spans in the browser.

**Repro:** Edit one character in a near-limit file containing many short or blank lines. The review panel marks the whole file red and green; a newline-heavy file can allocate millions of spans and stall the tab.

Use a minimal context diff or a side-by-side view, label any full replacement clearly, and cap rendered diff lines with a useful fallback.

### P2 — The rollback handle is lost when the review component goes away

**Evidence:** `apps/web/src/components/local-file-review.tsx:150,197-210`; project-keyed mount at `apps/web/src/components/workspace-conversation.tsx:1900-1903`; the in-memory patch record is described at `docs/implementation/LOCAL_FILE_REVIEW.md:29-35`.

The patch ID and saved before bytes are available through the current component state and process-local record. Unmount revokes the grant, and the patch ID is not persisted or discoverable through a patch-list route. The file remains changed, but switching projects or refreshing after approval removes the UI path to rollback even if the server has not restarted. The engineering note discloses restart loss, but the user-facing “Pulihkan versi sebelumnya” action does not say rollback is session-bound.

For this explicitly local, in-memory design, this is not a write-integrity bypass. Treat rollback as session-only in the UI, or retain a recoverable patch handle if users are expected to undo after leaving the panel.

### P3 — The file-review read grant stays visually active after expiry

**Evidence:** `apps/web/src/components/local-file-review.tsx:212-225,661-705`.

Only the write grant has an expiry timer. `activeGrantId` falls back to `readGrant` without checking its expiry, and the permission card stays hidden while that object remains. After 15 minutes, file operations receive the server's expired-grant response until the user manually chooses “Hentikan izin baca”; the panel does not offer a direct re-approval state.

**Repro:** Leave the panel open past the read-grant expiry and click a file. The UI still presents the old grant and requires a manual revoke before it can be approved again.

Expire and clear the read grant in the UI as well, so the panel returns to its explicit approval state.

### P2 — Apply and rollback completion are not announced accessibly

**Evidence:** `apps/web/src/components/local-file-review.tsx:440-464,927-943,974-1000,1102-1115`.

On a successful apply or rollback, the action button is removed and the badge text changes, but normal success does not set a live status message or move focus. The only live region announces work while `busy` is true, then disappears. A keyboard or screen-reader user can hear that work started without hearing that the file changed or was restored.

The collapse button also keeps `aria-controls="local-file-review-body"` while the body is conditionally removed when closed (`local-file-review.tsx:629,642-644`), leaving the control reference unresolved in that state.

Announce the completed state in a persistent `role="status"` region and move focus to a stable review heading or status after the action.

## Acceptable documented limits and reviewed controls

- The loopback, Host, same-origin Origin, forwarded-header, and mutating-request checks are centralized in `assertLocalSameOrigin`; route handlers call that guard. The focused tests inspect cross-origin, remote-host, forwarded, and same-origin cases. No CSRF bypass was found in this slice.
- Read grants are project-bound and root paths are server-only. Writes remain separately opted in, use a five-minute write grant, require an explicit action marker, and recheck the target hash and inode before rename. Rollback restores the saved bytes only while the approved after-hash still matches.
- The R1 source-consent path refreshes selected source permission and readiness before saving a turn and again before creating a run; the backend remains authoritative at run creation. The consent helper rejects missing, deleted, unversioned, ineligible, or non-shareable sources. No local file-review content is attached to chat.
- The file-review panel has one primary action per stage; reject, cancel, and close are secondary. The R2 source-browser approval and import stages also have a single primary action.
- The documented external-editor race remains real: a write after the final hash check but before rename can be overwritten. Changes observed before that check conflict. The local-only scope and explicit approval make this a documented limitation for this slice, but the implementation is not an OS-level compare-and-swap or multi-process lock.
- Process-local rollback data is explicitly documented as lost on server restart. Its consequence is that an already approved file remains changed without an app-level undo record; the UI should disclose that limit before applying.
