import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  database: null as unknown,
  captureResult: null as unknown,
  activeGraphSnapshot: null as unknown,
  graphSnapshotCurrent: false,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => ({ db: mockState.database }),
  };
});

vi.mock("@promptlab/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptlab/db")>();
  return {
    ...actual,
    captureWorkspaceSourceManifest: vi.fn(async () => mockState.captureResult),
    getActiveGraphSnapshot: vi.fn(async () => mockState.activeGraphSnapshot),
    graphSnapshotIsCurrent: vi.fn(async () => mockState.graphSnapshotCurrent),
  };
});

vi.mock("@promptlab/providers/policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@promptlab/providers/policy")>();
  return {
    ...actual,
    providerConnectionMatchesPolicy: () => true,
  };
});

vi.mock("@promptlab/providers/codex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@promptlab/providers/codex")>();
  return {
    ...actual,
    codexVerificationMatchesConfiguration: () => true,
  };
});

import { schema } from "@promptlab/db";
import { POST } from "./route.js";

const projectId = "0d5a5412-7abe-4a48-b733-4e41508c9fc0";
const promptVersionId = "1d5a5412-7abe-4a48-b733-4e41508c9fc0";
const sourceId = "2d5a5412-7abe-4a48-b733-4e41508c9fc0";
const sourceVersionId = "3d5a5412-7abe-4a48-b733-4e41508c9fc0";
const runId = "4d5a5412-7abe-4a48-b733-4e41508c9fc0";
const targetModel = "gpt-6.1";
const sourceManifest = {
  format: "promptlab-workspace-source-manifest-v1" as const,
  sources: [
    {
      documentId: sourceId,
      documentVersionId: sourceVersionId,
      documentVersion: 4,
      checksum: "a".repeat(64),
      sourcePermission: "campus_indexer_allowed" as const,
    },
  ],
};

interface FakeDatabaseState {
  captureResult: unknown;
  insertedRunRows: Array<Record<string, unknown>>;
  runEvents: Array<Record<string, unknown>>;
  outboxRows: Array<Record<string, unknown>>;
  persistedRun: Record<string, unknown> | null;
  runReadBarrier: { promise: Promise<void>; resolve: () => void } | null;
  runReadCount: number;
  runInsertAttempts: number;
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    promptVersionId,
    provider: "campus_gateway",
    requestedModel: "campus-test-model",
    purpose: "optimizer",
    intent: "workspace_chat",
    idempotencyKey: "workspace-manifest-test-key",
    retrieval: { strategy: "lexical", sourceIds: [sourceId] },
    workspaceChat: {
      format: "promptlab-workspace-chat-v1",
      target: {
        requestedModel: targetModel,
        reasoningEffort: "high",
        reasoningEffortMode: "selected",
      },
    },
    ...overrides,
  };
}

function createDatabase(state: FakeDatabaseState) {
  const query = (selection: Record<string, unknown>, transaction: boolean) => {
    let table: unknown;
    const rows = async () => {
      if (table === schema.promptVersions)
        return [
          {
            id: promptVersionId,
            promptId: "5d5a5412-7abe-4a48-b733-4e41508c9fc0",
            text: "Jelaskan kebijakan berdasarkan sumber.",
          },
        ];
      if (table === schema.documents)
        return [
          {
            id: sourceId,
            activeVersionId: sourceVersionId,
            permission: "campus_indexer_allowed",
          },
        ];
      if (table === schema.providerConnections) {
        return Object.hasOwn(selection, "id")
          ? [
              {
                id: "6d5a5412-7abe-4a48-b733-4e41508c9fc0",
                provider: "campus_gateway",
                role: "optimizer",
                connectionStatus: "verified",
                requestedModel: "campus-test-model",
                capabilitySnapshot: {},
              },
            ]
          : [
              {
                provider: "codex_app_server",
                role: "target",
                connectionStatus: "verified",
                requestedModel: targetModel,
                capabilitySnapshot: {},
              },
            ];
      }
      if (table === schema.runs) {
        if (transaction && state.runReadBarrier) {
          state.runReadCount += 1;
          if (state.runReadCount === 2) state.runReadBarrier.resolve();
          await state.runReadBarrier.promise;
          return [];
        }
        return state.persistedRun ? [state.persistedRun] : [];
      }
      return [];
    };
    const builder = {
      from: (value: unknown) => {
        table = value;
        return builder;
      },
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: () => builder,
      orderBy: () => builder,
      for: () => builder,
      limit: async () => rows(),
      then: (
        resolve: (value: unknown) => unknown,
        reject: (reason?: unknown) => unknown,
      ) => rows().then(resolve, reject),
    };
    return builder;
  };

  const createConnection = (transaction: boolean) => {
    return {
      select: (selection: Record<string, unknown>) =>
        query(selection, transaction),
      insert: (table: unknown) => {
        return {
          values: (value: Record<string, unknown>) => {
            if (table === schema.runEvents) state.runEvents.push(value);
            if (table === schema.outbox) state.outboxRows.push(value);
            return {
              returning: async () => {
                if (table === schema.runs) {
                  state.runInsertAttempts += 1;
                  if (state.persistedRun) {
                    throw Object.assign(
                      new Error("duplicate idempotency key"),
                      { code: "23505" },
                    );
                  }
                  state.insertedRunRows.push(value);
                  state.persistedRun = {
                    ...value,
                    id: runId,
                    createdAt: new Date("2026-10-18T12:00:00.000Z"),
                  };
                  return [
                    {
                      id: runId,
                      status: value.status,
                      purpose: value.purpose,
                      provider: value.provider,
                      requestedModel: value.requestedModel,
                      createdAt: state.persistedRun.createdAt,
                    },
                  ];
                }
                return [];
              },
            };
          },
        };
      },
    };
  };

  const database = createConnection(false);
  return {
    ...database,
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(createConnection(true)),
  };
}

function responseRequest(body: unknown) {
  return new Request(`http://localhost/api/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ projectId }) };

describe("Workspace run source-manifest persistence", () => {
  let state: FakeDatabaseState;
  let originalCampusKey: string | undefined;
  let originalCampusModel: string | undefined;

  beforeEach(() => {
    originalCampusKey = process.env.PROMPTLAB_CAMPUS_API_KEY;
    originalCampusModel = process.env.PROMPTLAB_CAMPUS_MODEL;
    process.env.PROMPTLAB_CAMPUS_API_KEY = "test-campus-key";
    process.env.PROMPTLAB_CAMPUS_MODEL = "campus-test-model";
    state = {
      captureResult: { ok: true, manifest: sourceManifest },
      insertedRunRows: [],
      runEvents: [],
      outboxRows: [],
      persistedRun: null,
      runReadBarrier: null,
      runReadCount: 0,
      runInsertAttempts: 0,
    };
    mockState.captureResult = state.captureResult;
    mockState.activeGraphSnapshot = null;
    mockState.graphSnapshotCurrent = false;
    mockState.database = createDatabase(state);
  });

  it("stores the captured source manifest in the queued run config", async () => {
    const response = await POST(responseRequest(requestBody()), context);
    const body = (await response.json()) as {
      run: { id: string; status: string };
    };

    expect(response.status).toBe(201);
    expect(body.run).toMatchObject({ id: runId, status: "queued" });
    expect(state.insertedRunRows).toHaveLength(1);
    expect(state.insertedRunRows[0]?.configSnapshot).toMatchObject({
      workspaceSourceManifest: sourceManifest,
      workspaceChatTarget: {
        requestedModel: targetModel,
        reasoningEffort: "high",
        reasoningEffortMode: "selected",
      },
    });
    expect(state.runEvents).toHaveLength(1);
    expect(state.outboxRows).toHaveLength(1);
  });

  it("persists Auto with selected sources when no compatible graph snapshot exists", async () => {
    const response = await POST(
      responseRequest(
        requestBody({ retrieval: { strategy: "auto", sourceIds: [sourceId] } }),
      ),
      context,
    );

    expect(response.status).toBe(201);
    expect(state.insertedRunRows[0]?.configSnapshot).toMatchObject({
      retrieval: { strategy: "auto", sourceIds: [sourceId], snapshotId: null },
      workspaceSourceManifest: sourceManifest,
    });
  });

  it("accepts Hybrid without a graph snapshot and replays the same request", async () => {
    const hybridRequest = requestBody({
      retrieval: { strategy: "hybrid", sourceIds: [sourceId] },
    });
    const response = await POST(responseRequest(hybridRequest), context);
    const retry = await POST(responseRequest(hybridRequest), context);
    const retryBody = (await retry.json()) as {
      run: { id: string; status: string };
    };

    expect(response.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retryBody.run).toMatchObject({ id: runId, status: "queued" });
    expect(state.insertedRunRows).toHaveLength(1);
    expect(state.insertedRunRows[0]?.configSnapshot).toMatchObject({
      retrieval: {
        strategy: "hybrid",
        sourceIds: [sourceId],
        snapshotId: null,
      },
      workspaceSourceManifest: sourceManifest,
    });
    expect(mockState.activeGraphSnapshot).toBeNull();
    expect(state.runEvents).toHaveLength(1);
    expect(state.outboxRows).toHaveLength(1);
  });

  it("freezes a current graph snapshot for Auto only when it covers selected versions", async () => {
    const snapshotId = "7d5a5412-7abe-4a48-b733-4e41508c9fc0";
    mockState.activeGraphSnapshot = {
      snapshotId,
      state: "active",
      sourceManifest: [
        {
          documentId: sourceId,
          documentVersionId: sourceVersionId,
          checksum: sourceManifest.sources[0]!.checksum,
          permission: "campus_indexer_allowed",
        },
      ],
    };
    mockState.graphSnapshotCurrent = true;

    const response = await POST(
      responseRequest(
        requestBody({ retrieval: { strategy: "auto", sourceIds: [sourceId] } }),
      ),
      context,
    );

    expect(response.status).toBe(201);
    expect(state.insertedRunRows[0]?.configSnapshot).toMatchObject({
      retrieval: {
        strategy: "auto",
        sourceIds: [sourceId],
        snapshotId,
      },
    });
  });

  it("does not retrieve when Auto has an empty source selection", async () => {
    state.captureResult = {
      ok: true,
      manifest: {
        format: "promptlab-workspace-source-manifest-v1",
        sources: [],
      },
    };
    mockState.captureResult = state.captureResult;

    const response = await POST(
      responseRequest(
        requestBody({ retrieval: { strategy: "auto", sourceIds: [] } }),
      ),
      context,
    );

    expect(response.status).toBe(201);
    expect(state.insertedRunRows[0]?.configSnapshot).toMatchObject({
      retrieval: { strategy: "auto", sourceIds: [], snapshotId: null },
      workspaceSourceManifest: {
        format: "promptlab-workspace-source-manifest-v1",
        sources: [],
      },
    });
    expect(mockState.activeGraphSnapshot).toBeNull();
  });

  it("rejects explicit GraphRAG with an empty source selection before run creation", async () => {
    const response = await POST(
      responseRequest(
        requestBody({ retrieval: { strategy: "graph", sourceIds: [] } }),
      ),
      context,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("INVALID_GRAPH_SNAPSHOT_SELECTION");
    expect(state.runInsertAttempts).toBe(0);
    expect(state.insertedRunRows).toHaveLength(0);
    expect(state.runEvents).toHaveLength(0);
    expect(state.outboxRows).toHaveLength(0);
  });

  it("keeps explicit GraphRAG strict when the active snapshot is absent", async () => {
    const response = await POST(
      responseRequest(
        requestBody({
          retrieval: { strategy: "graph", sourceIds: [sourceId] },
        }),
      ),
      context,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("GRAPH_SNAPSHOT_NOT_CURRENT");
    expect(state.insertedRunRows).toHaveLength(0);
  });

  it("rejects an explicit graph snapshot that is stale", async () => {
    mockState.activeGraphSnapshot = {
      snapshotId: "7d5a5412-7abe-4a48-b733-4e41508c9fc0",
      state: "active",
      sourceManifest: [
        {
          documentId: sourceId,
          documentVersionId: sourceVersionId,
          checksum: sourceManifest.sources[0]!.checksum,
          permission: "campus_indexer_allowed",
        },
      ],
    };
    mockState.graphSnapshotCurrent = false;

    const response = await POST(
      responseRequest(
        requestBody({
          retrieval: { strategy: "graph", sourceIds: [sourceId] },
        }),
      ),
      context,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("GRAPH_SNAPSHOT_NOT_CURRENT");
    expect(state.insertedRunRows).toHaveLength(0);
    expect(state.outboxRows).toHaveLength(0);
  });

  it("rejects an explicit graph snapshot that misses the selected source version", async () => {
    mockState.activeGraphSnapshot = {
      snapshotId: "7d5a5412-7abe-4a48-b733-4e41508c9fc0",
      state: "active",
      sourceManifest: [
        {
          documentId: sourceId,
          documentVersionId: "8d5a5412-7abe-4a48-b733-4e41508c9fc0",
          checksum: "b".repeat(64),
          permission: "campus_indexer_allowed",
        },
      ],
    };
    mockState.graphSnapshotCurrent = true;

    const response = await POST(
      responseRequest(
        requestBody({
          retrieval: { strategy: "graph", sourceIds: [sourceId] },
        }),
      ),
      context,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("GRAPH_SNAPSHOT_SOURCE_MISMATCH");
    expect(state.insertedRunRows).toHaveLength(0);
    expect(state.outboxRows).toHaveLength(0);
  });

  it("rejects a missing target before inserting or enqueueing a run", async () => {
    const response = await POST(
      responseRequest(
        requestBody({
          workspaceChat: {
            format: "promptlab-workspace-chat-v1",
            target: null,
          },
        }),
      ),
      context,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("WORKSPACE_CHAT_TARGET_REQUIRED");
    expect(state.insertedRunRows).toHaveLength(0);
    expect(state.runEvents).toHaveLength(0);
    expect(state.outboxRows).toHaveLength(0);
  });

  it("refuses a source whose egress permission changed during run creation", async () => {
    state.captureResult = {
      ok: false,
      reason: "source_permission_not_granted",
    };
    mockState.captureResult = state.captureResult;

    const response = await POST(responseRequest(requestBody()), context);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("RETRIEVAL_SOURCE_PERMISSION_REQUIRED");
    expect(state.insertedRunRows).toHaveLength(0);
    expect(state.outboxRows).toHaveLength(0);
  });

  it("replays the winner after concurrent identical inserts race on the key", async () => {
    let resolveRunReads!: () => void;
    const runReads = new Promise<void>((resolve) => {
      resolveRunReads = resolve;
    });
    state.runReadBarrier = { promise: runReads, resolve: resolveRunReads };

    const responses = await Promise.all([
      POST(responseRequest(requestBody()), context),
      POST(responseRequest(requestBody()), context),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    const bodies = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{ run: { id: string; status: string } }>,
      ),
    );

    expect(statuses).toEqual([200, 201]);
    expect(bodies.map((body) => body.run.id)).toEqual([runId, runId]);
    expect(bodies.map((body) => body.run.status)).toEqual(["queued", "queued"]);
    expect(state.runInsertAttempts).toBe(2);
    expect(state.insertedRunRows).toHaveLength(1);
    expect(state.runEvents).toHaveLength(1);
    expect(state.outboxRows).toHaveLength(1);
  });

  afterEach(() => {
    if (originalCampusKey === undefined)
      delete process.env.PROMPTLAB_CAMPUS_API_KEY;
    else process.env.PROMPTLAB_CAMPUS_API_KEY = originalCampusKey;
    if (originalCampusModel === undefined)
      delete process.env.PROMPTLAB_CAMPUS_MODEL;
    else process.env.PROMPTLAB_CAMPUS_MODEL = originalCampusModel;
  });
});
