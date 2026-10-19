# Codex file draft recovery

The draft flow stores an unresolved create request in project scoped
`sessionStorage` before sending it. The stored request contains the idempotency
key and prompt version ID, but no task text or file text.

## Unresolved create request

Status lookup by the saved idempotency key is read only and remains available
when the selected file context is stale. If the server returns
`RUN_NOT_FOUND`, the client checks the saved project, file path, raw snapshot
hash, read and write grant IDs and expirations, the current verified Codex
model, and both sharing consents before reposting the exact same request. The
retry is manual; mounting or returning to a project never creates a run.

If any check fails, the saved request remains unresolved and the editor stays
locked. The user can still inspect status for the same key. Once a run is
accepted, the client moves its run ID, status, captured context, and
metadata-only request into a project scoped active record before clearing the
pending record.

## Accepted run

Active run state is reloaded when the draft component remounts or the user
returns to its project. Active and unknown statuses remain locked and continue
through the existing run event stream. `succeeded` and `failed` release the
lock after the durable status arrives. `interrupted_unknown`, paused statuses,
and unrecognized statuses remain locked and stored so the user cannot infer a
new idempotency key while the remote result is uncertain.

Cancellation keeps the existing cancellation request and reports that a
`canceled` run does not prove the remote worker stopped. When the response
doesn't explicitly set `remoteOutcomeKnown: true`, the UI says the remote
outcome is still unknown.

## Focused coverage

The helper unit tests cover recovery eligibility, changed or expired context,
provider and consent checks, and metadata only active storage. The offline
browser recovery spec covers a stale `RUN_NOT_FOUND` without a POST, active
run recovery after remount, and the lock after `interrupted_unknown`.
