# Runtime knowledge evaluation

The offline deterministic evaluator scores exact structured answers, labeled
fact recall, source identity precision and recall, exact citation identity and
quote matches, abstention, and labeled critical constraints. It does not make a
general semantic-faithfulness claim. Citation quote matches check exact
identity and string overlap; they do not establish that a citation semantically
supports a claim.

The runtime integration test is gated by
`PROMPTLAB_KNOWLEDGE_EVALUATION_INTEGRATION_TESTS=1` and a separately created
disposable PostgreSQL URL. It exercises the real sequence:

1. Create Markdown sources through `createKnowledgeSource` and resolve their
   links through `getActiveKnowledgeMarkdownStructure`.
2. Build a graph with `executeGraphBuild` and a deterministic mocked extractor.
3. Retrieve current evidence through `retrieveKnowledgeContext`.
4. Pack those results with `createWorkspaceTargetEvidencePack`, build the
   Workspace target context and target input, and pass the input through
   `runWorkspaceChatAgent`'s mandatory-optimization gate.
5. Feed the target controller a deterministic response based only on its
   visible input and score the returned observation against private fixture
   labels.

The seven synthetic development cases cover direct lookup, a linked Enterprise
exception, a digital-product exclusion, abstention when retrieval finds no
evidence, a changed policy version, project isolation with a wrong-project
distractor, and quoted prompt injection. Gold answers, required evidence, and
expected citation quotes are projected away before the optimizer callback or
target handler runs. The fixtures contain no holdout cases, and this test does
not evaluate holdout labels.

Each runtime record binds the deterministic metrics to the SHA-256 of the
actual string returned by `buildWorkspaceTargetInput`; it records retrieved
evidence identities, quotes, strategies, and trace IDs. The fixture run uses
mocked indexer, optimizer, and target steps. Their provider-inference cost is
recorded as known zero. Database and local infrastructure cost is unmetered,
so retrieval-stage and total monetary cost remain unknown. There is no provider
pricing model in the evaluator, and no estimate is inferred from token counts.
The existing paired experiment report remains the source for repeated-run
confidence intervals; this seven-case check adds no separate interval.

## Running the integration test

Use an isolated PostgreSQL container on loopback port `56432`, with a database
named `promptlab_knowledge_eval_<32 lowercase hex characters>`. The harness
rejects any other host, port, or database name. Use a fresh container name and
tmpfs data directory; do not use the repository's persistent integration
Compose volume.

After applying the database migrations to that disposable database, run:

```sh
rtk proxy env \
  PROMPTLAB_KNOWLEDGE_EVALUATION_INTEGRATION_TESTS=1 \
  PROMPTLAB_KNOWLEDGE_EVALUATION_TEST_DATABASE_URL='postgresql://promptlab:promptlab@127.0.0.1:56432/promptlab_knowledge_eval_<uuid>' \
  corepack pnpm exec vitest run evals/src/knowledge-runtime.integration.test.ts
```

The integration test creates two UUID-scoped synthetic projects, deletes them
afterward, and performs no live provider request. A failed or interrupted run
may leave its UUID project rows in the disposable database; remove the entire
container after the run.

## Live-provider status

No live provider result is claimed for this evaluator. The active process did
not have Campus or API-key based Codex credentials configured. The repository
readiness note reports Campus credentials by variable name only and leaves
their validity unverified. A Codex app-server no-generation check is separate
from this mechanical test. The existing readiness note also records no
explicit output-token cap for Codex target turns, so this harness does not
infer a bounded target cost or claim a Luna-max live run.
