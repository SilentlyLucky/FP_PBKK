import { describe, expect, it } from "vitest";
import {
  schema,
  type Database,
  type KnowledgeMarkdownStructuralLinkRecord,
} from "@promptlab/db";

import {
  executeGraphBuild,
  parseBuildManifest,
  planStructuralGraphLinks,
  STRUCTURAL_LINK_PREDICATE,
  validateGraphExtractionResponse,
  type GraphBuildRuntime,
} from "./graph-build.ts";

const identity = {
  projectId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  documentVersionId: "33333333-3333-4333-8333-333333333333",
  chunkId: "44444444-4444-4444-8444-444444444444",
  requestedModel: "mock-campus-model",
  sourceText: "Service Checkout uses Queue Orders.",
};

function response(quote: string, spanStart: number, spanEnd: number) {
  return JSON.stringify({
    schemaVersion: "promptlab-graph-extraction-v1",
    projectId: identity.projectId,
    runId: identity.runId,
    documentVersionId: identity.documentVersionId,
    chunkId: identity.chunkId,
    requestedModel: identity.requestedModel,
    entities: [
      {
        localId: "service",
        type: "Component",
        label: "Service Checkout",
        aliases: [],
        quote: "Service Checkout",
        spanStart: 0,
        spanEnd: 16,
      },
      {
        localId: "queue",
        type: "Component",
        label: "Queue Orders",
        aliases: [],
        quote: "Queue Orders",
        spanStart: 22,
        spanEnd: 34,
      },
    ],
    relations: [
      {
        subjectLocalId: "service",
        predicate: "uses",
        objectLocalId: "queue",
        direction: "directed",
        qualifiers: {
          dateOrVersion: null,
          negated: null,
          modality: null,
          conditions: null,
        },
        quote,
        spanStart,
        spanEnd,
      },
    ],
  });
}

describe("graph extraction evidence validation", () => {
  it("accepts exact source quote spans", () => {
    const result = validateGraphExtractionResponse(
      response(identity.sourceText, 0, identity.sourceText.length),
      identity,
    );

    expect(result.errors).toEqual([]);
    expect(result.extraction?.relations).toHaveLength(1);
  });

  it("accepts a schema-valid JSON object wrapped in Markdown or prose", () => {
    const wrapped = `Extraction:\n\`\`\`json\n${response(
      identity.sourceText,
      0,
      identity.sourceText.length,
    )}\n\`\`\``;

    const result = validateGraphExtractionResponse(wrapped, identity);

    expect(result.errors).toEqual([]);
    expect(result.extraction?.relations).toHaveLength(1);
  });

  it("rejects a quote that does not exactly match its source span", () => {
    const result = validateGraphExtractionResponse(
      response("Service Checkout uses an unsupported component.", 0, 16),
      identity,
    );

    expect(result.extraction).toBeNull();
    expect(result.errors).toContain("relation_quote_span_mismatch");
  });

  it("rejects an exact relation quote that omits one linked endpoint", () => {
    const quote = "Service Checkout uses";
    const result = validateGraphExtractionResponse(
      response(quote, 0, quote.length),
      identity,
    );

    expect(result.extraction).toBeNull();
    expect(result.errors).toContain("relation_endpoints_not_in_quote");
  });

  it("derives spans when the exact quote occurs once in the source", () => {
    const malformed = JSON.parse(response(identity.sourceText, 1, 2)) as {
      entities: Array<Record<string, unknown>>;
      relations: Array<Record<string, unknown>>;
    };
    malformed.entities[0]!.spanStart = 1;
    malformed.entities[0]!.spanEnd = 2;

    const result = validateGraphExtractionResponse(
      JSON.stringify(malformed),
      identity,
    );

    expect(result.errors).toEqual([]);
    expect(result.spanCorrections).toEqual({ entities: 1, relations: 1 });
    expect(result.extraction?.entities[0]).toMatchObject({
      spanStart: 0,
      spanEnd: 16,
    });
    expect(result.extraction?.relations[0]).toMatchObject({
      spanStart: 0,
      spanEnd: identity.sourceText.length,
    });
  });

  it("defaults omitted nullable relation qualifiers while preserving validation", () => {
    const malformed = JSON.parse(
      response(identity.sourceText, 0, identity.sourceText.length),
    ) as {
      relations: Array<{
        qualifiers: Record<string, unknown>;
      }>;
    };
    delete malformed.relations[0]!.qualifiers.conditions;

    const result = validateGraphExtractionResponse(
      JSON.stringify(malformed),
      identity,
    );

    expect(result.errors).toEqual([]);
    expect(result.extraction?.relations[0]?.qualifiers).toEqual({
      dateOrVersion: null,
      negated: null,
      modality: null,
      conditions: null,
    });
  });

  it("clears invalid optional qualifier values without weakening extraction evidence", () => {
    const malformed = JSON.parse(
      response(identity.sourceText, 0, identity.sourceText.length),
    ) as {
      relations: Array<{
        qualifiers: Record<string, unknown>;
      }>;
    };
    malformed.relations[0]!.qualifiers.conditions = { unexpected: "shape" };

    const result = validateGraphExtractionResponse(
      JSON.stringify(malformed),
      identity,
    );

    expect(result.errors).toEqual([]);
    expect(result.extraction?.relations[0]?.qualifiers.conditions).toBeNull();
  });

  it("normalizes unique entity IDs and rewrites relation references", () => {
    const malformed = JSON.parse(
      response(identity.sourceText, 0, identity.sourceText.length),
    ) as {
      entities: Array<Record<string, unknown>>;
      relations: Array<Record<string, unknown>>;
    };
    malformed.entities[0]!.localId = "service checkout";
    malformed.entities[1]!.localId = "queue/orders";
    malformed.relations[0]!.subjectLocalId = "service_checkout";
    malformed.relations[0]!.objectLocalId = "queue_orders";

    const result = validateGraphExtractionResponse(
      JSON.stringify(malformed),
      identity,
    );

    expect(result.errors).toEqual([]);
    expect(result.extraction?.entities.map((entity) => entity.localId)).toEqual(
      ["entity_1", "entity_2"],
    );
    expect(result.extraction?.relations[0]).toMatchObject({
      subjectLocalId: "entity_1",
      objectLocalId: "entity_2",
    });
  });

  it("rejects a wrong span when the quoted text appears more than once", () => {
    const duplicatedSource = identity.sourceText + " Service Checkout";
    const malformed = JSON.parse(
      response(identity.sourceText, 0, identity.sourceText.length),
    ) as {
      entities: Array<Record<string, unknown>>;
    };
    malformed.entities[0]!.spanStart = 1;
    malformed.entities[0]!.spanEnd = 2;

    const result = validateGraphExtractionResponse(JSON.stringify(malformed), {
      ...identity,
      sourceText: duplicatedSource,
    });

    expect(result.extraction).toBeNull();
    expect(result.errors).toContain("entity_quote_span_mismatch");
    expect(result.spanCorrections.entities).toBe(0);
  });

  it("reports schema field paths without exposing model output", () => {
    const malformed = JSON.parse(
      response(identity.sourceText, 0, identity.sourceText.length),
    ) as {
      entities: Array<Record<string, unknown>>;
    };
    delete malformed.entities[0]!.aliases;

    const result = validateGraphExtractionResponse(
      JSON.stringify(malformed),
      identity,
    );

    expect(result.extraction).toBeNull();
    expect(result.errors[0]).toMatch(/^response_schema_invalid:/u);
    expect(result.errors[0]).toContain("entities.0.aliases");
  });
});

describe("graph build source manifest", () => {
  it("preserves the source version in the active snapshot manifest", () => {
    const manifest = parseBuildManifest([
      {
        documentId: "66666666-6666-4666-8666-666666666666",
        documentVersionId: identity.documentVersionId,
        displayName: "Mock source",
        version: 7,
        checksum: "source-checksum",
        permission: "campus_indexer_allowed",
        chunks: [
          {
            chunkId: identity.chunkId,
            ordinal: 0,
            contentHash: "chunk-hash",
          },
        ],
      },
    ]);

    expect(manifest[0]?.version).toBe(7);
  });

  it("rejects a missing or invalid source version", () => {
    expect(() =>
      parseBuildManifest([
        {
          documentId: "66666666-6666-4666-8666-666666666666",
          documentVersionId: identity.documentVersionId,
          displayName: "Mock source",
          checksum: "source-checksum",
          permission: "campus_indexer_allowed",
          chunks: [
            {
              chunkId: identity.chunkId,
              ordinal: 0,
              contentHash: "chunk-hash",
            },
          ],
        },
      ]),
    ).toThrowError(/manifest is incomplete/u);
  });

  it("rejects a source that has not allowed campus indexing", () => {
    expect(() =>
      parseBuildManifest([
        {
          documentId: "66666666-6666-4666-8666-666666666666",
          documentVersionId: identity.documentVersionId,
          displayName: "Private source",
          version: 1,
          checksum: "source-checksum",
          permission: "local_only",
          chunks: [
            {
              chunkId: identity.chunkId,
              ordinal: 0,
              contentHash: "chunk-hash",
            },
          ],
        },
      ]),
    ).toThrowError(/must allow campus indexing/u);
  });
});

describe("structural Markdown graph links", () => {
  const sourceId = "66666666-6666-4666-8666-666666666666";
  const targetId = "77777777-7777-4777-8777-777777777777";
  const sourceText = "See [[notes/Target#Setup|target setup]].";

  function linkRecord(
    overrides: Partial<KnowledgeMarkdownStructuralLinkRecord> = {},
  ): KnowledgeMarkdownStructuralLinkRecord {
    return {
      namespace: "main",
      sourceDocumentId: sourceId,
      sourceDocumentVersionId: identity.documentVersionId,
      sourceDisplayName: "Index.md",
      sourcePath: "notes/Index.md",
      sourcePermission: "campus_indexer_allowed",
      sourceChecksum: "source-checksum",
      sourceChunkId: identity.chunkId,
      sourceChunkOrdinal: 0,
      sourceText,
      link: {
        syntax: "obsidian",
        rawTarget: "notes/Target#Setup",
        normalizedVaultRelativeTarget: "notes/Target",
        anchor: "Setup",
        label: null,
        alias: "target setup",
        sourceLocation: {
          startOffset: 4,
          endOffset: sourceText.length - 1,
          line: 1,
          column: 5,
        },
        resolution: {
          status: "resolved",
          method: "path",
          note: { path: "notes/Target.md", id: targetId },
        },
      },
      targetDocumentId: targetId,
      targetDocumentVersionId: "88888888-8888-4888-8888-888888888888",
      targetDisplayName: "Target.md",
      targetPath: "notes/Target.md",
      targetPermission: "campus_indexer_allowed",
      ...overrides,
    };
  }

  it("keeps navigation typed and only plans selected, permitted resolved notes", () => {
    const sourceManifest = parseBuildManifest([
      {
        documentId: sourceId,
        documentVersionId: identity.documentVersionId,
        displayName: "Index.md",
        version: 1,
        checksum: "source-checksum",
        permission: "campus_indexer_allowed",
        structuralFingerprint: "f".repeat(64),
        chunks: [
          {
            chunkId: identity.chunkId,
            ordinal: 0,
            contentHash: "chunk-hash",
          },
        ],
      },
      {
        documentId: targetId,
        documentVersionId: "88888888-8888-4888-8888-888888888888",
        displayName: "Target.md",
        version: 1,
        checksum: "target-checksum",
        permission: "campus_indexer_allowed",
        structuralFingerprint: "f".repeat(64),
        chunks: [
          {
            chunkId: "99999999-9999-4999-8999-999999999999",
            ordinal: 0,
            contentHash: "target-chunk-hash",
          },
        ],
      },
    ]);
    const unresolved = linkRecord({
      link: {
        ...linkRecord().link,
        resolution: { status: "unresolved", method: "basename" },
      },
      targetDocumentId: null,
      targetDocumentVersionId: null,
      targetDisplayName: null,
      targetPath: null,
      targetPermission: null,
    });
    const localOnlyTarget = linkRecord({ targetPermission: "local_only" });
    const unselectedTarget = linkRecord({
      targetDocumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      targetDocumentVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetPath: "notes/Unselected.md",
      targetDisplayName: "Unselected.md",
    });

    const plan = planStructuralGraphLinks(
      [linkRecord(), unresolved, localOnlyTarget, unselectedTarget],
      sourceManifest,
    );

    expect(STRUCTURAL_LINK_PREDICATE).toBe("structural_links_to");
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      predicate: STRUCTURAL_LINK_PREDICATE,
      quote: "[[notes/Target#Setup|target setup]]",
      spanStart: 4,
      spanEnd: sourceText.length - 1,
      qualifiers: {
        relationKind: "structural_navigation",
        linkSyntax: "obsidian",
        namespace: "main",
        sourceDocumentId: sourceId,
        sourceDocumentVersionId: identity.documentVersionId,
        anchor: "Setup",
        alias: "target setup",
        targetDocumentId: targetId,
        targetDocumentVersionId: "88888888-8888-4888-8888-888888888888",
      },
    });
    expect(plan.resolutions.map((item) => item.graphStatus)).toEqual([
      "eligible",
      "unresolved",
      "permission_excluded",
      "target_not_selected",
    ]);
  });
});

type MockRow = Record<string, unknown>;

interface MockSelectQuery {
  from(table: unknown): MockSelectQuery;
  where(...conditions: unknown[]): MockSelectQuery;
  for(...options: unknown[]): MockSelectQuery;
  limit(count: number): Promise<MockRow[]>;
  then<TResult1 = MockRow[], TResult2 = never>(
    onfulfilled?:
      ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

interface MockMutationQuery {
  set(values: MockRow): MockMutationQuery;
  values(values: MockRow): MockMutationQuery;
  where(...conditions: unknown[]): MockMutationQuery;
  returning(...selection: unknown[]): Promise<MockRow[]>;
  onConflictDoUpdate(options: MockRow): MockMutationQuery;
  then<TResult1 = MockRow[], TResult2 = never>(
    onfulfilled?:
      ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

function mockSelectQuery(
  rowsForTable: (table: unknown) => MockRow[],
): MockSelectQuery {
  let table: unknown;
  const query: MockSelectQuery = {
    from(source) {
      table = source;
      return query;
    },
    where() {
      return query;
    },
    for() {
      return query;
    },
    limit() {
      return Promise.resolve(rowsForTable(table));
    },
    then(onfulfilled, onrejected) {
      return Promise.resolve(rowsForTable(table)).then(onfulfilled, onrejected);
    },
  };
  return query;
}

function mockMutationQuery(
  table: unknown,
  recordUpdate: (table: unknown, values: MockRow) => void,
): MockMutationQuery {
  const query: MockMutationQuery = {
    set(values) {
      recordUpdate(table, values);
      return query;
    },
    values() {
      return query;
    },
    where() {
      return query;
    },
    returning() {
      return Promise.resolve([]);
    },
    onConflictDoUpdate() {
      return query;
    },
    then(onfulfilled, onrejected) {
      return Promise.resolve([]).then(onfulfilled, onrejected);
    },
  };
  return query;
}

function createIdentityTestDatabase(options: {
  budgetRunId?: string;
  buildId?: string;
  runConfig?: MockRow;
}): {
  db: Database;
  runUpdates: MockRow[];
  buildUpdates: MockRow[];
} {
  const manifestHash = "a".repeat(64);
  const build = {
    id: options.buildId ?? "55555555-5555-4555-8555-555555555555",
    state: "queued",
    sourceManifest: [
      {
        documentId: "66666666-6666-4666-8666-666666666666",
        documentVersionId: identity.documentVersionId,
        displayName: "Mock source",
        version: 1,
        checksum: "source-checksum",
        permission: "campus_indexer_allowed",
        chunks: [
          {
            chunkId: identity.chunkId,
            ordinal: 0,
            contentHash: "chunk-hash",
          },
        ],
      },
    ],
    sourceManifestHash: manifestHash,
    extractorModel: identity.requestedModel,
    budget: {
      idempotencyKey: "graph-build-test-key",
      sourceIds: [],
      maxModelCalls: 1,
      maxRepairPerChunk: 1,
      maxCallsPerChunk: 2,
      callsUsed: 0,
      completedChunks: [],
      failedChunks: [],
      requestedModel: identity.requestedModel,
      runId: options.budgetRunId ?? identity.runId,
    },
  };
  const run = {
    id: identity.runId,
    providerConnectionId: "77777777-7777-4777-8777-777777777777",
    status: "queued",
    configSnapshot: options.runConfig ?? {
      buildId: build.id,
      sourceManifestHash: manifestHash,
    },
  };
  const runUpdates: MockRow[] = [];
  const buildUpdates: MockRow[] = [];

  const database = {
    select() {
      return mockSelectQuery((table) => {
        if (table === schema.graphBuilds) return [build];
        if (table === schema.runs) return [run];
        if (table === schema.graphSnapshots || table === schema.runEvents)
          return [];
        return [];
      });
    },
    update(table: unknown) {
      return mockMutationQuery(table, (target, values) => {
        if (target === schema.runs) runUpdates.push(values);
        if (target === schema.graphBuilds) buildUpdates.push(values);
      });
    },
    insert(table: unknown) {
      return mockMutationQuery(table, () => undefined);
    },
    transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(database);
    },
  };

  return {
    db: database as unknown as Database,
    runUpdates,
    buildUpdates,
  };
}

describe("graph build execution identity", () => {
  const job = {
    projectId: identity.projectId,
    buildId: "55555555-5555-4555-8555-555555555555",
    runId: identity.runId,
  };

  const cases = [
    {
      name: "budget run ID differs from the queued job",
      databaseOptions: {
        budgetRunId: "88888888-8888-4888-8888-888888888888",
      },
    },
    {
      name: "run config references a different build",
      databaseOptions: {
        runConfig: {
          buildId: "88888888-8888-4888-8888-888888888888",
          sourceManifestHash: "a".repeat(64),
        },
      },
    },
    {
      name: "loaded build ID differs from the queued job",
      databaseOptions: {
        buildId: "88888888-8888-4888-8888-888888888888",
      },
    },
    {
      name: "run config has a different source manifest hash",
      databaseOptions: {
        runConfig: {
          buildId: job.buildId,
          sourceManifestHash: "b".repeat(64),
        },
      },
    },
  ];

  for (const { name, databaseOptions } of cases) {
    it(`marks the build failed without calling the provider when ${name}`, async () => {
      const { db, runUpdates, buildUpdates } =
        createIdentityTestDatabase(databaseOptions);
      let providerCalls = 0;
      const runtime: GraphBuildRuntime = {
        adapter: {
          async complete() {
            providerCalls += 1;
            throw new Error("Identity mismatch reached provider adapter.");
          },
        },
        apiKey: "mock-campus-key",
        keyConfigured: true,
        configuredModel: identity.requestedModel,
      };

      await executeGraphBuild(db, job, runtime);

      expect(providerCalls).toBe(0);
      expect(
        runUpdates.some(
          (values) => values.errorCode === "GRAPH_BUILD_IDENTITY_MISMATCH",
        ),
      ).toBe(true);
      expect(buildUpdates.some((values) => values.state === "failed")).toBe(
        true,
      );
    });
  }
});
