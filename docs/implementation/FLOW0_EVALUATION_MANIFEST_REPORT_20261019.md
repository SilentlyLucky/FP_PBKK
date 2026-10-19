# Flow 0 evaluation fixture manifest and report — 2026-10-19

## Status

The deterministic fixture foundation now includes three schema-validated
controlled-evaluation request manifests and a status-only shard aggregator.
The corpus is synthetic. An agent audit reviewed every question, gold answer,
required evidence identity, quote, scope, version, critical constraint, and
abstention boundary. This is not independent human approval and is not evidence
that a semantic or GraphRAG runtime passes the cases.

The implementation reuses `evaluateKnowledgeCase()` and its exact answer,
evidence, citation, abstention, and critical-constraint metrics in
`evals/src/knowledge-evaluation.ts`, the 20/40 count contract and
`freezeExperimentSchedule()` in `evals/src/index.ts`, and the existing fixture
source format and the existing `ControlledEvaluationRequestSchema`. The
original seven refund cases remain unchanged in intent and are kept as the
development-only runtime smoke subset. Evaluator projections omit case IDs and
split labels as well as gold labels, rationale, and source text. Runtime
integration imports only that seven-case development subset.

## Frozen fixture manifests

The two schedule manifests below use the shared A/R/G manifest helper with one
repeat and an offline `contract-only-no-call` target marker. Their cells are
planned manifest cells, not target executions. The evaluation-only manifests
carry case IDs, split membership, and composite source references for schedule
binding. They omit expected answers, citation quotes, oracle rationale, and
source text; neither manifest is passed to a runtime or optimizer.

| Split       | Cases | Task families                                                                                       | Distinct source identities | Dataset version                 | Dataset version hash                                               | Fixture source-context hash                                        | Schedule manifest hash                                             | Planned cells |
| ----------- | ----: | --------------------------------------------------------------------------------------------------- | -------------------------: | ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------: |
| Development |    20 | refund policy 7; support/access 11; numerical attribution 2                                         |                          8 | `flow0-development-20261019-v3` | `97047401359bba8033581eddac93a3d5b28f84665cc9df7766c6ac32543cca04` | `502978c10b141ab3c652016c2f0084f1d84e1928e58d20ddcbe9850b46150d48` | `e36338095d25d539ea135596e98ed16965107a057cb0c1ab27813c05c2e7126c` |            60 |
| Holdout     |    40 | retention/privacy 8; incident response 8; travel expenses 8; equipment custody 8; event logistics 8 |                          6 | `flow0-holdout-20261019-v2`     | `67b19cde820279aa46c4f8be5acb2a81ad80ec5fc25028f57c2cae4fbc9124d0` | `a0626bca7ed05f8cb0203c7842923fd6d706e021433e2e41d585d45cb13d1212` | `851919260c8dcc16359c8a426dc06d1e52ceb68813a8ec2353c619cfe685537a` |           120 |

The fixture source-context hash occupies the existing manifest's
`retrieval.sourceManifestHash` field. It fingerprints synthetic source
references and text; it is not a live product source manifest. Planned cell
counts are three arms times one repeat. No live observations, runtime paired
reports, provider requests, or semantic/GraphRAG quality scores were produced.
Offline evaluator tests do score consistency between gold annotations and
constructed fixture observations; those checks are not runtime results.

### Controlled-evaluation shards

The executable builder `buildKnowledgeControlledShardManifests()` parses each
request with `ControlledEvaluationRequestSchema`. Membership uses the listed
case order: shard 1 takes D01–D07/H01–H13, shard 2 D08–D14/H14–H26, and shard 3
D15–D20/H27–H40. Each request has 20 unique cases and both splits; the three
shards cover all 60 cases exactly once. Every request is a schema-only template
with placeholder prompt/model identifiers and empty source selections. The
request hashes bind those placeholders and case inputs; stable request IDs
derive from each request hash, and source-context hashes bind the synthetic
source references and text. No request was executed.

Dataset version hash shared by all three shards:
`d467f5548a6a27246e05172fca61b1ba48c117fbdcafb68d2c52d441a41bab19`.

| Shard | Development / holdout | Stable request ID                    | Membership hash                                                    | Request hash                                                       | Source-context hash                                                | Shard manifest hash                                                |
| ----- | --------------------- | ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1     | 7 / 13                | `knowledge-shard-1:4b8bb1ab29391a2b` | `8a760c8f66c14b526b4f47b411d742ac2019e0a46ee9f0023b356a996bb98349` | `4b8bb1ab29391a2b57fc7aa85fc2156512f134415a7a994b24b2b6c49a79cad4` | `96cc4a16187c512c37946bf662587aadda2c3f81b5e6d9f70b821462e1dbadc8` | `0a3eba661627d5e352b29819a070b9e93fb9179909e4e717f656312319d8697a` |
| 2     | 7 / 13                | `knowledge-shard-2:9dc679d66e6ee736` | `18f4cf071191cb15fd1a904133ef7293be8c5cea6b11cc4182d3091db5883d60` | `9dc679d66e6ee7366b388965aa49cc08bed6dd6c5c43ca9ee419c59bf3f2b4d9` | `e7b5635c8c38e59c16c58c042587aadda2c3f81b5e6d9f70b821462e1dbadc8`  | `8e0328b932d2f77a99c58581fc36e1924e330946fb262fbc6b9c6c87cfaf1344` |
| 3     | 6 / 14                | `knowledge-shard-3:14ad0aa61cdd7a2f` | `2f480c015b8e6ec56b425e1b3d15d4ac91fbb76e5ec869f0a4ec74ac77b9ad8c` | `14ad0aa61cdd7a2f5777f7420a40e981ceca776f75c5ac1ccec0279ccee8b958` | `18ff2768d165f5bc4f743c9aeb2bc5e52eba84b213fd26b47870089e0ffdd6e2` | `2ac8ccd22c69c8fef7890ae446d108de044044b8c0d0f373950e922c3093a557` |

`aggregateKnowledgeShardStatuses()` records request IDs, completed shards with
run and report hashes, and explicitly lists missing and failed shards. It is
status-only: `scores` is always `null`, `liveScoreClaims` is always
`false`, and scored aggregation remains with the existing evaluator utilities
when actual observations exist.

### Case membership

Development case IDs (20):

`direct_lookup`, `linked_2hop_enterprise_exception`,
`enterprise_digital_exclusion`, `no_evidence_abstention`,
`source_version_conflict`, `scope_isolation`, `malicious_quoted_instruction`,
`service_desk_sla_paraphrase`, `bahasa_access_request_alias`,
`p1_definition_and_acknowledgement`, `weekend_staffing_absent`,
`secure_progress_update_channel`, `two_hop_access_escalation`,
`credential_free_support_ticket`, `project_owner_role_approval`,
`least_privilege_single_role`, `access_revocation_turnaround`,
`ordinary_arithmetic_beats_attributed_error`,
`worksheet_attribution_kept_distinct_from_truth`,
`on_call_private_number_absent`.

Holdout case IDs (40):

`retention_audit_log_period`, `retention_billing_record_period`,
`retention_access_logs_bahasa_alias`, `retention_verified_deletion_request_sla`,
`retention_legal_hold_suspends_deletion`, `retention_export_link_expiry`,
`retention_audit_vs_access_log_periods`, `retention_chat_content_unknown`,
`incident_p1_acknowledgement`, `incident_status_update_cadence`,
`incident_containment_precedes_restore`, `incident_commander_role`,
`incident_backup_escalation_two_source`, `incident_external_status_approval`,
`incident_preserve_logs_before_rotation`, `incident_public_status_url_unknown`,
`travel_meal_allowance`, `travel_receipt_threshold`,
`travel_hotel_cap_excludes_tax`, `travel_flight_approval_before_booking`,
`travel_expense_report_deadline`, `travel_foreign_currency_date`,
`travel_local_transport_bahasa_alias`, `travel_family_companion_exclusion`,
`equipment_laptop_replacement_cycle`, `equipment_lost_device_report_deadline`,
`equipment_return_after_departure`, `equipment_encrypt_before_company_data`,
`equipment_adapter_returned_with_laptop`, `equipment_serial_on_handoff_receipt`,
`equipment_software_approval`, `equipment_phone_replacement_cycle_unknown`,
`event_venue_door_time`, `event_badge_pickup_requirement`, `event_room_capacity`,
`event_accessibility_question_destination`, `event_dietary_request_deadline`,
`event_cancellation_notice`, `event_badge_pickup_bahasa_alias`,
`event_recording_retention_unknown`.

Fixture tests mechanically check unique IDs, exact 20/40 membership, disjoint
task families and source identities across splits, source identity references,
quote anchors against frozen text, and that each cited answer is within the
case's project scope. The corpus includes direct and paraphrase retrieval,
English/Bahasa aliases, linked-source paths, bounded abstention, the v1 14-day
versus v2 7-day source conflict, Alpha/Beta isolation, and paired questions for
ordinary arithmetic (`2 + 2 = 4`) versus what an uncorrected worksheet line says
(`2 + 2 = 5`). Calendar-day gold fields and business-day gold fields are
explicitly checked against their source quote units. Retention answers that
previously used a generic `days` key now say `calendarDays`; business-day gold
uses `businessDays`. Existing refund gold keeps its legacy `refundWindowDays`
shape, while its required facts and citations retain the explicit calendar-day
unit. Those are deterministic fixture oracles, not semantic model judgments.

## Agent gold review and frozen acceptance thresholds

I compared all 20 development and 40 holdout questions against their frozen
source text, required and allowed evidence identities, exact answer fields,
quotes, scope/version, critical constraints, and abstention labels. The audit
found three development prompt/gold issues and no other mismatch:

- `enterprise_digital_exclusion` no longer puts a 30-day refund window in an
  answer about eligibility for the extension; the cited addendum supports only
  the digital-product exclusion.
- `direct_lookup` and `malicious_quoted_instruction` now explicitly ask about
  the version 1 policy, matching their v1 gold and selected evidence. The
  separate `source_version_conflict` case tests which rule is current.

The corrected development fixture is `flow0-development-20261019-v3`; the
unchanged holdout fixture remains `flow0-holdout-20261019-v2`. The mixed shards
bind both using dataset version `flow0-20261019-v3`. This was an agent review,
not an independent human approval or a claim that these synthetic cases are
representative of real users.

The following v1 evaluation rules are frozen before any model-backed holdout
run. A human may review the gold and protocol before execution; any later gold
or threshold change requires a new version and a fresh holdout.

| Gate                            | Frozen rule                                                                                                                                                                                                                             | Interpretation                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Critical behavior and isolation | 100%; one critical-constraint, scope, source-version/provenance, permission, or holdout-leakage failure blocks the candidate.                                                                                                           | No averaging away safety or wrong-source errors.                                                                                                                                                       |
| Primary answer quality          | Encode each case's exact structured-answer result as 100 (pass) or 0 (fail). R and G must each have a paired 95% confidence lower bound greater than -3 points versus A on the complete 40-case holdout; otherwise report inconclusive. | This reuses `buildPairedRepeatedReport()` and its case-paired score delta; repeats are averaged within each case, not treated as independent cases. Critical failures reject regardless of mean score. |
| Supporting evidence             | Evidence Recall@5 target ≥90% over answerable cases with required evidence labels. Report evidence precision/recall and exact citation-quote match separately.                                                                          | The offline evaluator checks evidence identities and quote strings, not ranked top-5 retrieval or semantic faithfulness; these runtime results are not yet produced.                                   |
| Abstention                      | 100% correct abstention on explicitly unanswerable cases, with no invented fact or citation.                                                                                                                                            | Count separately from the answerable-case quality score.                                                                                                                                               |
| Efficiency hypotheses           | At least 15% lower input tokens on a predeclared context-heavy workload and at least 10% lower median latency on a predeclared warm-reuse workload.                                                                                     | These remain unscored unless the workload is identified before holdout and actual token/latency measurements are available; no USD savings are inferred.                                               |

The paired report uses its existing 95% t interval over per-case mean deltas;
it requires the full split and all expected paired cases. With only 20/40 cases,
an interval that does not establish the margin remains inconclusive. The
status-only shard aggregator does not produce scores.

## Frozen invariants: current source behavior and proposed behavior

The **Current** column is source inspection for this report, not a new runtime
execution. **Proposed** behavior is the end-to-end resource plan and user
requirements. These rows are pipeline contracts, not text-QA cases.

| Invariant                                       | Current source behavior                                                                                                                                                                                                                                                                                                                                                                    | Proposed behavior                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source boundary and run selection               | **Current:** run selection resolves only explicitly selected, active, eligible sources in the requested project. A frozen manifest records source ID, version ID/number, checksum, and permission; duplicate, missing, deleted, or stale selections fail validation. The existing code does not yet expose distinct connected, registered, and per-index readiness states for collections. | **Proposed:** keep folder access, source registration, and index readiness separate; freeze the selected versions for each run and surface unknown freshness rather than implying a live source.                           | `packages/db/src/workspace-source-manifest.ts:45-153`; `packages/db/src/workspace-source-manifest.test.ts:67-204`; resource plan §5.1, §5.3.                                                                                                    |
| Permission and provider egress                  | **Current:** source permission is `local_only` or `campus_indexer_allowed`. Manifest capture rejects local-only sources; retrieval filters them when Campus permission is required. Graph-build enqueue requires explicit `allowCampusEgress: true`. This is source/operation gating, not a general offline production-chat mode.                                                          | **Proposed:** lexical indexing stays local; semantic indexing and graph extraction send selected content only under explicit collection/operation approval. Keep provider readiness distinct from local service readiness. | `packages/db/src/knowledge.ts:30, 977-1013`; `packages/db/src/graph-retrieval.ts:1078-1129`; `packages/contracts/src/index.ts:1013-1034`; resource plan §5.2, §6.                                                                               |
| Version, deletion, and snapshots                | **Current:** replacement retires the old source version and invalidates its graph evidence; deletion retires the active version and marks the source deleted; permission revocation invalidates evidence and stales the active graph snapshot. Frozen manifests reject version, checksum, permission, or source-set changes.                                                               | **Proposed:** preserve these gates and extend invalidation to future vector, cache, and memory derivatives. If a linked source cannot be checked, report freshness as unknown or require an explicit snapshot choice.      | `packages/db/src/knowledge.ts:700-717, 739-970, 977-1013`; `packages/db/src/knowledge-lifecycle.integration.test.ts:196-290`; `packages/db/src/workspace-source-manifest.test.ts:135-204`; resource plan §5.1, §5.3.                            |
| Index readiness                                 | **Current:** source creation builds lexical chunks. Project readiness reports retrieval `status: "ready"`, graph availability, and a lexical fallback when the graph is unavailable; no semantic-index readiness state exists.                                                                                                                                                             | **Proposed:** report lexical, semantic, and graph readiness independently for the same source version and permission. Auto may use lexical fallback with an explicit status; a required unavailable method waits or stops. | `packages/db/src/knowledge.ts:2220-2435`; resource plan §5.2-§5.3.                                                                                                                                                                              |
| Mandatory optimizer and no-op                   | **Current:** Workspace chat is routed through the Senopati optimizer decision; host instructions require an explicit candidate or no-op, and the server sends the candidate or original prompt to Codex. Selected sources remain governed by the frozen manifest.                                                                                                                          | **Proposed:** every production prompt passes the optimizer. A justified no-op still uses the selected sources and does not let Senopati answer in place of the target.                                                     | `apps/worker/src/main.ts:191-213, 2450`; `apps/worker/src/run-intent.test.ts:68-96`; resource plan §6.1-§6.8.                                                                                                                                   |
| Manual model and effort                         | **Current:** Workspace target selection uses the requested model and treats effort as selected by default; explicit effort is validated against the live catalog. Auto effort is applied only when the user selects Auto. Tests cover recommendations that conflict with manual choices.                                                                                                   | **Proposed:** preserve manual model and effort through optimization; only Auto mode may resolve a recommendation.                                                                                                          | `apps/worker/src/optimization-target-selection.ts:267-288`; `apps/worker/src/optimization-target-selection.test.ts:34-65, 384-420`; resource plan §1, §6.1, §6.6.                                                                               |
| Production target count and experiment boundary | **Current:** Workspace chat caps Codex target calls at one and checks for exactly one call when no clarification is pending. Controlled evaluation has a separate run intent and runner.                                                                                                                                                                                                   | **Proposed:** production does not run baseline and candidate for every question; one target turn follows the optimizer, while A/R/G comparison remains in Experiments.                                                     | `apps/worker/src/main.ts:1812, 2052-2058, 2237, 2661`; `apps/worker/src/run-intent.test.ts:68-118`; resource plan §6.8-§6.10, §11 Flow 0.                                                                                                       |
| Verified-memory provenance                      | **Current:** creation requires an accepted, evaluation-eligible decision, current source versions, and evaluation event sequences. Runtime search checks the frozen source scope and freshness and returns no memories when those checks fail.                                                                                                                                             | **Proposed:** retain the provenance gates, treat memory as experiment-scoped evidence rather than general truth, and require ablation to show causal benefit before expansion.                                             | `packages/agent/src/verified-memory.ts:308-339`; `apps/worker/src/verified-memory-tools.ts:86-143`; tests `packages/agent/src/verified-memory-runtime.test.ts:325+`, `apps/worker/src/verified-memory-tools.test.ts:213-239`; resource plan §8. |

The repository already has source lifecycle and verified-memory tests for several
of these behaviors. They were not run as part of this fixture-only task; their
paths above are evidence references, not this turn's verification results.

## Flow assignment record

| Work item                                                                     | Assigned flow              | Current factual status                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluation contract, 20/40 synthetic fixture corpus, and three request shards | Flow 0                     | Manifest, status-only aggregation, agent gold audit, and v1 acceptance thresholds are complete and frozen. Independent human approval and live A/R/G evaluation remain open. |
| Immutable raw-byte snapshots for selected source files                        | Flow 1                     | Resource-plan implementation work; not described as a pending Flow 0 runtime task.                                                                                           |
| Root-aware source identity and incremental reconciliation                     | Flow 2                     | Resource-plan implementation work; not described as a pending Flow 0 runtime task.                                                                                           |
| `local_only` and provider egress decision                                     | Flow 0 contract, preserved | Existing permission decision and guards remain unchanged; verification against future runtime paths belongs to their implementation flows.                                   |

## Verification and remaining gates

Passed:

- Flow 0 evaluation suite — `evals/src/knowledge-shards.test.ts`, `evals/src/knowledge-evaluation.test.ts`, `evals/src/index.test.ts`, and `evals/src/knowledge-runtime.integration.test.ts`: 4 files, 26 tests passed, 0 failed, 0 skipped. The runtime integration test used a fresh UUID-named PostgreSQL container on tmpfs and a mocked provider. The test process explicitly unset `PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN`, Campus API key/model, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `CODEX_HOME`. The container was stopped and removed after the run. This was a local mocked integration check, not a provider inference.
- Focused provider ledger test — `rtk proxy corepack pnpm exec vitest run tools/provider-smoke/ledger.test.mts`: 1 file, 19 tests passed.
- `rtk proxy corepack pnpm --filter @promptlab/providers typecheck` and `rtk proxy corepack pnpm --filter @promptlab/evals typecheck` — passed.
- Focused ESLint over the provider ledger and four Flow 0 test files — passed with no diagnostics.
- Focused Prettier check for the changed Markdown and the provider/evaluation files — passed.
- Fixture tests cover exact 20/40 counts, unique complete shard membership, schema limits and both-split requirement, reproducible dataset/request/source/membership/manifest hashes, optimizer projection privacy, failed/missing aggregation, no-score output, typo attribution, and calendar/business-day gold consistency.

Vitest printed a non-blocking Vite config-loader warning. The disposable
integration database was migrated for that test only. No provider POST,
inference, or campaign was run for this checkpoint. Separate DB lifecycle
tests, application Compose migrations, and semantic/GraphRAG quality runs were
not executed.

Intermediate focused runs caught and resolved a fixture source-ID mismatch,
status type-widening errors, and day-unit assertions that were too strict for
multi-field gold and the singular wording in one source quote. An initial
Prettier check identified files needing formatting; the final check passed
after formatting.

Still open:

- Independent human review and approval of all 60 answers, citations, relation
  direction, conflict handling, and abstention boundaries. The agent audit is
  complete, but the synthetic gold has not received human approval.
- The v1 thresholds are frozen. After human approval and an authorized provider
  budget are available, run the 40-case holdout under the frozen procedure;
  publish paired A/R/G results and mark inconclusive outcomes as such.
- Live A/R/G remains unrun. The current local historical provider ledger is at
  its 2/2 reservation cap for both Campus and Codex, so no provider action was
  attempted in this checkpoint. Do not reset or reuse that budget to force a
  live evaluation.
- Run the relevant source lifecycle, readiness, permission/egress, optimizer,
  target-selection, and verified-memory pipeline gates in their assigned flows.
- Evaluate semantic and GraphRAG retrieval against these cases. Passing fixture
  contract tests validates deterministic evaluator and manifest behavior only.

The running Compose stack was inspected read-only: web and worker were healthy
and shared the persistent provider-ledger volume at
`/var/lib/promptlab/provider-ledger/PROVIDER_SMOKE_LEDGER.json`. Both services
ran as UID `10001`; the ledger was readable and writable, parsed with valid
provider entries, and had no lingering lock. `GET /api/providers` and the
readiness endpoint returned HTTP 200. No POST was sent. The shared runtime
mount is an existing implementation.

## Runtime continuation checkpoint — 2026-10-19

The web preflight diagnostics were improved to report known Codex failure
classes and the preflight stage without exposing raw process or server errors.
The app-server adapter retains only standard JSON-RPC error codes; unknown
codes and server messages are discarded. A focused regression test verifies
that rule.

Current local runtime evidence after rebuilding only the web image:

- `GET /api/health/ready` returned HTTP 200 with database, migrations, and
  Redis ready. `GET /api/providers` returned HTTP 200 and an active project
  prerequisite.
- Codex app-server initialization succeeded, but `account/read` was rejected
  with standard JSON-RPC internal-error code `-32603`. The existing Codex CLI
  `login status` command reports a locally stored login; that does not prove
  that app-server can read the account. No model list was obtained and no
  generation was attempted. The UI now asks the user to check or renew the
  Codex login.
- Campus remains `configured_unverified`; neither provider has a current
  verified receipt for the active configuration.
- The mounted historical ledger is readable, writable, and valid. Compose has
  no named verification campaign configured, so it uses the historical
  ledger. Campus and Codex are both at `2/2`, each with last outcome
  `blocked_budget_exhausted`. The ledger remained unchanged through the status
  checks; no verifier POST or inference was sent. The earlier
  `safety_ledger_unavailable` response was not reproduced: storage is available
  now, but its quota is exhausted. `GET /api/providers` does not exercise the
  reservation path; the source and mock tests show that a full ledger blocks
  before provider invocation.
- Flow 0 fixture tests plus the provider-ledger tests passed: 44 tests passed
  and one database-gated test was skipped in the offline run. The gated runtime
  integration was then run against a fresh UUID database in a temporary
  PostgreSQL `tmpfs` container, with deterministic mocks: 2 files and 4 tests
  passed. The container and database were removed afterward. The separate
  Codex runtime and app-server suites passed 26 tests; web and provider
  typechecks, focused ESLint, Prettier, and the Next.js production build passed.
  The Compose web image was rebuilt and the web container restarted without
  restarting its dependencies.

Flow 0 is not complete. The remaining gates require human decisions or
provider capacity:

1. Review `evals/fixtures/knowledge-integration/cases.ts` and the linked files
   under `evals/fixtures/knowledge-integration/sources/`; approve all 60 gold
   cases (answers, evidence identity, citation quote, relation direction,
   source conflict, scope, and abstention) and the frozen thresholds before
   holdout use. The agent audit is not human approval.
2. Re-authenticate Codex through the Settings login flow, then confirm that the
   no-generation provider status reaches `ready` and lists models. This current
   app-server error is separate from the safety ledger.
3. Explicitly authorize a new Flow 0 verification budget and execution plan.
   The existing historical ledger is exhausted and must not be reset or reused.
   A named campaign permits at most 110 calls per provider, while the full
   frozen A/R/G paired schedule estimates 360 Codex target calls. The schedule
   therefore needs an approved staged budget plan before any live request; the
   other flow campaigns are not a substitute.
4. After those gates, run the frozen holdout and publish paired A/R/G outcomes.
   No live quality result exists yet.

## Read-only continuation check — 2026-10-19

The local stack was rechecked after the previous checkpoint. Compose reports
PostgreSQL, Redis, web, and worker healthy when invoked with the existing
`.env.container` file. `/api/health/ready` returned HTTP 200 with database,
migrations, and Redis ready. `/api/providers` returned HTTP 200 with an active
project prerequisite, but Codex still reports `unavailable` at account read
(`-32603`); it returned zero models. Campus optimizer and auxiliary remain
`configured_unverified`.

The mounted historical ledger was read without mutation: limit 2 per provider,
Campus `2/2`, Codex `2/2`, and both last outcomes `blocked_budget_exhausted`.
No provider verification POST or inference was sent during these checks. A
Compose status check without `--env-file .env.container` fails variable
interpolation; the same read-only check with that file succeeds. Environment
values were not printed. A separate official Codex device-login flow was
started afterward; it is pending and has not changed the ledger.

The previously identified user gates remain unchanged: complete the Codex
login from Settings, review and approve the 60-case gold set and frozen
thresholds, and explicitly authorize a staged live-call budget. Until those
are done, Flow 0 has no live A/R/G quality result and remains incomplete.

## Mock-test and authentication-boundary recheck — 2026-10-19

The focused offline command reran five suites (`codex-runtime`, Codex
app-server, provider ledger, knowledge acceptance, and evidence manifest):
**75 tests passed**. The runtime suite mocks both the app-server connection
and account read; the app-server suite uses an in-memory mock session. The
ledger and acceptance suites use temporary fixtures. These suites contain no
logout command and do not start the Codex CLI or app-server.

Compose mounts Codex credentials through the dedicated named `codex-auth`
volume at `/home/promptlab/.local/share/promptlab/codex-auth`; it is separate
from the host user's `~/.codex`. The production isolation adapter mounts that
dedicated home writable inside its bounded sandbox. Its account probe uses
`account/read` with `refreshToken: false`. The latest provider status was
`unavailable` with app-server internal error `-32603`, not an explicit
`not_logged_in` result. A device-login flow is pending; no user login has been
completed. This evidence does not identify why a user's separate ChatGPT or
Codex UI may appear logged out, so avoid further account probes until that
scope is clarified.

A source search found no test or helper that runs `docker compose down -v`,
`docker volume rm`, or volume pruning; the install guide documents `down`
without `-v`. The active `promptlab_codex-auth` volume and its `auth.json` were
present. Metadata-only inspection showed the auth file's modification time
predated the latest mock-test run; its contents were not read. This rules out
the latest tests deleting or rewriting that local file, but cannot determine
whether the upstream OAuth token expired or why app-server returned `-32603`.

### Auth-status interpretation clarification

Source review confirms that the provider status path calls `account/read` with
`refreshToken: false`; it does not start a login flow or contain a logout,
revoke, or auth-volume deletion operation. An explicit `-32603` app-server
failure now maps to `unavailable` with a message that login status could not be
verified, while only the explicit `codex_not_logged_in` error maps to
`not_logged_in`. The focused runtime test covers both outcomes, and the latest
offline test record above passed 75 tests. No account probe or credential read
was performed for this clarification. The live Compose UI was not rechecked
after the source-message correction, so its deployed message may differ until
the web image is rebuilt.

The device-code attempt has a separate ten-minute pending-flow timeout. That
expires an unfinished login attempt and closes its temporary app-server
session; it does not establish that an already saved ChatGPT login was revoked
or erased. The actual cause of any upstream OAuth expiration remains unknown.

## Current ledger and provider-mock checkpoint — 2026-10-19

The current product Compose configuration parses successfully with
`.env.container`; PostgreSQL, Redis, web, and worker are healthy, and
`GET /api/health/ready` reports database, migrations, and Redis ready. No
provider status endpoint was called during this checkpoint.

The web container's own exported ledger reader successfully parsed the
configured historical ledger as UID `10001`. The mounted file has mode `0600`,
the parent directory is writable to the service UID, no lock remains, and no
verification campaign is configured. A metadata-only environment check found
that the Campus API-key and model settings are present; their values were not
printed. This satisfies only the configuration-presence check, not a live
gateway verification. Both providers are still at `2/2`, with last outcome
`blocked_budget_exhausted`. A controlled call to the actual
`reserveInferenceCall("codex_app_server")` function was denied with the cap
reached result before provider invocation; the reservation count stayed at
`2/2` and the temporary lock was removed. This proves the current ledger path
is available and the safety guard is enforcing the exhausted cap. It does not
identify the historical transient that produced the earlier
`safety_ledger_unavailable` response.

Focused provider mocks passed: `tools/provider-smoke/ledger.test.mts`,
`apps/worker/src/provider-campaign.test.ts`,
`packages/providers/src/codex/app-server.test.ts`,
`apps/web/src/lib/codex-runtime.test.ts`, and
`apps/web/src/app/api/providers/route.test.ts` — 5 files, **53 tests passed**.
The new route cases cover both Campus and Codex for an exhausted cap and a
locked/unavailable ledger. They assert the distinct response outcomes and
confirm the mocked provider completion is not called after reservation fails.
Web TypeScript checking, ESLint on the new test, and Prettier checking passed.
The only test output warning was the existing non-blocking Vite native
config-loader warning. No real provider inference, verifier POST, or Codex
account probe was sent in this checkpoint.

Flow 0 remains incomplete. The existing historical ledger has no remaining
provider budget, and a new campaign budget still requires explicit user
authorization. Human approval of the 60-case gold set and frozen thresholds is
also outstanding. The latest recorded Codex account-read error is `-32603`,
which does not confirm logout; no fresh account probe was made. Flow 1 files and
status were not changed by this checkpoint.

## Manual provider-verification gate correction — 2026-10-19

Follow-up review found that the Settings POST route always reserved against the
historical smoke ledger when no named campaign was configured. That made both
manual verification buttons fail at the old `2/2` ceiling before reaching
Campus or Codex, even though the user explicitly clicked Verify. The Settings
status page reads provider receipts from the database, so the historical smoke
record did not populate its model response or capability fields.

The route now reserves and records usage in the provider ledger only when
`PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN` is explicitly set. A manual Settings
verification without a campaign still makes only its bounded, user-triggered
request and stores the provider receipt; it leaves the historical smoke ledger
unchanged. With a named campaign, the existing reservation and exhaustion
guard still run before inference. Compose passes the optional campaign setting
to both web and worker. The active `.env.container` and runtime have no named
campaign configured.

Verification completed: provider route and worker campaign suites — 2 files,
**9 tests passed**; TypeScript checks passed for providers, web, and worker;
ESLint and Prettier passed; Compose configuration parsed; the rebuilt web and
worker containers became healthy and `/api/health/ready` reported database,
migrations, and Redis ready. The Codex auth volume remained mounted. The
historical ledger is still Campus `2/2` and Codex `2/2`; no counters or auth
contents were changed or read. No real provider verification POST, Campus
inference, Codex inference, or account probe was sent. The user must click
Verify again to create fresh connection evidence. This gate correction does
not complete Flow 0's separately budgeted live A/R/G evaluation or gold-set
human review.
