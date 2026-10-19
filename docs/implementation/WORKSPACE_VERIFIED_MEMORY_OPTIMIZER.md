# Verified memory in Workspace optimization

This report records the Workspace integration as verified against source and
focused tests on 2026-10-18. Related implementation context is linked from
[[R2_KNOWLEDGE_WORKSPACE]], [[WORKSPACE_SNAPSHOT_BINDING]],
[[INTEGRITY_AUDIT]], and [[AGENT_INTEGRITY_FIXES]].

## Request and run flow

1. The runs API freezes the selected Workspace source manifest at enqueue. An
   empty selection remains an empty manifest. Explicit GraphRAG with no source
   selection returns `400 INVALID_GRAPH_SNAPSHOT_SELECTION` before run, event,
   or outbox insertion. Explicit GraphRAG also rejects missing, stale, and
   source-version-mismatched snapshots. Auto may freeze a compatible graph
   snapshot; otherwise the worker can use its lexical route. Auto with no
   selected sources remains allowed and performs no source retrieval.
2. The worker validates the stored manifest against the run's selected source
   IDs and current source versions before planning. The verified-memory handler
   rechecks that frozen manifest before and after lookup. Its memory dependency
   list must be a subset of the run's selected source IDs with the same version,
   checksum, and permission. With no selected sources, source-dependent memories
   are excluded; dependency-free memories may still be used as prior experiment
   references. No Knowledge sources are implicitly added.
3. Before the first optimizer provider request, the Workspace controller
   deterministically calls `search_verified_memory` through its existing
   bounded tool executor. Its query is trimmed and capped at 2,000 characters
   from the current user prompt. The worker reuses
   `createVerifiedMemorySearchHandler` and `listVerifiedMemories` with the
   `runtime` audience, scans at most 20 matches, and returns at most five
   bounded memories. An unavailable or stale lookup stops the run before
   optimizer or target egress. An empty lookup remains available and allows
   normal optimization. The handler exposes development task and strategy
   context plus bounded acceptance provenance. It omits holdout/gold cases,
   model and effort controls, verifier criteria, and per-case verifier labels.
   The result is supplied to the first optimizer decision as runtime context;
   the prefetch consumes a bounded tool call and emits a safe trace, but adds
   no optimizer provider call. A clarification may stop optimization after the
   lookup and never invokes Codex. For a simple source-free request, empty or
   populated memory therefore uses the same single optimizer provider call,
   followed by the one target call.
4. After memory prefetch, Senopati may perform only the source retrieval allowed
   by the run. Explicit GraphRAG requires one graph search. Auto selects at
   most one lexical or graph route and may skip retrieval. Lexical results can
   be followed by one `get_source` detail read; its full text, citation, source
   version, checksum, and trace are added to the same target evidence packs.
   The worker revalidates source scope and freshness before returning that
   detail. Source retrieval and planning still use their existing optimizer
   provider calls.
5. Senopati must provide an optimized candidate or explicit no-op before the
   server injects the target call. The controller accepts one target call at
   most and requires its prompt to equal the server-selected candidate or the
   original prompt. Normal Workspace chat does not create a baseline request.
   The target model remains the user's verified selection; manually selected
   effort remains authoritative. Auto effort continues to use the existing
   live capability policy, including GPT-6 Luna `max` when supported.

The memory result is optimizer context; it is not copied into Codex's final
target context. Codex receives the selected prompt and the current run's source
evidence. The worker builds that target input once, records the exact
`targetInput`, source manifest, evidence packs, and SHA-256 `targetInputHash` in
the append-only completion event, and sends those exact bytes to Codex.

## Runtime memory and evaluator export

The runtime lookup calls the shared eligibility and projection path in
`packages/agent/src/verified-memory.ts`; it does not read the evaluator export.
The tool trace records only query character count, requested result limit, and
the bounded `available`, `reason`, `resultCount`, and `truncated` summary. It
does not log query text, memory task text, candidate prompts, source text, or
verifier labels.

The Knowledge workspace link in
`apps/web/src/components/knowledge-workspace.tsx` points to
`/api/projects/{projectId}/memory?format=markdown&audience=evaluator`. The API in
`apps/web/src/app/api/projects/[projectId]/memory/route.ts` requires the explicit
evaluator audience for Markdown and returns the full evaluator records,
including cases and criteria. The optimizer tool does not follow that download
link or pass its contents to runtime memory. The browser assertion in
`apps/web/e2e/r2-knowledge-workspace.spec.ts` checks the evaluator-only label,
href, and runtime separation; that browser test was not part of the focused
Vitest run.

## Verification and limits

- The previous released memory integration verification passed: 9 Vitest
  files, 109 tests. This cost-regression focused verification passed: 9
  Vitest files, 95 tests.
  Coverage includes one-call parity with no memory support, empty memory, and
  populated memory; one prefetch before the first planner call; bounded query
  input; one target; required GraphRAG sequencing; memory handler behavior;
  tool budget caps; target selection; and memory/run routes.
- Root workspace typecheck passed across contracts, DB, providers, tools,
  agent, web, worker, evals, and the tools project.
- Scoped Prettier check passed for the four owned implementation, test, worker,
  and report files.
- No live provider generation or full end-to-end Workspace run was performed.
  DB-backed memory lifecycle, browser, and Graphify build integration tests
  were not part of this bounded regression run.
- Atlas reported no matching curated project note and a stale structural
  snapshot (`20261018T121532`). All behavior above was checked against current
  source and focused tests rather than inferred from that snapshot.
