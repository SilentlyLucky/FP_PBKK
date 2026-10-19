# Local workspace read-only foundation

**Status:** standalone server-side foundation. It is not connected to an app route, browser screen, or agent tool.

This implements the v3 PRD's `read_only` profile: list, read, and search under an approved project root. It deliberately provides no write, patch, shell, command execution, network, database, or provider capability. The v3 PRD requires approved-root scoping, path normalization, symlink and hard-link handling, secret/internal exclusions, and bounded operations (design ZIP `PromptLab_QA_First_UI_Mockups_v3_with_PRD.zip`, `PRD.md` §5.2–5.4; `README_QA.md`, “Ketentuan perilaku implementasi”). The rebaseline identifies workspace file access as a new seam, not an existing active route or tool (`docs/implementation/REBASELINE.md`).

## API

The exported API is in `packages/tools/src/local-workspace.ts` and re-exported from `packages/tools/src/index.ts`.

```ts
const workspace = await createLocalWorkspaceService({
  // Load this only from trusted server configuration/project records.
  allowedProjectRoots: [
    { projectId: "project-123", rootPath: "/srv/work/project-123" },
  ],
});

// Call only after the server has authorized this project and the user has
// explicitly requested a read-only grant.
const grant = workspace.issueGrant("project-123");
const tree = await workspace.list(grant.grantId); // or list(grant.grantId, "src")
const file = await workspace.read(grant.grantId, "README.md");
const matches = await workspace.search(grant.grantId, "workspace");
workspace.revokeGrant(grant.grantId);
```

`createLocalWorkspaceService()` defaults to an empty root allowlist. No grants exist until `issueGrant` is called. Grant issuance accepts only a configured `projectId`; callers cannot supply or extend a root as part of grant issuance or file operations. Roots are canonicalized at service construction, then revalidated with `lstat`/`realpath` before path operations. The grant descriptor contains an opaque UUID, project key, `read_only` access, and `project_root` scope; it does not return the filesystem root.

Operations accept only a grant ID and a relative slash-separated path. The empty path denotes the root for `list`; read requires a file path. Absolute paths, drive paths, backslashes, NUL, empty segments, `.` and `..` are rejected. Every existing path component is checked; symlinks are refused, symlink directory entries are omitted, paths must remain under the canonical root, and regular files with `nlink > 1` are refused as hard links. Reads use `O_NOFOLLOW` where the platform exposes it and verify the opened file handle's target before returning content (using `/proc/self/fd` on Linux).

`LocalWorkspaceError` has a stable `code`, a fixed safe `message`, and `toJSON()` returning only `{ code, message }`. Filesystem error details, requested paths, and file contents are not included. Server adapters should catch this class and serialize `error.toJSON()`; they should also map unexpected adapter errors to a fixed generic response.

## Trust boundary

- The allowlist and its canonical project roots are trusted server configuration. Do not construct them from browser or model input.
- `issueGrant` and `revokeGrant` are trusted server operations. Do not expose grant issuance as an unauthenticated endpoint or let model output invoke it. Bind the authorized project and current user in the server before calling it.
- Treat `grantId` as a bearer capability. Keep it server-side where possible, never put it in model context, and never accept a caller-supplied filesystem root. Recheck session, project ownership, Origin/CSRF policy, and the user's explicit grant decision at the app boundary.
- Pass only the resulting scoped grant to a future server wrapper for `list`, `read`, and `search`. File contents are untrusted input and cannot change policy or add tools.
- Revocation blocks later operations and prevents an in-flight operation from returning once it observes revocation. Grants are held in process memory only; restarting the process invalidates them.

The module does not implement authentication, session/CSRF checks, grant persistence, audit storage, or app integration. `issueGrant` must remain behind the server authorization flow when those layers are added.

## Exclusions and bounds

All dot-prefixed path segments are excluded. The service also excludes internal directories such as `backups`, `build`, `coverage`, `dist`, `node_modules`, `vendor`, `venv`, `tmp`, and `temp`; credential/secret/token-named files and folders; `.env` forms; private-key formats; the standard extensionless OpenSSH host-key names `ssh_host_rsa_key`, `ssh_host_dsa_key`, `ssh_host_ecdsa_key`, and `ssh_host_ed25519_key` (case-insensitively); and database files (`.db`, `.sqlite`, `.sqlite3`, and `.dump`). There is no per-request or user override. This conservative rule also hides benign dotfiles such as `.gitignore` and `.editorconfig`.

`read` accepts bounded, valid UTF-8 text only. NUL-containing and invalid UTF-8 files are treated as binary. `search` is a literal case-insensitive search and returns bounded line snippets. List/search omit excluded paths and symlinks. Search reports partial results with `truncated` and a `limitReason`; `filesSkipped` counts unsupported, oversized, or inaccessible files that were skipped.

| Server-configured limit              |          Default |     Hard maximum |
| ------------------------------------ | ---------------: | ---------------: |
| Active grants                        |              128 |            1,024 |
| Read file size                       |            1 MiB |            8 MiB |
| Directory entries examined by `list` |              200 |            1,000 |
| Search files                         |              100 |            1,000 |
| Search directory entries             |            2,000 |           10,000 |
| Search results                       |               50 |              200 |
| Search bytes                         |           16 MiB |           64 MiB |
| Search duration                      |         1 second |       10 seconds |
| Search depth                         |                8 |               16 |
| Query length                         | 1,000 characters | 4,000 characters |
| Snippet length                       |   240 characters | 1,000 characters |

Invalid server limit configuration fails closed. List/search limits are never provided by a model or browser request. Search checks its monotonic deadline between filesystem operations and while traversing; a single in-progress local filesystem call can exceed the deadline before control returns.

## Verification

`packages/tools/src/local-workspace.test.ts` uses temporary directories only. It covers empty defaults, explicit grant scope/revocation, traversal and absolute path injection, symlink escapes, secret/internal exclusions, extensionless OpenSSH host-key refusal from read/list/search (including case-insensitive matching), size/binary/hard-link refusal, ordinary list/read/search behavior, and grant/list/search limits including deterministic search-time truncation.

Verified with the installed binaries directly, without changing shared configuration or installing dependencies:

- `rtk ./node_modules/.bin/vitest run packages/tools/src/local-workspace.test.ts` — **1 test file passed; 9 tests passed**.
- `rtk ./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck packages/tools/src/local-workspace.ts packages/tools/src/local-workspace.test.ts` — **passed**.
- `rtk ./node_modules/.bin/prettier --check packages/tools/src/local-workspace.ts packages/tools/src/local-workspace.test.ts docs/implementation/LOCAL_WORKSPACE_FOUNDATION.md` — **passed**.

No production `.env`, provider inference, database, migration, app, or worker was accessed for this foundation. No application integration is claimed.

## Limitations and integration steps

This is an in-process capability service, not an OS sandbox. Path checks and `O_NOFOLLOW` narrow filesystem races, and hard links are refused, but portable Node path-based filesystem calls cannot fully eliminate a hostile concurrent local mutation race in every platform/runtime. Deploy it in the trusted local server/runtime; use an OS sandbox or descriptor-relative filesystem API if the threat model includes an adversary that can mutate the project tree concurrently.

To integrate later, load configured project roots on the server, authorize an explicit read-only request, issue and retain a grant server-side, expose only the three read operations through authenticated routes, serialize safe errors, and revoke on access change/session lifecycle. Keep write/edit approval, patch review/apply, isolated evaluation, and command execution in separate contracts with their own security review; this service cannot perform them.
