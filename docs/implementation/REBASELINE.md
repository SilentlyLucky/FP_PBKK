# R0 implementation rebaseline

**Scope:** baseline and implementation direction for the v3 QA-first PromptLab UI. This is an R0 planning artifact; it does not change application behavior.

## Target experience

The design reference is `PromptLab_QA_First_UI_Mockups_v3_with_PRD.zip` at the project root. Its required primary navigation is **Workspace, Sumber, Pengujian, Monitoring, Pengaturan**. Prompt optimization and chat history belong inside Workspace; they are not separate top-level destinations. The mockup HTML is a static visual reference, not a working application: it does not supply functional API or event behavior. Example metrics, provider states, and sample content in the mockups are illustrative.

Proposed route and screen ownership:

| Route | Screen responsibility | Reusable components |
| --- | --- | --- |
| `/workspace` | Select project/prompt, edit the working prompt, keep durable chat history, start inline optimization, inspect candidate and run results | `ProjectPicker`, `PromptEditor`, `ConversationPanel`, `OptimizationPanel`, `CandidateReview`, `RunResult` |
| `/sources` | Add and manage knowledge sources; show ingestion, document, and graph-index state; select sources for workspace/evaluation | `SourceList`, `SourceDetail`, `IngestionStatus`, `GraphStatus` |
| `/evaluation` | Configure representative cases and compare baseline/candidate results, including the PRD's A/R/G checks and holdout separation | `EvaluationSetup`, `CaseSetEditor`, `ComparisonResults`, `EvidenceViewer` |
| `/monitoring` | Inspect runs, attempts, events, usage, provider health, and queued work | `RunTable`, `RunTimeline`, `UsageSummary`, `ProviderHealth` |
| `/settings` | Manage project-level provider connections and application preferences | `ProviderSettings`, `ProjectSettings` |

These are product-level ownership boundaries, not a commitment to one component library or route implementation. The source/reference and QA flow should retain the existing bounded graph retrieval and evidence surfaces.

## Active implementation baseline

The active project root has `packages/` but no `apps/` or `evals/`. Root `pnpm-workspace.yaml` includes `apps/*`, `packages/*`, and `evals`; root scripts also target `@promptlab/web` and `@promptlab/worker`. The package source that is actually present includes:

- **Contracts and bounded agent/tools:** `packages/contracts/src/index.ts` defines project, prompt-version, provider, run, retrieval, optimization, and stateless completion contracts. `packages/agent/src/index.ts` runs a budgeted agent; `packages/tools/src/executor.ts` scopes source, history, case, candidate, and graph IDs and enforces tool budgets. These form the behavior-bearing foundation to preserve.
- **Prompt optimization:** `packages/agent/src/prompt-optimization-auto.ts` models candidate evaluation, frozen execution snapshots, selected sources/history, and lexical/graph/full-context retrieval. It can accept a snapshot persistence callback, but the DB schema has no conversation/session model and this does not establish durable chat history.
- **Providers:** `packages/providers/src/codex/app-server.ts` and the adjacent provider packages contain provider adapters, capability/usage contracts, configuration restrictions, isolation, and network-egress controls. Reuse them through their current contracts; do not make an R0 inference call.
- **Database and GraphRAG:** `packages/db/src/schema.ts` contains project/provider/prompt, document/version/chunk, run/attempt/event/usage/outbox, and graph build/snapshot/entity/assertion/evidence/query-trace tables. `packages/db/src/graph-retrieval.ts` implements bounded retrieval. No migration was run for this baseline.

The active `ChatMessageSchema`/`ChatCompletionRequestSchema` (`packages/contracts/src/index.ts:134-145`) describe an input message array for a completion call. They are not a persisted chat model. There are no active tables or routes for conversations/messages, workspace file grants or changes, or durable evaluation datasets/holdouts. `packages/tools/src/executor.ts:12-35` exposes bounded agent handlers, not workspace file read/write operations.

## Recovery and change classification

| Classification | Baseline decision | Rationale |
| --- | --- | --- |
| **KEEP** | Contracts, bounded agent/tool executor, provider adapters and restrictions, project/prompt/run/usage persistence, knowledge lifecycle, and GraphRAG retrieval/evidence model | These are active source and give the implementation a bounded execution and evidence foundation. Retain their validation and scope boundaries when connecting UI flows. |
| **REFACTOR** | Recoverable web shell and page composition; align it to the five v3 destinations | The shell at `backups/apps/web/src/components/app-shell.tsx:30-37` has seven links: Optimasi, Workspace, Knowledge, Pengujian, Monitoring, Riwayat, Pengaturan. Consolidate optimization and history into Workspace, rename Knowledge to Sumber, and map Pengujian and the other destinations to the v3 information architecture. |
| **REFACTOR** | Existing API and worker integration | Implementations are present only under `backups/apps/web` and `backups/apps/worker`. They cover project/prompt/run/clarification/event/candidate apply, source/knowledge, graph, usage, readiness, and experiment flows. Selectively recover and review them against active package contracts; do not treat the backup snapshot as active source or copy it wholesale. |
| **REPLACE** | The backup shell's top-level navigation and screen grouping | Its seven-destination IA conflicts with the explicit five-item v3 navigation. The static v3 mockups are the UX reference; retain compatible underlying components only after regrouping and review. |
| **NEW** | Persisted Workspace conversations and messages, with project ownership and stable ordering | The current completion contract is stateless and there is no corresponding DB/API surface. Define the persistence contract before wiring chat history or cross-session workspace behavior. |
| **NEW** | Workspace file access/change capabilities, if required by the Workspace flow | No active workspace/file tables, routes, or tools were found. Keep this capability out of the current agent scope until permissions, allowed operations, and audit semantics are specified. |
| **NEW** | Durable evaluation case-set and holdout model, if the QA-first flow requires cross-run reuse | The active agent has bounded development-case evaluation, and the backup contains pilot experiments, but the active DB has no dataset/holdout tables. Keep development cases separate from any holdout set and align measures with the PRD before adding persistence. |

## Data and API seams

| Product data | Active foundation | R0 seam to define before integration |
| --- | --- | --- |
| Project and prompt | `projects`, `prompts`, `prompt_versions`; `ProjectCreateSchema`, `PromptVersionCreateSchema` | Keep project ownership and version lineage. Workspace editing should create explicit versions/drafts instead of treating chat text as the current prompt. |
| Conversation and chat history | Only `ChatMessageSchema` and `ChatCompletionRequestSchema`; optimizer may receive history in a frozen snapshot | Add conversation and message identity, project linkage, ordering, timestamps, and lifecycle/API semantics. Clarify whether optimizer messages share a conversation with general workspace chat or are a separate typed activity. |
| Optimization and runs | Optimization contracts and snapshot in the agent package; `runs`, `model_attempts`, `run_events`, `usage_records`, `outbox` in DB | Preserve the existing run/attempt/event/usage lifecycle. Connect inline optimization to a run and candidate with visible status, cancellation, and evidence; make snapshot persistence explicit. |
| Sources and graph | `documents`, `document_versions`, `chunks`, graph builds/snapshots/entities/mentions/assertions/evidence/query traces | Reuse existing ingestion/retrieval APIs from the backup only after compatibility review. Show source and graph freshness; keep evidence linked to source versions and snapshots. |
| Evaluation | Agent-level development-case evaluation exists; backup has experiment endpoints and eligibility logic | Define reusable case sets, explicit development/holdout roles, comparison provenance, and the PRD's A/R/G result contract before claiming reproducible evaluation. |
| Monitoring and settings | Runs, attempts, events, usage, outbox, and provider connections are represented in active DB/contracts | Aggregate existing records into read-only monitoring first. Provider secrets and mutation flows must follow current provider settings boundaries. |

The backup API inventory includes routes for `/projects`, `/providers`, project `/runs` and `/events`, prompt versions/rollback, knowledge and graph operations, `/experiments`, `/usage`, and `/readiness`. There is no conversation/message endpoint in that inventory. The backup worker includes run guards, clarifications, prompt-run history, graph build, optimization graph tools, and queue processing. These are recovery candidates for R1, not available active application routes today.

## Dependencies and implementation order

1. Restore a coherent app/worker workspace from the backup snapshot and make package references resolve without changing the active agent/provider/DB contracts blindly.
2. Rebuild the shell around the five required routes and recover only page/API code that still fits the active package seams.
3. Specify and implement persisted conversation/message contracts before presenting chat history as durable.
4. Connect source selection and graph freshness to optimization/evaluation while retaining bounded scope and evidence provenance.
5. Add durable evaluation/holdout semantics only after the A/R/G measures and case lifecycle are mapped to the PRD.
6. Verify package tests/typecheck first, then app/API integration and E2E. Keep provider inference and database migration as explicit later verification steps.

## Risks and limits

- The workspace has no `.git` directory, so there is no Git status/history or clean baseline for distinguishing prior changes. Do not initialize Git as part of this baseline.
- A previous availability probe through `pnpm exec` unexpectedly rewrote `pnpm-lock.yaml`: the observed original was 271,278 bytes and the current lockfile is 215,816 bytes (shown by `rtk ls` as 210.8K). No exact original was found in `.local` or `backups`; there is no Git history to restore. The current lockfile must not be represented as unchanged or silently replaced.
- Eight targeted package test files were attempted during the initial audit but failed before discovering tests because root `tsconfig.base.json` is missing; zero tests ran. The Playwright config points to `./apps/web/e2e`, which is absent from the active tree. Do not report the active application as passing tests.
- No provider inference, app/browser run, or migration was performed. `.env` content was not displayed.
- Root `PRD (1).md` is PNG/binary content despite its extension; `README_QA (1).md` is the PRD text. Use the canonical materials inside the v3 ZIP when resolving product requirements. Older backup PRDs and UI docs predate v3 and should not override the v3 navigation.

## Evidence index

Primary active source: `packages/contracts/src/index.ts`, `packages/agent/src/index.ts`, `packages/agent/src/prompt-optimization-auto.ts`, `packages/tools/src/executor.ts`, `packages/providers/src/codex/app-server.ts`, `packages/db/src/schema.ts`, and `packages/db/src/graph-retrieval.ts`.

Recovery snapshot: `backups/apps/web/src/components/app-shell.tsx`, `backups/apps/web/src/app/api/`, and `backups/apps/worker/src/`.

Workspace/test configuration: `package.json`, `pnpm-workspace.yaml`, and `playwright.config.ts`.
