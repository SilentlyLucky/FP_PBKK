# Workspace proposal snapshot binding

Workspace reads now include `contentHash`, a lowercase SHA-256 digest of the
exact raw UTF-8 bytes read from disk. The digest preserves byte-level
differences such as a UTF-8 BOM and `LF` versus `CRLF` line endings; it is not
computed from normalized or re-encoded display text.

Proposal requests may include an optional `expectedBeforeHash` string alongside
the existing `path`, `content`, and `source: "user_editor"` fields. When
supplied, the API and gateway require exactly 64 lowercase hexadecimal
characters. The workspace service compares it with the current raw file bytes
while creating the proposal. A mismatch returns `PATCH_CONFLICT` (HTTP 409)
before a proposal is stored, and does not change the file. Existing apply-time
hash checks remain in force after proposal creation.

Clients that need protection from edits made after their read must retain the
read response's `contentHash` with that snapshot and send it as
`expectedBeforeHash` when proposing the edit. They should not recalculate the
hash from displayed, edited, or generated text. On `PATCH_CONFLICT`, refresh
the file and review the proposed change against the new snapshot. Omitting the
field remains supported for older clients; those callers do not receive the
read-to-proposal stale-file check.

Caller status: the local file review UI now retains the read response's
contentHash with the selected snapshot and sends it as expectedBeforeHash when
creating a proposal. It refuses to propose when the read response has no valid
hash, and it does not recalculate the hash from displayed, edited, or generated
text. On PATCH_CONFLICT, it reloads the latest file and keeps the user's editor
text visible with an explanation that it must be reviewed against the new
snapshot. After apply or rollback, it binds the displayed snapshot to the
server-returned afterHash or beforeHash.

The existing relative-path, grant, symlink, hard-link, secret-file, and size
checks are unchanged. Proposal creation remains non-mutating, and applying a
proposal still requires the existing explicit approval action.
