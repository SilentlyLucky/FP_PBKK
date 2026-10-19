import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { schema } from "./schema.ts";
import type { Database } from "./index.ts";
import {
  checksumText,
  getActiveGraphSnapshot,
  getActiveKnowledgeMarkdownFingerprint,
  graphSnapshotIsCurrent,
} from "./knowledge.ts";
import {
  GraphifyImportError,
  graphifyConfidenceRequiresReview,
  parseGraphifyExportImport,
  type GraphifyExportImport,
  type GraphifyLinkBinding,
  type GraphifyNodeBinding,
  type GraphifySelectedSource,
} from "./graphify-export.ts";

type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

interface SourceManifestEntry extends Record<string, unknown> {
  documentId: string;
  documentVersionId: string;
  displayName: string;
  sourceKind: string;
  permission: string;
  version: number;
  checksum: string;
  structuralFingerprint: string;
  chunks: Array<{ chunkId: string; ordinal: number; contentHash: string }>;
}

interface BoundChunk {
  documentId: string;
  documentVersionId: string;
  checksum: string;
  content: string;
  contentHash: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sourceManifestEntry(value: unknown): SourceManifestEntry | null {
  const row = object(value);
  if (
    typeof row.documentId !== "string" ||
    typeof row.documentVersionId !== "string" ||
    typeof row.displayName !== "string" ||
    typeof row.sourceKind !== "string" ||
    typeof row.permission !== "string" ||
    typeof row.version !== "number" ||
    typeof row.checksum !== "string" ||
    typeof row.structuralFingerprint !== "string" ||
    !Array.isArray(row.chunks)
  ) {
    return null;
  }
  const chunks = row.chunks.flatMap((value) => {
    const chunk = object(value);
    return typeof chunk.chunkId === "string" &&
      typeof chunk.ordinal === "number" &&
      typeof chunk.contentHash === "string"
      ? [
          {
            chunkId: chunk.chunkId,
            ordinal: chunk.ordinal,
            contentHash: chunk.contentHash,
          },
        ]
      : [];
  });
  if (chunks.length !== row.chunks.length) return null;
  return {
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    displayName: row.displayName,
    sourceKind: row.sourceKind,
    permission: row.permission,
    version: row.version,
    checksum: row.checksum,
    structuralFingerprint: row.structuralFingerprint,
    chunks,
  };
}

function isGraphifyMembership(qualifiers: unknown, importKey: string): boolean {
  const row = object(qualifiers);
  return (
    row.relationKind === "structural_navigation" &&
    row.namespace === "graphify" &&
    row.graphifyImportKey === importKey
  );
}

function isUnreviewedInferredGraphifyMembership(member: {
  qualifiers: unknown;
  status: string;
  changedBy: string | null;
}): boolean {
  const qualifiers = object(member.qualifiers);
  const confidence =
    typeof qualifiers.graphifyConfidence === "string"
      ? qualifiers.graphifyConfidence
      : null;
  return (
    qualifiers.relationKind === "structural_navigation" &&
    qualifiers.namespace === "graphify" &&
    member.status === "extracted_supported" &&
    member.changedBy === "graphify_import" &&
    graphifyConfidenceRequiresReview(confidence)
  );
}

async function loadCurrentSourceManifest(
  tx: DatabaseTransaction,
  projectId: string,
  selection: readonly GraphifySelectedSource[],
): Promise<{
  manifest: SourceManifestEntry[];
  chunks: Map<string, BoundChunk>;
}> {
  const documentIds = selection.map((source) => source.documentId);
  await tx
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.projectId, projectId),
        inArray(schema.documents.id, documentIds),
      ),
    )
    .orderBy(asc(schema.documents.id))
    .for("update");

  const rows = await tx
    .select({
      documentId: schema.documents.id,
      displayName: schema.documents.displayName,
      sourceKind: schema.documents.sourceKind,
      permission: schema.documents.trust,
      deletedAt: schema.documents.deletedAt,
      activeVersionId: schema.documents.activeVersionId,
      documentVersionId: schema.documentVersions.id,
      version: schema.documentVersions.version,
      checksum: schema.documentVersions.checksum,
      eligible: schema.documentVersions.eligible,
    })
    .from(schema.documents)
    .innerJoin(
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
        inArray(schema.documents.id, documentIds),
      ),
    )
    .orderBy(asc(schema.documents.id));

  if (rows.length !== selection.length) {
    throw new GraphifyImportError(
      "SOURCE_NOT_FOUND",
      "A selected source does not belong to this project or is unavailable.",
      404,
    );
  }
  const requestedByDocument = new Map(
    selection.map((source) => [source.documentId, source]),
  );
  for (const row of rows) {
    const selected = requestedByDocument.get(row.documentId);
    if (!selected || row.deletedAt || !row.eligible || !row.activeVersionId) {
      throw new GraphifyImportError(
        "SOURCE_VERSION_STALE",
        "A selected source is deleted, ineligible, or has no active version.",
        409,
      );
    }
    if (selected.documentVersionId !== row.documentVersionId) {
      throw new GraphifyImportError(
        "SOURCE_VERSION_STALE",
        "A selected source version is no longer active.",
        409,
      );
    }
    if (selected.checksum !== row.checksum) {
      throw new GraphifyImportError(
        "SOURCE_CHECKSUM_MISMATCH",
        "A selected source checksum no longer matches the active version.",
        409,
      );
    }
    if (row.permission !== "campus_indexer_allowed") {
      throw new GraphifyImportError(
        "SOURCE_PERMISSION_REQUIRED",
        "Every selected source must be permitted by PromptLab's graph retrieval policy.",
        409,
      );
    }
  }

  const versionIds = rows.map((row) => row.documentVersionId);
  const chunkRows = await tx
    .select({
      id: schema.chunks.id,
      documentVersionId: schema.chunks.documentVersionId,
      ordinal: schema.chunks.ordinal,
      contentHash: schema.chunks.contentHash,
      content: schema.chunks.content,
    })
    .from(schema.chunks)
    .where(
      and(
        eq(schema.chunks.projectId, projectId),
        inArray(schema.chunks.documentVersionId, versionIds),
      ),
    )
    .orderBy(asc(schema.chunks.documentVersionId), asc(schema.chunks.ordinal))
    .limit(121);
  const structuralFingerprint = await getActiveKnowledgeMarkdownFingerprint(
    tx,
    projectId,
  );
  const manifest = rows.map((row) => {
    const chunks = chunkRows
      .filter((chunk) => chunk.documentVersionId === row.documentVersionId)
      .map((chunk) => ({
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        contentHash: chunk.contentHash,
      }));
    if (!chunks.length) {
      throw new GraphifyImportError(
        "SOURCE_SELECTION_INVALID",
        "Every selected source must contain at least one imported chunk.",
      );
    }
    return {
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      displayName: row.displayName,
      sourceKind: row.sourceKind,
      permission: row.permission,
      version: row.version,
      checksum: row.checksum,
      structuralFingerprint,
      chunks,
    } satisfies SourceManifestEntry;
  });
  if (manifest.reduce((count, entry) => count + entry.chunks.length, 0) > 120) {
    throw new GraphifyImportError(
      "SOURCE_CHUNK_LIMIT",
      "Graphify import source selection exceeds 120 imported chunks.",
    );
  }
  const chunksById = new Map<string, BoundChunk>();
  for (const chunk of chunkRows) {
    const owner = rows.find(
      (row) => row.documentVersionId === chunk.documentVersionId,
    );
    if (!owner) continue;
    chunksById.set(chunk.id, {
      documentId: owner.documentId,
      documentVersionId: owner.documentVersionId,
      checksum: owner.checksum,
      content: chunk.content,
      contentHash: chunk.contentHash,
    });
  }
  return { manifest, chunks: chunksById };
}

function validateBindings(
  input: GraphifyExportImport,
  manifest: readonly SourceManifestEntry[],
  chunks: ReadonlyMap<string, BoundChunk>,
): {
  nodeBindings: Map<string, GraphifyNodeBinding>;
  linkBindings: Map<number, GraphifyLinkBinding>;
  quotes: Map<string, string>;
} {
  const manifestByVersion = new Map(
    manifest.map((source) => [source.documentVersionId, source]),
  );
  const nodeBindings = new Map(
    input.nodeBindings.map((binding) => [binding.nodeId, binding]),
  );
  const linkBindings = new Map(
    input.linkBindings.map((binding) => [binding.linkIndex, binding]),
  );
  const quotes = new Map<string, string>();
  const bindings = [
    ...input.nodeBindings.map(
      (binding) => [`node:${binding.nodeId}`, binding] as const,
    ),
    ...input.linkBindings.map(
      (binding) => [`link:${binding.linkIndex}`, binding] as const,
    ),
  ];
  for (const [key, binding] of bindings) {
    const source = manifestByVersion.get(binding.documentVersionId);
    if (
      !source ||
      source.documentId !== binding.documentId ||
      source.checksum !== binding.checksum
    ) {
      throw new GraphifyImportError(
        "GRAPHIFY_SOURCE_NOT_SELECTED",
        "A node or link binding does not belong to the selected source manifest.",
      );
    }
    if (!source.chunks.some((chunk) => chunk.chunkId === binding.chunkId)) {
      throw new GraphifyImportError(
        "GRAPHIFY_CHUNK_UNBOUND",
        "A node or link binding references a chunk outside its selected source version.",
      );
    }
    const chunk = chunks.get(binding.chunkId);
    const quote = chunk?.content.slice(binding.spanStart, binding.spanEnd);
    if (
      !chunk ||
      chunk.documentId !== binding.documentId ||
      chunk.documentVersionId !== binding.documentVersionId ||
      chunk.checksum !== binding.checksum ||
      !quote ||
      quote.length !== binding.spanEnd - binding.spanStart ||
      checksumText(chunk.content) !== chunk.contentHash
    ) {
      throw new GraphifyImportError(
        "GRAPHIFY_CITATION_MISMATCH",
        "A node or link span does not match the selected imported chunk content.",
        409,
      );
    }
    quotes.set(key, quote);
  }
  return { nodeBindings, linkBindings, quotes };
}

function makeMergedManifest(
  current: readonly SourceManifestEntry[],
  previous: unknown,
  currentFingerprint: string,
): SourceManifestEntry[] {
  const byDocument = new Map<string, SourceManifestEntry>();
  for (const value of Array.isArray(previous) ? previous : []) {
    const entry = sourceManifestEntry(value);
    if (entry) {
      byDocument.set(entry.documentId, {
        ...entry,
        structuralFingerprint: currentFingerprint,
      });
    }
  }
  for (const entry of current) {
    const prior = byDocument.get(entry.documentId);
    if (
      prior &&
      (prior.documentVersionId !== entry.documentVersionId ||
        prior.checksum !== entry.checksum)
    ) {
      throw new GraphifyImportError(
        "SOURCE_MANIFEST_STALE",
        "The active graph snapshot refers to a different version of a selected source.",
        409,
      );
    }
    byDocument.set(entry.documentId, entry);
  }
  return [...byDocument.values()].sort((a, b) =>
    a.documentId.localeCompare(b.documentId),
  );
}

async function findOrCreateGraphifyEntity(
  tx: DatabaseTransaction,
  projectId: string,
  node: GraphifyExportImport["nodes"][number],
): Promise<string> {
  const nodeAlias = `graphify-node:${node.id}`;
  const candidates = await tx
    .select({
      id: schema.graphEntities.id,
      canonicalLabel: schema.graphEntities.canonicalLabel,
      aliases: schema.graphEntities.aliases,
    })
    .from(schema.graphEntities)
    .where(
      and(
        eq(schema.graphEntities.projectId, projectId),
        eq(schema.graphEntities.entityType, "Component"),
        eq(schema.graphEntities.normalizedLabel, normalize(node.label)),
      ),
    );
  const matches = candidates.filter((candidate) =>
    candidate.aliases.includes(nodeAlias),
  );
  if (matches.length > 1) {
    throw new GraphifyImportError(
      "GRAPHIFY_NODE_ID_AMBIGUOUS",
      "A Graphify node ID matches multiple runtime graph entities.",
      409,
    );
  }
  if (matches.length === 1) {
    if (matches[0]!.canonicalLabel !== node.label) {
      throw new GraphifyImportError(
        "GRAPHIFY_NODE_ID_CONFLICT",
        "A Graphify node ID was previously imported with a different label.",
        409,
      );
    }
    return matches[0]!.id;
  }
  const [entity] = await tx
    .insert(schema.graphEntities)
    .values({
      projectId,
      canonicalLabel: node.label,
      entityType: "Component",
      normalizedLabel: normalize(node.label),
      aliases: [nodeAlias, node.sourceFile],
      reviewStatus: "unreviewed",
    })
    .returning({ id: schema.graphEntities.id });
  if (!entity) throw new Error("Graphify entity insert returned no row");
  return entity.id;
}

async function ensureGraphifyMention(
  tx: DatabaseTransaction,
  projectId: string,
  entityId: string,
  binding: GraphifyNodeBinding,
  quote: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.graphMentions.id })
    .from(schema.graphMentions)
    .where(
      and(
        eq(schema.graphMentions.projectId, projectId),
        eq(schema.graphMentions.entityId, entityId),
        eq(schema.graphMentions.documentVersionId, binding.documentVersionId),
        eq(schema.graphMentions.chunkId, binding.chunkId),
        eq(schema.graphMentions.spanStart, binding.spanStart),
        eq(schema.graphMentions.spanEnd, binding.spanEnd),
      ),
    )
    .limit(1);
  if (existing) return;
  await tx.insert(schema.graphMentions).values({
    projectId,
    entityId,
    documentVersionId: binding.documentVersionId,
    chunkId: binding.chunkId,
    spanStart: binding.spanStart,
    spanEnd: binding.spanEnd,
    surfaceText: quote,
    extractionRunId: null,
  });
}

async function insertGraphifyAssertionVersion(
  tx: DatabaseTransaction,
  input: {
    projectId: string;
    assertionId: string;
    version: number;
    subjectEntityId: string;
    objectEntityId: string;
    direction: "directed" | "undirected";
    qualifiers: Record<string, unknown>;
    status: "extracted_supported" | "needs_review";
  },
): Promise<string> {
  const [version] = await tx
    .insert(schema.graphAssertionVersions)
    .values({
      projectId: input.projectId,
      assertionId: input.assertionId,
      version: input.version,
      subjectEntityId: input.subjectEntityId,
      predicate: "structural_links_to",
      objectEntityId: input.objectEntityId,
      direction: input.direction,
      qualifiers: input.qualifiers,
      status: input.status,
      changedBy: "graphify_import",
    })
    .returning({ id: schema.graphAssertionVersions.id });
  if (!version)
    throw new Error("Graphify assertion version insert returned no row");
  return version.id;
}

async function insertGraphifyLink(
  tx: DatabaseTransaction,
  input: {
    projectId: string;
    snapshotId: string;
    manifestHash: string;
    importKey: string;
    directed: boolean;
    link: GraphifyExportImport["links"][number];
    linkIndex: number;
    sourceEntityId: string;
    targetEntityId: string;
    sourceNode: GraphifyExportImport["nodes"][number];
    targetNode: GraphifyExportImport["nodes"][number];
    sourceBinding: GraphifyNodeBinding;
    targetBinding: GraphifyNodeBinding;
    evidenceBinding: GraphifyLinkBinding;
    quote: string;
  },
): Promise<{ eligible: boolean; needsReview: boolean }> {
  const qualifiers = {
    relationKind: "structural_navigation",
    namespace: "graphify",
    graphifyImportKey: input.importKey,
    graphifyRelation: input.link.relation,
    graphifyConfidence: input.link.confidence,
    graphifyConfidenceScore: input.link.confidenceScore,
    graphifySourceFile: input.link.sourceFile,
    graphifySourceLocation: input.link.sourceLocation,
    graphifyLinkIndex: input.linkIndex,
    sourceDocumentId: input.sourceBinding.documentId,
    sourceDocumentVersionId: input.sourceBinding.documentVersionId,
    sourcePath: input.sourceNode.sourceFile,
    targetDocumentId: input.targetBinding.documentId,
    targetDocumentVersionId: input.targetBinding.documentVersionId,
    targetPath: input.targetNode.sourceFile,
    evidenceDocumentId: input.evidenceBinding.documentId,
    evidenceDocumentVersionId: input.evidenceBinding.documentVersionId,
    evidenceChunkId: input.evidenceBinding.chunkId,
    sourceGraphifyNodeId: input.link.source,
    targetGraphifyNodeId: input.link.target,
  };
  const direction = input.directed ? "directed" : "undirected";
  const candidates = await tx
    .select({
      id: schema.graphAssertions.id,
      currentVersion: schema.graphAssertions.currentVersion,
      status: schema.graphAssertions.status,
      versionId: schema.graphAssertionVersions.id,
      changedBy: schema.graphAssertionVersions.changedBy,
    })
    .from(schema.graphAssertions)
    .innerJoin(
      schema.graphAssertionVersions,
      and(
        eq(
          schema.graphAssertionVersions.projectId,
          schema.graphAssertions.projectId,
        ),
        eq(
          schema.graphAssertionVersions.assertionId,
          schema.graphAssertions.id,
        ),
        eq(
          schema.graphAssertionVersions.version,
          schema.graphAssertions.currentVersion,
        ),
      ),
    )
    .where(
      and(
        eq(schema.graphAssertions.projectId, input.projectId),
        eq(schema.graphAssertions.subjectEntityId, input.sourceEntityId),
        eq(schema.graphAssertions.predicate, "structural_links_to"),
        eq(schema.graphAssertions.objectEntityId, input.targetEntityId),
        eq(schema.graphAssertions.direction, direction),
        eq(schema.graphAssertions.qualifiers, qualifiers),
      ),
    )
    .limit(2);
  if (candidates.length > 1) {
    throw new GraphifyImportError(
      "GRAPHIFY_LINK_AMBIGUOUS",
      "A Graphify link matches multiple runtime graph assertions.",
      409,
    );
  }
  let assertionId: string;
  let assertionVersionId: string;
  let status: "extracted_supported" | "needs_review" | "rejected";
  if (candidates.length === 1) {
    const existing = candidates[0]!;
    assertionId = existing.id;
    status = existing.status;
    if (
      graphifyConfidenceRequiresReview(input.link.confidence) &&
      existing.status === "extracted_supported" &&
      existing.changedBy === "graphify_import"
    ) {
      const nextVersion = existing.currentVersion + 1;
      assertionVersionId = await insertGraphifyAssertionVersion(tx, {
        projectId: input.projectId,
        assertionId,
        version: nextVersion,
        subjectEntityId: input.sourceEntityId,
        objectEntityId: input.targetEntityId,
        direction,
        qualifiers,
        status: "needs_review",
      });
      const [updated] = await tx
        .update(schema.graphAssertions)
        .set({
          currentVersion: nextVersion,
          status: "needs_review",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.graphAssertions.projectId, input.projectId),
            eq(schema.graphAssertions.id, assertionId),
            eq(schema.graphAssertions.currentVersion, existing.currentVersion),
          ),
        )
        .returning({ id: schema.graphAssertions.id });
      if (!updated) {
        throw new GraphifyImportError(
          "GRAPHIFY_LINK_CHANGED",
          "A Graphify link changed while its imported confidence was being reviewed.",
          409,
        );
      }
      status = "needs_review";
    } else {
      assertionVersionId = existing.versionId;
    }
  } else {
    status = graphifyConfidenceRequiresReview(input.link.confidence)
      ? "needs_review"
      : "extracted_supported";
    const [assertion] = await tx
      .insert(schema.graphAssertions)
      .values({
        projectId: input.projectId,
        subjectEntityId: input.sourceEntityId,
        predicate: "structural_links_to",
        objectEntityId: input.targetEntityId,
        direction,
        qualifiers,
        status,
      })
      .returning({ id: schema.graphAssertions.id });
    if (!assertion)
      throw new Error("Graphify assertion insert returned no row");
    assertionId = assertion.id;
    assertionVersionId = await insertGraphifyAssertionVersion(tx, {
      projectId: input.projectId,
      assertionId,
      version: 1,
      subjectEntityId: input.sourceEntityId,
      objectEntityId: input.targetEntityId,
      direction,
      qualifiers,
      status,
    });
  }

  const [existingEvidence] = await tx
    .select({ id: schema.graphEvidence.id })
    .from(schema.graphEvidence)
    .where(
      and(
        eq(schema.graphEvidence.projectId, input.projectId),
        eq(schema.graphEvidence.assertionId, assertionId),
        eq(schema.graphEvidence.assertionVersionId, assertionVersionId),
        eq(
          schema.graphEvidence.documentVersionId,
          input.evidenceBinding.documentVersionId,
        ),
        eq(schema.graphEvidence.chunkId, input.evidenceBinding.chunkId),
        eq(schema.graphEvidence.sourceChecksum, input.evidenceBinding.checksum),
        eq(schema.graphEvidence.quote, input.quote),
        eq(schema.graphEvidence.spanStart, input.evidenceBinding.spanStart),
        eq(schema.graphEvidence.spanEnd, input.evidenceBinding.spanEnd),
        eq(schema.graphEvidence.eligible, true),
      ),
    )
    .limit(1);
  if (!existingEvidence) {
    await tx.insert(schema.graphEvidence).values({
      projectId: input.projectId,
      assertionId,
      assertionVersionId,
      documentVersionId: input.evidenceBinding.documentVersionId,
      chunkId: input.evidenceBinding.chunkId,
      quote: input.quote,
      spanStart: input.evidenceBinding.spanStart,
      spanEnd: input.evidenceBinding.spanEnd,
      sourceChecksum: input.evidenceBinding.checksum,
      extractionRunId: null,
      eligible: true,
    });
  }
  const eligible = status === "extracted_supported";
  const needsReview = status === "needs_review";
  const [existingMembership] = await tx
    .select({ assertionId: schema.graphSnapshotAssertions.assertionId })
    .from(schema.graphSnapshotAssertions)
    .where(
      and(
        eq(schema.graphSnapshotAssertions.projectId, input.projectId),
        eq(schema.graphSnapshotAssertions.snapshotId, input.snapshotId),
        eq(schema.graphSnapshotAssertions.assertionId, assertionId),
        eq(
          schema.graphSnapshotAssertions.assertionVersionId,
          assertionVersionId,
        ),
      ),
    )
    .limit(1);
  if (!existingMembership) {
    await tx.insert(schema.graphSnapshotAssertions).values({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      assertionId,
      assertionVersionId,
      sourceManifestHash: input.manifestHash,
      eligible,
    });
  }
  return { eligible, needsReview };
}

export async function importGraphifyExport(
  db: Database,
  projectId: string,
  value: unknown,
): Promise<{
  snapshotId: string;
  buildId: string;
  sourceManifestHash: string;
  importKey: string;
  nodeCount: number;
  linkCount: number;
  eligibleLinkCount: number;
  needsReviewLinkCount: number;
}> {
  const input = parseGraphifyExportImport(value);
  const importKey = checksumText(
    stableJson({
      sources: input.selectedSources
        .map(({ documentId, documentVersionId, checksum }) => ({
          documentId,
          documentVersionId,
          checksum,
        }))
        .sort((a, b) => a.documentId.localeCompare(b.documentId)),
      sourceFiles: [
        ...new Set([
          ...input.nodes.map((node) => node.sourceFile),
          ...input.links.map((link) => link.sourceFile),
        ]),
      ].sort(),
    }),
  );
  const exportHash = checksumText(
    stableJson({
      directed: input.directed,
      nodes: input.nodes,
      links: input.links,
    }),
  );

  return db.transaction(async (tx) => {
    // The active-snapshot row is absent before the first import, so locking it
    // alone cannot serialize simultaneous first imports for this project.
    await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .for("update");
    const loaded = await loadCurrentSourceManifest(
      tx,
      projectId,
      input.selectedSources,
    );
    const bindings = validateBindings(input, loaded.manifest, loaded.chunks);
    const markdownFingerprint = loaded.manifest[0]!.structuralFingerprint;
    const activeLock = await tx
      .select({ projectId: schema.graphActiveSnapshots.projectId })
      .from(schema.graphActiveSnapshots)
      .where(eq(schema.graphActiveSnapshots.projectId, projectId))
      .for("update");
    void activeLock;
    const active = await getActiveGraphSnapshot(tx, projectId);
    const previousManifestRows = Array.isArray(active?.sourceManifest)
      ? active.sourceManifest.map(sourceManifestEntry)
      : [];
    const previousManifestIsValid =
      previousManifestRows.length > 0 &&
      previousManifestRows.every((entry) => entry !== null);
    const activeIsCurrent = Boolean(
      active?.state === "active" &&
      previousManifestIsValid &&
      (await graphSnapshotIsCurrent(tx, projectId, active.sourceManifest)),
    );
    const manifest = makeMergedManifest(
      loaded.manifest,
      activeIsCurrent ? active?.sourceManifest : [],
      markdownFingerprint,
    );
    const manifestHash = checksumText(stableJson(manifest));
    if (!(await graphSnapshotIsCurrent(tx, projectId, manifest))) {
      throw new GraphifyImportError(
        "SOURCE_MANIFEST_STALE",
        "Selected sources changed before the Graphify snapshot could be activated.",
        409,
      );
    }

    const oldMembers =
      activeIsCurrent && active
        ? await tx
            .select({
              assertionId: schema.graphSnapshotAssertions.assertionId,
              assertionVersionId:
                schema.graphSnapshotAssertions.assertionVersionId,
              eligible: schema.graphSnapshotAssertions.eligible,
              qualifiers: schema.graphAssertionVersions.qualifiers,
              status: schema.graphAssertionVersions.status,
              changedBy: schema.graphAssertionVersions.changedBy,
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
              ),
            )
            .where(
              and(
                eq(schema.graphSnapshotAssertions.projectId, projectId),
                eq(
                  schema.graphSnapshotAssertions.snapshotId,
                  active.snapshotId,
                ),
              ),
            )
        : [];
    const retainedMembers = oldMembers.filter(
      (member) =>
        !isGraphifyMembership(member.qualifiers, importKey) &&
        !isUnreviewedInferredGraphifyMembership(member),
    );

    const [build] = await tx
      .insert(schema.graphBuilds)
      .values({
        projectId,
        sourceManifest: manifest,
        sourceManifestHash: manifestHash,
        extractionPromptVersion: "graphify-export-adapter-v1",
        extractionSchemaVersion: "graphify-node-link-v1",
        state: "ready_to_activate",
        budget: {
          adapter: "graphify-export",
          importKey,
          exportHash,
          sourceCount: manifest.length,
          nodeCount: input.nodes.length,
          linkCount: input.links.length,
          providerCalls: 0,
        },
        usageRefs: [],
      })
      .returning({ id: schema.graphBuilds.id });
    if (!build) throw new Error("Graphify build insert returned no row");
    const [snapshot] = await tx
      .insert(schema.graphSnapshots)
      .values({
        projectId,
        buildId: build.id,
        sourceManifest: manifest,
        sourceManifestHash: manifestHash,
        state: "staging",
        coverage: {
          adapter: "graphify-export",
          importKey,
          exportHash,
          sourceCount: manifest.length,
          chunkCount: manifest.reduce(
            (sum, source) => sum + source.chunks.length,
            0,
          ),
          nodeCount: input.nodes.length,
          linkCount: input.links.length,
          providerCalls: 0,
        },
      })
      .returning({ id: schema.graphSnapshots.id });
    if (!snapshot) throw new Error("Graphify snapshot insert returned no row");

    for (const member of retainedMembers) {
      await tx.insert(schema.graphSnapshotAssertions).values({
        projectId,
        snapshotId: snapshot.id,
        assertionId: member.assertionId,
        assertionVersionId: member.assertionVersionId,
        sourceManifestHash: manifestHash,
        eligible: member.eligible,
      });
    }
    const entityIds = new Map<string, string>();
    for (const node of input.nodes) {
      const entityId = await findOrCreateGraphifyEntity(tx, projectId, node);
      entityIds.set(node.id, entityId);
      const binding = bindings.nodeBindings.get(node.id)!;
      await ensureGraphifyMention(
        tx,
        projectId,
        entityId,
        binding,
        bindings.quotes.get(`node:${node.id}`)!,
      );
    }

    let eligibleLinkCount = 0;
    let needsReviewLinkCount = 0;
    for (const [linkIndex, link] of input.links.entries()) {
      const sourceNode = input.nodes.find((node) => node.id === link.source)!;
      const targetNode = input.nodes.find((node) => node.id === link.target)!;
      const sourceBinding = bindings.nodeBindings.get(link.source)!;
      const targetBinding = bindings.nodeBindings.get(link.target)!;
      const evidenceBinding = bindings.linkBindings.get(linkIndex)!;
      const result = await insertGraphifyLink(tx, {
        projectId,
        snapshotId: snapshot.id,
        manifestHash,
        importKey,
        directed: input.directed,
        link,
        linkIndex,
        sourceEntityId: entityIds.get(link.source)!,
        targetEntityId: entityIds.get(link.target)!,
        sourceNode,
        targetNode,
        sourceBinding,
        targetBinding,
        evidenceBinding,
        quote: bindings.quotes.get(`link:${linkIndex}`)!,
      });
      if (result.eligible) eligibleLinkCount += 1;
      if (result.needsReview) needsReviewLinkCount += 1;
    }

    if (!(await graphSnapshotIsCurrent(tx, projectId, manifest))) {
      throw new GraphifyImportError(
        "SOURCE_MANIFEST_STALE",
        "A selected source changed while the Graphify snapshot was being written.",
        409,
      );
    }
    const now = new Date();
    await tx
      .update(schema.graphSnapshots)
      .set({
        state: "active",
        activatedAt: now,
        coverage: {
          adapter: "graphify-export",
          importKey,
          exportHash,
          sourceCount: manifest.length,
          chunkCount: manifest.reduce(
            (sum, source) => sum + source.chunks.length,
            0,
          ),
          nodeCount: input.nodes.length,
          linkCount: input.links.length,
          eligibleLinkCount,
          needsReviewLinkCount,
          providerCalls: 0,
        },
      })
      .where(
        and(
          eq(schema.graphSnapshots.projectId, projectId),
          eq(schema.graphSnapshots.id, snapshot.id),
        ),
      );
    if (active) {
      await tx
        .update(schema.graphSnapshots)
        .set({ state: "superseded" })
        .where(
          and(
            eq(schema.graphSnapshots.projectId, projectId),
            eq(schema.graphSnapshots.id, active.snapshotId),
            eq(schema.graphSnapshots.state, "active"),
          ),
        );
    }
    await tx
      .insert(schema.graphActiveSnapshots)
      .values({ projectId, snapshotId: snapshot.id, revision: 1 })
      .onConflictDoUpdate({
        target: schema.graphActiveSnapshots.projectId,
        set: {
          snapshotId: snapshot.id,
          revision: sql`${schema.graphActiveSnapshots.revision} + 1`,
          updatedAt: now,
        },
      });
    await tx
      .update(schema.graphBuilds)
      .set({ state: "active", finishedAt: now })
      .where(
        and(
          eq(schema.graphBuilds.projectId, projectId),
          eq(schema.graphBuilds.id, build.id),
        ),
      );

    return {
      snapshotId: snapshot.id,
      buildId: build.id,
      sourceManifestHash: manifestHash,
      importKey,
      nodeCount: input.nodes.length,
      linkCount: input.links.length,
      eligibleLinkCount,
      needsReviewLinkCount,
    };
  });
}
