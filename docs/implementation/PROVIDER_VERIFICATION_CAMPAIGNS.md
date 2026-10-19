# Provider verification campaigns

The provider verifier supports an explicitly named application verification
campaign through the backend environment variable
`PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN`. Set it before starting the backend:

```sh
export PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN=live-journey-2026-10-17-7c3f8d2e
```

The value must be exactly 32 lowercase ASCII letters, digits, or internal
hyphens. It cannot contain a slash, backslash, dot, whitespace, or other path
syntax. The example above is one valid 32-character ID. The backend reads this
setting when the provider verifier module starts; use the same value for every
backend process serving the campaign and after restarts.

The campaign ledger is stored beside the selected base ledger at
`<base-ledger-directory>/provider-verification-campaigns/<id>.json`. Local
processes default to `<PromptLab root>/docs/PROVIDER_SMOKE_LEDGER.json`. Docker
Compose sets `PROMPTLAB_PROVIDER_LEDGER_PATH` to
`/var/lib/promptlab/provider-ledger/PROVIDER_SMOKE_LEDGER.json`; web and worker
share the persistent `provider-ledger-data` volume seeded from the historical
ledger. The provider verifier creates a ledger for a previously unused valid
ID and stores that ID in the ledger schema. A companion
`<id>.json.initialized` file records that the campaign has been initialized. A
missing, corrupt, or differently named ledger fails closed. If an initialized
ledger is missing, the verifier refuses to recreate it. Neither condition
falls back to the historical ledger.

The historical smoke ledger remains capped at two reserved calls per provider
for direct smoke-test tooling. User-triggered verification from Settings uses
that budget only when a named campaign is explicitly configured. Without a
campaign, each explicit click sends one bounded verification request and stores
its receipt in the provider connection database; it does not consume or update
the historical ledger. Named campaigns have separate per-provider ceilings recorded in
`maxInferenceCallsByProvider`; the code permits ceilings up to 110 calls per
provider. A reservation is written under the ledger lock before a provider
request starts, so failed requests and requests with unknown outcomes still
consume one application verification reservation. These ceilings are
PromptLab's per-campaign verification budgets; they are not provider quotas,
rate limits, or billing limits. Normal worker generations do not use this
verifier ledger.

The Flow 2 campaign `v3-live-validation-20261017-a-01` has ceilings of 73
Campus calls and 110 Codex calls. Its ledger counters are cumulative; a new
run must use the remaining budget in that same ledger rather than resetting it
or creating another campaign ID.

The active Flow 1 follow-up campaign
`flow1-live-20261018-000000000001` has ceilings of 8 Campus calls and 9 Codex
calls. After its first incomplete run, the existing counters are Campus 5/8
and Codex 3/9. The Flow 1 rerun must continue with this same ledger; do not
reset its counters or initialized marker.

Use one ID for the entire bounded verification journey. An uninitialized
campaign defaults to two calls per provider. For a larger bounded run, initialize
it explicitly with `createProviderSmokeLedger(path, campaignId, { campus_gateway,
codex_app_server })`. The maximum is 110 calls per provider. Choosing a new ID
creates a separate application budget, so selecting it has real budget impact.
Do not change the ID to work around an exhausted campaign.

When the variable is absent, Settings verification does not use a campaign
ledger. Direct smoke-test tooling that calls the ledger API without a campaign
continues to use `docs/PROVIDER_SMOKE_LEDGER.json` and the historical session
`foundation-provider-spike-2026-10-11`. That ledger and its existing counters
remain intact. The historical record is Campus `2/2` and Codex `2/2`; these
counts no longer block manual Settings verification. Docker Compose passes the
optional campaign ID to both web and worker services when one is configured.
