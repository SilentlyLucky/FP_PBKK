import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const routeMocks = vi.hoisted(() => ({
  database: undefined as unknown,
  importGraphifyExport: vi.fn(),
  runRealImport: null as
    | ((
        database: unknown,
        projectId: string,
        value: unknown,
      ) => Promise<unknown>)
    | null,
}));

vi.mock("@promptlab/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptlab/db")>();
  routeMocks.runRealImport = (database, projectId, value) =>
    actual.importGraphifyExport(
      database as Parameters<typeof actual.importGraphifyExport>[0],
      projectId,
      value,
    );
  return {
    ...actual,
    importGraphifyExport: routeMocks.importGraphifyExport,
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => ({ db: routeMocks.database }),
  };
});

import {
  createDatabaseClient,
  createKnowledgeSource,
  GraphifyImportError,
  replaceKnowledgeSource,
  schema,
  type DatabaseClient,
} from "@promptlab/db";

import { POST } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const mockDatabase = { adapter: "route-test" };
const mockImportResult = {
  snapshotId: "snapshot-id",
  buildId: "build-id",
  sourceManifestHash: "a".repeat(64),
  importKey: "b".repeat(64),
  nodeCount: 2,
  linkCount: 1,
  eligibleLinkCount: 1,
  needsReviewLinkCount: 0,
};

const connectionString = process.env.PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL;
const integrationRequested =
  process.env.PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS === "1" &&
  Boolean(connectionString);

const requiredTables = [
  "projects",
  "documents",
  "document_versions",
  "chunks",
  "graph_builds",
  "graph_snapshots",
  "graph_entities",
  "graph_assertions",
  "graph_assertion_versions",
  "graph_evidence",
  "graph_snapshot_assertions",
  "graph_active_snapshots",
];

const projectIds: string[] = [];

function context(id = projectId) {
  return { params: Promise.resolve({ projectId: id }) };
}

function post(body: string, id = projectId) {
  return POST(
    new Request(`http://localhost/api/projects/${id}/graph/graphify-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    context(id),
  );
}

describe("Graphify import API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.database = mockDatabase;
    routeMocks.importGraphifyExport.mockResolvedValue(mockImportResult);
  });

  it("rejects an invalid project ID before reading or importing the body", async () => {
    const response = await post("{", "not-a-project-id");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_PROJECT_ID" });
    expect(routeMocks.importGraphifyExport).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and 413 above the byte limit", async () => {
    const malformed = await post("{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "INVALID_JSON" });

    const tooLarge = await post("x".repeat(8_000_001));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      error: "GRAPHIFY_IMPORT_TOO_LARGE",
      maxBytes: 8_000_000,
    });
    expect(routeMocks.importGraphifyExport).not.toHaveBeenCalled();
  });

  it.each([
    { status: 400 as const, code: "GRAPHIFY_EXPORT_INVALID" },
    { status: 404 as const, code: "SOURCE_NOT_FOUND" },
    { status: 409 as const, code: "SOURCE_VERSION_STALE" },
  ])(
    "maps adapter $status errors into the route response",
    async ({ status, code }) => {
      routeMocks.importGraphifyExport.mockRejectedValue(
        new GraphifyImportError(
          code,
          "Graphify adapter rejected the import.",
          status,
        ),
      );

      const response = await post("{}");

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: code,
        message: "Graphify adapter rejected the import.",
      });
    },
  );

  it("returns 201 and forwards the parsed body and route project to the adapter", async () => {
    const body = { graph: { nodes: [], links: [] }, marker: "exact-body" };
    const response = await post(JSON.stringify(body));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ import: mockImportResult });
    expect(routeMocks.importGraphifyExport).toHaveBeenCalledExactlyOnceWith(
      mockDatabase,
      projectId,
      body,
    );
  });
});

describe.skipIf(!integrationRequested)(
  "Graphify import API route with Postgres",
  () => {
    let client: DatabaseClient | undefined;

    beforeAll(async () => {
      const target = new URL(connectionString!);
      const databaseName = decodeURIComponent(
        target.pathname.replace(/^\/+/, ""),
      );
      if (
        !["127.0.0.1", "localhost"].includes(target.hostname) ||
        !/^\d+$/u.test(target.port) ||
        Number(target.port) < 1 ||
        Number(target.port) > 65_535 ||
        !/^promptlab_knowledge_test_[a-f0-9]{32}$/iu.test(databaseName)
      ) {
        throw new Error(
          "Graphify route integration tests require a disposable UUID-named database on a loopback port, configured with PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL.",
        );
      }

      client = createDatabaseClient(connectionString!);
      routeMocks.database = client.db;
      routeMocks.importGraphifyExport.mockImplementation(
        (database, id, value) => {
          if (!routeMocks.runRealImport) {
            throw new Error(
              "Real Graphify adapter import was not initialized.",
            );
          }
          return routeMocks.runRealImport(database, id, value);
        },
      );

      const tables = await client.pool.query<{ tablename: string }>(
        `select tablename from pg_tables
       where schemaname = 'public' and tablename = any($1::text[])`,
        [requiredTables],
      );
      const presentTables = new Set(tables.rows.map((row) => row.tablename));
      const missingTables = requiredTables.filter(
        (table) => !presentTables.has(table),
      );
      if (missingTables.length) {
        throw new Error(
          `Graphify route integration database is missing migrated tables: ${missingTables.join(", ")}.`,
        );
      }
    }, 15_000);

    afterAll(async () => {
      if (!client) return;
      if (projectIds.length) {
        await client.db
          .delete(schema.projects)
          .where(inArray(schema.projects.id, projectIds));
      }
      await client.pool.end();
    });

    it("imports through the route and returns source scope and freshness failures", async () => {
      const connected = requireClient(client);
      const projectA = await createProject(connected);
      const projectB = await createProject(connected);
      const content = "Caller invokes Callee.";
      const source = await createKnowledgeSource(connected.db, {
        projectId: projectA,
        displayName: "route-graphify-source.ts",
        content,
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const [chunk] = await connected.db
        .select({ id: schema.chunks.id })
        .from(schema.chunks)
        .where(
          and(
            eq(schema.chunks.projectId, projectA),
            eq(schema.chunks.documentVersionId, source.versionId),
          ),
        )
        .limit(1);
      if (!chunk)
        throw new Error("Graphify route integration chunk is missing.");

      const input = routeGraphifyInput(source, chunk.id, content);
      const imported = await post(JSON.stringify(input), projectA);
      const importedPayload = (await imported.json()) as {
        import: Record<string, unknown>;
      };
      expect(imported.status).toBe(201);
      expect(importedPayload.import).toMatchObject({
        nodeCount: 2,
        linkCount: 1,
        eligibleLinkCount: 1,
        needsReviewLinkCount: 0,
      });
      expect(Object.keys(importedPayload.import).sort()).toEqual(
        [
          "buildId",
          "eligibleLinkCount",
          "importKey",
          "linkCount",
          "needsReviewLinkCount",
          "nodeCount",
          "snapshotId",
          "sourceManifestHash",
        ].sort(),
      );

      const wrongProject = await post(JSON.stringify(input), projectB);
      expect(wrongProject.status).toBe(404);
      expect(await wrongProject.json()).toMatchObject({
        error: "SOURCE_NOT_FOUND",
      });

      const wrongChecksum = structuredClone(input);
      const incorrectChecksum = "f".repeat(64);
      wrongChecksum.selectedSources[0]!.checksum = incorrectChecksum;
      for (const binding of [
        ...wrongChecksum.nodeBindings,
        ...wrongChecksum.linkBindings,
      ]) {
        binding.checksum = incorrectChecksum;
      }
      const checksumRejected = await post(
        JSON.stringify(wrongChecksum),
        projectA,
      );
      expect(checksumRejected.status).toBe(409);
      expect(await checksumRejected.json()).toMatchObject({
        error: "SOURCE_CHECKSUM_MISMATCH",
      });

      await replaceKnowledgeSource(connected.db, {
        projectId: projectA,
        sourceId: source.sourceId,
        displayName: "route-graphify-source.ts",
        content: "Caller now invokes Callee.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const staleVersion = await post(JSON.stringify(input), projectA);
      expect(staleVersion.status).toBe(409);
      expect(await staleVersion.json()).toMatchObject({
        error: "SOURCE_VERSION_STALE",
      });
    }, 20_000);
  },
);

function requireClient(client: DatabaseClient | undefined): DatabaseClient {
  if (!client) throw new Error("Graphify route integration setup did not run.");
  return client;
}

async function createProject(client: DatabaseClient): Promise<string> {
  const unique = randomUUID();
  const [project] = await client.db
    .insert(schema.projects)
    .values({
      ownerId: `graphify-route-integration-${unique}`,
      name: `graphify-route-integration-${unique}`,
    })
    .returning({ id: schema.projects.id });
  if (!project) throw new Error("Graphify route project insert failed.");
  projectIds.push(project.id);
  return project.id;
}

function routeGraphifyInput(
  source: { sourceId: string; versionId: string; checksum: string },
  chunkId: string,
  content: string,
) {
  const sourceFile = "src/route-graphify.ts";
  const selectedSource = {
    documentId: source.sourceId,
    documentVersionId: source.versionId,
    checksum: source.checksum,
  };
  const binding = (spanStart: number, spanEnd: number) => ({
    sourceFile,
    documentId: source.sourceId,
    documentVersionId: source.versionId,
    checksum: source.checksum,
    chunkId,
    spanStart,
    spanEnd,
  });
  const calleeStart = content.indexOf("Callee");

  return {
    graph: {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: "route-caller",
          label: "Caller",
          file_type: "code",
          source_file: sourceFile,
          source_location: "L1",
        },
        {
          id: "route-callee",
          label: "Callee",
          file_type: "code",
          source_file: sourceFile,
          source_location: "L1",
        },
      ],
      links: [
        {
          source: "route-caller",
          target: "route-callee",
          relation: "calls",
          source_file: sourceFile,
          source_location: "L1",
          confidence: "EXTRACTED",
          confidence_score: 1,
        },
      ],
    },
    selectedSources: [selectedSource],
    nodeBindings: [
      { nodeId: "route-caller", ...binding(0, "Caller".length) },
      {
        nodeId: "route-callee",
        ...binding(calleeStart, calleeStart + "Callee".length),
      },
    ],
    linkBindings: [{ linkIndex: 0, ...binding(0, content.length) }],
  };
}
