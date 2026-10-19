/**
 * Small adapter for Graphify's graph.json node-link export. It intentionally
 * accepts data, not filesystem paths, and requires caller supplied provenance
 * bindings before the database layer can import any node or link.
 */

const MAX_GRAPHIFY_NODES = 2_000;
const MAX_GRAPHIFY_LINKS = 4_000;
const MAX_GRAPHIFY_SOURCES = 20;
const MAX_GRAPHIFY_NODE_SPAN = 500;
const MAX_GRAPHIFY_LINK_SPAN = 2_000;
const GRAPHIFY_FILE_TYPES = new Set([
  "code",
  "document",
  "paper",
  "image",
  "rationale",
  "concept",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;

/**
 * A Graphify export's declared confidence tier describes how it claims to
 * have produced a relation, not whether its citation entails that relation.
 * Only EXTRACTED edges are eligible for navigation before human review.
 */
export function graphifyConfidenceRequiresReview(
  confidence: string | null,
): boolean {
  return confidence !== "EXTRACTED";
}

export class GraphifyImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "GraphifyImportError";
  }
}

export interface GraphifySelectedSource {
  documentId: string;
  documentVersionId: string;
  checksum: string;
}

interface GraphifyBinding extends GraphifySelectedSource {
  sourceFile: string;
  chunkId: string;
  spanStart: number;
  spanEnd: number;
}

export interface GraphifyNodeBinding extends GraphifyBinding {
  nodeId: string;
}

export interface GraphifyLinkBinding extends GraphifyBinding {
  linkIndex: number;
}

export interface GraphifyExportNode {
  id: string;
  label: string;
  fileType: string;
  sourceFile: string;
  sourceLocation: string | null;
}

export interface GraphifyExportLink {
  source: string;
  target: string;
  relation: string;
  sourceFile: string;
  sourceLocation: string | null;
  confidence: string | null;
  confidenceScore: number | null;
}

export interface GraphifyExportImport {
  directed: boolean;
  nodes: GraphifyExportNode[];
  links: GraphifyExportLink[];
  selectedSources: GraphifySelectedSource[];
  nodeBindings: GraphifyNodeBinding[];
  linkBindings: GraphifyLinkBinding[];
}

function invalid(message: string, code = "GRAPHIFY_EXPORT_INVALID"): never {
  throw new GraphifyImportError(code, message);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value.includes("\u0000")
  ) {
    invalid(`Graphify ${field} is missing or invalid.`);
  }
  return value;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    invalid(`${field} must be a UUID.`);
  }
  return value;
}

function parseSelectedSources(value: unknown): GraphifySelectedSource[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_GRAPHIFY_SOURCES
  ) {
    invalid(`Select between one and ${MAX_GRAPHIFY_SOURCES} source versions.`);
  }
  const result: GraphifySelectedSource[] = [];
  const documents = new Set<string>();
  const versions = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = object(item);
    if (!row) invalid(`selectedSources[${index}] must be an object.`);
    const documentId = requiredId(
      row.documentId,
      `selectedSources[${index}].documentId`,
    );
    const documentVersionId = requiredId(
      row.documentVersionId,
      `selectedSources[${index}].documentVersionId`,
    );
    if (typeof row.checksum !== "string" || !SHA256.test(row.checksum)) {
      invalid(`selectedSources[${index}].checksum must be a SHA-256 digest.`);
    }
    if (documents.has(documentId) || versions.has(documentVersionId)) {
      invalid("A selected document or version appears more than once.");
    }
    documents.add(documentId);
    versions.add(documentVersionId);
    result.push({ documentId, documentVersionId, checksum: row.checksum });
  }
  return result;
}

function parseBinding(
  value: unknown,
  field: string,
  maximumSpan: number,
): GraphifyBinding {
  const row = object(value);
  if (!row) invalid(`${field} must be an object.`);
  const sourceFile = requiredText(row.sourceFile, `${field}.sourceFile`, 2_048);
  const documentId = requiredId(row.documentId, `${field}.documentId`);
  const documentVersionId = requiredId(
    row.documentVersionId,
    `${field}.documentVersionId`,
  );
  const chunkId = requiredId(row.chunkId, `${field}.chunkId`);
  if (typeof row.checksum !== "string" || !SHA256.test(row.checksum)) {
    invalid(`${field}.checksum must be a SHA-256 digest.`);
  }
  if (
    typeof row.spanStart !== "number" ||
    !Number.isSafeInteger(row.spanStart) ||
    row.spanStart < 0 ||
    typeof row.spanEnd !== "number" ||
    !Number.isSafeInteger(row.spanEnd) ||
    row.spanEnd <= row.spanStart ||
    row.spanEnd - row.spanStart > maximumSpan
  ) {
    invalid(`${field} must include a bounded, non-empty source chunk span.`);
  }
  return {
    sourceFile,
    documentId,
    documentVersionId,
    checksum: row.checksum,
    chunkId,
    spanStart: row.spanStart,
    spanEnd: row.spanEnd,
  };
}

function parseNodeBindings(
  value: unknown,
  nodes: readonly GraphifyExportNode[],
): GraphifyNodeBinding[] {
  if (!Array.isArray(value) || value.length !== nodes.length) {
    invalid(
      "Every Graphify node needs exactly one explicit source binding.",
      "GRAPHIFY_NODE_UNBOUND",
    );
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const row = object(item);
    if (!row) invalid(`nodeBindings[${index}] must be an object.`);
    const nodeId = requiredText(
      row.nodeId,
      `nodeBindings[${index}].nodeId`,
      512,
    );
    const node = nodesById.get(nodeId);
    if (!node || seen.has(nodeId)) {
      invalid(
        "A node binding is duplicated or does not resolve to one Graphify node.",
        "GRAPHIFY_NODE_BINDING_AMBIGUOUS",
      );
    }
    const binding = parseBinding(
      row,
      `nodeBindings[${index}]`,
      MAX_GRAPHIFY_NODE_SPAN,
    );
    if (binding.sourceFile !== node.sourceFile) {
      invalid(
        "A node binding does not match the node's Graphify source_file.",
        "GRAPHIFY_NODE_BINDING_MISMATCH",
      );
    }
    seen.add(nodeId);
    return { ...binding, nodeId };
  });
}

function parseLinkBindings(
  value: unknown,
  links: readonly GraphifyExportLink[],
): GraphifyLinkBinding[] {
  if (!Array.isArray(value) || value.length !== links.length) {
    invalid(
      "Every Graphify link needs exactly one explicit source binding.",
      "GRAPHIFY_LINK_UNBOUND",
    );
  }
  const seen = new Set<number>();
  return value.map((item, index) => {
    const row = object(item);
    if (!row) invalid(`linkBindings[${index}] must be an object.`);
    if (
      typeof row.linkIndex !== "number" ||
      !Number.isSafeInteger(row.linkIndex) ||
      row.linkIndex < 0 ||
      row.linkIndex >= links.length ||
      seen.has(row.linkIndex)
    ) {
      invalid(
        "A link binding index is duplicated or does not resolve to one Graphify link.",
        "GRAPHIFY_LINK_BINDING_AMBIGUOUS",
      );
    }
    const binding = parseBinding(
      row,
      `linkBindings[${index}]`,
      MAX_GRAPHIFY_LINK_SPAN,
    );
    if (binding.sourceFile !== links[row.linkIndex]!.sourceFile) {
      invalid(
        "A link binding does not match the link's Graphify source_file.",
        "GRAPHIFY_LINK_BINDING_MISMATCH",
      );
    }
    seen.add(row.linkIndex);
    return { ...binding, linkIndex: row.linkIndex };
  });
}

function parseSourceLocation(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, field, 200);
}

export function parseGraphifyExportImport(
  value: unknown,
): GraphifyExportImport {
  const request = object(value);
  if (!request) invalid("The Graphify import body must be an object.");
  const graph = object(request.graph);
  if (
    !graph ||
    typeof graph.directed !== "boolean" ||
    typeof graph.multigraph !== "boolean" ||
    !object(graph.graph) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.links)
  ) {
    invalid(
      "graph must use Graphify's NetworkX node-link graph.json shape with nodes and links.",
    );
  }
  if (
    graph.nodes.length < 1 ||
    graph.nodes.length > MAX_GRAPHIFY_NODES ||
    graph.links.length > MAX_GRAPHIFY_LINKS
  ) {
    invalid(
      `Graphify graph limits are ${MAX_GRAPHIFY_NODES} nodes and ${MAX_GRAPHIFY_LINKS} links.`,
    );
  }
  const graphAttributes = graph.graph as Record<string, unknown>;
  const topLevelHyperedges = Array.isArray(request.hyperedges)
    ? request.hyperedges
    : [];
  const graphHyperedges = Array.isArray(graphAttributes.hyperedges)
    ? graphAttributes.hyperedges
    : [];
  if (topLevelHyperedges.length > 0 || graphHyperedges.length > 0) {
    invalid(
      "Graphify hyperedges are not supported by this adapter.",
      "GRAPHIFY_HYPEREDGES_UNSUPPORTED",
    );
  }

  const nodes: GraphifyExportNode[] = [];
  const nodeIds = new Set<string>();
  for (const [index, item] of graph.nodes.entries()) {
    const row = object(item);
    if (!row) invalid(`graph.nodes[${index}] must be an object.`);
    const id = requiredText(row.id, `graph.nodes[${index}].id`, 512);
    if (nodeIds.has(id)) {
      invalid(
        "Graphify node IDs must be unique.",
        "GRAPHIFY_NODE_ID_AMBIGUOUS",
      );
    }
    const fileType = requiredText(
      row.file_type,
      `graph.nodes[${index}].file_type`,
      40,
    );
    if (!GRAPHIFY_FILE_TYPES.has(fileType)) {
      invalid(
        `graph.nodes[${index}].file_type is not in Graphify's export schema.`,
      );
    }
    nodeIds.add(id);
    nodes.push({
      id,
      label: requiredText(row.label, `graph.nodes[${index}].label`, 500),
      fileType,
      sourceFile: requiredText(
        row.source_file,
        `graph.nodes[${index}].source_file`,
        2_048,
      ),
      sourceLocation: parseSourceLocation(
        row.source_location,
        `graph.nodes[${index}].source_location`,
      ),
    });
  }

  const links: GraphifyExportLink[] = [];
  for (const [index, item] of graph.links.entries()) {
    const row = object(item);
    if (!row) invalid(`graph.links[${index}] must be an object.`);
    const source = requiredText(
      row.source,
      `graph.links[${index}].source`,
      512,
    );
    const target = requiredText(
      row.target,
      `graph.links[${index}].target`,
      512,
    );
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      invalid(
        "Every Graphify link endpoint must resolve to exactly one exported node.",
        "GRAPHIFY_ENDPOINT_UNBOUND",
      );
    }
    const confidence =
      row.confidence === null || row.confidence === undefined
        ? null
        : requiredText(row.confidence, `graph.links[${index}].confidence`, 40);
    const confidenceScore =
      row.confidence_score === null || row.confidence_score === undefined
        ? null
        : row.confidence_score;
    if (
      confidenceScore !== null &&
      (typeof confidenceScore !== "number" ||
        !Number.isFinite(confidenceScore) ||
        confidenceScore < 0 ||
        confidenceScore > 1)
    ) {
      invalid(
        `graph.links[${index}].confidence_score must be between zero and one.`,
      );
    }
    links.push({
      source,
      target,
      relation: requiredText(
        row.relation,
        `graph.links[${index}].relation`,
        120,
      ),
      sourceFile: requiredText(
        row.source_file,
        `graph.links[${index}].source_file`,
        2_048,
      ),
      sourceLocation: parseSourceLocation(
        row.source_location,
        `graph.links[${index}].source_location`,
      ),
      confidence,
      confidenceScore,
    });
  }

  const selectedSources = parseSelectedSources(request.selectedSources);
  const nodeBindings = parseNodeBindings(request.nodeBindings, nodes);
  const linkBindings = parseLinkBindings(request.linkBindings, links);
  const selectedByVersion = new Map(
    selectedSources.map((source) => [source.documentVersionId, source]),
  );
  const usedVersions = new Set<string>();
  for (const binding of [...nodeBindings, ...linkBindings]) {
    const selected = selectedByVersion.get(binding.documentVersionId);
    if (
      !selected ||
      selected.documentId !== binding.documentId ||
      selected.checksum !== binding.checksum
    ) {
      invalid(
        "Every node and link binding must use an explicitly selected source version and checksum.",
        "GRAPHIFY_SOURCE_NOT_SELECTED",
      );
    }
    usedVersions.add(binding.documentVersionId);
  }
  if (usedVersions.size !== selectedSources.length) {
    invalid(
      "selectedSources must contain exactly the source versions used by the explicit bindings.",
      "GRAPHIFY_SOURCE_SELECTION_MISMATCH",
    );
  }

  const linkIndices = new Set(linkBindings.map((binding) => binding.linkIndex));
  if (linkIndices.size !== links.length) {
    invalid(
      "Every Graphify link must have exactly one unambiguous binding.",
      "GRAPHIFY_LINK_UNBOUND",
    );
  }
  return {
    directed: graph.directed,
    nodes,
    links,
    selectedSources,
    nodeBindings,
    linkBindings,
  };
}
