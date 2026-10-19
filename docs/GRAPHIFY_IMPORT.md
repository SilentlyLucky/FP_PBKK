# Importing a Graphify export

PromptLab accepts a user-selected Graphify `graph.json` through
`POST /api/projects/{projectId}/graph/graphify-import`. The route receives JSON
data only; it does not open a local path, scan a checkout, or read an Atlas
graph. Graphify extraction is local and does not call a PromptLab provider.

## Accepted Graphify format

The installed Graphify runtime is 0.9.57. Its `graphify/export.py` serializer
calls NetworkX `node_link_data(G, edges="links")` for `graph.json`. The
corresponding top-level fields are `directed`, `multigraph`, `graph`, `nodes`,
and `links`. Node-link edges use `source` and `target`; Graphify's extraction
schema supplies node fields such as `id`, `label`, `file_type`, `source_file`,
and `source_location`, and relation fields such as `relation`, `confidence`,
`confidence_score`, `source_file`, and `source_location`.

The adapter accepts that final `graph.json` shape. It does not accept the
intermediate extraction shape with `edges`, GraphML, Obsidian vault exports, or
hyperedges. Graphify's generated `source_location` is retained as metadata; the
PromptLab citation span is supplied separately and checked against the selected
imported chunk. The adapter does not authenticate that the JSON was produced by
Graphify, verify that a declared confidence tier is genuine, or check that
`source_location` identifies the bound chunk or span. `source_file` must match
the export record, but it is not opened or mapped to the imported chunk.

To produce a local code-only export, run Graphify against the folder you chose:

```sh
graphify extract /path/to/selected-source --code-only
```

The resulting `graphify-out/graph.json` is the file the user selects and sends
to PromptLab.

## Source bindings

Every Graphify node and link must have one explicit binding. Get the imported
source version, checksum, chunk IDs, and chunk text from
`GET /api/projects/{projectId}/knowledge/sources/{sourceId}`. The selected
version must be active, eligible, and permitted by the current graph retrieval
policy (`campus_indexer_allowed`). A newer active version makes an old export
stale.

Each binding repeats the source file exactly as it appears in the Graphify
node or link, and supplies its PromptLab document, version, checksum, chunk,
and citation span. `spanStart` and `spanEnd` are zero-based JavaScript string
offsets into that chunk's `content`; `spanEnd` is exclusive. The service checks
the span, chunk ownership, version, checksum, current permission, and project
scope inside one database transaction. These checks establish provenance
binding only: they do not establish that a Graphify label or relation is
entailed by the quoted text. A caller can bind an unrelated span from any
selected chunk, so imported labels, relations, and confidence values remain
untrusted navigation metadata; use the source chunks to establish factual
conclusions.

`selectedSources` must contain exactly the document versions referenced by the
bindings. Every link endpoint must resolve to one exported node, and every
node, link, endpoint, and chunk must be bound. Duplicate or stale bindings,
unselected versions, unpermitted sources, and spans that do not match chunk
text are rejected before snapshot activation.

## Request shape

```json
{
  "graph": {
    "directed": true,
    "multigraph": false,
    "graph": {},
    "nodes": [
      {
        "id": "src_service_caller",
        "label": "caller",
        "file_type": "code",
        "source_file": "src/service.ts",
        "source_location": "L4"
      },
      {
        "id": "src_service_callee",
        "label": "callee",
        "file_type": "code",
        "source_file": "src/service.ts",
        "source_location": "L12"
      }
    ],
    "links": [
      {
        "source": "src_service_caller",
        "target": "src_service_callee",
        "relation": "calls",
        "source_file": "src/service.ts",
        "source_location": "L5",
        "confidence": "EXTRACTED",
        "confidence_score": 1
      }
    ]
  },
  "selectedSources": [
    {
      "documentId": "<document UUID>",
      "documentVersionId": "<active version UUID>",
      "checksum": "<64-character SHA-256>"
    }
  ],
  "nodeBindings": [
    {
      "nodeId": "src_service_caller",
      "sourceFile": "src/service.ts",
      "documentId": "<document UUID>",
      "documentVersionId": "<active version UUID>",
      "checksum": "<64-character SHA-256>",
      "chunkId": "<chunk UUID>",
      "spanStart": 16,
      "spanEnd": 22
    },
    {
      "nodeId": "src_service_callee",
      "sourceFile": "src/service.ts",
      "documentId": "<document UUID>",
      "documentVersionId": "<active version UUID>",
      "checksum": "<64-character SHA-256>",
      "chunkId": "<chunk UUID>",
      "spanStart": 58,
      "spanEnd": 64
    }
  ],
  "linkBindings": [
    {
      "linkIndex": 0,
      "sourceFile": "src/service.ts",
      "documentId": "<document UUID>",
      "documentVersionId": "<active version UUID>",
      "checksum": "<64-character SHA-256>",
      "chunkId": "<chunk UUID>",
      "spanStart": 42,
      "spanEnd": 50
    }
  ]
}
```

The example offsets are illustrative; use offsets that slice the selected
chunk's actual text. The binding for `linkIndex` uses the zero-based position
in `graph.links`.

## Stored behavior and limits

Imported nodes and links use PromptLab's existing graph entity, mention,
evidence, snapshot, and source-manifest tables. Graphify nodes map to runtime
`Component` entities with the Graphify node ID and source path retained as
aliases. Each Graphify relation is stored as `structural_links_to` with
`relationKind: "structural_navigation"`; its original relation, confidence,
source location, and explicit source bindings remain in qualifiers. Only
links declared `EXTRACTED` are immediately eligible for navigation. `INFERRED`,
`AMBIGUOUS`, missing, and unknown confidence tiers are retained as
needs-review and excluded from retrieval until a person reviews them. Even an
eligible link is a navigation path with a bound source span, not a factual
predicate or semantic proof.

GraphRAG only traverses a structural navigation edge when both endpoint source
versions are selected for that run. The snapshot is activated only while its
selected source versions, checksums, permissions, and Markdown structure
fingerprint remain current. Re-importing the same Graphify file/source
selection replaces that import's active memberships while preserving other
current graph memberships.

The current adapter limit is 8 MB per API request, 2,000 nodes, 4,000 links,
20 selected source versions, and 120 imported chunks. Graphify hyperedges are
not represented. No database migration is needed.

Example request:

```sh
curl -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @graphify-import.json \
  http://localhost:3000/api/projects/PROJECT_UUID/graph/graphify-import
```

## Verification record

Verified on 2026-10-18 against a disposable Postgres 16 container named
`promptlab-graphify-verify-cdaca755bfaf45dca6e8509c0d6ef2ab`, published on
loopback port `59564`, with database
`promptlab_knowledge_test_cdaca755bfaf45dca6e8509c0d6ef2ab`. Docker assigned
the port dynamically. The existing integration database container was left
untouched. The disposable database was migrated and removed after the checks.

Commands and results:

```sh
rtk proxy env PROMPTLAB_DATABASE_URL=postgresql://promptlab:promptlab@127.0.0.1:59564/promptlab_knowledge_test_cdaca755bfaf45dca6e8509c0d6ef2ab corepack pnpm --filter @promptlab/db db:migrate
# PromptLab migrations applied.

rtk proxy env PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS=1 PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL=postgresql://promptlab:promptlab@127.0.0.1:59564/promptlab_knowledge_test_cdaca755bfaf45dca6e8509c0d6ef2ab corepack pnpm exec vitest run packages/db/src/graphify-export.test.ts packages/db/src/graphify-import.integration.test.ts 'apps/web/src/app/api/projects/[projectId]/graph/graphify-import/route.test.ts'
# 3 files passed; 15 tests passed, 0 skipped.

rtk proxy env PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS=1 PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL=postgresql://promptlab:promptlab@127.0.0.1:59564/promptlab_knowledge_test_cdaca755bfaf45dca6e8509c0d6ef2ab corepack pnpm exec vitest run apps/worker/src/graph-build.integration.test.ts
# 1 file passed; 3 tests passed, 0 skipped.

rtk proxy corepack pnpm --filter @promptlab/db typecheck
rtk proxy corepack pnpm --filter @promptlab/web typecheck
rtk proxy corepack pnpm --filter @promptlab/worker typecheck
# All three typechecks passed.

rtk proxy corepack pnpm exec prettier --check packages/db/src/graphify-import.integration.test.ts apps/worker/src/graph-build.integration.test.ts 'apps/web/src/app/api/projects/[projectId]/graph/graphify-import/route.test.ts'
# All matched files use Prettier code style.
```

The API route tests cover invalid project IDs and JSON, the byte limit, 400/404/409
adapter mapping, successful response shape and argument forwarding, and a real
database import followed by wrong-project, stale-version, and checksum rejection.
The database integration tests exercise inferred-link review state, re-import
membership handling, and concurrent first imports. No live provider was called.
