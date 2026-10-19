# Recovery Notes

Date: 2026-10-16

## Provider smoke ledger

- Canonical path: docs/PROVIDER_SMOKE_LEDGER.json
- Historical source copy: backups/docs/PROVIDER_SMOKE_LEDGER.json
- SHA-256: 4e6b3f4c3899141cc7029347f0d7e22d6c752afba96c6353ff8895cfbccf71c8
- The canonical file was already present during recovery inspection and was left untouched. SHA-256 and byte comparison confirm it exactly matches the backup copy.
- Validation passed through createProviderSmokeLedger(...).getSmokeLedgerSnapshot() in packages/providers/src/provider-smoke-ledger.ts, which applies the source contract schema validator. No provider calls were made.
- These ledger entries are HISTORICAL records. This recovery is not new live provider verification.
