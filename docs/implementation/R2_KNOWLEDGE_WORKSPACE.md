# R2 — Knowledge workspace and authorized local reads

**Status:** implementation and offline verification complete for the R2 knowledge/source slice. This does not claim a live database, provider, Campus Gateway, or worker integration.

## Server boundary

The web server reads its local root allowlist from `PROMPTLAB_LOCAL_WORKSPACE_ROOTS`. The value is a JSON array keyed by an existing project ID:

```sh
PROMPTLAB_LOCAL_WORKSPACE_ROOTS='[{"projectId":"<existing-project-uuid>","rootPath":"<absolute-approved-root>"}]'
```

Replace both placeholders before configuring the server. The example contains no real path or credential. An unset or empty value authorizes no roots. Invalid JSON, invalid project IDs, duplicate IDs, non-absolute roots, or roots rejected by the existing `packages/tools` local-workspace service fail closed. Root values are server-only and never appear in status, grant, list, read, search, or import responses.

`POST /api/projects/{projectId}/workspace/grants` accepts only the explicit `read_only_project_root` approval. It issues an opaque project-bound grant with a 15-minute expiry. The service grant stays behind the web wrapper; the browser keeps its wrapper token in component memory, and can revoke it with `DELETE /workspace/grants/{grantId}`. Grants are process-local and are invalidated by expiry, revocation, server restart, or leaving the Sumber panel. The server checks project-to-grant binding on every operation.

Workspace endpoints are restricted to same-origin requests on loopback hosts. Mutating requests require an exact Origin match; read requests require the matching Origin, same-origin Fetch Metadata, or a same-origin Referer. Forwarded-host requests are rejected. The local Docker Compose web service may use `0.0.0.0` as Next.js's internal bind URL; that address is accepted only when the request's actual `Host` and origin remain loopback and same-origin. Compose publishes the web port on host loopback. The routes expose only:

- `GET /workspace` — project root configuration and whether the database URL is configured; no path.
- `GET /workspace/grants/{grantId}/list?path=...`
- `GET /workspace/grants/{grantId}/read?path=...`
- `GET /workspace/grants/{grantId}/search?q=...`
- `POST /workspace/grants/{grantId}/import`

List, read, and search delegate to `packages/tools/src/local-workspace.ts`, retaining its path checks, exclusions, text validation, and server-side operation limits. Errors use the service’s safe code/message shape or a fixed adapter error. No filesystem write, patch, shell, command, or test-execution route was added.

The current app has no persisted user/session grant model. This slice binds grants to a configured project and keeps them in the local server process; it does not claim multi-process or multi-instance grant sharing.

## Sumber and import behavior

The Sumber screen uses existing knowledge APIs for the active source list, readiness, source preview, permission updates, removal, and retrieval selection. The common view shows active-source counts and retrieval readiness. Chunk, snapshot, GraphRAG build, evidence, and retrieval diagnostics are inside a closed-by-default advanced section; the existing GraphRAG retrieval route and backend remain in use.

The local folder panel starts unavailable when its project has no configured root. A user must check the read-only approval and press the approval button before the browser can list, read, or search. The grant expires after 15 minutes and is revoked on request, project change, or panel unmount. The browser does not send a filesystem root or file content to the import endpoint; the server reads a relative path through the approved grant.

Import is limited to UTF-8 `.txt`, `.md`, and `.markdown`. The user must explicitly choose `local_only` or `campus_indexer_allowed` for each import; the API rejects a missing or invalid policy. Local imports call the existing knowledge `createKnowledgeSource` function. Reimporting the same active local relative path calls `replaceKnowledgeSource` to preserve source-version lineage. Each stored version includes the normal knowledge checksum and `origin`, relative path, import time, and SHA-256 metadata. It stores no absolute path. Allowing Campus Gateway does not itself start indexing; the existing preview and separate egress approval still apply.

Pengaturan includes a Folder & izin subsection. It reports the selected project’s configured-root state without displaying the root and explains how to configure the server environment. It reports when `PROMPTLAB_DATABASE_URL` is absent; it does not claim the database is healthy merely because the URL exists. If the database is unavailable, local read/preview can still work when a root is configured, but source import remains unavailable.

## Changed paths

- `apps/web/src/lib/local-workspace.ts`
- `apps/web/src/lib/local-workspace-api.ts`
- `apps/web/src/lib/local-workspace.test.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/list/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/read/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/search/route.ts`
- `apps/web/src/app/api/projects/[projectId]/workspace/grants/[grantId]/import/route.ts`
- `apps/web/src/components/knowledge-workspace.tsx`
- `apps/web/src/components/knowledge-workspace.module.css`
- `apps/web/src/components/local-source-browser.tsx`
- `apps/web/src/components/local-source-browser.module.css`
- `apps/web/src/components/local-workspace-status.tsx`
- `apps/web/src/components/local-workspace-status.module.css`
- `apps/web/src/app/(product)/settings/page.tsx`
- `apps/web/e2e/r2-knowledge-workspace.spec.ts`

## Verification and limits

Offline checks run for this slice:

- `rtk ./node_modules/.bin/vitest run apps/web/src/lib/local-workspace.test.ts apps/web/src/lib/knowledge-api.test.ts packages/tools/src/local-workspace.test.ts` — 3 files passed, 24 tests passed.
- `rtk ./node_modules/.bin/tsc --noEmit --project apps/web/tsconfig.json` — passed.

The route tests use temporary directories and injected knowledge persistence; they cover empty and invalid configuration, browser root injection rejection, loopback/same-origin guards, project and grant binding, expiry, revocation, list/read/search, explicit import policy, unavailable database behavior, unsupported file types, and relative provenance. Existing local-workspace service tests also ran.

The new Playwright spec uses API fixtures only, including a disconnected-root/database state. It does not require a live database or provider. Browser execution and screenshot inspection are recorded separately after checking that the shared `.next` directory is not in use.

No production database, provider, Campus Gateway, or worker was contacted. No schema, migration, install, package manifest, lockfile, secret, or environment credential was changed. The existing source and GraphRAG APIs remain the ingestion/retrieval implementation.
