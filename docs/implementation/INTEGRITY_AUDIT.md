# PromptLab v3 focused agent integrity audit

**Date:** 2026-10-16  
**Scope:** `packages/agent`, `contracts`, `db`, `tools`, `providers`, and the backup web API reference. The active `apps/` tree was not inspected. Backup routes below are recovery references, not evidence of active application behavior.

## Evidence and limits

Requirements were checked against `docs/implementation/REBASELINE.md` and the v3 ZIP's `PromptLab_QA_UI_v3/PRD.md` and `README_QA.md`. PRD requirements relevant here include frozen comparable evaluations, one evidence-readiness predicate for vote/history/report/apply, preservation of an earlier ready revision, distinct terminal outcomes, honest remote cancellation, and GraphRAG evidence reaching a target prompt.

Findings below distinguish source-confirmed behavior from explicit assumptions. Root `tsconfig.base.json` was absent initially and present before tests; this audit did not modify config. I ran the installed Vitest binary directly on `packages/agent/src/prompt-optimization-auto.test.ts`, `packages/agent/src/index.test.ts`, `packages/contracts/src/index.test.ts`, `packages/tools/src/executor.test.ts`, `packages/db/src/graph-retrieval.test.ts`, and `packages/providers/src/codex/app-server.test.ts`: 6 files and 57 tests passed. The selection excluded active app tests, backup app tests, and DB integration tests. Atlas reports no registered project at this path, so project context was unavailable; the project was not initialized because setup was not requested. No provider inference, database access, or migration was performed.

## Actionable findings

### I-01 — P1: Evaluation evidence does not bind the full frozen context

**Evidence:** `OptimizationFrozenExecutionSnapshot` at `packages/agent/src/prompt-optimization-auto.ts:232` freezes test cases, source IDs, retrieval strategy, graph snapshot ID, history, and target selection. It has no source-version manifest, workspace snapshot, policy version, or evidence hash. `OptimizationInvocation` has a `responseId` (`:114`), but `OptimizationCaseRun` (`:126`) does not retain it; `evaluateCases` stores answer/usage/timing without the response ID (`:1129`). The exported `evidenceBoundToPrompt` is a boolean calculated from current tested text and invariant key (`:1006`), rather than a persisted binding manifest. The backup experiment acceptance helper explicitly says its run config has no source-version lock and rejects nonempty source/context selections (`backups/apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.ts:391`, `:394`).

**Impact:** The package can prove that the same case inputs and selected target were used and can pin a graph snapshot ID, but it cannot independently replay or verify all PRD evidence dimensions, especially source versions, workspace/policy state, and target response references. The backup experiment gate consequently cannot accept source-backed comparisons.

**Narrow fix:** Persist one immutable evaluation manifest containing prompt/candidate and invariant hashes, exact case manifest, source-version checksums, graph/workspace snapshots, target model/effort/policy, candidate revision ID, and response IDs. Treat missing fields as legacy/unverified.

**Tests needed:** Mutate each manifest dimension independently and reject vote/apply/report eligibility; accept a complete paired run with matching source and response references. Add a source-backed experiment acceptance case.

### I-02 — P1: Vote, history, apply, and experiment gates are inconsistent

**Evidence:** The backup quality-vote route checks successful run status and optimization config, then only matches the candidate ID (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/quality/route.ts:42`, `:66`). It does not require `candidate_ready`, `testingStatus: ready`, bound evidence, or complete frozen cases. Apply has a separate, stronger predicate checking readiness, prompt/draft equality, invariants, and frozen results (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/eligibility.ts:318`, `:383`, `:401`). Experiment acceptance uses another predicate (`backups/apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.ts:334`). The event stream replays stored payloads directly (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/events/route.ts:86`, `:93`) without an eligibility projection. The vote contract supports `original_better`, `candidate_better`, and `equal`, but not a distinct `inconclusive` verdict (`packages/contracts/src/index.ts:401`).

**Impact:** A matching candidate ID is enough for the backup vote route even when its evidence fields are incomplete; history delivery also does not apply the PRD's shared readiness rule. `equal` cannot represent insufficient evidence separately. These are recovery-reference findings, not claims about a running endpoint; the active app was outside scope.

**Narrow fix:** Use one server-side candidate-evidence predicate for vote, history/read projection, report, experiment acceptance, and apply. Keep raw events available as audit data but label them unverified unless the predicate passes. Add an explicit inconclusive vote value.

**Tests needed:** Run the same ready, incomplete, unbound, legacy, text-mismatched, and invalid-fixture candidate through every decision surface and assert identical eligibility. Add quality-route and history-projection tests; retain the existing apply and experiment eligibility suites (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/eligibility.test.ts:141`, `backups/apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.test.ts:321`, `:441`).

### I-03 — P1: A later incomplete revision hides an earlier ready candidate

**Evidence:** The agent stores revisions in `candidateById` and sends them to later planner turns, but finalization selects only `latestCandidate` (`packages/agent/src/prompt-optimization-auto.ts:974`, `:977`, `:1019`). Only that candidate is returned and only it can receive a persisted draft (`:996`). The test beginning at `packages/agent/src/prompt-optimization-auto.test.ts:1166` evaluates candidate A, proposes B, and checks that incomplete B is returned; it does not assert that A remains reviewable or apply-eligible.

**Impact:** If A passes and B then fails, A remains in the in-memory candidate map but is absent from the returned candidate result and is not saved as a draft. This contradicts PRD preservation semantics and prevents safe recovery to A through the result contract.

**Narrow fix:** Return an immutable `candidates[]` history with per-revision evidence/readiness; keep latest revision status separate from the best/last-ready revision. Persist a draft for a ready revision without activating it.

**Tests needed:** A passes all frozen cases; B fails validation, verification, or evaluation; assert A's exact text/evidence/draft remain available and eligible while B remains separately rejected/incomplete.

### I-04 — P1: Graph tool evidence is not wired into the package's target-evaluation request

**Evidence:** Graph search/traversal/evidence handlers return observations to the optimizer (`packages/agent/src/prompt-optimization-auto.ts:677`, `:708`), and prior tool results are placed in the planner prompt (`:938`, `:1525`). The target request is separately built from only the saved prompt and test input, then calls `invokeTarget` with `{ subject, caseId, source }` metadata (`:1114`, `:1124`). `retrieveKnowledgeContext` can produce context and provenance in `packages/db/src/graph-retrieval.ts:1144`, but no package contract passes selected graph evidence into `evaluateCases`. Existing graph tests cover traversal/bounds (`packages/db/src/graph-retrieval.test.ts:36`, `:59`; `packages/tools/src/executor.test.ts:148`, `:187`), not graph-to-target flow.

**Impact:** The inspected package path proves GraphRAG can inform Senopati, but does not prove that retrieved graph evidence changes the target prompt or target output. The v3 PRD's GraphRAG acceptance remains unverified at this seam.

**Assumption/limit:** An outer `invokeTarget` closure could independently retrieve and inject context. The active app/worker wiring was intentionally not inspected, so that possibility is not confirmed.

**Narrow fix:** Pass the selected evidence pack and provenance explicitly into each paired target call and include it in the frozen manifest.

**Tests needed:** Two-hop graph fixture with evidence from two sources; assert the same frozen evidence reaches baseline and candidate target requests, provenance is retained, and lexical fallback is not recorded as GraphRAG success.

### I-05 — P2: No-op and candidate rejection are not first-class optimization outcomes

**Evidence:** `AutomaticPromptOptimizationResult.status` has only `candidate_ready`, `incomplete`, and `clarification_required` (`packages/agent/src/prompt-optimization-auto.ts:271`). A finish with no candidate therefore returns `incomplete`; a deterministically rejected candidate is only marked through `candidate.testingStatus` while the top-level result remains incomplete. There is no comparison against `originalPrompt` before readiness/draft persistence (`:977`, `:996`).

**Impact:** The PRD's `no_change_recommended` and `candidate_rejected` outcomes cannot be distinguished from incomplete work at the optimization-result level. An unchanged prompt can proceed through normal readiness and draft persistence.

**Narrow fix:** Add explicit no-change and candidate-rejected outcomes; keep execution `failed`/`canceled`/`interrupted_unknown` on the separate run lifecycle. An unchanged candidate should produce no draft or improvement claim.

**Tests needed:** Planner finishes with no candidate; candidate text exactly equals baseline; deterministic fixture fails/unavailable; provider execution fails or is canceled. Assert each has a distinct outcome and no-op cannot be voted/applied as an improvement.

### I-06 — P2: An already-aborted signal can miss the remote interrupt

**Evidence:** The Codex adapter starts the turn before installing its abort listener (`packages/providers/src/codex/app-server.ts:970`, `:1027`). `waitForCompletion` immediately rejects an already-aborted signal (`:1250`), but the catch path labels it as a timeout (`:1047`) and sends no `turn/interrupt`. The existing app-server tests cover protocol-violation/approval interrupts (`packages/providers/src/codex/app-server.test.ts:373`, `:406`), not a pre-aborted signal. The backup cancel API correctly records local cancellation with `remoteOutcomeKnown: false` and exposes that the remote outcome may be unknown (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/cancel/route.ts:50`, `:75`).

**Assumption:** A caller can abort while asynchronous setup or `thread/start` is in progress, before the listener is installed. If so, the remote turn may continue despite local cancellation.

**Narrow fix:** Check `signal.aborted` before starting a turn and invoke the interrupt handler immediately if it becomes aborted before listener registration completes; preserve an interrupted/unknown outcome rather than classifying it as timeout.

**Tests needed:** Abort during `thread/start` and pass an already-aborted signal; assert `turn/interrupt` is sent, the error is interruption with unknown remote outcome, and no late completion changes the terminal state.

## Existing capabilities to preserve

- Iteration is bounded: request default `maxIterations: 1`, hard maximum 2, tool-call cap 8; agent budget caps decision turns at 4, candidates at 2, revisions at 1, duration at 180 seconds, and graph traversal (`packages/contracts/src/index.ts:291`, `:293`, `:548`, `:550`, `:551`, `:552`). `packages/agent/src/index.test.ts:106` covers candidate/revision caps.
- Candidate validation checks exact current text and invariant key before evaluation, requires all frozen cases, and invalidates stale evaluation when text changes (`packages/agent/src/prompt-optimization-auto.ts:746`, `:799`, `:1344`). The focused suite covers stale candidate text and invariant failures (`packages/agent/src/prompt-optimization-auto.test.ts:1166`, `:1523`).
- The apply reference checks project/run/prompt/draft lineage, text equality, invariant status, frozen test cases, and deterministic verification; its route uses CAS against the baseline (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/eligibility.ts:275`; route `backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/route.ts:172`). Dedicated eligibility tests cover these gates (`backups/apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/eligibility.test.ts:141`, `:232`, `:250`).
- Tool scope and budgets are server-enforced; tools expose no shell/filesystem/network/SQL handlers. Tests cover project scope, holdout isolation, graph seed scope, and graph budgets (`packages/tools/src/executor.test.ts:42`, `:64`, `:85`, `:130`, `:187`).
- Graph retrieval retains source-version/checksum evidence (`packages/db/src/graph-retrieval.ts:981`) and the DB schema records graph evidence (`packages/db/src/schema.ts:824`); bounded traversal and provenance are a sound base to connect to target calls. Provider/DB code models remote uncertainty (`packages/db/src/schema.ts:400`; `packages/contracts/src/index.ts:38`).

The listed test references describe existing regression coverage; the 57 passing focused tests are offline package checks only and do not establish provider-live, database-integration, or app behavior.
