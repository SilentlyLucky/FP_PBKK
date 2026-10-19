import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  WorkspaceSourceManifestSchema,
  type WorkspaceSourceManifestEntry as ContractWorkspaceSourceManifestEntry,
  type WorkspaceSourceManifest as ContractWorkspaceSourceManifest,
} from "@promptlab/contracts";

import { schema, type Database } from "./index.ts";

export const MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES = 20;

export type WorkspaceSourceManifestEntry = ContractWorkspaceSourceManifestEntry;
export type WorkspaceSourceManifest = ContractWorkspaceSourceManifest;

/** Parses the shared contracts representation used by runs and evidence. */
export function parseWorkspaceSourceManifest(
  value: unknown,
): WorkspaceSourceManifest | null {
  const parsed = WorkspaceSourceManifestSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export interface CurrentWorkspaceSourceVersion {
  documentId: string;
  documentVersionId: string;
  documentVersion: number;
  checksum: string;
  permission: string;
}

export interface CurrentWorkspaceSourceScope {
  sources: CurrentWorkspaceSourceVersion[];
  invalidSelection: boolean;
  clipped: boolean;
}

type SourceScopeDatabase = Pick<Database, "select">;

/**
 * Resolves only the currently active, eligible versions of explicitly selected
 * project sources. The result is shared by run creation and retrieval so both
 * paths apply the same source validity rules.
 */
export async function loadCurrentWorkspaceSourceScope(
  db: SourceScopeDatabase,
  projectId: string,
  requestedSourceIds: readonly string[],
): Promise<CurrentWorkspaceSourceScope> {
  const selectedIds = [...new Set(requestedSourceIds)];
  if (selectedIds.length === 0) {
    return { sources: [], invalidSelection: false, clipped: false };
  }
  if (
    selectedIds.length !== requestedSourceIds.length ||
    selectedIds.length > MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES
  ) {
    return { sources: [], invalidSelection: true, clipped: false };
  }

  const rows = await db
    .select({
      documentId: schema.documents.id,
      activeVersionId: schema.documents.activeVersionId,
      deletedAt: schema.documents.deletedAt,
      permission: schema.documents.trust,
      documentVersionId: schema.documentVersions.id,
      documentVersion: schema.documentVersions.version,
      checksum: schema.documentVersions.checksum,
      eligible: schema.documentVersions.eligible,
    })
    .from(schema.documents)
    .leftJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.projectId, schema.documents.projectId),
        eq(schema.documentVersions.documentId, schema.documents.id),
        eq(schema.documentVersions.id, schema.documents.activeVersionId),
      ),
    )
    .where(
      and(
        eq(schema.documents.projectId, projectId),
        inArray(schema.documents.id, selectedIds),
      ),
    )
    .orderBy(asc(schema.documents.id))
    .limit(MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES + 1);

  const sources = rows.flatMap((row) =>
    !row.deletedAt &&
    row.activeVersionId &&
    row.activeVersionId === row.documentVersionId &&
    row.documentVersion !== null &&
    row.checksum !== null &&
    row.eligible
      ? [
          {
            documentId: row.documentId,
            documentVersionId: row.documentVersionId,
            documentVersion: row.documentVersion,
            checksum: row.checksum,
            permission: row.permission,
          },
        ]
      : [],
  );

  return {
    sources: sources.slice(0, MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES),
    invalidSelection:
      selectedIds.length !== sources.length ||
      rows.length > MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES,
    clipped: rows.length > MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES,
  };
}

export async function captureWorkspaceSourceManifest(
  db: SourceScopeDatabase,
  projectId: string,
  sourceIds: readonly string[],
): Promise<
  | { ok: true; manifest: WorkspaceSourceManifest }
  | {
      ok: false;
      reason:
        | "source_selection_not_current_in_project"
        | "source_permission_not_granted";
    }
> {
  const scope = await loadCurrentWorkspaceSourceScope(db, projectId, sourceIds);
  if (scope.invalidSelection) {
    return {
      ok: false,
      reason: "source_selection_not_current_in_project",
    };
  }
  if (
    scope.sources.some(
      (source) => source.permission !== "campus_indexer_allowed",
    )
  ) {
    return { ok: false, reason: "source_permission_not_granted" };
  }
  return {
    ok: true,
    manifest: {
      format: "promptlab-workspace-source-manifest-v1",
      sources: scope.sources.map((source) => ({
        documentId: source.documentId,
        documentVersionId: source.documentVersionId,
        documentVersion: source.documentVersion,
        checksum: source.checksum,
        sourcePermission: "campus_indexer_allowed",
      })),
    },
  };
}

export function workspaceSourceManifestMatchesCurrent(
  expected: readonly WorkspaceSourceManifestEntry[],
  current: readonly CurrentWorkspaceSourceVersion[],
): boolean {
  const expectedIds = expected.map((source) => source.documentId);
  if (
    new Set(expectedIds).size !== expectedIds.length ||
    expected.length !== current.length ||
    current.some((source) => source.permission !== "campus_indexer_allowed")
  ) {
    return false;
  }
  const canonical = <T extends { documentId: string }>(sources: readonly T[]) =>
    [...sources].sort((left, right) =>
      left.documentId.localeCompare(right.documentId),
    );
  return (
    JSON.stringify(canonical(expected)) ===
    JSON.stringify(
      canonical(
        current.map((source) => ({
          documentId: source.documentId,
          documentVersionId: source.documentVersionId,
          documentVersion: source.documentVersion,
          checksum: source.checksum,
          sourcePermission: source.permission,
        })),
      ),
    )
  );
}

export async function isWorkspaceSourceManifestCurrent(
  db: SourceScopeDatabase,
  projectId: string,
  manifest: WorkspaceSourceManifest,
): Promise<boolean> {
  if (
    manifest.format !== "promptlab-workspace-source-manifest-v1" ||
    manifest.sources.length > MAX_WORKSPACE_SOURCE_MANIFEST_ENTRIES ||
    manifest.sources.some(
      (source) => source.sourcePermission !== "campus_indexer_allowed",
    )
  ) {
    return false;
  }
  const current = await loadCurrentWorkspaceSourceScope(
    db,
    projectId,
    manifest.sources.map((source) => source.documentId),
  );
  return (
    !current.invalidSelection &&
    workspaceSourceManifestMatchesCurrent(manifest.sources, current.sources)
  );
}
