export type FlowchartDirection = "TB" | "LR";
export type FlowchartNodeShape = "rectangle" | "rounded" | "decision";

export interface FlowchartNode {
  id: string;
  label: string;
  shape: FlowchartNodeShape;
  x: number;
  y: number;
}

export interface FlowchartEdge {
  from: string;
  to: string;
  label: string | null;
}

export interface MermaidFlowchart {
  direction: FlowchartDirection;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  width: number;
  height: number;
}

const MAX_SOURCE_LENGTH = 12_000;
const MAX_NODES = 28;
const MAX_EDGES = 40;
const NODE_TOKEN =
  /[A-Za-z][A-Za-z0-9_-]{0,39}(?:\[[^\]\n]{1,120}\]|\([^\)\n]{1,120}\)|\{[^}\n]{1,120}\})?/uy;
const SHAPE_SIZE = { width: 184, height: 58 };

function parseNode(token: string): Omit<FlowchartNode, "x" | "y"> | null {
  const match =
    /^([A-Za-z][A-Za-z0-9_-]{0,39})([\[({])?([\s\S]*?)([\])}]?)$/u.exec(token);
  if (!match) return null;

  const id = match[1] ?? "";
  if (!id) return null;
  const opening = match[2] ?? "";
  const rawLabel = match[3] ?? "";
  const closing = match[4] ?? "";
  if (
    opening &&
    !(
      (opening === "[" && closing === "]") ||
      (opening === "(" && closing === ")") ||
      (opening === "{" && closing === "}")
    )
  )
    return null;

  let label = rawLabel.trim();
  if (label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1);
  if (label.length > 100) return null;
  const shape: FlowchartNodeShape =
    opening === "{" ? "decision" : opening === "(" ? "rounded" : "rectangle";
  return { id, label: label || id, shape };
}

function addNode(
  nodes: Map<string, Omit<FlowchartNode, "x" | "y">>,
  token: string,
): string | null {
  const parsed = parseNode(token);
  if (!parsed) return null;
  const existing = nodes.get(parsed.id);
  if (existing && parsed.label === parsed.id) return parsed.id;
  nodes.set(parsed.id, parsed);
  return parsed.id;
}

function layoutFlowchart(
  direction: FlowchartDirection,
  nodeMap: Map<string, Omit<FlowchartNode, "x" | "y">>,
  edges: FlowchartEdge[],
): MermaidFlowchart | null {
  const nodeIds = [...nodeMap.keys()];
  const ranks = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const queue = nodeIds.filter((id) => incoming.get(id) === 0);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift();
    if (!id) continue;
    processed += 1;
    for (const target of outgoing.get(id) ?? []) {
      ranks.set(
        target,
        Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1),
      );
      const degree = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  }
  if (processed !== nodeIds.length) return null;

  const rankGroups = new Map<number, string[]>();
  for (const id of nodeIds) {
    const rank = ranks.get(id) ?? 0;
    rankGroups.set(rank, [...(rankGroups.get(rank) ?? []), id]);
  }
  const rankCount = Math.max(1, ...rankGroups.keys()) + 1;
  const largestRank = Math.max(
    ...[...rankGroups.values()].map((group) => group.length),
  );
  const gap = 48;
  const crossGap = 52;
  const nodes: FlowchartNode[] = [];

  for (const [rank, group] of rankGroups) {
    group.forEach((id, index) => {
      const x =
        direction === "TB"
          ? 28 + index * (SHAPE_SIZE.width + gap)
          : 28 + rank * (SHAPE_SIZE.width + crossGap);
      const y =
        direction === "TB"
          ? 24 + rank * (SHAPE_SIZE.height + crossGap)
          : 24 + index * (SHAPE_SIZE.height + crossGap);
      const node = nodeMap.get(id);
      if (node) nodes.push({ ...node, x, y });
    });
  }

  return {
    direction,
    nodes,
    edges,
    width:
      direction === "TB"
        ? 56 + largestRank * (SHAPE_SIZE.width + gap) - gap
        : 56 + rankCount * (SHAPE_SIZE.width + crossGap) - crossGap,
    height:
      direction === "TB"
        ? 48 + rankCount * (SHAPE_SIZE.height + crossGap) - crossGap
        : 48 + largestRank * (SHAPE_SIZE.height + crossGap) - crossGap,
  };
}

/**
 * Parses a deliberately small, safe Mermaid flowchart subset. Unsupported
 * Mermaid syntax stays visible as copyable source instead of being executed.
 */
export function parseMermaidFlowchart(source: string): MermaidFlowchart | null {
  if (source.length > MAX_SOURCE_LENGTH) return null;
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const header = /^\s*(?:flowchart|graph)\s+(TB|TD|LR)\s*$/iu.exec(
    lines[0] ?? "",
  );
  if (!header) return null;
  const direction: FlowchartDirection =
    header[1]?.toUpperCase() === "LR" ? "LR" : "TB";
  const nodes = new Map<string, Omit<FlowchartNode, "x" | "y">>();
  const edges: FlowchartEdge[] = [];

  for (const sourceLine of lines.slice(1)) {
    const commentIndex = sourceLine.indexOf("%%");
    const line = (
      commentIndex >= 0 ? sourceLine.slice(0, commentIndex) : sourceLine
    ).trim();
    if (!line) continue;

    let cursor = 0;
    let previous: string | null = null;
    let pendingEdgeLabel: string | null = null;
    let tokenCount = 0;
    while (cursor < line.length) {
      while (/\s/u.test(line[cursor] ?? "")) cursor += 1;
      if (cursor >= line.length) break;
      NODE_TOKEN.lastIndex = cursor;
      const tokenMatch = NODE_TOKEN.exec(line);
      if (!tokenMatch || tokenMatch.index !== cursor) return null;
      const token = tokenMatch[0];
      const current = addNode(nodes, token);
      if (!current) return null;
      if (previous) {
        edges.push({ from: previous, to: current, label: pendingEdgeLabel });
        if (edges.length > MAX_EDGES) return null;
      } else if (line.slice(0, cursor).trim()) {
        return null;
      }
      previous = current;
      cursor = NODE_TOKEN.lastIndex;
      tokenCount += 1;
      if (nodes.size > MAX_NODES) return null;

      while (/\s/u.test(line[cursor] ?? "")) cursor += 1;
      if (cursor >= line.length) break;
      const connector = /^(?:-->|==>|-\.->)\s*(?:\|([^|\n]{1,60})\|)?/u.exec(
        line.slice(cursor),
      );
      if (!connector) return null;
      pendingEdgeLabel = connector[1]?.trim() || null;
      cursor += connector[0].length;
    }
    if (!tokenCount) return null;
  }

  if (!nodes.size) return null;
  return layoutFlowchart(direction, nodes, edges);
}
