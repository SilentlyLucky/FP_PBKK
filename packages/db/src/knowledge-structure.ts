import { createHash } from "node:crypto";

import {
  parseKnowledgeMarkdownLinks,
  type KnowledgeMarkdownStructuralLink,
} from "./knowledge-markdown.ts";

export const DEFAULT_KNOWLEDGE_VAULT_NAMESPACE = "default";

export interface KnowledgeVaultLocator {
  namespace: string;
  path: string;
}

export interface KnowledgeVaultLocatorInput {
  namespace?: string;
  path: string;
}

export interface KnowledgeMarkdownStructureChunk {
  chunkId: string;
  ordinal: number;
  content: string;
}

export interface KnowledgeMarkdownStructureNote {
  documentId: string;
  documentVersionId: string;
  displayName: string;
  checksum: string;
  permission: string;
  locator: KnowledgeVaultLocator;
  chunks: KnowledgeMarkdownStructureChunk[];
}

export interface KnowledgeMarkdownStructuralLinkRecord {
  namespace: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  sourceDisplayName: string;
  sourcePath: string;
  sourcePermission: string;
  sourceChecksum: string;
  sourceChunkId: string;
  sourceChunkOrdinal: number;
  sourceText: string;
  link: KnowledgeMarkdownStructuralLink;
  targetDocumentId: string | null;
  targetDocumentVersionId: string | null;
  targetDisplayName: string | null;
  targetPath: string | null;
  targetPermission: string | null;
}

const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Validates a metadata-only vault locator. This value is never used to read a
 * filesystem path; it is only a namespace and a note key for Markdown links.
 */
export function normalizeKnowledgeVaultLocator(
  value: unknown,
  contentType: string,
): KnowledgeVaultLocator | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== "namespace" && key !== "path"))
    return null;
  if (typeof row.path !== "string" || contentType !== "text/markdown")
    return null;

  const rawPath = row.path.trim();
  if (
    !rawPath ||
    rawPath.length > 500 ||
    CONTROL_CHARACTERS.test(rawPath) ||
    rawPath.includes("\\") ||
    rawPath.includes("?") ||
    rawPath.includes("#") ||
    rawPath.startsWith("/") ||
    WINDOWS_DRIVE_PATH.test(rawPath) ||
    URI_SCHEME.test(rawPath)
  ) {
    return null;
  }

  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const path = segments
    .filter((segment) => segment && segment !== ".")
    .join("/");
  if (!path || !/\.(?:md|markdown)$/iu.test(path)) return null;

  const rawNamespace = row.namespace;
  const namespace =
    rawNamespace === undefined || rawNamespace === null || rawNamespace === ""
      ? DEFAULT_KNOWLEDGE_VAULT_NAMESPACE
      : typeof rawNamespace === "string"
        ? rawNamespace.trim()
        : "";
  if (!NAMESPACE_PATTERN.test(namespace)) return null;

  return { namespace, path };
}

export function knowledgeMarkdownNoteSetFingerprint(
  notes: readonly KnowledgeMarkdownStructureNote[],
): string {
  const manifest = [...notes]
    .map((note) => ({
      documentId: note.documentId,
      documentVersionId: note.documentVersionId,
      displayName: note.displayName,
      checksum: note.checksum,
      permission: note.permission,
      namespace: note.locator.namespace,
      path: note.locator.path,
    }))
    .sort(
      (left, right) =>
        compareText(left.documentId, right.documentId) ||
        compareText(left.documentVersionId, right.documentVersionId),
    );
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/**
 * Resolves source-note links only against caller-provided notes in the same
 * namespace. The parser records unresolved and ambiguous references too.
 */
export function resolveKnowledgeMarkdownStructure(
  notes: readonly KnowledgeMarkdownStructureNote[],
): KnowledgeMarkdownStructuralLinkRecord[] {
  const notesByNamespace = new Map<string, KnowledgeMarkdownStructureNote[]>();
  for (const note of notes) {
    const group = notesByNamespace.get(note.locator.namespace) ?? [];
    group.push(note);
    notesByNamespace.set(note.locator.namespace, group);
  }

  const result: KnowledgeMarkdownStructuralLinkRecord[] = [];
  for (const namespace of [...notesByNamespace.keys()].sort()) {
    const namespaceNotes = [...(notesByNamespace.get(namespace) ?? [])].sort(
      (left, right) =>
        compareText(left.locator.path, right.locator.path) ||
        compareText(left.documentId, right.documentId),
    );
    const noteById = new Map(
      namespaceNotes.map((note) => [note.documentId, note]),
    );
    const knownNotes = namespaceNotes.map((note) => ({
      id: note.documentId,
      path: note.locator.path,
    }));

    for (const note of namespaceNotes) {
      for (const chunk of [...note.chunks].sort(
        (left, right) => left.ordinal - right.ordinal,
      )) {
        const links = parseKnowledgeMarkdownLinks(chunk.content, {
          sourcePath: note.locator.path,
          knownNotes,
        });
        for (const link of links) {
          const targetId =
            link.resolution.status === "resolved"
              ? link.resolution.note.id
              : null;
          const target = targetId ? (noteById.get(targetId) ?? null) : null;
          result.push({
            namespace,
            sourceDocumentId: note.documentId,
            sourceDocumentVersionId: note.documentVersionId,
            sourceDisplayName: note.displayName,
            sourcePath: note.locator.path,
            sourcePermission: note.permission,
            sourceChecksum: note.checksum,
            sourceChunkId: chunk.chunkId,
            sourceChunkOrdinal: chunk.ordinal,
            sourceText: chunk.content,
            link,
            targetDocumentId: target?.documentId ?? null,
            targetDocumentVersionId: target?.documentVersionId ?? null,
            targetDisplayName: target?.displayName ?? null,
            targetPath: target?.locator.path ?? null,
            targetPermission: target?.permission ?? null,
          });
        }
      }
    }
  }

  return result.sort(
    (left, right) =>
      compareText(left.sourceDocumentId, right.sourceDocumentId) ||
      left.sourceChunkOrdinal - right.sourceChunkOrdinal ||
      left.link.sourceLocation.startOffset -
        right.link.sourceLocation.startOffset ||
      compareText(left.link.rawTarget, right.link.rawTarget),
  );
}
