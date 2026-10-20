import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  WorkspaceSourceManifestSchema,
  type WorkspaceSourceManifestEntry as ContractWorkspaceSourceManifestEntry,
  type WorkspaceSourceManifest as ContractWorkspaceSourceManifest,
} from "@promptlab/contracts";

import { schema, type Database } from "./index.ts";

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
  if (selectedIds.length !== requestedSourceIds.length) {
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
    sources,
    invalidSelection: selectedIds.length !== sources.length,
    clipped: false,
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
      reason: "source_selection_not_current_in_project";
    }
> {
  const scope = await loadCurrentWorkspaceSourceScope(db, projectId, sourceIds);
  if (scope.invalidSelection) {
    return {
      ok: false,
      reason: "source_selection_not_current_in_project",
    };
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
    expected.length !== current.length
  ) {
    return false;
  }
  const canonical = <T extends { documentId: string }>(sources: readonly T[]) =>
    [...sources].sort((left, right) =>
      left.documentId.localeCompare(right.documentId),
    );
  return (
    JSON.stringify(
      canonical(
        expected.map((source) => ({
          documentId: source.documentId,
          documentVersionId: source.documentVersionId,
          documentVersion: source.documentVersion,
          checksum: source.checksum,
        })),
      ),
    ) ===
    JSON.stringify(
      canonical(
        current.map((source) => ({
          documentId: source.documentId,
          documentVersionId: source.documentVersionId,
          documentVersion: source.documentVersion,
          checksum: source.checksum,
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
  if (manifest.format !== "promptlab-workspace-source-manifest-v1") {
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
