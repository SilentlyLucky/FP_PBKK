import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import referencePack from "./data/knowledge-reference-pack.json" with { type: "json" };
import { schema, type Database } from "./index.ts";
import {
  knowledgeMarkdownNoteSetFingerprint,
  normalizeKnowledgeVaultLocator,
  resolveKnowledgeMarkdownStructure,
  type KnowledgeMarkdownStructureNote,
  type KnowledgeMarkdownStructuralLinkRecord,
  type KnowledgeVaultLocator,
  type KnowledgeVaultLocatorInput,
} from "./knowledge-structure.ts";

export type { KnowledgeMarkdownStructuralLinkRecord } from "./knowledge-structure.ts";

type QueryDatabase = Pick<Database, "select" | "insert" | "update" | "delete">;

export const MAX_KNOWLEDGE_SOURCE_BYTES = 98_304;
export const MAX_KNOWLEDGE_PDF_FILE_BYTES = 5_242_880;
export const MAX_KNOWLEDGE_PDF_PAGES = 50;
export const MAX_KNOWLEDGE_SOURCE_METADATA_BYTES = 16_384;
export const MAX_GRAPH_BUILD_DOCUMENTS = 20;
export const MAX_GRAPH_BUILD_CHUNKS = 120;
export const MAX_GRAPH_BUILD_CALLS = 240;

export type SourcePermission = "local_only" | "campus_indexer_allowed";
export type RetrievalStrategy = "lexical" | "graph" | "full_context" | "hybrid";

export interface KnowledgeSourceInput {
  projectId: string;
  displayName: string;
  content: string;
  contentType: "text/plain" | "text/markdown" | "application/pdf";
  sourceKind: "upload" | "paste" | "reference_pack";
  permission: SourcePermission;
  rawByteSha256?: string | null;
  rawByteSize?: number | null;
  sourceRef?: string | null;
  vaultLocator?: KnowledgeVaultLocatorInput | KnowledgeVaultLocator | null;
  sourceMetadata?: Record<string, unknown>;
  chunks?: KnowledgeChunkInput[];
  pages?: KnowledgePageInput[];
}

export interface KnowledgeChunkInput {
  content: string;
  heading?: string | null;
  pageNumber?: number | null;
}

export interface KnowledgePageInput {
  pageNumber: number;
  content: string;
}

export interface GraphBuildSelection {
  sourceIds: string[];
  requestedModel: string | null;
  maxModelCalls?: number;
}

export interface GraphBuildPreview {
  ready: boolean;
  projectId: string;
  sourceCount: number;
  chunkCount: number;
  sources: Array<{
    id: string;
    name: string;
    version: number;
    checksum: string;
    chunkCount: number;
  }>;
  requestedModel: string | null;
  providerReady: boolean;
  providerReason: string | null;
  minModelCalls: number;
  maxModelCalls: number;
  selectedMaxModelCalls: number;
  sourceManifest: Array<Record<string, unknown>>;
  sourceManifestHash: string;
}

export type KnowledgeErrorCode =
  | "PROJECT_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_EMPTY"
  | "SOURCE_NAME_INVALID"
  | "SOURCE_CONTENT_INVALID"
  | "SOURCE_REF_INVALID"
  | "SOURCE_LOCATOR_INVALID"
  | "SOURCE_METADATA_INVALID"
  | "SOURCE_PDF_INVALID"
  | "SOURCE_PDF_PAGE_LIMIT"
  | "SOURCE_PDF_TEXT_MISSING"
  | "REFERENCE_PACK_INVALID"
  | "SOURCE_SELECTION_INVALID"
  | "SOURCE_PERMISSION_REQUIRED"
  | "SOURCE_CHUNK_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_BUDGET_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "BUILD_ALREADY_ACTIVE"
  | "BUILD_NOT_FOUND"
  | "BUILD_NOT_CANCELLABLE"
  | "ASSERTION_NOT_FOUND"
  | "ASSERTION_VERSION_CONFLICT"
  | "ASSERTION_EVIDENCE_STALE";

export class KnowledgeOperationError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KnowledgeOperationError";
  }
}

export function checksumText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface RawByteSnapshot {
  rawByteSha256: string | null;
  rawByteSize: number | null;
}

function validateRawByteSnapshot(
  rawByteSha256: string | null | undefined,
  rawByteSize: number | null | undefined,
): RawByteSnapshot {
  const digest = rawByteSha256 ?? null;
  const size = rawByteSize ?? null;
  if (
    (digest === null) !== (size === null) ||
    (digest !== null &&
      (typeof digest !== "string" || !/^[0-9a-f]{64}$/iu.test(digest))) ||
    (size !== null && (!Number.isSafeInteger(size) || size < 0))
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Digest dan ukuran bytes sumber harus valid serta diberikan bersama.",
    );
  }
  return {
    rawByteSha256: digest?.toLowerCase() ?? null,
    rawByteSize: size,
  };
}

export function validateKnowledgeText(input: {
  displayName: string;
  content: string;
}): { displayName: string; content: string; bytes: number } {
  const displayName = input.displayName.trim();
  if (
    !displayName ||
    displayName.length > 240 ||
    /[\\/\u0000-\u001f\u007f]/u.test(displayName) ||
    displayName === "." ||
    displayName === ".."
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_NAME_INVALID",
      "Nama sumber tidak valid.",
    );
  }
  // Keep imported text byte-for-byte at the string level. Markdown parsing is
  // read-only; the immutable version and its chunks retain the supplied text.
  const content = input.content;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_KNOWLEDGE_SOURCE_BYTES) {
    throw new KnowledgeOperationError(
      "SOURCE_TOO_LARGE",
      `Sumber dibatasi ${MAX_KNOWLEDGE_SOURCE_BYTES} byte.`,
      { limitBytes: MAX_KNOWLEDGE_SOURCE_BYTES, actualBytes: bytes },
    );
  }
  if (!content.trim()) {
    throw new KnowledgeOperationError(
      "SOURCE_EMPTY",
      "Sumber kosong tidak dapat disimpan.",
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Sumber hanya menerima teks UTF-8 yang dapat dibaca.",
    );
  }
  return { displayName, content, bytes };
}

interface TextChunk {
  ordinal: number;
  content: string;
  heading: string | null;
  pageNumber?: number | null;
}

interface ReferencePackSource {
  id: string;
  title: string;
  publisher: string;
  url: string;
  accessed_at_utc: string;
  source_type: string;
  use: string;
  sections_used: string[];
  license_caveat: string;
  temporal_caveat?: string;
  version_observed?: string;
}

interface ReferencePackChunk {
  id: string;
  source_id: string;
  topic: string;
  summary: string;
  evidence_excerpt: string;
  source_section: string;
  claim_type: string;
}

interface PackagedReferencePack {
  schema_version: string;
  corpus_id: string;
  status: string;
  source_snapshot_at_utc: string;
  scope: Record<string, unknown>;
  sources: ReferencePackSource[];
  chunks: ReferencePackChunk[];
  graph: { edges: Array<Record<string, unknown>> };
}

const packagedReferencePack = referencePack as PackagedReferencePack;

export function normalizeKnowledgeSourceRef(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const raw = value.trim();
  if (raw.length > 500) {
    throw new KnowledgeOperationError(
      "SOURCE_REF_INVALID",
      "Referensi sumber melebihi batas 500 karakter.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new KnowledgeOperationError(
      "SOURCE_REF_INVALID",
      "Referensi sumber harus berupa URL HTTPS yang valid.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.length === 0
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_REF_INVALID",
      "Referensi sumber harus berupa URL HTTPS yang valid.",
    );
  }
  parsed.hash = "";
  const canonical = parsed.href;
  if (canonical.length > 500) {
    throw new KnowledgeOperationError(
      "SOURCE_REF_INVALID",
      "Referensi sumber melebihi batas 500 karakter.",
    );
  }
  return canonical;
}

function validateSourceMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (value === undefined) return {};
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new KnowledgeOperationError(
      "SOURCE_METADATA_INVALID",
      "Metadata sumber tidak dapat diserialisasi.",
    );
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, "utf8") > MAX_KNOWLEDGE_SOURCE_METADATA_BYTES
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_METADATA_INVALID",
      `Metadata sumber dibatasi ${MAX_KNOWLEDGE_SOURCE_METADATA_BYTES} byte.`,
    );
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function sourceMetadataWithVaultLocator(
  value: Record<string, unknown> | undefined,
  locatorInput: KnowledgeSourceInput["vaultLocator"],
  contentType: KnowledgeSourceInput["contentType"],
): Record<string, unknown> {
  const metadata = validateSourceMetadata(value);
  const hasStoredLocator = Object.prototype.hasOwnProperty.call(
    metadata,
    "vaultLocator",
  );
  const explicitlySupplied = locatorInput !== undefined;
  const rawLocator =
    locatorInput === undefined
      ? hasStoredLocator
        ? metadata.vaultLocator
        : undefined
      : locatorInput;

  if (rawLocator === undefined || rawLocator === null) {
    delete metadata.vaultLocator;
    return metadata;
  }

  if (contentType !== "text/markdown" && !explicitlySupplied) {
    delete metadata.vaultLocator;
    return metadata;
  }

  const locator = normalizeKnowledgeVaultLocator(rawLocator, contentType);
  if (!locator) {
    throw new KnowledgeOperationError(
      "SOURCE_LOCATOR_INVALID",
      "Lokasi catatan harus berupa path Markdown relatif yang aman.",
    );
  }
  metadata.vaultLocator = locator;
  return validateSourceMetadata(metadata);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function splitKnowledgeText(content: string): TextChunk[] {
  const targetChars = 2_800;
  const minimumBoundary = 1_400;
  const result: TextChunk[] = [];
  let offset = 0;
  let heading: string | null = null;

  while (offset < content.length) {
    let end = Math.min(offset + targetChars, content.length);
    if (end < content.length) {
      const paragraph = content.lastIndexOf("\n\n", end);
      const line = content.lastIndexOf("\n", end);
      const boundary =
        paragraph >= offset + minimumBoundary ? paragraph + 2 : line + 1;
      if (boundary > offset + minimumBoundary && boundary < end) end = boundary;
    }
    if (end <= offset) end = Math.min(offset + targetChars, content.length);
    const chunkContent = content.slice(offset, end);
    const headings = [...chunkContent.matchAll(/^\s{0,3}#{1,6}\s+(.+)\s*$/gmu)];
    if (headings.length)
      heading = headings[0]?.[1]?.trim().slice(0, 500) ?? heading;
    result.push({ ordinal: result.length, content: chunkContent, heading });
    offset = end;
  }

  return result;
}

function knowledgeChunksForInput(
  content: string,
  input: Pick<KnowledgeSourceInput, "chunks" | "pages">,
): TextChunk[] {
  if (input.chunks && input.pages) {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Sumber tidak dapat memakai potongan umum dan halaman sekaligus.",
    );
  }
  if (input.pages) {
    if (
      input.pages.length < 1 ||
      input.pages.length > MAX_KNOWLEDGE_PDF_PAGES ||
      input.pages.some(
        (page, index) =>
          !Number.isSafeInteger(page.pageNumber) ||
          page.pageNumber !== index + 1 ||
          typeof page.content !== "string" ||
          !page.content.trim(),
      )
    ) {
      throw new KnowledgeOperationError(
        "SOURCE_PDF_PAGE_LIMIT",
        `PDF harus memiliki 1 sampai ${MAX_KNOWLEDGE_PDF_PAGES} halaman dengan teks yang terbaca.`,
      );
    }
    const pageJoined = input.pages.map((page) => page.content).join("\n\n");
    if (pageJoined !== content) {
      throw new KnowledgeOperationError(
        "SOURCE_CONTENT_INVALID",
        "Teks halaman PDF tidak cocok dengan isi sumber.",
      );
    }
    return input.pages
      .flatMap((page) =>
        splitKnowledgeText(page.content).map((chunk) => ({
          ...chunk,
          ordinal: 0,
          pageNumber: page.pageNumber,
        })),
      )
      .map((chunk, ordinal) => ({ ...chunk, ordinal }));
  }
  if (input.chunks) {
    const joined = input.chunks.map((chunk) => chunk.content).join("\n\n");
    if (
      input.chunks.length < 1 ||
      input.chunks.length > MAX_GRAPH_BUILD_CHUNKS ||
      joined !== content ||
      input.chunks.some(
        (chunk) =>
          !chunk.content.trim() ||
          (chunk.heading !== undefined &&
            chunk.heading !== null &&
            chunk.heading.length > 500) ||
          (chunk.pageNumber !== undefined &&
            chunk.pageNumber !== null &&
            (!Number.isSafeInteger(chunk.pageNumber) || chunk.pageNumber < 1)),
      )
    ) {
      throw new KnowledgeOperationError(
        "SOURCE_CONTENT_INVALID",
        "Potongan sumber tidak valid.",
      );
    }
    return input.chunks.map((chunk, ordinal) => ({
      ordinal,
      content: chunk.content,
      heading: chunk.heading?.trim() || null,
      pageNumber: chunk.pageNumber ?? null,
    }));
  }
  return splitKnowledgeText(content).map((chunk) => ({
    ...chunk,
    pageNumber: null,
  }));
}

interface SourceManifestRow extends Record<string, unknown> {
  documentId: string;
  documentVersionId: string;
  displayName: string;
  sourceKind: string;
  permission: SourcePermission;
  version: number;
  checksum: string;
  structuralFingerprint?: string;
  chunks: Array<{
    chunkId: string;
    ordinal: number;
    contentHash: string;
  }>;
}

async function loadSelectedSources(
  db: QueryDatabase,
  projectId: string,
  sourceIds: string[],
): Promise<{
  manifest: SourceManifestRow[];
  sourceSummaries: GraphBuildPreview["sources"];
}> {
  const uniqueIds = [...new Set(sourceIds)].sort();
  if (
    uniqueIds.length === 0 ||
    uniqueIds.length > MAX_GRAPH_BUILD_DOCUMENTS ||
    uniqueIds.length !== sourceIds.length
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_SELECTION_INVALID",
      "Pilih satu sampai dua puluh sumber yang berbeda.",
    );
  }
  const rows = await db
    .select({
      documentId: schema.documents.id,
      displayName: schema.documents.displayName,
      sourceKind: schema.documents.sourceKind,
      permission: schema.documents.trust,
      deletedAt: schema.documents.deletedAt,
      activeVersionId: schema.documents.activeVersionId,
      versionId: schema.documentVersions.id,
      version: schema.documentVersions.version,
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
        inArray(schema.documents.id, uniqueIds),
      ),
    );
  if (
    rows.length !== uniqueIds.length ||
    rows.some(
      (row) =>
        row.deletedAt ||
        !row.versionId ||
        !row.activeVersionId ||
        !row.eligible,
    )
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_SELECTION_INVALID",
      "Satu atau lebih sumber sudah tidak tersedia pada proyek ini.",
    );
  }

  const versionIds = rows.map((row) => row.versionId!);
  const chunkRows = await db
    .select({
      id: schema.chunks.id,
      projectId: schema.chunks.projectId,
      documentVersionId: schema.chunks.documentVersionId,
      ordinal: schema.chunks.ordinal,
      contentHash: schema.chunks.contentHash,
    })
    .from(schema.chunks)
    .where(
      and(
        eq(schema.chunks.projectId, projectId),
        inArray(schema.chunks.documentVersionId, versionIds),
      ),
    )
    .orderBy(asc(schema.chunks.documentVersionId), asc(schema.chunks.ordinal));

  const manifest = rows
    .sort((a, b) => a.documentId.localeCompare(b.documentId))
    .map((row) => {
      const chunks = chunkRows
        .filter((chunk) => chunk.documentVersionId === row.versionId)
        .map((chunk) => ({
          chunkId: chunk.id,
          ordinal: chunk.ordinal,
          contentHash: chunk.contentHash,
        }));
      return {
        documentId: row.documentId,
        documentVersionId: row.versionId!,
        displayName: row.displayName,
        sourceKind: row.sourceKind,
        permission:
          row.permission === "campus_indexer_allowed"
            ? "campus_indexer_allowed"
            : "local_only",
        version: row.version!,
        checksum: row.checksum!,
        chunks,
      } satisfies SourceManifestRow;
    });
  const totalChunks = manifest.reduce(
    (total, item) => total + item.chunks.length,
    0,
  );
  if (!totalChunks) {
    throw new KnowledgeOperationError(
      "SOURCE_SELECTION_INVALID",
      "Sumber terpilih belum memiliki chunk yang dapat dibangun.",
    );
  }

  return {
    manifest,
    sourceSummaries: manifest.map((item) => ({
      id: item.documentId,
      name: item.displayName,
      version: item.version,
      checksum: item.checksum,
      chunkCount: item.chunks.length,
    })),
  };
}

interface KnowledgeSourceWriteResult {
  sourceId: string;
  versionId: string;
  version: number;
  checksum: string;
  chunkCount: number;
  sourceRef: string | null;
  sourceMetadata: Record<string, unknown>;
  rawByteSha256: string | null;
  rawByteSize: number | null;
}

function storedSourceKind(kind: KnowledgeSourceInput["sourceKind"]): string {
  if (kind === "upload") return "text_upload";
  if (kind === "reference_pack") return "curated_reference";
  return "text_paste";
}

async function createKnowledgeSourceInTransaction(
  tx: QueryDatabase,
  input: KnowledgeSourceInput,
): Promise<KnowledgeSourceWriteResult> {
  const clean = validateKnowledgeText(input);
  const sourceRef = normalizeKnowledgeSourceRef(input.sourceRef);
  const sourceMetadata = sourceMetadataWithVaultLocator(
    input.sourceMetadata,
    input.vaultLocator,
    input.contentType,
  );
  const rawBytes = validateRawByteSnapshot(
    input.rawByteSha256,
    input.rawByteSize,
  );
  const checksum = checksumText(clean.content);
  const chunks = knowledgeChunksForInput(clean.content, input);

  const [project] = await tx
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        isNull(schema.projects.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!project) {
    throw new KnowledgeOperationError(
      "PROJECT_NOT_FOUND",
      "Proyek tidak tersedia.",
    );
  }
  const [document] = await tx
    .insert(schema.documents)
    .values({
      projectId: input.projectId,
      displayName: clean.displayName,
      sourceKind: storedSourceKind(input.sourceKind),
      trust: input.permission,
    })
    .returning({ id: schema.documents.id });
  if (!document) throw new Error("Source insert returned no row");
  const [version] = await tx
    .insert(schema.documentVersions)
    .values({
      projectId: input.projectId,
      documentId: document.id,
      version: 1,
      sourceRef,
      sourceMetadata,
      checksum,
      ...rawBytes,
      contentType: input.contentType,
      eligible: true,
      extractStatus: "ready",
      wordCount: clean.content.trim().split(/\s+/u).length,
    })
    .returning({
      id: schema.documentVersions.id,
      version: schema.documentVersions.version,
    });
  if (!version) throw new Error("Source version insert returned no row");
  await tx.insert(schema.chunks).values(
    chunks.map((chunk) => ({
      projectId: input.projectId,
      documentVersionId: version.id,
      ordinal: chunk.ordinal,
      content: chunk.content,
      heading: chunk.heading,
      pageNumber: chunk.pageNumber ?? null,
      contentHash: checksumText(chunk.content),
      tokenEstimate: Math.ceil(chunk.content.length / 4),
      searchVector: sql`to_tsvector('simple', ${chunk.content})`,
    })),
  );
  await tx
    .update(schema.documents)
    .set({ activeVersionId: version.id, updatedAt: new Date() })
    .where(
      and(
        eq(schema.documents.projectId, input.projectId),
        eq(schema.documents.id, document.id),
      ),
    );
  if (input.permission === "campus_indexer_allowed") {
    await enqueueKnowledgeEmbedding(
      tx,
      input.projectId,
      document.id,
      version.id,
    );
  }
  return {
    sourceId: document.id,
    versionId: version.id,
    version: version.version,
    checksum,
    chunkCount: chunks.length,
    sourceRef,
    sourceMetadata,
    ...rawBytes,
  };
}

export async function createKnowledgeSource(
  db: Database,
  input: KnowledgeSourceInput,
): Promise<KnowledgeSourceWriteResult> {
  return db.transaction((tx) => createKnowledgeSourceInTransaction(tx, input));
}

async function invalidateEvidenceForVersions(
  tx: QueryDatabase,
  projectId: string,
  versionIds: string[],
): Promise<void> {
  if (!versionIds.length) return;
  await tx
    .update(schema.graphEvidence)
    .set({ eligible: false })
    .where(
      and(
        eq(schema.graphEvidence.projectId, projectId),
        inArray(schema.graphEvidence.documentVersionId, versionIds),
      ),
    );
}

async function purgeKnowledgeEmbeddingsForVersions(
  tx: QueryDatabase,
  projectId: string,
  versionIds: string[],
): Promise<void> {
  if (!versionIds.length) return;
  await tx
    .delete(schema.knowledgeChunkEmbeddings)
    .where(
      and(
        eq(schema.knowledgeChunkEmbeddings.projectId, projectId),
        inArray(schema.knowledgeChunkEmbeddings.documentVersionId, versionIds),
      ),
    );
}

async function enqueueKnowledgeEmbedding(
  tx: QueryDatabase,
  projectId: string,
  sourceId: string,
  documentVersionId: string,
): Promise<void> {
  await tx.insert(schema.outbox).values({
    projectId,
    aggregateId: sourceId,
    eventType: "knowledge.embedding.enqueue",
    payload: { projectId, sourceId, documentVersionId },
  });
}

async function staleActiveGraphSnapshot(
  tx: QueryDatabase,
  projectId: string,
): Promise<void> {
  const [active] = await tx
    .select({ snapshotId: schema.graphActiveSnapshots.snapshotId })
    .from(schema.graphActiveSnapshots)
    .where(eq(schema.graphActiveSnapshots.projectId, projectId))
    .for("update");
  if (!active) return;
  await tx
    .update(schema.graphSnapshots)
    .set({ state: "stale" })
    .where(
      and(
        eq(schema.graphSnapshots.projectId, projectId),
        eq(schema.graphSnapshots.id, active.snapshotId),
        eq(schema.graphSnapshots.state, "active"),
      ),
    );
}

export async function replaceKnowledgeSource(
  db: Database,
  input: KnowledgeSourceInput & { sourceId: string },
): Promise<KnowledgeSourceWriteResult> {
  return db.transaction((tx) => replaceKnowledgeSourceInTransaction(tx, input));
}

async function replaceKnowledgeSourceInTransaction(
  tx: QueryDatabase,
  input: KnowledgeSourceInput & { sourceId: string },
): Promise<KnowledgeSourceWriteResult> {
  const clean = validateKnowledgeText(input);
  const checksum = checksumText(clean.content);
  const chunks = knowledgeChunksForInput(clean.content, input);

  const [document] = await tx
    .select({
      id: schema.documents.id,
      sourceKind: schema.documents.sourceKind,
      activeVersionId: schema.documents.activeVersionId,
      deletedAt: schema.documents.deletedAt,
      trust: schema.documents.trust,
    })
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.projectId, input.projectId),
        eq(schema.documents.id, input.sourceId),
      ),
    )
    .for("update");
  if (!document || document.deletedAt) {
    throw new KnowledgeOperationError(
      "SOURCE_NOT_FOUND",
      "Sumber tidak tersedia.",
    );
  }
  const [current] = document.activeVersionId
    ? await tx
        .select({
          id: schema.documentVersions.id,
          version: schema.documentVersions.version,
          sourceRef: schema.documentVersions.sourceRef,
          sourceMetadata: schema.documentVersions.sourceMetadata,
          checksum: schema.documentVersions.checksum,
          rawByteSha256: schema.documentVersions.rawByteSha256,
          rawByteSize: schema.documentVersions.rawByteSize,
          contentType: schema.documentVersions.contentType,
        })
        .from(schema.documentVersions)
        .where(
          and(
            eq(schema.documentVersions.projectId, input.projectId),
            eq(schema.documentVersions.id, document.activeVersionId),
          ),
        )
        .limit(1)
    : [];
  const sourceRef =
    input.sourceRef === undefined
      ? (current?.sourceRef ?? null)
      : normalizeKnowledgeSourceRef(input.sourceRef);
  const sourceMetadata = sourceMetadataWithVaultLocator(
    input.sourceMetadata === undefined
      ? current?.sourceMetadata
      : input.sourceMetadata,
    input.vaultLocator,
    input.contentType,
  );
  const rawBytes = validateRawByteSnapshot(
    input.rawByteSha256 === undefined
      ? current?.rawByteSha256
      : input.rawByteSha256,
    input.rawByteSize === undefined ? current?.rawByteSize : input.rawByteSize,
  );
  if (
    document.trust !== input.permission &&
    input.permission === "local_only"
  ) {
    if (document.activeVersionId) {
      await invalidateEvidenceForVersions(tx, input.projectId, [
        document.activeVersionId,
      ]);
    }
    await staleActiveGraphSnapshot(tx, input.projectId);
  }
  const versionContentChanged =
    current?.checksum !== checksum ||
    current?.sourceRef !== sourceRef ||
    stableJson(current?.sourceMetadata ?? {}) !== stableJson(sourceMetadata) ||
    current?.contentType !== input.contentType ||
    current?.rawByteSha256 !== rawBytes.rawByteSha256 ||
    current?.rawByteSize !== rawBytes.rawByteSize;
  if (current && !versionContentChanged) {
    await tx
      .update(schema.documents)
      .set({
        displayName: clean.displayName,
        sourceKind: storedSourceKind(input.sourceKind),
        trust: input.permission,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.documents.projectId, input.projectId),
          eq(schema.documents.id, input.sourceId),
        ),
      );
    if (
      document.trust !== input.permission &&
      input.permission === "local_only" &&
      document.activeVersionId
    ) {
      await purgeKnowledgeEmbeddingsForVersions(tx, input.projectId, [
        document.activeVersionId,
      ]);
    }
    if (
      document.trust !== input.permission &&
      input.permission === "campus_indexer_allowed"
    ) {
      await enqueueKnowledgeEmbedding(
        tx,
        input.projectId,
        input.sourceId,
        current.id,
      );
    }
    return {
      sourceId: input.sourceId,
      versionId: current.id,
      version: current.version,
      checksum,
      chunkCount: chunks.length,
      sourceRef,
      sourceMetadata,
      ...rawBytes,
    };
  }
  const oldVersionIds = document.activeVersionId
    ? [document.activeVersionId]
    : [];
  if (oldVersionIds.length) {
    await tx
      .update(schema.documentVersions)
      .set({ eligible: false, retiredAt: new Date() })
      .where(
        and(
          eq(schema.documentVersions.projectId, input.projectId),
          inArray(schema.documentVersions.id, oldVersionIds),
        ),
      );
    await purgeKnowledgeEmbeddingsForVersions(
      tx,
      input.projectId,
      oldVersionIds,
    );
    await invalidateEvidenceForVersions(tx, input.projectId, oldVersionIds);
  }
  const [version] = await tx
    .insert(schema.documentVersions)
    .values({
      projectId: input.projectId,
      documentId: input.sourceId,
      version: (current?.version ?? 0) + 1,
      sourceRef,
      sourceMetadata,
      checksum,
      ...rawBytes,
      contentType: input.contentType,
      eligible: true,
      extractStatus: "ready",
      wordCount: clean.content.trim().split(/\s+/u).length,
    })
    .returning({
      id: schema.documentVersions.id,
      version: schema.documentVersions.version,
    });
  if (!version) throw new Error("Source version insert returned no row");
  await tx.insert(schema.chunks).values(
    chunks.map((chunk) => ({
      projectId: input.projectId,
      documentVersionId: version.id,
      ordinal: chunk.ordinal,
      content: chunk.content,
      heading: chunk.heading,
      pageNumber: chunk.pageNumber ?? null,
      contentHash: checksumText(chunk.content),
      tokenEstimate: Math.ceil(chunk.content.length / 4),
      searchVector: sql`to_tsvector('simple', ${chunk.content})`,
    })),
  );
  await tx
    .update(schema.documents)
    .set({
      displayName: clean.displayName,
      sourceKind: storedSourceKind(input.sourceKind),
      trust: input.permission,
      activeVersionId: version.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.documents.projectId, input.projectId),
        eq(schema.documents.id, input.sourceId),
      ),
    );
  if (input.permission === "campus_indexer_allowed") {
    await enqueueKnowledgeEmbedding(
      tx,
      input.projectId,
      input.sourceId,
      version.id,
    );
  }
  return {
    sourceId: input.sourceId,
    versionId: version.id,
    version: version.version,
    checksum,
    chunkCount: chunks.length,
    sourceRef,
    sourceMetadata,
    ...rawBytes,
  };
}

export async function deleteKnowledgeSource(
  db: Database,
  projectId: string,
  sourceId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [document] = await tx
      .select({
        id: schema.documents.id,
        activeVersionId: schema.documents.activeVersionId,
        deletedAt: schema.documents.deletedAt,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.projectId, projectId),
          eq(schema.documents.id, sourceId),
        ),
      )
      .for("update");
    if (!document)
      throw new KnowledgeOperationError(
        "SOURCE_NOT_FOUND",
        "Sumber tidak tersedia.",
      );
    if (document.deletedAt) return;
    const sourceVersions = await tx
      .select({ id: schema.documentVersions.id })
      .from(schema.documentVersions)
      .where(
        and(
          eq(schema.documentVersions.projectId, projectId),
          eq(schema.documentVersions.documentId, sourceId),
        ),
      );
    const versionIds = sourceVersions.map((version) => version.id);
    if (versionIds.length) {
      await tx
        .update(schema.documentVersions)
        .set({ eligible: false, retiredAt: new Date() })
        .where(
          and(
            eq(schema.documentVersions.projectId, projectId),
            inArray(schema.documentVersions.id, versionIds),
          ),
        );
      await invalidateEvidenceForVersions(tx, projectId, versionIds);
      await purgeKnowledgeEmbeddingsForVersions(tx, projectId, versionIds);
    }
    await tx
      .update(schema.documents)
      .set({
        deletedAt: new Date(),
        activeVersionId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.documents.projectId, projectId),
          eq(schema.documents.id, sourceId),
        ),
      );
  });
}

export async function setKnowledgeSourcePermission(
  db: Database,
  projectId: string,
  sourceId: string,
  permission: SourcePermission,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [document] = await tx
      .select({
        id: schema.documents.id,
        activeVersionId: schema.documents.activeVersionId,
        deletedAt: schema.documents.deletedAt,
        trust: schema.documents.trust,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.projectId, projectId),
          eq(schema.documents.id, sourceId),
        ),
      )
      .for("update");
    if (!document || document.deletedAt)
      throw new KnowledgeOperationError(
        "SOURCE_NOT_FOUND",
        "Sumber tidak tersedia.",
      );
    if (document.trust === permission) return;
    if (permission === "local_only" && document.activeVersionId) {
      await purgeKnowledgeEmbeddingsForVersions(tx, projectId, [
        document.activeVersionId,
      ]);
      await invalidateEvidenceForVersions(tx, projectId, [
        document.activeVersionId,
      ]);
      await staleActiveGraphSnapshot(tx, projectId);
    }
    await tx
      .update(schema.documents)
      .set({ trust: permission, updatedAt: new Date() })
      .where(
        and(
          eq(schema.documents.projectId, projectId),
          eq(schema.documents.id, sourceId),
        ),
      );
    if (permission === "campus_indexer_allowed" && document.activeVersionId) {
      await enqueueKnowledgeEmbedding(
        tx,
        projectId,
        sourceId,
        document.activeVersionId,
      );
    }
  });
}

async function loadActiveKnowledgeMarkdownNoteHeaders(
  db: QueryDatabase,
  projectId: string,
): Promise<KnowledgeMarkdownStructureNote[]> {
  const rows = await db
    .select({
      documentId: schema.documents.id,
      documentVersionId: schema.documentVersions.id,
      displayName: schema.documents.displayName,
      permission: schema.documents.trust,
      sourceMetadata: schema.documentVersions.sourceMetadata,
      checksum: schema.documentVersions.checksum,
      contentType: schema.documentVersions.contentType,
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
        isNull(schema.documents.deletedAt),
        eq(schema.documentVersions.contentType, "text/markdown"),
        eq(schema.documentVersions.eligible, true),
        sql`${schema.documentVersions.sourceMetadata} ? 'vaultLocator'`,
      ),
    )
    .orderBy(asc(schema.documents.id));

  return rows.flatMap((row) => {
    const sourceMetadata = row.sourceMetadata;
    const metadata =
      sourceMetadata &&
      typeof sourceMetadata === "object" &&
      !Array.isArray(sourceMetadata)
        ? (sourceMetadata as Record<string, unknown>)
        : {};
    const locator = normalizeKnowledgeVaultLocator(
      metadata.vaultLocator,
      row.contentType,
    );
    if (!locator) return [];
    return [
      {
        documentId: row.documentId,
        documentVersionId: row.documentVersionId,
        displayName: row.displayName,
        checksum: row.checksum,
        permission: row.permission,
        locator,
        chunks: [],
      },
    ];
  });
}

export interface KnowledgeMarkdownStructureSnapshot {
  fingerprint: string;
  links: KnowledgeMarkdownStructuralLinkRecord[];
}

export async function getActiveKnowledgeMarkdownFingerprint(
  db: QueryDatabase,
  projectId: string,
): Promise<string> {
  const notes = await loadActiveKnowledgeMarkdownNoteHeaders(db, projectId);
  return knowledgeMarkdownNoteSetFingerprint(notes);
}

export async function getActiveKnowledgeMarkdownStructure(
  db: QueryDatabase,
  projectId: string,
): Promise<KnowledgeMarkdownStructureSnapshot> {
  const notes = await loadActiveKnowledgeMarkdownNoteHeaders(db, projectId);
  if (!notes.length) {
    return {
      fingerprint: knowledgeMarkdownNoteSetFingerprint(notes),
      links: [],
    };
  }

  const noteByVersion = new Map(
    notes.map((note) => [note.documentVersionId, note]),
  );
  const chunks = await db
    .select({
      documentVersionId: schema.chunks.documentVersionId,
      chunkId: schema.chunks.id,
      ordinal: schema.chunks.ordinal,
      content: schema.chunks.content,
    })
    .from(schema.chunks)
    .where(
      and(
        eq(schema.chunks.projectId, projectId),
        inArray(schema.chunks.documentVersionId, [...noteByVersion.keys()]),
      ),
    )
    .orderBy(asc(schema.chunks.documentVersionId), asc(schema.chunks.ordinal));
  for (const chunk of chunks) {
    noteByVersion.get(chunk.documentVersionId)?.chunks.push({
      chunkId: chunk.chunkId,
      ordinal: chunk.ordinal,
      content: chunk.content,
    });
  }

  return {
    fingerprint: knowledgeMarkdownNoteSetFingerprint(notes),
    links: resolveKnowledgeMarkdownStructure(notes),
  };
}

export async function listKnowledgeSources(
  db: QueryDatabase,
  projectId: string,
) {
  const documents = await db
    .select({
      id: schema.documents.id,
      displayName: schema.documents.displayName,
      sourceKind: schema.documents.sourceKind,
      permission: schema.documents.trust,
      activeVersionId: schema.documents.activeVersionId,
      updatedAt: schema.documents.updatedAt,
      deletedAt: schema.documents.deletedAt,
    })
    .from(schema.documents)
    .where(eq(schema.documents.projectId, projectId))
    .orderBy(desc(schema.documents.updatedAt))
    .limit(100);
  const versionIds = documents.flatMap((item) => item.activeVersionId ?? []);
  const versions = versionIds.length
    ? await db
        .select({
          id: schema.documentVersions.id,
          version: schema.documentVersions.version,
          sourceRef: schema.documentVersions.sourceRef,
          sourceMetadata: schema.documentVersions.sourceMetadata,
          checksum: schema.documentVersions.checksum,
          eligible: schema.documentVersions.eligible,
          contentType: schema.documentVersions.contentType,
          wordCount: schema.documentVersions.wordCount,
          extractStatus: schema.documentVersions.extractStatus,
        })
        .from(schema.documentVersions)
        .where(
          and(
            eq(schema.documentVersions.projectId, projectId),
            inArray(schema.documentVersions.id, versionIds),
          ),
        )
    : [];
  const chunkCounts = versionIds.length
    ? await db
        .select({
          versionId: schema.chunks.documentVersionId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.chunks)
        .where(
          and(
            eq(schema.chunks.projectId, projectId),
            inArray(schema.chunks.documentVersionId, versionIds),
          ),
        )
        .groupBy(schema.chunks.documentVersionId)
    : [];
  const versionById = new Map(versions.map((item) => [item.id, item]));
  const chunksByVersion = new Map(
    chunkCounts.map((item) => [item.versionId, item.count]),
  );
  return documents.map((document) => {
    const version = document.activeVersionId
      ? versionById.get(document.activeVersionId)
      : undefined;
    return {
      id: document.id,
      displayName: document.displayName,
      sourceKind: document.sourceKind,
      permission:
        document.permission === "campus_indexer_allowed"
          ? "campus_indexer_allowed"
          : "local_only",
      updatedAt: document.updatedAt,
      deleted: Boolean(document.deletedAt),
      version: version?.version ?? null,
      versionId: version?.id ?? null,
      sourceRef: version?.sourceRef ?? null,
      sourceMetadata: version?.sourceMetadata ?? {},
      checksum: version?.checksum ?? null,
      eligible: Boolean(version?.eligible && !document.deletedAt),
      contentType: version?.contentType ?? null,
      wordCount: version?.wordCount ?? null,
      extractStatus: version?.extractStatus ?? "deleted",
      chunkCount: version ? (chunksByVersion.get(version.id) ?? 0) : 0,
    };
  });
}

export async function getKnowledgeSource(
  db: QueryDatabase,
  projectId: string,
  sourceId: string,
) {
  const [row] = await db
    .select({
      id: schema.documents.id,
      displayName: schema.documents.displayName,
      sourceKind: schema.documents.sourceKind,
      permission: schema.documents.trust,
      updatedAt: schema.documents.updatedAt,
      versionId: schema.documentVersions.id,
      version: schema.documentVersions.version,
      sourceRef: schema.documentVersions.sourceRef,
      sourceMetadata: schema.documentVersions.sourceMetadata,
      checksum: schema.documentVersions.checksum,
      contentType: schema.documentVersions.contentType,
      eligible: schema.documentVersions.eligible,
      extractStatus: schema.documentVersions.extractStatus,
      wordCount: schema.documentVersions.wordCount,
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
        eq(schema.documents.id, sourceId),
        isNull(schema.documents.deletedAt),
        eq(schema.documentVersions.eligible, true),
      ),
    )
    .limit(1);
  if (!row) {
    throw new KnowledgeOperationError(
      "SOURCE_NOT_FOUND",
      "Sumber tidak tersedia.",
    );
  }
  const chunks = await db
    .select({
      id: schema.chunks.id,
      ordinal: schema.chunks.ordinal,
      content: schema.chunks.content,
      heading: schema.chunks.heading,
      pageNumber: schema.chunks.pageNumber,
      contentHash: schema.chunks.contentHash,
    })
    .from(schema.chunks)
    .where(
      and(
        eq(schema.chunks.projectId, projectId),
        eq(schema.chunks.documentVersionId, row.versionId),
      ),
    )
    .orderBy(asc(schema.chunks.ordinal))
    .limit(MAX_GRAPH_BUILD_CHUNKS);
  return {
    ...row,
    permission:
      row.permission === "campus_indexer_allowed"
        ? "campus_indexer_allowed"
        : "local_only",
    chunks,
  };
}

function validatedReferencePack(): PackagedReferencePack {
  const pack = packagedReferencePack;
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  const chunkIds = new Set(pack.chunks.map((chunk) => chunk.id));
  const bounds = pack.scope.bounds as Record<string, unknown> | undefined;
  if (
    pack.schema_version !== "1.0" ||
    pack.sources.length !== 9 ||
    pack.chunks.length !== 10 ||
    pack.graph.edges.length !== 15 ||
    bounds?.source_count !== 9 ||
    bounds?.chunk_count !== 10 ||
    pack.chunks.some(
      (chunk) =>
        !sourceIds.has(chunk.source_id) ||
        chunk.summary.trim().split(/\s+/u).length > 140,
    ) ||
    pack.graph.edges.some((edge) => {
      const ids = edge.evidence_chunk_ids;
      return (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.some((id) => typeof id !== "string" || !chunkIds.has(id))
      );
    })
  ) {
    throw new KnowledgeOperationError(
      "REFERENCE_PACK_INVALID",
      "Paket referensi terkurasi tidak lolos pemeriksaan provenance.",
    );
  }
  return pack;
}

export function getKnowledgeReferencePack() {
  const pack = validatedReferencePack();
  return {
    metadata: {
      schema_version: pack.schema_version,
      corpus_id: pack.corpus_id,
      status: "ready_local_only",
      source_snapshot_at_utc: pack.source_snapshot_at_utc,
      scope: pack.scope,
    },
    publicSources: pack.sources.map((source) => ({ ...source })),
    previews: pack.chunks.map((chunk) => ({ ...chunk })),
  };
}

function referenceSourceInput(
  projectId: string,
  source: ReferencePackSource,
  chunks: ReferencePackChunk[],
): KnowledgeSourceInput {
  const knowledgeChunks = chunks.map((chunk) => ({
    heading: chunk.topic,
    content: `${chunk.summary}\n\nEvidence excerpt: “${chunk.evidence_excerpt}”\n\nSource section: ${chunk.source_section}\nClaim type: ${chunk.claim_type}`,
  }));
  const sourceMetadata: Record<string, unknown> = {
    corpus_id: packagedReferencePack.corpus_id,
    corpus_schema_version: packagedReferencePack.schema_version,
    source_id: source.id,
    title: source.title,
    publisher: source.publisher,
    accessed_at_utc: source.accessed_at_utc,
    source_type: source.source_type,
    sections_used: source.sections_used,
    license_caveat: source.license_caveat,
    temporal_caveat: source.temporal_caveat ?? null,
    version_observed: source.version_observed ?? null,
  };
  return {
    projectId,
    displayName: source.title,
    content: knowledgeChunks.map((chunk) => chunk.content).join("\n\n"),
    contentType: "text/markdown",
    sourceKind: "reference_pack",
    permission: "local_only",
    sourceRef: source.url,
    sourceMetadata,
    chunks: knowledgeChunks,
  };
}

export async function importKnowledgeReferencePack(
  db: Database,
  projectId: string,
  permission: "local_only",
): Promise<{
  imported: number;
  skipped: number;
  documentIds: string[];
  packId: string;
}> {
  if (permission !== "local_only") {
    throw new KnowledgeOperationError(
      "SOURCE_PERMISSION_REQUIRED",
      "Paket referensi hanya dapat diimpor sebagai local-only.",
    );
  }
  const pack = validatedReferencePack();
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          isNull(schema.projects.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!project) {
      throw new KnowledgeOperationError(
        "PROJECT_NOT_FOUND",
        "Proyek tidak tersedia.",
      );
    }

    let imported = 0;
    let skipped = 0;
    const documentIds: string[] = [];
    for (const source of pack.sources) {
      const sourceRef = normalizeKnowledgeSourceRef(source.url);
      if (!sourceRef) {
        throw new KnowledgeOperationError(
          "REFERENCE_PACK_INVALID",
          "Paket referensi memiliki URL sumber yang tidak valid.",
        );
      }
      const sourceChunks = pack.chunks.filter(
        (chunk) => chunk.source_id === source.id,
      );
      const input = referenceSourceInput(projectId, source, sourceChunks);
      const matchingRows = await tx
        .select({
          documentId: schema.documents.id,
          sourceKind: schema.documents.sourceKind,
          displayName: schema.documents.displayName,
          trust: schema.documents.trust,
          deletedAt: schema.documents.deletedAt,
          activeVersionId: schema.documents.activeVersionId,
          versionId: schema.documentVersions.id,
          version: schema.documentVersions.version,
          sourceRef: schema.documentVersions.sourceRef,
          sourceMetadata: schema.documentVersions.sourceMetadata,
          checksum: schema.documentVersions.checksum,
          contentType: schema.documentVersions.contentType,
        })
        .from(schema.documents)
        .innerJoin(
          schema.documentVersions,
          and(
            eq(schema.documentVersions.projectId, schema.documents.projectId),
            eq(schema.documentVersions.documentId, schema.documents.id),
          ),
        )
        .where(
          and(
            eq(schema.documents.projectId, projectId),
            eq(schema.documentVersions.sourceRef, sourceRef),
          ),
        )
        .orderBy(desc(schema.documentVersions.version));
      const documentRows = new Map<string, (typeof matchingRows)[number]>();
      for (const row of matchingRows) {
        if (!documentRows.has(row.documentId))
          documentRows.set(row.documentId, row);
      }
      const allSourceRows = [...documentRows.values()];
      const ownedRows = allSourceRows.filter((row) => {
        const metadata = row.sourceMetadata ?? {};
        return (
          row.sourceKind === "curated_reference" &&
          metadata.corpus_id === pack.corpus_id &&
          metadata.source_id === source.id
        );
      });
      const existing = ownedRows.find(
        (row) => row.versionId === row.activeVersionId,
      );
      if (ownedRows.length === 0 && allSourceRows.length > 0) {
        skipped += 1;
        continue;
      }
      if (existing?.deletedAt) {
        skipped += 1;
        continue;
      }
      if (existing) {
        const expectedChecksum = checksumText(input.content);
        const expectedMetadata = validateSourceMetadata(input.sourceMetadata);
        const unchanged =
          existing.sourceRef === sourceRef &&
          existing.checksum === expectedChecksum &&
          existing.contentType === input.contentType &&
          stableJson(existing.sourceMetadata) ===
            stableJson(expectedMetadata) &&
          existing.displayName === input.displayName &&
          existing.trust === "local_only";
        if (unchanged) {
          skipped += 1;
          documentIds.push(existing.documentId);
          continue;
        }
        const result = await replaceKnowledgeSourceInTransaction(tx, {
          ...input,
          sourceId: existing.documentId,
        });
        imported += 1;
        documentIds.push(result.sourceId);
        continue;
      }
      if (ownedRows.length > 0) {
        skipped += 1;
        continue;
      }
      const result = await createKnowledgeSourceInTransaction(tx, input);
      imported += 1;
      documentIds.push(result.sourceId);
    }
    return {
      imported,
      skipped,
      documentIds: [...new Set(documentIds)],
      packId: pack.corpus_id,
    };
  });
}

export async function previewGraphBuild(
  db: QueryDatabase,
  projectId: string,
  selection: GraphBuildSelection,
  providerInput: { keyConfigured: boolean; environmentModel: string | null },
): Promise<GraphBuildPreview> {
  const { manifest, sourceSummaries } = await loadSelectedSources(
    db,
    projectId,
    selection.sourceIds,
  );
  const structuralFingerprint = await getActiveKnowledgeMarkdownFingerprint(
    db,
    projectId,
  );
  const sourceManifest = manifest.map((source) => ({
    ...source,
    structuralFingerprint,
  }));
  const chunkCount = manifest.reduce(
    (total, item) => total + item.chunks.length,
    0,
  );
  if (chunkCount > MAX_GRAPH_BUILD_CHUNKS) {
    throw new KnowledgeOperationError(
      "SOURCE_CHUNK_LIMIT",
      `Build dibatasi ${MAX_GRAPH_BUILD_CHUNKS} chunk; kurangi sumber terpilih.`,
      { maxChunks: MAX_GRAPH_BUILD_CHUNKS, selectedChunks: chunkCount },
    );
  }
  if (manifest.some((item) => item.permission !== "campus_indexer_allowed")) {
    throw new KnowledgeOperationError(
      "SOURCE_PERMISSION_REQUIRED",
      "Setiap sumber harus mengizinkan campus indexer sebelum build.",
    );
  }

  const [connection] = await db
    .select({
      status: schema.providerConnections.connectionStatus,
      model: schema.providerConnections.requestedModel,
    })
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.projectId, projectId),
        eq(schema.providerConnections.provider, "campus_gateway"),
        eq(schema.providerConnections.role, "optimizer"),
      ),
    )
    .limit(1);
  const requestedModel =
    selection.requestedModel?.trim() || providerInput.environmentModel;
  const providerReady = Boolean(
    providerInput.keyConfigured &&
    requestedModel &&
    connection?.status === "verified" &&
    connection.model === requestedModel &&
    providerInput.environmentModel === requestedModel,
  );
  const providerReason = !providerInput.keyConfigured
    ? "Campus gateway credential belum tersedia."
    : !providerInput.environmentModel
      ? "Campus model belum dikonfigurasi."
      : !connection
        ? "Koneksi campus optimizer belum disimpan untuk proyek ini."
        : connection.status !== "verified"
          ? "Koneksi campus optimizer belum diverifikasi."
          : connection.model !== requestedModel ||
              providerInput.environmentModel !== requestedModel
            ? "Model pada koneksi berbeda dari model gateway yang aktif."
            : null;
  const maxModelCalls = Math.min(MAX_GRAPH_BUILD_CALLS, chunkCount * 2);
  const minModelCalls = chunkCount;
  const selectedMaxModelCalls = selection.maxModelCalls ?? minModelCalls;
  if (
    selectedMaxModelCalls < minModelCalls ||
    selectedMaxModelCalls > maxModelCalls
  ) {
    throw new KnowledgeOperationError(
      "MODEL_BUDGET_INVALID",
      `Anggaran panggilan harus antara ${minModelCalls} dan ${maxModelCalls}.`,
      { minModelCalls, maxModelCalls },
    );
  }
  const sourceManifestHash = checksumText(stableJson(sourceManifest));
  return {
    ready: providerReady,
    projectId,
    sourceCount: manifest.length,
    chunkCount,
    sources: sourceSummaries,
    requestedModel,
    providerReady,
    providerReason,
    minModelCalls,
    maxModelCalls,
    selectedMaxModelCalls,
    sourceManifest,
    sourceManifestHash,
  };
}

export async function enqueueGraphBuild(
  db: Database,
  input: GraphBuildSelection & {
    projectId: string;
    requestedModel: string;
    maxModelCalls: number;
    idempotencyKey: string;
    allowCampusEgress: true;
    providerConnectionId: string;
  },
): Promise<{
  buildId: string;
  runId: string;
  state: "queued";
  created: boolean;
}> {
  if (!input.allowCampusEgress) {
    throw new KnowledgeOperationError(
      "SOURCE_PERMISSION_REQUIRED",
      "Campus egress harus disetujui secara eksplisit.",
    );
  }
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          isNull(schema.projects.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!project)
      throw new KnowledgeOperationError(
        "PROJECT_NOT_FOUND",
        "Proyek tidak tersedia.",
      );

    const preview = await previewGraphBuild(tx, input.projectId, input, {
      keyConfigured: true,
      environmentModel: input.requestedModel,
    });
    if (!preview.providerReady) {
      throw new KnowledgeOperationError(
        "PROVIDER_UNAVAILABLE",
        preview.providerReason ?? "Campus indexer belum siap.",
      );
    }
    const [connection] = await tx
      .select({
        id: schema.providerConnections.id,
        status: schema.providerConnections.connectionStatus,
        model: schema.providerConnections.requestedModel,
      })
      .from(schema.providerConnections)
      .where(
        and(
          eq(schema.providerConnections.projectId, input.projectId),
          eq(schema.providerConnections.id, input.providerConnectionId),
          eq(schema.providerConnections.provider, "campus_gateway"),
          eq(schema.providerConnections.role, "optimizer"),
        ),
      )
      .limit(1);
    if (
      !connection ||
      connection.status !== "verified" ||
      connection.model !== input.requestedModel
    ) {
      throw new KnowledgeOperationError(
        "PROVIDER_UNAVAILABLE",
        "Koneksi campus indexer berubah sebelum enqueue.",
      );
    }

    const [existing] = await tx
      .select({
        id: schema.graphBuilds.id,
        budget: schema.graphBuilds.budget,
        sourceManifestHash: schema.graphBuilds.sourceManifestHash,
        state: schema.graphBuilds.state,
      })
      .from(schema.graphBuilds)
      .where(
        and(
          eq(schema.graphBuilds.projectId, input.projectId),
          sql`${schema.graphBuilds.budget}->>'idempotencyKey' = ${input.idempotencyKey}`,
        ),
      )
      .limit(1);
    if (existing) {
      const stored = existing.budget;
      if (
        existing.sourceManifestHash !== preview.sourceManifestHash ||
        stored.maxModelCalls !== input.maxModelCalls ||
        stored.requestedModel !== input.requestedModel
      ) {
        throw new KnowledgeOperationError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key sudah dipakai untuk build berbeda.",
        );
      }
      if (typeof stored.runId !== "string")
        throw new Error("Existing graph build has no run identity");
      return {
        buildId: existing.id,
        runId: stored.runId,
        state: "queued",
        created: false,
      };
    }

    const [inFlight] = await tx
      .select({ id: schema.graphBuilds.id, state: schema.graphBuilds.state })
      .from(schema.graphBuilds)
      .where(
        and(
          eq(schema.graphBuilds.projectId, input.projectId),
          inArray(schema.graphBuilds.state, [
            "queued",
            "extracting",
            "validating",
            "ready_to_activate",
          ]),
          eq(schema.graphBuilds.sourceManifestHash, preview.sourceManifestHash),
        ),
      )
      .orderBy(desc(schema.graphBuilds.requestedAt))
      .limit(1);
    if (inFlight) {
      throw new KnowledgeOperationError(
        "BUILD_ALREADY_ACTIVE",
        "Build yang sama sedang berjalan.",
        { buildId: inFlight.id, state: inFlight.state },
      );
    }

    const [build] = await tx
      .insert(schema.graphBuilds)
      .values({
        projectId: input.projectId,
        sourceManifest: preview.sourceManifest,
        sourceManifestHash: preview.sourceManifestHash,
        extractorProvider: "campus_gateway",
        extractorModel: input.requestedModel,
        extractionPromptVersion: "promptlab-campus-extraction-v1",
        extractionSchemaVersion: "promptlab-graph-extraction-v1",
        state: "queued",
        budget: {
          idempotencyKey: input.idempotencyKey,
          sourceIds: input.sourceIds,
          maxModelCalls: input.maxModelCalls,
          maxRepairPerChunk: 1,
          maxCallsPerChunk: 2,
          callsUsed: 0,
          spanCorrections: { entities: 0, relations: 0 },
          completedChunks: [],
          failedChunks: [],
          allowCampusEgress: true,
          requestedModel: input.requestedModel,
        },
      })
      .returning({ id: schema.graphBuilds.id });
    if (!build) throw new Error("Graph build insert returned no row");
    const [run] = await tx
      .insert(schema.runs)
      .values({
        projectId: input.projectId,
        providerConnectionId: connection.id,
        purpose: "graph_indexing",
        provider: "campus_gateway",
        requestedModel: input.requestedModel,
        status: "queued",
        idempotencyKey: `graph-build:${build.id}`,
        configSnapshot: {
          buildId: build.id,
          sourceManifestHash: preview.sourceManifestHash,
          maxModelCalls: input.maxModelCalls,
          retrieval: null,
        },
      })
      .returning({ id: schema.runs.id });
    if (!run) throw new Error("Graph build run insert returned no row");
    await tx
      .update(schema.graphBuilds)
      .set({
        budget: {
          ...{
            idempotencyKey: input.idempotencyKey,
            sourceIds: input.sourceIds,
            maxModelCalls: input.maxModelCalls,
            maxRepairPerChunk: 1,
            maxCallsPerChunk: 2,
            callsUsed: 0,
            spanCorrections: { entities: 0, relations: 0 },
            completedChunks: [],
            failedChunks: [],
            allowCampusEgress: true,
            requestedModel: input.requestedModel,
          },
          runId: run.id,
        },
      })
      .where(
        and(
          eq(schema.graphBuilds.projectId, input.projectId),
          eq(schema.graphBuilds.id, build.id),
        ),
      );
    await tx.insert(schema.runEvents).values({
      projectId: input.projectId,
      runId: run.id,
      sequence: 1,
      eventType: "run.status",
      payload: {
        status: "queued",
        purpose: "graph_indexing",
        buildId: build.id,
      },
    });
    await tx.insert(schema.outbox).values({
      projectId: input.projectId,
      aggregateId: build.id,
      eventType: "graph.build.enqueue",
      payload: { projectId: input.projectId, buildId: build.id, runId: run.id },
    });
    return { buildId: build.id, runId: run.id, state: "queued", created: true };
  });
}

export async function cancelGraphBuild(
  db: Database,
  projectId: string,
  buildId: string,
) {
  return db.transaction(async (tx) => {
    const [build] = await tx
      .select({
        id: schema.graphBuilds.id,
        state: schema.graphBuilds.state,
        budget: schema.graphBuilds.budget,
      })
      .from(schema.graphBuilds)
      .where(
        and(
          eq(schema.graphBuilds.projectId, projectId),
          eq(schema.graphBuilds.id, buildId),
        ),
      )
      .for("update");
    if (!build)
      throw new KnowledgeOperationError(
        "BUILD_NOT_FOUND",
        "Build tidak ditemukan.",
      );
    if (
      !["queued", "extracting", "validating", "ready_to_activate"].includes(
        build.state,
      )
    ) {
      throw new KnowledgeOperationError(
        "BUILD_NOT_CANCELLABLE",
        "Build sudah selesai.",
      );
    }
    await tx
      .update(schema.graphBuilds)
      .set({
        state: "cancelled",
        finishedAt: new Date(),
        budget: {
          ...build.budget,
          cancelRequestedAt: new Date().toISOString(),
        },
      })
      .where(
        and(
          eq(schema.graphBuilds.projectId, projectId),
          eq(schema.graphBuilds.id, buildId),
        ),
      );
    const runId =
      typeof build.budget.runId === "string" ? build.budget.runId : null;
    if (runId) {
      const [run] = await tx
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(
          and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)),
        )
        .for("update");
      if (run && ["queued", "running"].includes(run.status)) {
        await tx
          .update(schema.runs)
          .set({
            status: "canceled",
            cancelRequestedAt: new Date(),
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(schema.runs.projectId, projectId),
              eq(schema.runs.id, runId),
            ),
          );
        const [last] = await tx
          .select({ sequence: max(schema.runEvents.sequence) })
          .from(schema.runEvents)
          .where(
            and(
              eq(schema.runEvents.projectId, projectId),
              eq(schema.runEvents.runId, runId),
            ),
          );
        await tx.insert(schema.runEvents).values({
          projectId,
          runId,
          sequence: (last?.sequence ?? 0) + 1,
          eventType: "run.status",
          payload: {
            status: "canceled",
            buildId,
            remoteOutcomeMayBeUnknown: true,
          },
        });
      }
    }
    return { buildId, state: "cancelled" };
  });
}

export async function getGraphBuild(
  db: QueryDatabase,
  projectId: string,
  buildId: string,
) {
  const [build] = await db
    .select({
      id: schema.graphBuilds.id,
      state: schema.graphBuilds.state,
      sourceManifest: schema.graphBuilds.sourceManifest,
      sourceManifestHash: schema.graphBuilds.sourceManifestHash,
      extractorProvider: schema.graphBuilds.extractorProvider,
      extractorModel: schema.graphBuilds.extractorModel,
      extractionPromptVersion: schema.graphBuilds.extractionPromptVersion,
      extractionSchemaVersion: schema.graphBuilds.extractionSchemaVersion,
      budget: schema.graphBuilds.budget,
      usageRefs: schema.graphBuilds.usageRefs,
      requestedAt: schema.graphBuilds.requestedAt,
      finishedAt: schema.graphBuilds.finishedAt,
    })
    .from(schema.graphBuilds)
    .where(
      and(
        eq(schema.graphBuilds.projectId, projectId),
        eq(schema.graphBuilds.id, buildId),
      ),
    )
    .limit(1);
  if (!build)
    throw new KnowledgeOperationError(
      "BUILD_NOT_FOUND",
      "Build tidak ditemukan.",
    );
  return build;
}

export async function listGraphBuilds(db: QueryDatabase, projectId: string) {
  return db
    .select({
      id: schema.graphBuilds.id,
      state: schema.graphBuilds.state,
      sourceManifest: schema.graphBuilds.sourceManifest,
      sourceManifestHash: schema.graphBuilds.sourceManifestHash,
      extractorModel: schema.graphBuilds.extractorModel,
      budget: schema.graphBuilds.budget,
      usageRefs: schema.graphBuilds.usageRefs,
      requestedAt: schema.graphBuilds.requestedAt,
      finishedAt: schema.graphBuilds.finishedAt,
    })
    .from(schema.graphBuilds)
    .where(eq(schema.graphBuilds.projectId, projectId))
    .orderBy(desc(schema.graphBuilds.requestedAt))
    .limit(20);
}

function manifestEntries(value: unknown): Array<{
  documentId: string;
  documentVersionId: string;
  checksum: string;
  permission: string;
  structuralFingerprint: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.documentId !== "string" ||
      typeof row.documentVersionId !== "string" ||
      typeof row.checksum !== "string"
    )
      return [];
    return [
      {
        documentId: row.documentId,
        documentVersionId: row.documentVersionId,
        checksum: row.checksum,
        permission: String(row.permission ?? ""),
        structuralFingerprint:
          typeof row.structuralFingerprint === "string"
            ? row.structuralFingerprint
            : null,
      },
    ];
  });
}

export async function graphSnapshotIsCurrent(
  db: QueryDatabase,
  projectId: string,
  sourceManifest: unknown,
): Promise<boolean> {
  const entries = manifestEntries(sourceManifest);
  if (!entries.length || entries.length > MAX_GRAPH_BUILD_DOCUMENTS)
    return false;
  for (const entry of entries) {
    const [row] = await db
      .select({
        activeVersionId: schema.documents.activeVersionId,
        deletedAt: schema.documents.deletedAt,
        permission: schema.documents.trust,
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
          eq(schema.documents.id, entry.documentId),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.deletedAt ||
      !row.eligible ||
      row.activeVersionId !== entry.documentVersionId ||
      row.checksum !== entry.checksum ||
      row.permission !== entry.permission ||
      row.permission !== "campus_indexer_allowed"
    )
      return false;
  }
  const presentFingerprints = entries.filter(
    (entry) => entry.structuralFingerprint !== null,
  );
  const missingFingerprints = entries.length - presentFingerprints.length;
  if (presentFingerprints.length && missingFingerprints) return false;

  const currentFingerprint = await getActiveKnowledgeMarkdownFingerprint(
    db,
    projectId,
  );
  if (!presentFingerprints.length) {
    return currentFingerprint === knowledgeMarkdownNoteSetFingerprint([]);
  }
  const expectedFingerprints = new Set(
    presentFingerprints.map((entry) => entry.structuralFingerprint),
  );
  return (
    expectedFingerprints.size === 1 &&
    expectedFingerprints.has(currentFingerprint)
  );
}

export async function getActiveGraphSnapshot(
  db: QueryDatabase,
  projectId: string,
) {
  const [row] = await db
    .select({
      snapshotId: schema.graphActiveSnapshots.snapshotId,
      revision: schema.graphActiveSnapshots.revision,
      state: schema.graphSnapshots.state,
      sourceManifest: schema.graphSnapshots.sourceManifest,
      sourceManifestHash: schema.graphSnapshots.sourceManifestHash,
      coverage: schema.graphSnapshots.coverage,
      activatedAt: schema.graphSnapshots.activatedAt,
      buildId: schema.graphSnapshots.buildId,
    })
    .from(schema.graphActiveSnapshots)
    .innerJoin(
      schema.graphSnapshots,
      and(
        eq(
          schema.graphSnapshots.projectId,
          schema.graphActiveSnapshots.projectId,
        ),
        eq(schema.graphSnapshots.id, schema.graphActiveSnapshots.snapshotId),
      ),
    )
    .where(eq(schema.graphActiveSnapshots.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export async function getGraphSnapshotById(
  db: QueryDatabase,
  projectId: string,
  snapshotId: string,
) {
  const [row] = await db
    .select({
      snapshotId: schema.graphSnapshots.id,
      state: schema.graphSnapshots.state,
      sourceManifest: schema.graphSnapshots.sourceManifest,
      sourceManifestHash: schema.graphSnapshots.sourceManifestHash,
      coverage: schema.graphSnapshots.coverage,
      activatedAt: schema.graphSnapshots.activatedAt,
      buildId: schema.graphSnapshots.buildId,
      createdAt: schema.graphSnapshots.createdAt,
    })
    .from(schema.graphSnapshots)
    .where(
      and(
        eq(schema.graphSnapshots.projectId, projectId),
        eq(schema.graphSnapshots.id, snapshotId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listGraphSnapshots(db: QueryDatabase, projectId: string) {
  const [active, rows] = await Promise.all([
    getActiveGraphSnapshot(db, projectId),
    db
      .select({
        id: schema.graphSnapshots.id,
        state: schema.graphSnapshots.state,
        sourceManifest: schema.graphSnapshots.sourceManifest,
        sourceManifestHash: schema.graphSnapshots.sourceManifestHash,
        coverage: schema.graphSnapshots.coverage,
        activatedAt: schema.graphSnapshots.activatedAt,
        buildId: schema.graphSnapshots.buildId,
        createdAt: schema.graphSnapshots.createdAt,
      })
      .from(schema.graphSnapshots)
      .where(eq(schema.graphSnapshots.projectId, projectId))
      .orderBy(desc(schema.graphSnapshots.createdAt))
      .limit(20),
  ]);
  const snapshots = [];
  for (const row of rows) {
    const current =
      (row.state === "active" || row.state === "superseded") &&
      (await graphSnapshotIsCurrent(db, projectId, row.sourceManifest));
    snapshots.push({
      id: row.id,
      state: row.state,
      current,
      active: active?.snapshotId === row.id,
      revision: active?.snapshotId === row.id ? active.revision : null,
      sourceManifestHash: row.sourceManifestHash,
      coverage: row.coverage,
      buildId: row.buildId,
      createdAt: row.createdAt,
      activatedAt: row.activatedAt,
    });
  }
  return snapshots;
}

export async function getProjectReadiness(
  db: QueryDatabase,
  projectId: string,
  providerInput: { keyConfigured: boolean; environmentModel: string | null },
) {
  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)),
    )
    .limit(1);
  if (!project)
    throw new KnowledgeOperationError(
      "PROJECT_NOT_FOUND",
      "Proyek tidak tersedia.",
    );
  const sources = await listKnowledgeSources(db, projectId);
  const currentSources = sources.filter((item) => item.eligible);
  const activeSnapshot = await getActiveGraphSnapshot(db, projectId);
  const snapshotCurrent = activeSnapshot
    ? await graphSnapshotIsCurrent(db, projectId, activeSnapshot.sourceManifest)
    : false;
  const [latestBuild] = await listGraphBuilds(db, projectId);
  const builds = await listGraphBuilds(db, projectId);
  const inProgress = builds.find((item) =>
    ["queued", "extracting", "validating", "ready_to_activate"].includes(
      item.state,
    ),
  );
  const snapshotStatus = !activeSnapshot
    ? "none"
    : !snapshotCurrent
      ? "stale"
      : activeSnapshot.state === "active"
        ? "active"
        : "stale";
  const snapshotVersionIds = activeSnapshot
    ? manifestEntries(activeSnapshot.sourceManifest).map(
        (entry) => entry.documentVersionId,
      )
    : [];
  const graphEvidenceRows =
    activeSnapshot && snapshotStatus === "active" && snapshotVersionIds.length
      ? await db
          .select({
            quote: schema.graphEvidence.quote,
            spanStart: schema.graphEvidence.spanStart,
            spanEnd: schema.graphEvidence.spanEnd,
            sourceChecksum: schema.graphEvidence.sourceChecksum,
            checksum: schema.documentVersions.checksum,
            content: schema.chunks.content,
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
                schema.graphAssertionVersions.id,
                schema.graphSnapshotAssertions.assertionVersionId,
              ),
              eq(schema.graphAssertionVersions.status, "extracted_supported"),
            ),
          )
          .innerJoin(
            schema.graphEvidence,
            and(
              eq(
                schema.graphEvidence.projectId,
                schema.graphSnapshotAssertions.projectId,
              ),
              eq(
                schema.graphEvidence.assertionId,
                schema.graphSnapshotAssertions.assertionId,
              ),
              eq(
                schema.graphEvidence.assertionVersionId,
                schema.graphSnapshotAssertions.assertionVersionId,
              ),
              eq(schema.graphEvidence.eligible, true),
            ),
          )
          .innerJoin(
            schema.documentVersions,
            and(
              eq(
                schema.documentVersions.projectId,
                schema.graphEvidence.projectId,
              ),
              eq(
                schema.documentVersions.id,
                schema.graphEvidence.documentVersionId,
              ),
              eq(schema.documentVersions.eligible, true),
              eq(
                schema.documentVersions.checksum,
                schema.graphEvidence.sourceChecksum,
              ),
            ),
          )
          .innerJoin(
            schema.documents,
            and(
              eq(schema.documents.projectId, schema.documentVersions.projectId),
              eq(schema.documents.id, schema.documentVersions.documentId),
              eq(schema.documents.activeVersionId, schema.documentVersions.id),
              eq(schema.documents.trust, "campus_indexer_allowed"),
              isNull(schema.documents.deletedAt),
            ),
          )
          .innerJoin(
            schema.chunks,
            and(
              eq(schema.chunks.projectId, schema.graphEvidence.projectId),
              eq(
                schema.chunks.documentVersionId,
                schema.graphEvidence.documentVersionId,
              ),
              eq(schema.chunks.id, schema.graphEvidence.chunkId),
            ),
          )
          .where(
            and(
              eq(schema.graphSnapshotAssertions.projectId, projectId),
              eq(
                schema.graphSnapshotAssertions.snapshotId,
                activeSnapshot.snapshotId,
              ),
              eq(schema.graphSnapshotAssertions.eligible, true),
              inArray(
                schema.graphEvidence.documentVersionId,
                snapshotVersionIds,
              ),
            ),
          )
          .limit(1_201)
      : [];
  const graphAvailable =
    snapshotStatus === "active" &&
    graphEvidenceRows.some(
      (row) =>
        row.sourceChecksum === row.checksum &&
        row.spanStart >= 0 &&
        row.spanEnd > row.spanStart &&
        row.spanEnd <= row.content.length &&
        row.content.slice(row.spanStart, row.spanEnd) === row.quote,
    );
  const provider = await db
    .select({
      status: schema.providerConnections.connectionStatus,
      model: schema.providerConnections.requestedModel,
    })
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.projectId, projectId),
        eq(schema.providerConnections.provider, "campus_gateway"),
        eq(schema.providerConnections.role, "optimizer"),
      ),
    )
    .limit(1);
  const indexer = provider[0];
  const providerReady = Boolean(
    providerInput.keyConfigured &&
    providerInput.environmentModel &&
    indexer?.status === "verified" &&
    indexer.model === providerInput.environmentModel,
  );
  return {
    projectId,
    documents: {
      total: sources.length,
      eligible: currentSources.length,
      chunkCount: currentSources.reduce(
        (sum, item) => sum + item.chunkCount,
        0,
      ),
    },
    snapshot: activeSnapshot
      ? {
          id: activeSnapshot.snapshotId,
          status: snapshotStatus,
          buildId: activeSnapshot.buildId,
          revision: activeSnapshot.revision,
          activatedAt: activeSnapshot.activatedAt,
          sourceManifestHash: activeSnapshot.sourceManifestHash,
          coverage: activeSnapshot.coverage,
        }
      : {
          id: null,
          status: "none",
          buildId: null,
          revision: null,
          activatedAt: null,
          coverage: {},
        },
    build: inProgress
      ? { state: inProgress.state, id: inProgress.id }
      : latestBuild
        ? { state: latestBuild.state, id: latestBuild.id }
        : { state: "none", id: null },
    retrieval: {
      status: "ready",
      backend: "postgresql",
      strategies: ["lexical", "graph", "full_context"],
      graphAvailable,
      fallback: !graphAvailable
        ? "Lexical retrieval tersedia sampai snapshot memiliki evidence graph terkini."
        : null,
    },
    indexer: {
      provider: "campus_gateway",
      requestedModel: providerInput.environmentModel,
      connectionStatus: indexer?.status ?? "unavailable",
      ready: providerReady,
      reason: !providerInput.keyConfigured
        ? "Credential campus gateway belum tersedia."
        : !providerInput.environmentModel
          ? "Campus model belum dikonfigurasi."
          : !indexer
            ? "Koneksi campus optimizer belum disimpan."
            : indexer.status !== "verified"
              ? "Koneksi campus optimizer belum diverifikasi."
              : indexer.model !== providerInput.environmentModel
                ? "Model koneksi berbeda dari model gateway yang aktif."
                : null,
    },
  };
}

export async function listActiveGraphAssertions(
  db: QueryDatabase,
  projectId: string,
  limit = 100,
) {
  const snapshot = await getActiveGraphSnapshot(db, projectId);
  if (!snapshot || snapshot.state !== "active")
    return { snapshotId: null, assertions: [] };
  const objectEntity = alias(schema.graphEntities, "object_entity");
  const rows = await db
    .select({
      assertionId: schema.graphAssertions.id,
      currentVersion: schema.graphAssertionVersions.version,
      status: schema.graphAssertionVersions.status,
      subject: schema.graphEntities.canonicalLabel,
      subjectType: schema.graphEntities.entityType,
      predicate: schema.graphAssertionVersions.predicate,
      object: objectEntity.canonicalLabel,
      objectType: objectEntity.entityType,
      qualifiers: schema.graphAssertionVersions.qualifiers,
      snapshotEligible: schema.graphSnapshotAssertions.eligible,
      evidenceId: schema.graphEvidence.id,
      quote: schema.graphEvidence.quote,
      spanStart: schema.graphEvidence.spanStart,
      spanEnd: schema.graphEvidence.spanEnd,
      documentVersionId: schema.graphEvidence.documentVersionId,
      chunkId: schema.graphEvidence.chunkId,
      pageNumber: schema.chunks.pageNumber,
      checksum: schema.graphEvidence.sourceChecksum,
      displayName: schema.documents.displayName,
      documentVersion: schema.documentVersions.version,
      sourceRef: schema.documentVersions.sourceRef,
      sourceMetadata: schema.documentVersions.sourceMetadata,
      extractorRunId: schema.graphEvidence.extractionRunId,
      extractorModel: schema.runs.requestedModel,
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
    .innerJoin(
      schema.graphAssertions,
      and(
        eq(
          schema.graphAssertions.projectId,
          schema.graphAssertionVersions.projectId,
        ),
        eq(
          schema.graphAssertions.id,
          schema.graphAssertionVersions.assertionId,
        ),
      ),
    )
    .innerJoin(
      schema.graphEntities,
      and(
        eq(
          schema.graphEntities.projectId,
          schema.graphAssertionVersions.projectId,
        ),
        eq(
          schema.graphEntities.id,
          schema.graphAssertionVersions.subjectEntityId,
        ),
      ),
    )
    .innerJoin(
      objectEntity,
      and(
        eq(objectEntity.projectId, schema.graphAssertionVersions.projectId),
        eq(objectEntity.id, schema.graphAssertionVersions.objectEntityId),
      ),
    )
    .leftJoin(
      schema.graphEvidence,
      and(
        eq(
          schema.graphEvidence.projectId,
          schema.graphSnapshotAssertions.projectId,
        ),
        eq(
          schema.graphEvidence.assertionId,
          schema.graphSnapshotAssertions.assertionId,
        ),
        eq(
          schema.graphEvidence.assertionVersionId,
          schema.graphSnapshotAssertions.assertionVersionId,
        ),
        eq(schema.graphEvidence.eligible, true),
      ),
    )
    .leftJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.projectId, schema.graphEvidence.projectId),
        eq(schema.documentVersions.id, schema.graphEvidence.documentVersionId),
        eq(schema.documentVersions.eligible, true),
      ),
    )
    .leftJoin(
      schema.chunks,
      and(
        eq(schema.chunks.projectId, schema.graphEvidence.projectId),
        eq(
          schema.chunks.documentVersionId,
          schema.graphEvidence.documentVersionId,
        ),
        eq(schema.chunks.id, schema.graphEvidence.chunkId),
      ),
    )
    .leftJoin(
      schema.documents,
      and(
        eq(schema.documents.projectId, schema.documentVersions.projectId),
        eq(schema.documents.id, schema.documentVersions.documentId),
        eq(schema.documents.activeVersionId, schema.documentVersions.id),
        eq(schema.documents.trust, "campus_indexer_allowed"),
        isNull(schema.documents.deletedAt),
      ),
    )
    .leftJoin(
      schema.runs,
      eq(schema.runs.id, schema.graphEvidence.extractionRunId),
    )
    .where(
      and(
        eq(schema.graphSnapshotAssertions.projectId, projectId),
        eq(schema.graphSnapshotAssertions.snapshotId, snapshot.snapshotId),
      ),
    )
    .orderBy(desc(schema.graphAssertions.updatedAt))
    .limit(Math.min(100, Math.max(1, limit)));
  const grouped = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const current = grouped.get(row.assertionId) ?? {
      id: row.assertionId,
      version: row.currentVersion,
      status: row.status,
      eligible: row.snapshotEligible,
      subject: row.subject,
      subjectType: row.subjectType,
      predicate: row.predicate,
      object: row.object,
      objectType: row.objectType,
      qualifiers: row.qualifiers,
      evidence: [],
    };
    const evidence = current.evidence as Array<Record<string, unknown>>;
    if (row.evidenceId && evidence.length < 3) {
      evidence.push({
        id: row.evidenceId,
        quote: row.quote,
        spanStart: row.spanStart,
        spanEnd: row.spanEnd,
        documentVersionId: row.documentVersionId,
        documentVersion: row.documentVersion,
        chunkId: row.chunkId,
        checksum: row.checksum,
        displayName: row.displayName,
        sourceRef: row.sourceRef,
        sourceMetadata: row.sourceMetadata,
        pageNumber: row.pageNumber,
        extractionRunId: row.extractorRunId,
        extractorModel: row.extractorModel,
      });
    }
    grouped.set(row.assertionId, current);
  }
  return { snapshotId: snapshot.snapshotId, assertions: [...grouped.values()] };
}

export async function reviewGraphAssertion(
  db: Database,
  input: {
    projectId: string;
    assertionId: string;
    version: number;
    decision: "accept" | "reject";
    reason: string;
  },
) {
  return db.transaction(async (tx) => {
    const [observedActive] = await tx
      .select({
        snapshotId: schema.graphActiveSnapshots.snapshotId,
        revision: schema.graphActiveSnapshots.revision,
      })
      .from(schema.graphActiveSnapshots)
      .where(eq(schema.graphActiveSnapshots.projectId, input.projectId))
      .limit(1);
    if (!observedActive)
      throw new KnowledgeOperationError(
        "ASSERTION_NOT_FOUND",
        "Assertion tidak ada pada snapshot aktif.",
      );
    const [observedSnapshot] = await tx
      .select({ sourceManifest: schema.graphSnapshots.sourceManifest })
      .from(schema.graphSnapshots)
      .where(
        and(
          eq(schema.graphSnapshots.projectId, input.projectId),
          eq(schema.graphSnapshots.id, observedActive.snapshotId),
        ),
      )
      .limit(1);
    const sourceDocumentIds = observedSnapshot
      ? [
          ...new Set(
            manifestEntries(observedSnapshot.sourceManifest).map(
              (entry) => entry.documentId,
            ),
          ),
        ].sort()
      : [];
    if (!sourceDocumentIds.length) {
      throw new KnowledgeOperationError(
        "ASSERTION_EVIDENCE_STALE",
        "Snapshot sumber tidak lagi valid. Bangun ulang graph sebelum review.",
      );
    }
    // Source lifecycle operations lock documents before the active snapshot row.
    // Use the same lock order so permissions and versions cannot change mid-review.
    await tx
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.projectId, input.projectId),
          inArray(schema.documents.id, sourceDocumentIds),
        ),
      )
      .orderBy(asc(schema.documents.id))
      .for("update");
    const [active] = await tx
      .select({
        snapshotId: schema.graphActiveSnapshots.snapshotId,
        revision: schema.graphActiveSnapshots.revision,
      })
      .from(schema.graphActiveSnapshots)
      .where(eq(schema.graphActiveSnapshots.projectId, input.projectId))
      .limit(1)
      .for("update");
    if (
      !active ||
      active.snapshotId !== observedActive.snapshotId ||
      active.revision !== observedActive.revision
    ) {
      throw new KnowledgeOperationError(
        "ASSERTION_EVIDENCE_STALE",
        "Snapshot aktif berubah sebelum review. Muat ulang sebelum melanjutkan.",
      );
    }
    const [current] = await tx
      .select({
        id: schema.graphAssertions.id,
        currentVersion: schema.graphAssertions.currentVersion,
        currentVersionId: schema.graphAssertionVersions.id,
        subjectEntityId: schema.graphAssertionVersions.subjectEntityId,
        predicate: schema.graphAssertionVersions.predicate,
        objectEntityId: schema.graphAssertionVersions.objectEntityId,
        direction: schema.graphAssertionVersions.direction,
        qualifiers: schema.graphAssertionVersions.qualifiers,
        status: schema.graphAssertionVersions.status,
        snapshotState: schema.graphSnapshots.state,
        buildId: schema.graphSnapshots.buildId,
        manifest: schema.graphSnapshots.sourceManifest,
        manifestHash: schema.graphSnapshots.sourceManifestHash,
        coverage: schema.graphSnapshots.coverage,
      })
      .from(schema.graphAssertions)
      .innerJoin(
        schema.graphSnapshotAssertions,
        and(
          eq(
            schema.graphSnapshotAssertions.projectId,
            schema.graphAssertions.projectId,
          ),
          eq(
            schema.graphSnapshotAssertions.assertionId,
            schema.graphAssertions.id,
          ),
          eq(schema.graphSnapshotAssertions.snapshotId, active.snapshotId),
        ),
      )
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
      .innerJoin(
        schema.graphSnapshots,
        eq(schema.graphSnapshots.id, active.snapshotId),
      )
      .where(
        and(
          eq(schema.graphAssertions.projectId, input.projectId),
          eq(schema.graphAssertions.id, input.assertionId),
        ),
      )
      .limit(1)
      .for("update", { of: schema.graphAssertions });
    if (!current)
      throw new KnowledgeOperationError(
        "ASSERTION_NOT_FOUND",
        "Assertion tidak ada pada snapshot aktif.",
      );
    if (current.currentVersion !== input.version) {
      throw new KnowledgeOperationError(
        "ASSERTION_VERSION_CONFLICT",
        "Assertion berubah sejak dibuka. Muat ulang sebelum review.",
        { currentVersion: current.currentVersion },
      );
    }
    if (
      current.snapshotState !== "active" ||
      !(await graphSnapshotIsCurrent(tx, input.projectId, current.manifest))
    ) {
      throw new KnowledgeOperationError(
        "ASSERTION_EVIDENCE_STALE",
        "Sumber assertion berubah atau tidak lagi diizinkan. Bangun ulang graph sebelum review.",
      );
    }
    if (current.status === "rejected" && input.decision === "accept") {
      throw new KnowledgeOperationError(
        "ASSERTION_VERSION_CONFLICT",
        "Assertion yang ditolak perlu build baru sebelum dapat diterima.",
      );
    }
    const manifestVersionIds = new Set(
      manifestEntries(current.manifest).map((entry) => entry.documentVersionId),
    );
    const proofRows = await tx
      .select({
        documentVersionId: schema.graphEvidence.documentVersionId,
        chunkId: schema.graphEvidence.chunkId,
        quote: schema.graphEvidence.quote,
        spanStart: schema.graphEvidence.spanStart,
        spanEnd: schema.graphEvidence.spanEnd,
        sourceChecksum: schema.graphEvidence.sourceChecksum,
        extractionRunId: schema.graphEvidence.extractionRunId,
        currentChecksum: schema.documentVersions.checksum,
        content: schema.chunks.content,
      })
      .from(schema.graphEvidence)
      .innerJoin(
        schema.documentVersions,
        and(
          eq(schema.documentVersions.projectId, schema.graphEvidence.projectId),
          eq(
            schema.documentVersions.id,
            schema.graphEvidence.documentVersionId,
          ),
          eq(schema.documentVersions.eligible, true),
        ),
      )
      .innerJoin(
        schema.documents,
        and(
          eq(schema.documents.projectId, schema.documentVersions.projectId),
          eq(schema.documents.id, schema.documentVersions.documentId),
          eq(schema.documents.activeVersionId, schema.documentVersions.id),
          eq(schema.documents.trust, "campus_indexer_allowed"),
          isNull(schema.documents.deletedAt),
        ),
      )
      .innerJoin(
        schema.chunks,
        and(
          eq(schema.chunks.projectId, schema.graphEvidence.projectId),
          eq(
            schema.chunks.documentVersionId,
            schema.graphEvidence.documentVersionId,
          ),
          eq(schema.chunks.id, schema.graphEvidence.chunkId),
        ),
      )
      .where(
        and(
          eq(schema.graphEvidence.projectId, input.projectId),
          eq(schema.graphEvidence.assertionId, input.assertionId),
          eq(schema.graphEvidence.assertionVersionId, current.currentVersionId),
          eq(schema.graphEvidence.eligible, true),
          eq(
            schema.graphEvidence.sourceChecksum,
            schema.documentVersions.checksum,
          ),
        ),
      )
      .orderBy(desc(schema.graphEvidence.createdAt))
      .limit(100);
    const proofs = proofRows.filter(
      (row) =>
        manifestVersionIds.has(row.documentVersionId) &&
        row.sourceChecksum === row.currentChecksum &&
        row.spanStart >= 0 &&
        row.spanEnd > row.spanStart &&
        row.spanEnd <= row.content.length &&
        row.content.slice(row.spanStart, row.spanEnd) === row.quote,
    );
    if (input.decision === "accept" && proofs.length === 0) {
      throw new KnowledgeOperationError(
        "ASSERTION_EVIDENCE_STALE",
        "Tidak ada kutipan persis dari sumber terkini untuk mendukung assertion ini.",
      );
    }
    const [version] = await tx
      .insert(schema.graphAssertionVersions)
      .values({
        projectId: input.projectId,
        assertionId: input.assertionId,
        version: current.currentVersion + 1,
        subjectEntityId: current.subjectEntityId,
        predicate: current.predicate,
        objectEntityId: current.objectEntityId,
        direction: "directed",
        qualifiers: current.qualifiers,
        status:
          input.decision === "accept" ? "extracted_supported" : "rejected",
        changedBy: "local_user",
        changeReason: input.reason || `review_${input.decision}`,
      })
      .returning({ id: schema.graphAssertionVersions.id });
    if (!version) throw new Error("Assertion version insert returned no row");
    if (proofs.length) {
      await tx.insert(schema.graphEvidence).values(
        proofs.map((proof) => ({
          projectId: input.projectId,
          assertionId: input.assertionId,
          assertionVersionId: version.id,
          documentVersionId: proof.documentVersionId,
          chunkId: proof.chunkId,
          quote: proof.quote,
          spanStart: proof.spanStart,
          spanEnd: proof.spanEnd,
          sourceChecksum: proof.sourceChecksum,
          extractionRunId: proof.extractionRunId,
          eligible: true,
        })),
      );
    }
    await tx
      .update(schema.graphAssertions)
      .set({
        currentVersion: current.currentVersion + 1,
        status:
          input.decision === "accept" ? "extracted_supported" : "rejected",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.graphAssertions.projectId, input.projectId),
          eq(schema.graphAssertions.id, input.assertionId),
        ),
      );

    const [snapshot] = await tx
      .insert(schema.graphSnapshots)
      .values({
        projectId: input.projectId,
        buildId: current.buildId,
        sourceManifest: current.manifest,
        sourceManifestHash: current.manifestHash,
        coverage: {
          ...current.coverage,
          lastReview: {
            assertionId: input.assertionId,
            decision: input.decision,
            at: new Date().toISOString(),
          },
        },
        state: "staging",
      })
      .returning({ id: schema.graphSnapshots.id });
    if (!snapshot) throw new Error("Review snapshot insert returned no row");
    const members = await tx
      .select({
        projectId: schema.graphSnapshotAssertions.projectId,
        assertionId: schema.graphSnapshotAssertions.assertionId,
        assertionVersionId: schema.graphSnapshotAssertions.assertionVersionId,
        sourceManifestHash: schema.graphSnapshotAssertions.sourceManifestHash,
        eligible: schema.graphSnapshotAssertions.eligible,
      })
      .from(schema.graphSnapshotAssertions)
      .where(
        and(
          eq(schema.graphSnapshotAssertions.projectId, input.projectId),
          eq(schema.graphSnapshotAssertions.snapshotId, active.snapshotId),
        ),
      );
    await tx.insert(schema.graphSnapshotAssertions).values(
      members.map((member) => ({
        ...member,
        snapshotId: snapshot.id,
        assertionVersionId:
          member.assertionId === input.assertionId
            ? version.id
            : member.assertionVersionId,
        eligible:
          member.assertionId === input.assertionId
            ? input.decision === "accept"
            : member.eligible,
      })),
    );
    const [lockedActive] = await tx
      .select({
        snapshotId: schema.graphActiveSnapshots.snapshotId,
        revision: schema.graphActiveSnapshots.revision,
      })
      .from(schema.graphActiveSnapshots)
      .where(eq(schema.graphActiveSnapshots.projectId, input.projectId))
      .limit(1)
      .for("update");
    if (
      !lockedActive ||
      lockedActive.snapshotId !== active.snapshotId ||
      lockedActive.revision !== active.revision ||
      !(await graphSnapshotIsCurrent(tx, input.projectId, current.manifest))
    ) {
      throw new KnowledgeOperationError(
        "ASSERTION_EVIDENCE_STALE",
        "Sumber atau snapshot berubah selama review. Bangun ulang graph sebelum review.",
      );
    }
    await tx
      .update(schema.graphSnapshots)
      .set({ state: "superseded" })
      .where(
        and(
          eq(schema.graphSnapshots.projectId, input.projectId),
          eq(schema.graphSnapshots.id, active.snapshotId),
        ),
      );
    await tx
      .update(schema.graphSnapshots)
      .set({ state: "active", activatedAt: new Date() })
      .where(
        and(
          eq(schema.graphSnapshots.projectId, input.projectId),
          eq(schema.graphSnapshots.id, snapshot.id),
        ),
      );
    await tx
      .update(schema.graphActiveSnapshots)
      .set({
        snapshotId: snapshot.id,
        revision: active.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.graphActiveSnapshots.projectId, input.projectId));
    return {
      assertionId: input.assertionId,
      version: current.currentVersion + 1,
      status: input.decision === "accept" ? "extracted_supported" : "rejected",
      snapshotId: snapshot.id,
    };
  });
}
