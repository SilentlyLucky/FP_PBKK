# Consented Codex text drafts for local files

## Flow

The local file review editor can ask the configured, verified Codex target to
draft replacement text for the one file currently open. The user enters a
focused task and separately agrees to:

1. send the selected file text to Codex; and
2. save the task and file text in the project's prompt and run history.

The read grant only authorizes local reading. It does not grant either of these
sharing permissions. The disclosure states that only the task and selected file
text are sent, the text is untrusted, no retrieval sources or other files are
included, and Codex receives no file or command access.

The client saves the composed prompt through the project's normal prompt API
and creates a normal run with provider **codex_app_server**, purpose **target**,
the verified configured model, and an empty retrieval source list. The
server's usual provider, model, usage, and run checks remain in force. There is
no alternate provider if Codex is unavailable or unverified.

The prompt does not include the selected file path or workspace root. It marks
the file text as untrusted and JSON-quotes it as data. The result is accepted
only as editable text in the local editor. Proposal creation continues through
the local workspace route with source **user_editor**; the existing diff,
write grant, and explicit apply confirmation remain separate steps.

## Bounds and snapshot binding

- Selected file text: at most 64 KiB after UTF-8 encoding.
- User task: at most 4,000 Unicode code points.
- Codex answer: at most 128 KiB after UTF-8 encoding.
- Values outside these bounds are rejected in full; the client does not
  truncate them.
- A draft context captures project, relative file path, raw snapshot hash, and
  the read and write grant IDs and expirations. A result is discarded if any
  part changes or either grant expires.
- A proposal must include the snapshot's original contentHash as
  expectedBeforeHash. A missing or malformed hash prevents proposal creation.
- A proposal conflict reloads the latest snapshot while preserving the
  editor's text and explaining that the user must review it against the new
  file. Apply and rollback bind the visible snapshot to the returned
  afterHash and beforeHash, respectively.

## Run recovery and cancellation

Before posting a run request, the client stores its exact request and
idempotency key in project-scoped session storage. If the response is
ambiguous, the editor remains locked against another draft. The user can query
the run by the same key; if the server confirms it does not exist, the client
reposts the identical request with that key. A confirmed run is tracked through
the existing persisted run event stream and appears in project run history.

Changing project, file snapshot, or grant unmounts the draft flow, aborts its
browser request, and closes its local event stream. It does not claim that a
remote run stopped. A late or recovered answer still has to pass the captured
project, file, hash, and grant checks before it can enter the editor.
Cancellation sends the normal run cancellation request and tells the user that
the provider may still be working.

## Offline coverage

The focused unit test covers independent consent, input/output caps, prompt
path exclusion, same-key recovery classification, and stale or expired
context rejection.

The fixture browser test intercepts every API request. It proves that a result
enters the editor, proposal creation sends the original snapshot hash, no file
mutation happens before explicit approval, and a stale pre-proposal conflict
reloads the source without discarding the editor text.
