import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getGraphSnapshotById,
  graphSnapshotIsCurrent,
  retrieveKnowledgeContext,
  type Database,
} from "@promptlab/db";
import type { ToolContext } from "@promptlab/tools";

import { createOptimizationGraphToolHandlers } from "./optimization-graph-tools.js";

vi.mock("@promptlab/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@promptlab/db")>();
  return {
    ...original,
    getGraphSnapshotById: vi.fn(),
    graphSnapshotIsCurrent: vi.fn(),
    retrieveKnowledgeContext: vi.fn(),
  };
});

const projectId = "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceId = "1ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceVersionId = "2ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const snapshotId = "3ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const db = {} as Database;

function context(
  input: {
    sourceIds?: string[];
    entityIds?: string[];
  } = {},
): ToolContext {
  return {
    scope: {
      projectId,
      allowedSourceIds: new Set(input.sourceIds ?? [sourceId]),
      allowedChunkIds: new Set(),
      allowedHistoryMessageIds: new Set(),
      developmentCaseIds: new Set(),
      candidateIds: new Set(),
      graphEntityIds: new Set(input.entityIds ?? []),
      graphAssertionIds: new Set(),
    },
    signal: new AbortController().signal,
  };
}

describe("optimization graph tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the missing run-start snapshot without querying another snapshot", async () => {
    const handlers = createOptimizationGraphToolHandlers({
      db,
      sourceIds: [sourceId],
      graphSnapshotId: null,
      runId: "4ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
    });

    await expect(
      handlers.get_graph_status!({}, context()),
    ).resolves.toMatchObject({
      available: false,
      reason: "no_snapshot_at_run_start",
    });
    expect(getGraphSnapshotById).not.toHaveBeenCalled();
    expect(retrieveKnowledgeContext).not.toHaveBeenCalled();
  });

  it("keeps graph search on the frozen project, source, snapshot, and seed limit", async () => {
    vi.mocked(getGraphSnapshotById).mockResolvedValue({
      snapshotId,
      state: "active",
      sourceManifest: [
        {
          documentId: sourceId,
          documentVersionId: sourceVersionId,
          checksum: "a".repeat(64),
          permission: "campus_indexer_allowed",
        },
      ],
      coverage: { entityCount: 3, assertionCount: 4 },
    } as never);
    vi.mocked(graphSnapshotIsCurrent).mockResolvedValue(true);
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue({
      strategyUsed: "graph",
      fallbackReason: null,
      traceId: "5ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
      seeds: [
        { id: "6ab1d010-a1bb-4dc8-a520-12b6270fb8b3" },
        { id: "7ab1d010-a1bb-4dc8-a520-12b6270fb8b3" },
      ],
      paths: [],
    } as never);
    const handlers = createOptimizationGraphToolHandlers({
      db,
      sourceIds: [sourceId],
      graphSnapshotId: snapshotId,
      runId: "8ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
    });

    const result = await handlers.search_graph_entities!(
      { query: "testing", limit: 1 },
      context(),
    );

    expect(result).toMatchObject({
      available: true,
      resultCount: 1,
      entityIds: ["6ab1d010-a1bb-4dc8-a520-12b6270fb8b3"],
    });
    expect(retrieveKnowledgeContext).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        projectId,
        strategy: "graph",
        sourceIds: [sourceId],
        snapshotId,
        runId: "8ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
        bounds: expect.objectContaining({ maxSeeds: 1 }),
      }),
    );
  });

  it("rejects unlisted source scope and traversal seeds before database access", async () => {
    const handlers = createOptimizationGraphToolHandlers({
      db,
      sourceIds: [sourceId],
      graphSnapshotId: snapshotId,
      runId: "9ab1d010-a1bb-4dc8-a520-12b6270fb8b3",
    });

    await expect(
      handlers.get_graph_status!({}, context({ sourceIds: [] })),
    ).resolves.toMatchObject({
      available: false,
      reason: "source_scope_mismatch",
    });
    await expect(
      handlers.traverse_graph!(
        {
          seedEntityIds: ["6ab1d010-a1bb-4dc8-a520-12b6270fb8b3"],
          maxHops: 1,
          maxNeighborsPerExpansion: 8,
          maxNodes: 20,
          maxEdges: 30,
          maxPaths: 2,
          maxEstimatedContextTokens: 1000,
        },
        context(),
      ),
    ).resolves.toMatchObject({
      available: false,
      reason: "seed_entity_outside_run_scope",
    });
    expect(getGraphSnapshotById).not.toHaveBeenCalled();
    expect(retrieveKnowledgeContext).not.toHaveBeenCalled();
  });
});
