# Local file review fixture refresh

The local review UI now requires a verifiable snapshot hash before it opens a
file or creates a proposal. The offline browser fixture therefore computes
`contentHash`, `beforeHash`, and `afterHash` from the UTF-8 bytes of the matching
fixture content. Each proposal request is also checked for the original
`expectedBeforeHash` and `source: "user_editor"`.

This keeps the fixture aligned with the backend's raw-byte SHA-256 contract and
exercises the production stale-snapshot guard. The existing rejection,
approval, conflict reload, rollback, read-grant expiry, and project-switch
checks remain in the spec.

Focused verification passed: ESLint on the spec, Prettier on the spec and this
note, and standalone TypeScript checking of the spec. Browser execution is
pending until the in-progress local review source changes settle.
