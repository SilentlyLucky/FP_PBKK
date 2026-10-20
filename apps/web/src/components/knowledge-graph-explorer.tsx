"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronDown, Filter, Search, X } from "lucide-react";
import styles from "./knowledge-graph-explorer.module.css";

export interface KnowledgeGraphEvidence {
  id: string;
  quote: string;
  documentName: string;
  documentVersion: number;
  documentVersionId: string;
  chunkId: string;
  checksum: string;
  sourceRef?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  pageNumber?: number | null;
}

export interface KnowledgeGraphAssertion {
  id: string;
  subject: string;
  subjectType: string;
  predicate: string;
  object: string;
  objectType: string;
  evidence: KnowledgeGraphEvidence[];
}

interface GraphNodeData extends Record<string, unknown> {
  label: string;
  entityType: string;
  connectedCount: number;
  cluster: number;
}

type GraphNode = Node<GraphNodeData>;
type GraphEdge = Edge<{ assertion: KnowledgeGraphAssertion }>;

interface Props {
  assertions: KnowledgeGraphAssertion[];
  hasSnapshot: boolean;
  isStale: boolean;
  sourceIds: string[];
  onOpenSource: (sourceId: string) => void;
  onBuildGraph: () => void;
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("id-ID").replace(/\s+/gu, " ");
}

function entityKey(label: string, entityType: string) {
  return `${normalize(entityType)}:${normalize(label)}`;
}

function buildGraph(assertions: KnowledgeGraphAssertion[]) {
  const entities = new Map<string, { label: string; entityType: string }>();
  const edgeRows = assertions.filter(
    (assertion) => assertion.subject.trim() && assertion.object.trim(),
  );
  const adjacency = new Map<string, Set<string>>();
  for (const assertion of edgeRows) {
    const subject = entityKey(assertion.subject, assertion.subjectType);
    const object = entityKey(assertion.object, assertion.objectType);
    entities.set(subject, {
      label: assertion.subject,
      entityType: assertion.subjectType,
    });
    entities.set(object, {
      label: assertion.object,
      entityType: assertion.objectType,
    });
    if (!adjacency.has(subject)) adjacency.set(subject, new Set());
    if (!adjacency.has(object)) adjacency.set(object, new Set());
    adjacency.get(subject)?.add(object);
    adjacency.get(object)?.add(subject);
  }

  const visited = new Set<string>();
  const clusters: string[][] = [];
  for (const entityId of [...entities.keys()].sort()) {
    if (visited.has(entityId)) continue;
    const cluster: string[] = [];
    const pending = [entityId];
    visited.add(entityId);
    while (pending.length) {
      const next = pending.shift();
      if (!next) continue;
      cluster.push(next);
      for (const neighbor of [...(adjacency.get(next) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    clusters.push(cluster.sort());
  }
  clusters.sort(
    (a, b) =>
      b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""),
  );

  const clusterByEntity = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusters.length)));
  clusters.forEach((cluster, clusterIndex) => {
    const centerX = 180 + (clusterIndex % columns) * 390;
    const centerY = 120 + Math.floor(clusterIndex / columns) * 330;
    cluster.forEach((entityId, index) => {
      clusterByEntity.set(entityId, clusterIndex);
      const angle = (2 * Math.PI * index) / Math.max(cluster.length, 1);
      const radius = Math.max(0, Math.min(150, 42 * Math.sqrt(cluster.length)));
      positions.set(entityId, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });
    });
  });

  const nodes: GraphNode[] = [...entities.entries()].map(([id, entity]) => {
    const neighbors = adjacency.get(id)?.size ?? 0;
    return {
      id,
      type: "knowledgeEntity",
      position: positions.get(id) ?? { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        label: entity.label,
        entityType: entity.entityType || "Entitas",
        connectedCount: neighbors,
        cluster: clusterByEntity.get(id) ?? 0,
      },
    };
  });
  const edges: GraphEdge[] = edgeRows.map((assertion) => ({
    id: assertion.id,
    source: entityKey(assertion.subject, assertion.subjectType),
    target: entityKey(assertion.object, assertion.objectType),
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
    label: assertion.predicate,
    labelStyle: { fill: "#475569", fontSize: 10 },
    labelBgStyle: { fill: "#fff", fillOpacity: 0.9 },
    style: { stroke: "#b9c9e1", strokeWidth: 1.5 },
    data: { assertion },
  }));
  return {
    nodes,
    edges,
    types: [...new Set(nodes.map((node) => node.data.entityType))].sort(),
    clusterCount: clusters.length,
  };
}

function EntityNode({ data, selected }: NodeProps<GraphNode>) {
  return (
    <div
      className={`${styles.entityNode} ${selected ? styles.entityNodeSelected : ""}`}
      title={`${data.label} · ${data.entityType} · ${data.connectedCount} relasi`}
    >
      <Handle type="target" position={Position.Top} className={styles.handle} />
      <strong>{data.label}</strong>
      <span>{data.entityType}</span>
      <Handle type="source" position={Position.Bottom} className={styles.handle} />
    </div>
  );
}

const nodeTypes = { knowledgeEntity: EntityNode };

function GraphCanvas({ assertions, hasSnapshot, isStale, sourceIds, onOpenSource, onBuildGraph }: Props) {
  const graph = useMemo(() => buildGraph(assertions), [assertions]);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>(graph.edges);
  const [search, setSearch] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setEdges, setNodes]);

  const visibleTypes = selectedTypes.length ? selectedTypes : graph.types;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const relatedNodeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const related = new Set<string>();
    for (const edge of edges) {
      if (edge.source === selectedNodeId) related.add(edge.target);
      if (edge.target === selectedNodeId) related.add(edge.source);
    }
    return related;
  }, [edges, selectedNodeId]);

  const displayedNodes = useMemo(() => {
    const query = normalize(search);
    const hasMatch = query
      ? nodes.some((node) => normalize(node.data.label).includes(query))
      : false;
    return nodes.map((node) => {
      const typeHidden = !visibleTypes.includes(node.data.entityType);
      const match = !query || normalize(node.data.label).includes(query);
      const focusMatch = !selectedNodeId || node.id === selectedNodeId || relatedNodeIds.has(node.id);
      return {
        ...node,
        hidden: typeHidden,
        style: { opacity: (hasMatch && !match) || !focusMatch ? 0.28 : 1 },
      };
    });
  }, [nodes, relatedNodeIds, search, selectedNodeId, visibleTypes]);

  const displayedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const selected = edge.id === selectedEdgeId;
        const hidden =
          !visibleTypes.includes(
            nodes.find((node) => node.id === edge.source)?.data.entityType ?? "",
          ) ||
          !visibleTypes.includes(
            nodes.find((node) => node.id === edge.target)?.data.entityType ?? "",
          );
        return {
          ...edge,
          hidden,
          style: {
            stroke: selected ? "#2563eb" : "#b9c9e1",
            strokeWidth: selected ? 2.5 : 1.5,
          },
          label: selected ? edge.label : undefined,
        };
      }),
    [edges, nodes, selectedEdgeId, visibleTypes],
  );

  const handleNodeClick = useCallback((_: MouseEvent, node: GraphNode) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, []);
  const handleEdgeClick = useCallback((_: MouseEvent, edge: GraphEdge) => {
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
    setInspectorOpen(true);
  }, []);

  const toggleType = (entityType: string) => {
    setSelectedTypes((current) =>
      current.includes(entityType)
        ? current.filter((value) => value !== entityType)
        : [...current, entityType],
    );
  };

  const selectedAssertion = selectedEdge?.data?.assertion;
  const nodeAssertions = selectedNode
    ? assertions.filter((assertion) => {
        const subject = entityKey(assertion.subject, assertion.subjectType);
        const object = entityKey(assertion.object, assertion.objectType);
        return subject === selectedNode.id || object === selectedNode.id;
      })
    : [];
  const evidence = selectedAssertion?.evidence ?? nodeAssertions.flatMap((item) => item.evidence);

  if (!hasSnapshot || assertions.length === 0) {
    return (
      <div className={styles.graphEmpty} role="status">
        <div className={styles.graphEmptyIcon}>G</div>
        <h3>Knowledge Graph belum tersedia</h3>
        <p>
          {!hasSnapshot
            ? "Belum ada snapshot graph aktif untuk proyek ini. Tambahkan sumber lalu bangun graph untuk melihat relasinya."
            : "Snapshot aktif belum memiliki relasi terverifikasi dengan bukti sumber."}
        </p>
        <button type="button" className={styles.emptyAction} onClick={onBuildGraph}>
          Lihat kesiapan pembuatan graph
        </button>
      </div>
    );
  }

  return (
    <div className={styles.graphShell}>
      {isStale ? (
        <div className={styles.staleNotice} role="status">
          Snapshot graph belum mencakup perubahan sumber terbaru.
        </div>
      ) : null}
      <div className={styles.graphToolbar}>
        <label className={styles.search}>
          <Search aria-hidden="true" size={15} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari entitas atau konsep…"
            aria-label="Cari node graph"
          />
          {search ? (
            <button type="button" onClick={() => setSearch("")} aria-label="Hapus pencarian">
              <X aria-hidden="true" size={14} />
            </button>
          ) : null}
        </label>
        <details className={styles.filters}>
          <summary>
            <Filter aria-hidden="true" size={14} /> Tipe node <ChevronDown aria-hidden="true" size={13} />
          </summary>
          <div className={styles.filterMenu}>
            <label>
              <input
                type="checkbox"
                checked={selectedTypes.length === 0}
                onChange={() => setSelectedTypes([])}
              />
              Semua tipe
            </label>
            {graph.types.map((entityType) => (
              <label key={entityType}>
                <input
                  type="checkbox"
                  checked={selectedTypes.includes(entityType)}
                  onChange={() => toggleType(entityType)}
                />
                {entityType}
              </label>
            ))}
          </div>
        </details>
        <span className={styles.graphCount}>
          {nodes.length} node · {edges.length} relasi · {graph.clusterCount} kelompok terhubung
        </span>
        <button
          type="button"
          className={styles.inspectorToggle}
          aria-expanded={inspectorOpen}
          onClick={() => setInspectorOpen((open) => !open)}
        >
          {inspectorOpen ? "Tutup detail" : "Tampilkan detail"}
        </button>
      </div>
      <div className={`${styles.graphWorkspace} ${!inspectorOpen ? styles.graphWorkspaceWide : ""}`}>
        <div className={styles.canvas} aria-label="Canvas knowledge graph">
          <ReactFlow
            nodes={displayedNodes}
            edges={displayedEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.24, minZoom: 0.25, maxZoom: 1.2 }}
            minZoom={0.15}
            maxZoom={2.2}
            proOptions={{ hideAttribution: true }}
            aria-label="Knowledge Graph interaktif"
          >
            <Background color="#dbe4f0" gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor="#3b82f6"
              maskColor="rgb(248 250 252 / 72%)"
            />
          </ReactFlow>
        </div>
        {inspectorOpen ? (
          <aside className={styles.inspector} aria-label="Detail graph terpilih">
            {selectedNode ? (
              <>
                <div className={styles.inspectorHeader}>
                  <div>
                    <span>NODE</span>
                    <h3>{selectedNode.data.label}</h3>
                  </div>
                  <button type="button" onClick={() => setSelectedNodeId(null)} aria-label="Tutup detail node">
                    <X aria-hidden="true" size={16} />
                  </button>
                </div>
                <dl className={styles.nodeFacts}>
                  <div><dt>Tipe</dt><dd>{selectedNode.data.entityType}</dd></div>
                  <div><dt>Relasi langsung</dt><dd>{selectedNode.data.connectedCount}</dd></div>
                  <div><dt>Kelompok terhubung</dt><dd>{selectedNode.data.cluster + 1}</dd></div>
                </dl>
                <section className={styles.inspectorSection}>
                  <h4>Relasi terkait ({nodeAssertions.length})</h4>
                  <ul className={styles.relatedList}>
                    {nodeAssertions.slice(0, 8).map((assertion) => (
                      <li key={assertion.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedNodeId(null);
                            setSelectedEdgeId(assertion.id);
                          }}
                        >
                          <span>{assertion.subject} <em>{assertion.predicate}</em> {assertion.object}</span>
                          <small>{assertion.evidence.length} bukti</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <EvidenceList evidence={evidence} sourceIds={sourceIds} onOpenSource={onOpenSource} />
              </>
            ) : selectedAssertion ? (
              <>
                <div className={styles.inspectorHeader}>
                  <div>
                    <span>RELASI TERVERIFIKASI</span>
                    <h3>{selectedAssertion.predicate}</h3>
                  </div>
                  <button type="button" onClick={() => setSelectedEdgeId(null)} aria-label="Tutup detail relasi">
                    <X aria-hidden="true" size={16} />
                  </button>
                </div>
                <p className={styles.statement}>
                  <strong>{selectedAssertion.subject}</strong> {selectedAssertion.predicate} <strong>{selectedAssertion.object}</strong>
                </p>
                <EvidenceList evidence={evidence} sourceIds={sourceIds} onOpenSource={onOpenSource} />
              </>
            ) : (
              <div className={styles.inspectorEmpty}>
                <strong>Pilih node atau relasi</strong>
                <p>Detail dan kutipan sumber yang mendukung relasi akan tampil di sini.</p>
              </div>
            )}
            <p className={styles.clusterNote}>
              Kelompok diturunkan dari konektivitas pada snapshot ini; ini bukan folder proyek.
            </p>
          </aside>
        ) : null}
      </div>
      <div className={styles.legend} aria-label="Legenda graph">
        <span><i /> Node adalah entitas tersimpan</span>
        <span><b /> Panah adalah relasi dengan bukti aktif</span>
        <span>Kelompok: komponen yang saling terhubung</span>
      </div>
    </div>
  );
}

function EvidenceList({
  evidence,
  sourceIds,
  onOpenSource,
}: {
  evidence: KnowledgeGraphEvidence[];
  sourceIds: string[];
  onOpenSource: (sourceId: string) => void;
}) {
  return (
    <section className={styles.inspectorSection}>
      <h4>Bukti sumber ({evidence.length})</h4>
      {evidence.length ? (
        <ul className={styles.evidenceList}>
          {evidence.slice(0, 6).map((item) => (
            <li key={item.id}>
              <strong>{item.sourceTitle || item.documentName}</strong>
              <small>v{item.documentVersion}{item.pageNumber ? ` · halaman ${item.pageNumber}` : ""}</small>
              <blockquote>{item.quote}</blockquote>
              {item.sourceRef && sourceIds.includes(item.sourceRef) ? (
                <button type="button" onClick={() => onOpenSource(item.sourceRef!)}>
                  Lihat sumber
                </button>
              ) : item.sourceUrl?.startsWith("https://") ? (
                <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                  Buka sumber rujukan
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>Tidak ada kutipan untuk relasi ini.</p>
      )}
    </section>
  );
}

export function KnowledgeGraphExplorer(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
