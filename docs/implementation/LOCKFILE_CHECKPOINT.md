# Lockfile checkpoint audit

Audit date: 2026-10-16

## Current file

- `pnpm-lock.yaml`: 270,694 bytes
- SHA-256: `ac0bf35beade8d549aa16d0d304e9235861a250ace28914662ae2abfec7bd08c`

## Findings

- The prior documented checkpoint size is 270,347 bytes, making the current file 347 bytes larger. No project pnpm lockfile snapshot or checkpoint copy was found in the project’s `.local` or `backups` directories, so the byte difference cannot be tied to a specific content change. A size comparison alone does not establish byte-identical recovery or provenance.
- All nine lockfile importers match the active root, app, package, and eval manifests. Their direct dependency names and specifiers match, with no importer-only direct dependency, missing importer, or extra importer found. This confirms agreement with the current manifests; without a prior manifest and lockfile baseline, it does not establish whether a dependency was added historically.
- No package-manager or test command was run.
