# Synthetic knowledge integration fixture

This unreviewed synthetic corpus has 20 development cases and 40 holdout cases.
The original seven refund cases remain available as
`KNOWLEDGE_RUNTIME_SMOKE_CASES`; the runtime integration test uses only that
development subset. `KNOWLEDGE_INTEGRATION_CASES` is evaluator-only.

Gold answers, required-evidence labels, citation quotes, task-family labels, and
oracle justifications are private evaluator data. Optimizer-visible projection
contains only the task input and scope. Frozen schedule manifests are also
evaluator-only: they carry case, split, and selected-source references for
scheduling, but omit answers, quote labels, rationale, and source text. They are
not runtime or optimizer inputs. Fixture source files are deliberately
synthetic and are not representative real-world evidence. No independent or
human review is claimed, and deterministic fixture checks do not establish that
a future semantic or GraphRAG runtime passes these cases.

The QA format covers answer, evidence, citation, abstention, alias, conflict,
and bounded multi-source distinctions. Source lifecycle invalidation, source
permissions and provider egress, index readiness, mandatory optimization,
manual target selection, production call count, and verified-memory provenance
remain separate pipeline gates documented in the Flow 0 report; they are not
misrepresented as text-QA cases here.

## Controlled-evaluation shards

`manifest.ts` builds three deterministic request manifests with 7 development
and 13 holdout, 7 and 13, and 6 and 14 cases. Every request is parsed through
the existing `ControlledEvaluationRequestSchema`, stays within its 20-case
cap, and contains both splits. Membership, input, source-context, request,
dataset, and manifest SHA-256 hashes bind the fixture version and shard
contents.

The requests are schema-only templates with placeholder prompt/model
identifiers and empty source selections. They are marked
`targetExecution: "not_run"`; no provider or target call has run. Gold
answers, source text, and oracle rationale remain outside the request. The
request's case ID and split are evaluator scheduling metadata and are stripped
by the `toOptimizerVisibleKnowledgeCase()` projection contract, whose tests
verify that only input and scope are exposed.

`aggregateKnowledgeShardStatuses()` records stable request IDs, completed,
failed, and missing shard states, run IDs, and report hashes. It is status-only:
it always returns
`scores: null` and `liveScoreClaims: false`. Score reports remain the
responsibility of the existing evaluation report builder once actual
observations exist.
