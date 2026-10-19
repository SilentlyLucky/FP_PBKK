import { and, eq, inArray } from "drizzle-orm";

import {
  getGraphSnapshotById,
  graphSnapshotIsCurrent,
  GRAPH_RETRIEVAL_HARD_BOUNDS,
  retrieveKnowledgeContext,
  schema,
  type Database,
  type RetrievalEvidence,
  type WorkspaceSourceManifestEntry,
} from "@promptlab/db";
import {
  clampGraphBounds,
  type ToolContext,
  type ToolHandlers,
} from "@promptlab/tools";

const MAX_GRAPH_EVIDENCE_RESULTS = 60;

interface OptimizationGraphToolOptions {
  db: Database;
  sourceIds: readonly string[];
  graphSnapshotId: string | null;
  runId: string;
  sourceManifest?: readonly WorkspaceSourceManifestEntry[];
}

interface FrozenGraphSource {
  documentId: string;
  documentVersionId: string;
  checksum: string;
  permission: string;
}

interface ScopedGraphEvidence {
  assertionId: string;
  assertionVersionId: string;
  evidenceId: string;
  quote: string;
  documentId: string;
  documentName: string;
  sourceRef: string | null;
  sourceMetadata: Record<string, unknown>;
  documentVersionId: string;
  documentVersion: number;
  chunkId: string;
  pageNumber: number | null;
  sourceChecksum: string;
  extractionRunId: string | null;
  extractorModel: string | null;
  traceId: string;
}

/**
 * Exposes only graph data from the frozen project/source/snapshot selection.
 * All queries are read-only; graph extraction and provider egress stay in the
 * separately consented graph-build flow.
 */
export function createOptimizationGraphToolHandlers(
  options: OptimizationGraphToolOptions,
): Pick<
  ToolHandlers,
  | "search_graph_entities"
  | "traverse_graph"
  | "get_graph_evidence"
  | "get_graph_status"
> {
  const evidenceByAssertionId = new Map<string, ScopedGraphEvidence[]>();

  const usableSnapshot = async (context: ToolContext) => {
    const projectId = context.scope.projectId;
    if (options.sourceIds.length === 0) {
      return { snapshot: null, reason: "no_sources_selected" as const };
    }
    if (
      options.sourceIds.some((id) => !context.scope.allowedSourceIds.has(id))
    ) {
      return { snapshot: null, reason: "source_scope_mismatch" as const };
    }
    if (!options.graphSnapshotId) {
      return { snapshot: null, reason: "no_snapshot_at_run_start" as const };
    }
    const snapshot = await getGraphSnapshotById(
      options.db,
      projectId,
      options.graphSnapshotId,
    );
    if (!snapshot || !["active", "superseded"].includes(snapshot.state)) {
      return {
        snapshot: null,
        reason: "selected_snapshot_unavailable" as const,
      };
    }
    if (
      !(await graphSnapshotIsCurrent(
        options.db,
        projectId,
        snapshot.sourceManifest,
      ))
    ) {
      return { snapshot: null, reason: "selected_snapshot_stale" as const };
    }
    const selectedSourceIds = new Set(options.sourceIds);
    const manifest = parseSourceManifest(snapshot.sourceManifest);
    const selectedManifest = manifest.filter((source) =>
      selectedSourceIds.has(source.documentId),
    );
    if (selectedManifest.length !== selectedSourceIds.size) {
      return {
        snapshot: null,
        reason: "selected_sources_not_in_snapshot" as const,
      };
    }
    if (options.sourceManifest) {
      const frozenById = new Map(
        options.sourceManifest.map((source) => [source.documentId, source]),
      );
      if (
        selectedManifest.some((source) => {
          const frozen = frozenById.get(source.documentId);
          return (
            !frozen ||
            source.documentVersionId !== frozen.documentVersionId ||
            source.checksum !== frozen.checksum ||
            source.permission !== frozen.sourcePermission
          );
        })
      ) {
        return {
          snapshot: null,
          reason: "selected_sources_not_in_snapshot" as const,
        };
      }
    }
    return { snapshot, reason: null };
  };

  const runGraphRetrieval = async (
    query: string,
    context: ToolContext,
    bounds: typeof GRAPH_RETRIEVAL_HARD_BOUNDS,
  ) => {
    const available = await usableSnapshot(context);
    if (!available.snapshot) {
      return {
        available: false as const,
        reason: available.reason,
        seeds: [],
        paths: [],
        entityIds: [],
        assertionIds: [],
        traceId: null,
      };
    }
    const retrieval = await retrieveKnowledgeContext(options.db, {
      projectId: context.scope.projectId,
      query,
      strategy: "graph",
      sourceIds: [...options.sourceIds],
      ...(options.sourceManifest
        ? { sourceManifest: options.sourceManifest }
        : {}),
      snapshotId: available.snapshot.snapshotId,
      requireCampusPermission: true,
      bounds,
      runId: options.runId,
    });
    if (retrieval.strategyUsed !== "graph") {
      return {
        available: false as const,
        reason: retrieval.fallbackReason ?? "graph_evidence_unavailable",
        seeds: [],
        paths: [],
        entityIds: [],
        assertionIds: [],
        traceId: retrieval.traceId,
      };
    }

    const seeds = retrieval.seeds.slice(0, bounds.maxSeeds);
    const selectedSeedIds = new Set(seeds.map((seed) => seed.id));
    const selectedPaths = retrieval.paths
      .filter((path) => selectedSeedIds.has(path.entityIds[0] ?? ""))
      .slice(0, bounds.maxPaths);
    const versionIds = [
      ...new Set(selectedPaths.flatMap((path) => path.assertionVersionIds)),
    ].slice(0, MAX_GRAPH_EVIDENCE_RESULTS);
    const versionRows = versionIds.length
      ? await options.db
          .select({
            assertionId: schema.graphAssertionVersions.assertionId,
            assertionVersionId: schema.graphAssertionVersions.id,
          })
          .from(schema.graphSnapshotAssertions)
          .innerJoin(
            schema.graphAssertionVersions,
            and(
              eq(
                schema.graphAssertionVersions.projectId,
                schema.graphSnapshotAssertions.projectId,
              ),
              eq(
                schema.graphAssertionVersions.assertionId,
                schema.graphSnapshotAssertions.assertionId,
              ),
              eq(
                schema.graphAssertionVersions.id,
                schema.graphSnapshotAssertions.assertionVersionId,
              ),
              eq(schema.graphAssertionVersions.status, "extracted_supported"),
            ),
          )
          .where(
            and(
              eq(
                schema.graphSnapshotAssertions.projectId,
                context.scope.projectId,
              ),
              eq(
                schema.graphSnapshotAssertions.snapshotId,
                available.snapshot.snapshotId,
              ),
              eq(schema.graphSnapshotAssertions.eligible, true),
              inArray(schema.graphAssertionVersions.id, versionIds),
            ),
          )
          .limit(MAX_GRAPH_EVIDENCE_RESULTS)
      : [];
    const assertionIdByVersion = new Map(
      versionRows.map((row) => [row.assertionVersionId, row.assertionId]),
    );
    const paths = selectedPaths.map((path) => {
      const assertionIds: string[] = [];
      path.assertionVersionIds.forEach((versionId, index) => {
        const assertionId = assertionIdByVersion.get(versionId);
        const evidence = path.evidence[index];
        if (!assertionId || !evidence) return;
        assertionIds.push(assertionId);
        const record = toScopedEvidence(
          assertionId,
          versionId,
          evidence,
          retrieval.traceId,
        );
        const current = evidenceByAssertionId.get(assertionId) ?? [];
        if (!current.some((item) => item.evidenceId === record.evidenceId)) {
          current.push(record);
          evidenceByAssertionId.set(assertionId, current);
        }
      });
      return {
        entityIds: path.entityIds,
        labels: path.labels,
        predicates: path.predicates,
        assertionIds,
        evidence: path.evidence.map((item) => ({
          quote: item.quote,
          documentName: item.documentName,
          sourceRef: item.sourceRef,
          sourceMetadata: item.sourceMetadata,
          documentVersion: item.documentVersion,
          documentVersionId: item.documentVersionId,
          chunkId: item.chunkId,
          pageNumber: item.pageNumber,
          traceId: retrieval.traceId,
        })),
      };
    });
    const entityIds = [
      ...new Set([
        ...seeds.map((seed) => seed.id),
        ...paths.flatMap((path) => path.entityIds),
      ]),
    ].slice(0, bounds.maxNodes);
    const assertionIds = [
      ...new Set(paths.flatMap((path) => path.assertionIds)),
    ].slice(0, bounds.maxEdges);
    return {
      available: true as const,
      reason: null,
      seeds,
      paths,
      entityIds,
      assertionIds,
      traceId: retrieval.traceId,
    };
  };

  return {
    get_graph_status: async (_args, context) => {
      const available = await usableSnapshot(context);
      if (!available.snapshot) {
        return {
          available: false,
          revision: null,
          entityCount: 0,
          assertionCount: 0,
          reason: available.reason,
        };
      }
      const coverage = asRecord(available.snapshot.coverage);
      return {
        available: true,
        snapshotId: available.snapshot.snapshotId,
        revision: null,
        entityCount: nonnegativeCount(coverage?.entityCount),
        assertionCount: nonnegativeCount(coverage?.assertionCount),
        reason: null,
      };
    },
    search_graph_entities: async ({ query, limit }, context) => {
      const bounds = clampGraphBounds(
        { ...GRAPH_RETRIEVAL_HARD_BOUNDS, maxSeeds: limit },
        GRAPH_RETRIEVAL_HARD_BOUNDS,
      );
      const result = await runGraphRetrieval(query, context, bounds);
      return {
        available: result.available,
        reason: result.reason,
        resultCount: result.available ? result.seeds.length : 0,
        entities: result.seeds.slice(0, limit),
        entityIds: result.entityIds,
        assertionIds: result.assertionIds,
        paths: result.paths,
        traceId: result.traceId,
      };
    },
    traverse_graph: async (args, context) => {
      const requestedSeedIds = [...new Set(args.seedEntityIds)];
      if (
        requestedSeedIds.some((id) => !context.scope.graphEntityIds.has(id))
      ) {
        return {
          available: false,
          reason: "seed_entity_outside_run_scope",
          nodeCount: 0,
          edgeCount: 0,
          pathCount: 0,
          clipped: false,
          entityIds: [],
          assertionIds: [],
          paths: [],
          traceId: null,
        };
      }
      const rows = await options.db
        .select({
          id: schema.graphEntities.id,
          label: schema.graphEntities.canonicalLabel,
          aliases: schema.graphEntities.aliases,
        })
        .from(schema.graphEntities)
        .where(
          and(
            eq(schema.graphEntities.projectId, context.scope.projectId),
            inArray(schema.graphEntities.id, requestedSeedIds),
          ),
        )
        .limit(2);
      if (rows.length !== requestedSeedIds.length) {
        return {
          available: false,
          reason: "seed_entity_unavailable",
          nodeCount: 0,
          edgeCount: 0,
          pathCount: 0,
          clipped: false,
          entityIds: [],
          assertionIds: [],
          paths: [],
          traceId: null,
        };
      }
      const bounds = clampGraphBounds(
        {
          maxSeeds: requestedSeedIds.length,
          maxHops: args.maxHops,
          maxNeighborsPerExpansion: args.maxNeighborsPerExpansion,
          maxNodes: args.maxNodes,
          maxEdges: args.maxEdges,
          maxPaths: args.maxPaths,
          maxEstimatedContextTokens: args.maxEstimatedContextTokens,
        },
        GRAPH_RETRIEVAL_HARD_BOUNDS,
      );
      const query = rows
        .map((row) => [row.label, ...row.aliases].join(" "))
        .join(" ");
      const result = await runGraphRetrieval(query, context, bounds);
      const paths = result.paths.filter((path) =>
        requestedSeedIds.includes(path.entityIds[0] ?? ""),
      );
      const entityIds = [
        ...new Set(paths.flatMap((path) => path.entityIds)),
      ].slice(0, bounds.maxNodes);
      const assertionIds = [
        ...new Set(paths.flatMap((path) => path.assertionIds)),
      ].slice(0, bounds.maxEdges);
      return {
        available: result.available && paths.length > 0,
        reason:
          result.available && paths.length > 0
            ? null
            : (result.reason ?? "requested_seed_not_found_in_snapshot"),
        nodeCount: entityIds.length,
        edgeCount: assertionIds.length,
        pathCount: paths.length,
        clipped: paths.length < result.paths.length,
        entityIds,
        assertionIds,
        paths,
        traceId: result.traceId,
      };
    },
    get_graph_evidence: async ({ assertionIds }) => {
      const evidence = assertionIds.flatMap(
        (assertionId) => evidenceByAssertionId.get(assertionId) ?? [],
      );
      return {
        available: evidence.length > 0,
        resultCount: evidence.length,
        evidence,
        reason:
          evidence.length > 0
            ? null
            : "evidence_not_returned_by_prior_graph_query",
      };
    },
  };
}

function parseSourceManifest(value: unknown): FrozenGraphSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FrozenGraphSource[] => {
    const record = asRecord(entry);
    if (
      !record ||
      typeof record.documentId !== "string" ||
      typeof record.documentVersionId !== "string" ||
      typeof record.checksum !== "string"
    ) {
      return [];
    }
    return [
      {
        documentId: record.documentId,
        documentVersionId: record.documentVersionId,
        checksum: record.checksum,
        permission:
          typeof record.permission === "string" ? record.permission : "",
      },
    ];
  });
}

function toScopedEvidence(
  assertionId: string,
  assertionVersionId: string,
  evidence: RetrievalEvidence,
  traceId: string,
): ScopedGraphEvidence {
  return {
    assertionId,
    assertionVersionId,
    evidenceId: evidence.id,
    quote: evidence.quote,
    documentId: evidence.documentId,
    documentName: evidence.documentName,
    sourceRef: evidence.sourceRef,
    sourceMetadata: evidence.sourceMetadata,
    documentVersionId: evidence.documentVersionId,
    documentVersion: evidence.documentVersion,
    chunkId: evidence.chunkId,
    pageNumber: evidence.pageNumber,
    sourceChecksum: evidence.sourceChecksum,
    extractionRunId: evidence.extractionRunId ?? null,
    extractorModel: evidence.extractorModel ?? null,
    traceId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nonnegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
