# Flow 0 knowledge-contract decisions — 2026-10-19

**Status:** Flow 0 contract and v1 acceptance thresholds are frozen. The synthetic 20/40 corpus has an agent audit and documented corrections; independent human approval and runtime evaluation are not claimed. This record does not claim the planned runtime behavior is implemented.

This record makes the Flow 0 choices concrete. It preserves current source-permission restrictions and the existing Original/RAG/GraphRAG experiment meanings.

## Decisions

### 1. `local_only` and source egress

`local_only` remains local. Local parsing, lexical indexing, and preview may be supported, but the source text must not be sent to a remote optimizer, embedding service, semantic graph extractor, or answer target. Lexical fallback changes the retrieval method; it does not grant permission to send evidence remotely. Source-grounded remote chat continues to require the existing explicit source-selection and permission workflow. No new permission request is introduced here. Any future per-provider or local-target policy needs a separate contract.

This follows the current guards: the [workspace source manifest](../../packages/db/src/workspace-source-manifest.ts) accepts only `campus_indexer_allowed`; the [worker](../../apps/worker/src/main.ts) sets `requireCampusPermission: true`; the [evidence packer](../../apps/worker/src/workspace-graph-context.ts) records that permission on packed evidence; and the [agent tool loop](../../packages/agent/src/index.ts) returns source-tool observations to the optimizer. The [source-selection UI](../../apps/web/src/components/workspace-conversation.tsx) keeps source selection explicit. Do not treat a lexical fallback as permission to bypass any of these checks.

### 2. Source identity, versions, checksums, and bytes

Canonical source identity is **project ID + stable root/collection ID + normalized relative path**. Keep the existing source ID, version ID, and version APIs. The current [linked-file importer](../../apps/web/src/lib/local-workspace-api.ts) matches a source by project and relative path, so equal paths under different roots can collide; root/collection identity must be part of the contract.

Snapshot only registered files the user selected, never an entire disk. Preserve linked originals without mutation. Store uploaded original bytes and selected linked-file versions in managed content-addressed blobs. Keep three digests distinct: raw-byte SHA-256, normalized extracted-text checksum, and per-chunk hash. The current [knowledge lifecycle](../../packages/db/src/knowledge.ts) hashes text content and chunk content separately, while the [schema](../../packages/db/src/schema.ts) stores document versions and chunk hashes; it does not establish the planned raw-byte blob store. The resource plan also marks raw-blob storage as new work ([source storage plan](./FP_PBKK_END_TO_END_RESOURCE_PLAN_20261019.md)).

Implementation assignment: immutable raw-byte snapshots for selected files belong
to **Flow 1**; root-aware source identity and incremental reconciliation belong
to **Flow 2**. Flow 0 freezes these contracts and does not carry either runtime
implementation as a pending Flow 0 task.

### 3. Retrieval strategy and readiness

Record requested strategy, used strategy, and a reason for fallback or non-use. Keep the existing experiment arms unchanged: `original`, `rag` (optimizer plus lexical RAG), and `graphrag`. Semantic/hybrid and H/HG are future explicit additions; never silently relabel R as hybrid.

Lexical, semantic, and graph readiness must be independent and bound to the exact source version. Semantic readiness also binds the embedding profile, dimensions, chunking version, and query/document input-template versions. Show fallback and its reason while preserving the same source permissions. These are contract requirements, not claims that all readiness types or semantic/hybrid runtime paths exist today. The [current retrieval result and target-input path](../../apps/worker/src/workspace-target-retrieval.ts) already carries requested/used strategy and fallback reason for existing retrieval.

### 4. Embedding profile

An embedding profile records provider, requested and observed remote model identity, digest when the provider supplies one, dimensions, preprocessing version, query/document template versions, and source-version/chunk binding. `embeddinggemma:latest` is a mutable alias; the prior [resource plan](./FP_PBKK_END_TO_END_RESOURCE_PLAN_20261019.md) records one response with 768 finite, nonzero values. Validate vector length against the profile (768 for the observed response), finiteness, and nonzero magnitude; make retries/cache writes idempotent and never combine vectors from different profiles, even when dimensions match.

That single request is not evidence for batch behavior, input limits, sustained latency, or retrieval quality. Those remain Flow 1 checks. The prior latency value is one observation, not a latency profile.

### 5. Evaluation size, shards, and evidence status

The current [controlled-evaluation contract](../../packages/contracts/src/index.ts) permits 2–20 cases per API request and requires both development and holdout cases. The implemented deterministic manifest preserves 20 development and 40 holdout cases in three non-overlapping shards:

| Shard | Development IDs | Holdout IDs | Cases |
| ----- | --------------- | ----------- | ----: |
| 1     | D01–D07         | H01–H13     |    20 |
| 2     | D08–D14         | H14–H26     |    20 |
| 3     | D15–D20         | H27–H40     |    20 |

The evaluator-only shard manifests record stable case IDs/splits, input hashes,
source-context hashes, request hashes, dataset version/hash, schema-valid
request templates, and corpus provenance. The status-only aggregator records
stable request IDs, missing/failed/completed shard state, run IDs, report hashes,
and its aggregation version; it never invents or combines scores. The requests use no live prompt,
source selection, or target execution. Gold answers, relevance judgments, and
other oracles remain evaluator-only. The [agent evaluator](../../packages/agent/src/controlled-evaluation.ts) sends case inputs without gold labels or verification data to target calls.

The seven original refund cases remain the runtime smoke subset. The larger
fixture corpus has been agent-audited, but it is not an independently approved
or representative benchmark and gives no evidence that a live runtime passed.
Gold `requiredSupportingEvidence` supplies binary relevant-chunk labels for the
answerable cases; the ranked retrieval metrics have not been measured. Do not
infer those results from fixture presence.

### 6. Frozen acceptance thresholds

For this Flow 0 v1 protocol, each case contributes a primary score of 100 when
its exact structured answer matches gold and 0 otherwise. `buildPairedRepeatedReport()`
compares R and G with A using the 95% t interval over per-case mean deltas;
repeats are averaged within each case. Each candidate must cover all 40 holdout
cases, have no critical failure, and have a confidence lower bound greater than
-3 points. A critical failure rejects the candidate; insufficient paired cases
or an interval that does not establish the margin is inconclusive.

Hard scope, source-version/provenance, permission, critical-constraint, and
holdout-isolation gates require 100% success. Evidence Recall@5 has a target of
at least 90% across answerable cases with required evidence. Correct abstention
on labeled unanswerable cases requires 100%. Keep required-fact recall, evidence
precision/recall, and exact citation-quote matching as separate reported
metrics; the exact quote check does not establish semantic faithfulness.

The PRD efficiency hypotheses remain at least 15% lower input tokens on a
predeclared context-heavy workload and at least 10% lower median latency on a
predeclared warm-reuse workload. If those workloads or actual measurements are
unavailable, report the metrics as unscored. The complete definitions and
limitations are in the [Flow 0 evaluation report](./FLOW0_EVALUATION_MANIFEST_REPORT_20261019.md).

### 7. Independent deployment and knowledge gates

Track deployment readiness separately from knowledge-flow acceptance. The deployment lane covers Compose installation, migrations, and web/worker service readiness; the knowledge lane covers source identity and snapshots, permission-preserving retrieval, index/profile readiness, and evaluation evidence. Passing either lane does not pass the other. The [resource plan](./FP_PBKK_END_TO_END_RESOURCE_PLAN_20261019.md) keeps service readiness and provider readiness distinct and lists Flow 0/1 knowledge gates separately.

## Remaining gates and ownership

| Gate                                       | Owner                      | Current status and remaining evidence                                                                                                                                                                            |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flow 0 evaluation corpus and manifests     | Fixture owner              | 20/40 corpus, three schema-validated shards, deterministic hashes, optimizer projection, agent audit, and frozen v1 thresholds are implemented. Independent human approval and controlled live runs remain open. |
| Flow 1 raw snapshots, embedding, retrieval | Flow 1 implementation lane | Raw-byte snapshots for selected sources, embedding profile/index behavior, and retrieval-quality evidence remain Flow 1 implementation and verification work.                                                    |
| Flow 2 root-aware source identity          | Flow 2 implementation lane | Stable root/collection identity and incremental rename/delete/reconnect reconciliation remain Flow 2 implementation and verification work.                                                                       |
| Source permission and egress contract      | Existing permission owners | Preserve the `local_only` decision and current guards; any proposed policy change requires a separate decision.                                                                                                  |
| Compose deployment readiness               | Deployment owner           | Install/startup, migration, and web/worker readiness evidence. This remains independent of the knowledge gates above.                                                                                            |

## Evidence snapshot

Atlas was pinned to `wsl-fp-pbkk`, but its snapshot `20261018T121532-733d32b204cc` was stale and `project_context` found no matching curated notes. No graph refresh was run. Git status reported that this directory is not a Git repository; no checkout or commit was made for this artifact. Atlas also reported no associated branch or commit (`branch: null`, `commit: null`, `git_root_matches_scope: false`). No dated checksummed source inventory was created. The source links above are the evidence references for this record.

The original fixture verification snapshot is superseded by the dated checks
in the [Flow 0 evaluation outcome report](./FLOW0_EVALUATION_MANIFEST_REPORT_20261019.md).
Those newer checks include the focused offline suites and a Compose build/start;
they still contain no provider inference or scored controlled-evaluation run.
The permission decision in §1 is unchanged.
