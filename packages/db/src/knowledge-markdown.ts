/**
 * Extracts safe, in-vault structural note references from Markdown.
 *
 * These references are navigation structure only; they do not establish
 * factual truth. HTTPS source provenance belongs in the separate sourceRef
 * field and is intentionally not represented by this module.
 */

export interface KnowledgeMarkdownKnownNote {
  /** Vault-relative note path, normally ending in `.md`. */
  path: string;
  /** Optional caller-supplied stable note identifier. */
  id?: string;
}

export interface ParseKnowledgeMarkdownLinksOptions {
  /** Vault-relative path of the Markdown document being parsed. */
  sourcePath: string;
  /** Only these caller-scoped notes are considered during resolution. */
  knownNotes: readonly KnowledgeMarkdownKnownNote[];
}

export type KnowledgeMarkdownLookupMethod = "id" | "path" | "basename";

export interface KnowledgeMarkdownNoteCandidate {
  path: string;
  id: string | null;
}

export type KnowledgeMarkdownLinkResolution =
  | {
      status: "resolved";
      method: KnowledgeMarkdownLookupMethod;
      note: KnowledgeMarkdownNoteCandidate;
    }
  | {
      status: "unresolved";
      method: KnowledgeMarkdownLookupMethod;
    }
  | {
      status: "ambiguous";
      method: KnowledgeMarkdownLookupMethod;
      candidates: readonly KnowledgeMarkdownNoteCandidate[];
    };

export interface KnowledgeMarkdownSourceLocation {
  /** Zero-based UTF-16 offset at the start of the link. */
  startOffset: number;
  /** Exclusive zero-based UTF-16 offset after the complete link. */
  endOffset: number;
  /** One-based line number. */
  line: number;
  /** One-based UTF-16 column number. */
  column: number;
}

export interface KnowledgeMarkdownStructuralLink {
  syntax: "obsidian" | "markdown";
  /** Original target text, including an anchor when one was written. */
  rawTarget: string;
  /** Normalized target path relative to the vault root, before note resolution. */
  normalizedVaultRelativeTarget: string;
  /** Decoded anchor without the leading `#`, or null when absent. */
  anchor: string | null;
  /** Visible Markdown link label; null for Obsidian wikilinks. */
  label: string | null;
  /** Obsidian wikilink alias; null for ordinary Markdown links. */
  alias: string | null;
  sourceLocation: KnowledgeMarkdownSourceLocation;
  resolution: KnowledgeMarkdownLinkResolution;
}

interface ParsedTarget {
  normalizedPath: string;
  anchor: string | null;
}

interface IndexedKnownNote {
  note: KnowledgeMarkdownNoteCandidate;
  pathKey: string;
}

const MARKDOWN_ESCAPE_PUNCTUATION =
  /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~ ])/gu;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;

/**
 * Parses Obsidian wikilinks and inline Markdown links to caller-known notes.
 * External URLs, images, absolute paths, and paths escaping the vault root are
 * omitted. No files or URLs are read, and `markdown` is never modified.
 */
export function parseKnowledgeMarkdownLinks(
  markdown: string,
  options: ParseKnowledgeMarkdownLinksOptions,
): KnowledgeMarkdownStructuralLink[] {
  const visible = new Uint8Array(markdown.length);
  visible.fill(1);
  maskFencedCode(markdown, visible);
  maskInlineCode(markdown, visible);

  const sourcePath = normalizeVaultPath(options.sourcePath, []);
  const knownNotes = indexKnownNotes(options.knownNotes);
  const lineStarts = findLineStarts(markdown);
  const links: KnowledgeMarkdownStructuralLink[] = [];

  for (let index = 0; index < markdown.length;) {
    if (!visible[index]) {
      index += 1;
      continue;
    }

    if (markdown.startsWith("[[", index) && !isEscaped(markdown, index)) {
      const wiki = parseObsidianLink(markdown, visible, index);
      if (!wiki) {
        index += 1;
        continue;
      }
      if (isEmbeddedImage(markdown, index)) {
        index = wiki.end;
        continue;
      }

      const target = parseTarget(wiki.rawTarget, "obsidian", sourcePath);
      if (target) {
        links.push({
          syntax: "obsidian",
          rawTarget: wiki.rawTarget,
          normalizedVaultRelativeTarget: target.normalizedPath,
          anchor: target.anchor,
          label: null,
          alias: wiki.alias,
          sourceLocation: sourceLocation(lineStarts, index, wiki.end),
          resolution: resolveTarget(
            target.normalizedPath,
            "obsidian",
            knownNotes,
          ),
        });
      }
      index = wiki.end;
      continue;
    }

    if (
      markdown[index] === "!" &&
      !isEscaped(markdown, index) &&
      markdown[index + 1] === "["
    ) {
      const image = parseMarkdownLink(markdown, visible, index + 1);
      if (image) {
        index = image.end;
        continue;
      }
    }

    if (
      markdown[index] === "[" &&
      !isEscaped(markdown, index) &&
      !isMarkdownImage(markdown, index)
    ) {
      const markdownLink = parseMarkdownLink(markdown, visible, index);
      if (markdownLink) {
        const target = parseTarget(
          markdownLink.rawTarget,
          "markdown",
          sourcePath,
        );
        if (target) {
          links.push({
            syntax: "markdown",
            rawTarget: markdownLink.rawTarget,
            normalizedVaultRelativeTarget: target.normalizedPath,
            anchor: target.anchor,
            label: markdown.slice(index + 1, markdownLink.labelEnd),
            alias: null,
            sourceLocation: sourceLocation(lineStarts, index, markdownLink.end),
            resolution: resolveTarget(
              target.normalizedPath,
              "markdown",
              knownNotes,
            ),
          });
          index = markdownLink.end;
          continue;
        }
        index = markdownLink.end;
        continue;
      }
    }

    index += 1;
  }

  return links;
}

function maskFencedCode(markdown: string, visible: Uint8Array): void {
  let offset = 0;
  let fenceCharacter: "`" | "~" | null = null;
  let fenceLength = 0;

  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline < 0 ? markdown.length : newline + 1;
    const contentEnd =
      newline >= 0 && markdown[newline - 1] === "\r"
        ? newline - 1
        : newline >= 0
          ? newline
          : markdown.length;
    const line = markdown.slice(offset, contentEnd);
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];

    if (fenceCharacter) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line)?.[1];
      if (closing?.[0] === fenceCharacter && closing.length >= fenceLength) {
        fenceCharacter = null;
        fenceLength = 0;
      }
      visible.fill(0, offset, lineEnd);
    } else if (marker) {
      const markerCharacter = marker[0] as "`" | "~";
      const markerTail = line.slice(line.indexOf(marker) + marker.length);
      if (markerCharacter !== "`" || !markerTail.includes("`")) {
        fenceCharacter = markerCharacter;
        fenceLength = marker.length;
        visible.fill(0, offset, lineEnd);
      }
    }

    offset = lineEnd;
  }
}

function maskInlineCode(markdown: string, visible: Uint8Array): void {
  for (let index = 0; index < markdown.length;) {
    if (
      !visible[index] ||
      markdown[index] !== "`" ||
      isEscaped(markdown, index)
    ) {
      index += 1;
      continue;
    }

    const openingEnd = countRun(markdown, index, "`");
    const closingStart = findMatchingBacktickRun(
      markdown,
      visible,
      openingEnd,
      openingEnd - index,
    );
    if (closingStart < 0) {
      index = openingEnd;
      continue;
    }
    const closingEnd = closingStart + (openingEnd - index);
    visible.fill(0, index, closingEnd);
    index = closingEnd;
  }
}

function findMatchingBacktickRun(
  markdown: string,
  visible: Uint8Array,
  from: number,
  runLength: number,
): number {
  for (let index = from; index < markdown.length;) {
    if (!visible[index]) return -1;
    if (markdown[index] !== "`" || isEscaped(markdown, index)) {
      index += 1;
      continue;
    }
    const end = countRun(markdown, index, "`");
    if (end - index === runLength) return index;
    index = end;
  }
  return -1;
}

function countRun(value: string, start: number, character: string): number {
  let end = start;
  while (value[end] === character) end += 1;
  return end;
}

function parseObsidianLink(
  markdown: string,
  visible: Uint8Array,
  start: number,
): { rawTarget: string; alias: string | null; end: number } | null {
  for (let index = start + 2; index < markdown.length - 1; index += 1) {
    if (
      visible[index] &&
      markdown[index] === "]" &&
      markdown[index + 1] === "]" &&
      visible[index + 1] &&
      !isEscaped(markdown, index)
    ) {
      const body = markdown.slice(start + 2, index);
      const aliasSeparator = findUnescapedCharacter(body, "|");
      const rawTarget =
        aliasSeparator < 0 ? body : body.slice(0, aliasSeparator);
      const alias =
        aliasSeparator < 0
          ? null
          : body.slice(aliasSeparator + 1).trim() || null;
      return { rawTarget, alias, end: index + 2 };
    }
    if (!visible[index]) return null;
  }
  return null;
}

function parseMarkdownLink(
  markdown: string,
  visible: Uint8Array,
  start: number,
): { labelEnd: number; rawTarget: string; end: number } | null {
  let depth = 1;
  let labelEnd = -1;
  for (let index = start + 1; index < markdown.length; index += 1) {
    if (!visible[index]) continue;
    if (isEscaped(markdown, index)) {
      index += 1;
      continue;
    }
    if (markdown[index] === "[") depth += 1;
    if (markdown[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = index;
        break;
      }
    }
  }
  if (labelEnd < 0 || markdown[labelEnd + 1] !== "(") return null;

  let index = labelEnd + 2;
  while (isMarkdownWhitespace(markdown[index])) index += 1;
  const targetStart = index;
  let rawTarget: string;

  if (markdown[index] === "<") {
    index += 1;
    const contentStart = index;
    while (index < markdown.length) {
      if (markdown[index] === ">" && !isEscaped(markdown, index)) break;
      if (markdown[index] === "\n" || markdown[index] === "\r") return null;
      index += 1;
    }
    if (markdown[index] !== ">") return null;
    rawTarget = markdown.slice(contentStart, index);
    index += 1;
  } else {
    let parenthesisDepth = 0;
    while (index < markdown.length) {
      const character = markdown[index];
      if (isEscaped(markdown, index)) {
        index += 2;
        continue;
      }
      if (isMarkdownWhitespace(character)) break;
      if (character === "(") {
        parenthesisDepth += 1;
        index += 1;
        continue;
      }
      if (character === ")") {
        if (parenthesisDepth === 0) break;
        parenthesisDepth -= 1;
      }
      index += 1;
    }
    if (parenthesisDepth !== 0) return null;
    rawTarget = markdown.slice(targetStart, index);
  }

  while (isMarkdownWhitespace(markdown[index])) index += 1;
  if (markdown[index] === '"' || markdown[index] === "'") {
    const quote = markdown[index];
    index += 1;
    while (index < markdown.length) {
      if (markdown[index] === quote && !isEscaped(markdown, index)) break;
      index += 1;
    }
    if (markdown[index] !== quote) return null;
    index += 1;
    while (isMarkdownWhitespace(markdown[index])) index += 1;
  } else if (markdown[index] === "(") {
    index += 1;
    while (index < markdown.length && markdown[index] !== ")") index += 1;
    if (markdown[index] !== ")") return null;
    index += 1;
    while (isMarkdownWhitespace(markdown[index])) index += 1;
  }

  if (markdown[index] !== ")") return null;
  return { labelEnd, rawTarget, end: index + 1 };
}

function isMarkdownWhitespace(value: string | undefined): boolean {
  return value !== undefined && /[\t\n\r ]/u.test(value);
}

function isMarkdownImage(markdown: string, bracketStart: number): boolean {
  return (
    bracketStart > 0 &&
    markdown[bracketStart - 1] === "!" &&
    !isEscaped(markdown, bracketStart - 1)
  );
}

function isEmbeddedImage(markdown: string, linkStart: number): boolean {
  return (
    linkStart > 0 &&
    markdown[linkStart - 1] === "!" &&
    !isEscaped(markdown, linkStart - 1)
  );
}

function parseTarget(
  rawTarget: string,
  syntax: "obsidian" | "markdown",
  sourcePath: string | null,
): ParsedTarget | null {
  const raw = rawTarget.trim();
  const anchorStart = findUnescapedCharacter(raw, "#");
  const rawPath = anchorStart < 0 ? raw : raw.slice(0, anchorStart);
  const rawAnchor = anchorStart < 0 ? null : raw.slice(anchorStart + 1);

  let decodedPath: string;
  let decodedAnchor: string | null;
  try {
    decodedPath = decodeURIComponent(unescapeMarkdownPunctuation(rawPath));
    decodedAnchor =
      rawAnchor === null
        ? null
        : decodeURIComponent(unescapeMarkdownPunctuation(rawAnchor));
  } catch {
    return null;
  }

  const path = decodedPath.trim();
  if (
    path.includes("?") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.startsWith("//") ||
    WINDOWS_DRIVE_PATH.test(path) ||
    URI_SCHEME.test(path)
  ) {
    return null;
  }

  const base =
    syntax === "markdown" && path.length > 0
      ? sourceDirectorySegments(sourcePath)
      : [];
  if (syntax === "markdown" && path.length > 0 && base === null) return null;
  const normalizedPath = normalizeVaultPath(path, base ?? []);
  if (normalizedPath === null) return null;

  if (!normalizedPath && syntax === "markdown") {
    if (!sourcePath) return null;
    return { normalizedPath: sourcePath, anchor: decodedAnchor };
  }
  if (!normalizedPath) return null;

  return { normalizedPath, anchor: decodedAnchor };
}

function unescapeMarkdownPunctuation(value: string): string {
  return value.replace(MARKDOWN_ESCAPE_PUNCTUATION, "$1");
}

function findUnescapedCharacter(value: string, character: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === character && !isEscaped(value, index)) return index;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function normalizeVaultPath(
  value: string,
  baseSegments: readonly string[],
): string | null {
  const decoded = unescapeMarkdownPunctuation(value.trim());
  if (
    decoded.includes("\u0000") ||
    decoded.startsWith("/") ||
    decoded.startsWith("\\") ||
    WINDOWS_DRIVE_PATH.test(decoded) ||
    URI_SCHEME.test(decoded)
  ) {
    return null;
  }

  const segments = [...baseSegments];
  for (const segment of decoded.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function sourceDirectorySegments(sourcePath: string | null): string[] | null {
  if (!sourcePath) return null;
  const normalized = normalizeVaultPath(sourcePath, []);
  if (!normalized) return null;
  const segments = normalized.split("/");
  segments.pop();
  return segments;
}

function indexKnownNotes(
  knownNotes: readonly KnowledgeMarkdownKnownNote[],
): IndexedKnownNote[] {
  const indexed: IndexedKnownNote[] = [];
  for (const candidate of knownNotes) {
    const path = normalizeVaultPath(candidate.path, []);
    if (!path) continue;
    indexed.push({
      note: { path, id: candidate.id?.trim() || null },
      pathKey: path,
    });
  }
  return indexed;
}

function resolveTarget(
  normalizedPath: string,
  syntax: "obsidian" | "markdown",
  knownNotes: readonly IndexedKnownNote[],
): KnowledgeMarkdownLinkResolution {
  const idCandidates = uniqueCandidates(
    knownNotes.filter(({ note }) => note.id === normalizedPath),
  );
  const pathCandidates = uniqueCandidates(
    knownNotes.filter(({ pathKey }) => pathsMatch(pathKey, normalizedPath)),
  );
  if (idCandidates.length > 0 || pathCandidates.length > 0) {
    const exactCandidates = uniqueCandidates([
      ...idCandidates.map((note) => ({ note, pathKey: note.path })),
      ...pathCandidates.map((note) => ({ note, pathKey: note.path })),
    ]);
    return makeResolution(
      exactCandidates,
      pathCandidates.length > 0 ? "path" : "id",
    );
  }

  if (syntax === "obsidian" && !normalizedPath.includes("/")) {
    const basename = noteBasename(normalizedPath);
    const basenameCandidates = uniqueCandidates(
      knownNotes.filter(({ pathKey }) => noteBasename(pathKey) === basename),
    );
    return makeResolution(basenameCandidates, "basename");
  }

  return { status: "unresolved", method: "path" };
}

function makeResolution(
  candidates: readonly KnowledgeMarkdownNoteCandidate[],
  method: KnowledgeMarkdownLookupMethod,
): KnowledgeMarkdownLinkResolution {
  const sorted = [...candidates].sort(compareCandidates);
  if (sorted.length === 1) {
    return { status: "resolved", method, note: sorted[0]! };
  }
  if (sorted.length === 0) return { status: "unresolved", method };
  return { status: "ambiguous", method, candidates: sorted };
}

function uniqueCandidates(
  notes: readonly IndexedKnownNote[],
): KnowledgeMarkdownNoteCandidate[] {
  const unique = new Map<string, KnowledgeMarkdownNoteCandidate>();
  for (const { note } of notes) {
    const key = `${note.path}\u0000${note.id ?? ""}`;
    unique.set(key, note);
  }
  return [...unique.values()];
}

function compareCandidates(
  left: KnowledgeMarkdownNoteCandidate,
  right: KnowledgeMarkdownNoteCandidate,
): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  const leftId = left.id ?? "";
  const rightId = right.id ?? "";
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
}

function pathsMatch(knownPath: string, targetPath: string): boolean {
  return (
    knownPath === targetPath ||
    stripMarkdownExtension(knownPath) === stripMarkdownExtension(targetPath)
  );
}

function noteBasename(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return stripMarkdownExtension(filename);
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.(?:md|markdown)$/iu, "");
}

function findLineStarts(markdown: string): number[] {
  const starts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function sourceLocation(
  lineStarts: readonly number[],
  startOffset: number,
  endOffset: number,
): KnowledgeMarkdownSourceLocation {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((lineStarts[middle] ?? Number.POSITIVE_INFINITY) <= startOffset)
      low = middle + 1;
    else high = middle;
  }
  const lineIndex = low - 1;
  const lineStart = lineStarts[lineIndex] ?? 0;
  return {
    startOffset,
    endOffset,
    line: lineIndex + 1,
    column: startOffset - lineStart + 1,
  };
}
