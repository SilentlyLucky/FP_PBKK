# Local file review and approved patch slice

**Status:** implemented as a bounded local server capability and Workspace UI. The server remains read-only by default. This extends the foundation in `LOCAL_WORKSPACE_FOUNDATION.md` and R2's read routes; it does not add an agent tool or claim live Codex workspace editing.

## Write opt-in

Existing `PROMPTLAB_LOCAL_WORKSPACE_ROOTS` remains the read allowlist. Writes require both:

```sh
PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED=1
PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS='["<existing-project-uuid>"]'
```

Each listed project must already be present in the server's read-root allowlist. The write setting names project IDs only; it cannot supply a path or expand a root. Missing, malformed, or disabled write configuration leaves configured read access working and reports `writeAvailable: false`. No environment file or credential was changed for this implementation.

The Workspace UI first asks for a short-lived read grant to browse files, then separately asks the user to state the intent to edit before it requests a five-minute `workspace_write` grant. The server requires the explicit write-intent marker and a configured project opt-in. A read-only grant cannot propose, approve, reject, or roll back patches. Same-origin loopback checks remain in force.

## Review and apply behavior

- `POST /workspace/grants/write` issues a write capability only after the explicit `workspace_write_project_root` approval marker and server opt-in.
- `POST /workspace/grants/{grantId}/patches` accepts only structured `user_editor` text, a relative path, and proposed text. There is no model or shell route to create or apply a patch.
- `GET /workspace/grants/{grantId}/patches/{patchId}` returns the immutable review snapshot.
- `POST .../{patchId}/approve`, `reject`, and `rollback` require separate explicit action markers.
- Proposals capture the normalized relative path, exact before and proposed UTF-8 bytes, SHA-256 before/after hashes, and an in-process expiry. No-op, binary, invalid UTF-8, secret, excluded, oversized, symlink, hard-linked, or out-of-root files are refused.
- Approval rechecks the live grant, file path, inode, and before hash immediately before a same-directory temporary-file rename. A changed file returns a conflict and is not silently overwritten. Repeating approval is idempotent while the file still matches the approved hash. Rollback writes the saved exact before bytes only while the current hash still equals the approved after hash; a later edit blocks rollback.
- The diff is a bounded full-file replacement view, so every old line is shown as removed and every proposed line as added. It is not a minimal context diff.
- Proposals are user-authored in the Workspace review panel. The UI states that automatic Codex editing is unavailable. File contents stay in the local review panel and are not attached to chat/provider requests. A future attachment path needs its own visible egress choice and send-time permission/content validation.

## Isolated project evaluation

When enabled by the server, a proposed patch can be checked against the same named test on two separate project snapshots: the baseline copy and a candidate copy with the proposed file content. The project folder is not changed by evaluation. The runner executes the configured command once per snapshot, sequentially, inside bubblewrap with networking disabled, a cleared environment, a private temporary home, and only the selected runtime plus its required system libraries mounted read-only. The snapshot at `/workspace` is writable so test tools can create their normal output without touching the original project.

Evaluation commands are trusted server configuration. The request only selects a configured `testId`; it cannot submit an executable, shell command, arguments, or path. Commands use a fixed ELF executable and argument array; no shell is started. Configure them through `PROMPTLAB_LOCAL_WORKSPACE_EVALUATION_COMMANDS` as a JSON array grouped by project:

```sh
PROMPTLAB_LOCAL_WORKSPACE_EVALUATION_COMMANDS='[{"projectId":"00000000-0000-4000-8000-000000000001","commands":[{"id":"vitest-core","label":"Core Vitest checks","executable":"/home/lenovo/.nvm/versions/node/v22.23.2/bin/node","args":["node_modules/vitest/vitest.mjs","run","packages/tools/src/workspace-evaluation-runner.test.ts","--pool=threads","--maxWorkers=1"],"timeoutMs":60000}]}]'
```

Replace the example UUID with the project's configured ID and the executable with the server's absolute Node binary path. The command's working directory is the project snapshot, so arguments such as `node_modules/vitest/vitest.mjs` resolve inside that copy. The executable must be Node or an allowed system runtime; extra `runtimePaths`, if needed, may only refer to system runtime data under `/usr/lib`, `/usr/share`, `/lib`, or `/lib64`. Keep the argument list fixed and narrow to the checks reviewers need. The project must also be enabled for writes using both `PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED=1` and `PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS`; evaluation configuration for a project without that write opt-in is rejected. The normal explicit write grant is still required before evaluating a proposed patch.

Each snapshot is limited to 1 GiB and 50,000 entries by default. The runner limits each command to 30 seconds by default (60 seconds maximum), 45 CPU seconds, 1 GiB address space, 256 processes, 64 MiB per output stream, and 64 MiB per file. Secret files and selected generated or private directories are excluded when snapshots are copied; excluded-entry counts are included in the report. If bubblewrap or the configured runtime cannot be verified, evaluation reports unavailable instead of executing without isolation.

The report includes hashes for the starting, baseline, and candidate snapshots; file and byte counts; excluded-entry count; duration, exit code, stdout, stderr, and reason for both runs. Its interpretation is deliberately based on the same configured command and exit codes:

- `pass`: baseline and candidate both exit 0.
- `candidate_regression`: baseline exits 0 and candidate exits nonzero.
- `candidate_improved`: baseline exits nonzero and candidate exits 0. This is evidence of improvement on that check, not proof of overall correctness.
- `baseline_failing`: both exit nonzero; the run cannot attribute the failure to the candidate.
- `inconclusive`: a timeout, output limit, unavailable execution, or another non-completed arm prevents a comparison.

These results are interpretable evidence for the configured check, not a general quality score. A passing check proves only that command passed on those two snapshots. Configure tests that cover the patch's intended behavior and inspect the returned output and hashes before approval.

## Storage and limits

Grants and patch snapshots live in process memory. A server restart invalidates grants and removes pending/rollback records. The service retains at most 16 snapshots by default, pruning expired, rejected, and rolled-back records when it needs room; if active or approved snapshots fill the cap, new proposals fail closed. There is no production database, migration, general shell execution, or backup file. The approved before bytes are retained only in the in-process patch record for rollback. The existing service's default text limit is 1 MiB per file; configured server limits remain subject to the existing hard ceiling. The write grant lasts five minutes and an unapproved proposal expires after ten minutes.

The filesystem write uses an immediate hash/inode check and an atomic same-directory rename. Portable path-based Node APIs cannot provide a conditional compare-and-swap against an adversarial concurrent editor that changes the target in the small interval after the final check. This remains a local server capability, not an OS sandbox or multi-process lock.

The routes retain the existing loopback and same-origin guard and use short-lived bearer grants held in browser memory. The app still has no persisted user/session authorization layer; this slice is for the configured local runtime, not a network-exposed deployment.

## Changed paths

- `packages/tools/src/local-workspace.ts`
- `packages/tools/src/local-workspace-patches.test.ts`
- `packages/tools/src/index.ts`
- `apps/web/src/lib/local-workspace.ts`
- `apps/web/src/lib/local-workspace-api.ts`
- `apps/web/src/lib/local-workspace.test.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/write/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/patches/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/patches/[patchId]/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/patches/[patchId]/approve/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/patches/[patchId]/reject/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/patches/[patchId]/rollback/route.ts`
- `apps/web/src/components/local-file-review.tsx`
- `apps/web/src/components/local-file-review.module.css`
- `apps/web/src/components/workspace-conversation.tsx`
- `packages/tools/src/workspace-evaluation-snapshots.ts`
- `packages/tools/src/workspace-evaluation-runner.ts`
- `packages/tools/src/workspace-evaluation-runner.test.ts`
- `docs/implementation/LOCAL_FILE_REVIEW.md`

## Verification

- Focused Vitest: `packages/tools/src/local-workspace.test.ts`, `packages/tools/src/local-workspace-patches.test.ts`, and `apps/web/src/lib/local-workspace.test.ts` — **3 files and 34 tests passed**. Write and rollback operations use temporary directories only.
- Strict TypeScript check for the local workspace service and its focused tests — **passed**.
- Prettier check on the changed TypeScript, TSX, and CSS files — **passed**.
- Full `apps/web` typecheck — **blocked by errors in concurrently changing experiment and worker files** (`acceptance-eligibility.test.ts` has strategy type mismatches and a duplicate property; `packages/agent/src/python-candidate-sandbox.ts` has a `NODE_ENV` process-environment type error). No errors were reported in the new local file review code. Those files are outside this slice and were not edited.
- No browser, build, provider, database, or actual project-file patch run was performed.
