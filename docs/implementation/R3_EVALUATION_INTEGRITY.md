# R3 Evaluation Integrity

**Date:** 2026-10-16  
**Scope:** Frozen prompt-optimization evidence, shared candidate eligibility, and the development-only Original/RAG/GraphRAG pilot. This document records the implemented contract and its verification limits.

## Evidence manifest

Every eligible candidate revision carries a canonical SHA-256 manifest with:

- Run and completion-attempt IDs; candidate revision ID and revision number; baseline and candidate prompt hashes; and the exact invariant list and hash.
- The ordered development-case inputs, source labels, input hashes and lengths, and deterministic-verification specification hashes. A manifest marked `development_only` rejects holdout cases.
- Selected source IDs and the exact active document-version IDs, version numbers, and checksums. Each per-case evidence pack records the context text and hash, evidence references, requested and actual retrieval strategies, selected and used graph snapshots, and any fallback reason.
- Frozen run, optimizer, target, and retrieval configurations; workspace-snapshot state; policy version; model/effort selection; and per-case baseline and candidate response IDs, response models, providers, attempts, request hashes, context hashes, and answer hashes.

The manifest hash is computed over canonical JSON. The in-process object is deeply frozen before it is returned. Eligibility recomputes the hash and checks all cross-references against the completion payload, stored run config, frozen cases, evidence packs, and target results. A missing or inconsistent manifest is treated as legacy/unverified evidence.

## Shared eligibility

`isOptimizationCandidateEvidenceEligible` is the shared server-side gate used for candidate votes, completion-event projections, apply eligibility, and experiment acceptance/history. It requires a succeeded run and completion from the same attempt, matching run and target configuration, a non-no-op candidate with a persisted draft, preserved configured invariants, complete frozen baseline and candidate case results, exact prompt/request/context/answer bindings, and passing configured candidate verification.

The event projection annotates completion candidates and prior votes with the server result. Apply retains its prompt lineage and compare-and-swap checks, then calls the same gate. Experiment history recalculates pilot evidence eligibility from stored run events; an accepted decision whose evidence no longer verifies is shown as unverified. Legacy one-case pilot metadata remains visible in history but is never marked evidence-eligible. `inconclusive` is a supported, distinct decision.

## Frozen retrieval and experiment methods

Run creation validates selected sources and Campus egress permission. For graph retrieval it requires a current active snapshot, checks that each selected source version is present in that snapshot, persists the selected snapshot ID, and includes it in idempotency comparison. The worker preserves explicit null snapshot choices and uses the frozen graph snapshot for agent retrieval. It resolves per-case evidence once, then sends the same frozen evidence pack to both baseline and candidate target calls.

The Pengujian setup retains three explicit methods:

| Arm | Retrieval | Evidence required for acceptance |
| --- | --- | --- |
| Original | No selected sources; lexical request with an empty source list | Empty source manifest and no graph snapshot |
| RAG | Selected eligible sources; lexical retrieval | Exact selected source versions and checksums; lexical retrieval recorded for the case |
| GraphRAG | Selected eligible sources on the current graph snapshot | Exact source versions and snapshot; graph retrieval recorded with no fallback |

The API stores the arm, development split, source title/version/checksum, and selected snapshot with the run. The acceptance predicate checks the stored manifest against those values and rejects a GraphRAG arm if retrieval fell back to lexical search. Setup, result history, and JSON report display the arm and evidence status.

The current workflow is a **single-case, development-only exploratory pilot**. It does not run a batch or use a holdout set. Token and latency values are reported as efficiency metrics and are explicitly not treated as proof of improved quality. Human decisions can be accepted, rejected, or marked inconclusive; acceptance is enabled only when the shared evidence checks pass.

## Files updated

- Contracts and agent evidence: `packages/contracts/src/index.ts`, `packages/agent/src/evidence-manifest.ts`, `packages/agent/src/evidence-manifest.test.ts`, `packages/agent/src/prompt-optimization-auto.ts`, `packages/agent/src/prompt-optimization-auto.test.ts`, and `packages/agent/src/prompt-optimization-verification.ts`.
- Worker retrieval wiring: `apps/worker/src/main.ts`.
- Frozen run selection and graph setup: `apps/web/src/app/api/projects/[projectId]/runs/route.ts` and `apps/web/src/app/api/projects/[projectId]/graph/snapshots/route.ts`.
- Shared candidate surfaces: `apps/web/src/app/api/projects/[projectId]/runs/[runId]/quality/route.ts`, `apps/web/src/app/api/projects/[projectId]/runs/[runId]/events/route.ts`, `apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/eligibility.ts`, and `apps/web/src/components/workspace-prompt-optimization.tsx`.
- Experiment setup/history/acceptance: `apps/web/src/lib/experiment-pilot.ts`, `apps/web/src/lib/experiment-pilot.test.ts`, `apps/web/src/app/api/projects/[projectId]/experiments/route.ts`, `apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.ts`, `apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.test.ts`, `apps/web/src/components/experiments-workspace.tsx`, and `apps/web/src/components/experiments-workspace.module.css`.
- Typecheck fixes required by the root check: `packages/agent/src/python-candidate-sandbox.ts` and `packages/tools/src/local-workspace-patches.test.ts`.

## Verification

The focused offline suite covers manifest mutation and response binding, candidate preservation and verification, source-backed RAG and GraphRAG acceptance, GraphRAG fallback rejection, development/holdout separation, and apply eligibility.

- `rtk corepack pnpm typecheck` — passed across the contracts, DB, providers, tools, agent, web, worker, evals, and root tools checks.
- Focused Vitest run — 7 files and 74 tests passed: `packages/agent/src/evidence-manifest.test.ts`, `packages/agent/src/prompt-optimization-auto.test.ts`, `packages/agent/src/prompt-optimization-verification.test.ts`, `apps/worker/src/optimization-evaluation-evidence.test.ts`, `apps/web/src/lib/experiment-pilot.test.ts`, `apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/acceptance-eligibility.test.ts`, and `apps/web/src/app/api/projects/[projectId]/runs/[runId]/candidates/[candidateId]/apply/eligibility.test.ts`.

No browser session, app build, provider inference, database operation/migration, or worker startup was performed. Runtime provider behavior and live database event persistence remain unverified.

## Limits

- Evidence hashes detect accidental changes and internal mismatches; they are not a digital signature. A privileged database writer able to rewrite both payload and hash is outside this integrity boundary.
- Holdout cases are excluded by the current manifest and pilot contracts, but no durable holdout dataset or statistical batch evaluation is implemented here.
- GraphRAG pilot acceptance requires actual graph retrieval without fallback. Other optimization surfaces can still show an exploratory result when the frozen retrieval records a fallback; they must not label that run as successful GraphRAG evidence.
