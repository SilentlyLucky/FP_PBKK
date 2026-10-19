import { describe, expect, it } from "vitest";

import {
  GRAPH_RETRIEVAL_HARD_BOUNDS,
  findBoundedGraphPaths,
  resolveGraphSeeds,
  type GraphEdge,
} from "./graph-retrieval.js";

function edge(
  id: string,
  subjectId: string,
  subjectLabel: string,
  objectId: string,
  objectLabel: string,
  types: { subject?: string; object?: string } = {},
): GraphEdge {
  return {
    assertionId: `assertion-${id}`,
    assertionVersionId: `version-${id}`,
    subjectId,
    subjectLabel,
    subjectType: types.subject ?? "Component",
    subjectAliases: [],
    predicate: "uses",
    objectId,
    objectLabel,
    objectType: types.object ?? "Component",
    objectAliases: [],
    direction: "directed",
    qualifiers: {},
    evidence: [],
  };
}

describe("bounded graph traversal", () => {
  it("follows directed edges and skips cycles", () => {
    const paths = findBoundedGraphPaths({
      query: "Service Alpha Queue Beta",
      edges: [
        edge("ab", "a", "Service Alpha", "b", "Queue Beta"),
        edge("ba", "b", "Queue Beta", "a", "Service Alpha"),
      ],
      seedIds: ["a"],
      bounds: { maxHops: 2 },
    });

    expect(paths.paths.map((path) => path.entityIds)).toEqual([["a", "b"]]);
    expect(paths.clipping.cycleSkips).toBe(1);
    expect(
      findBoundedGraphPaths({
        query: "Service Alpha Queue Beta",
        edges: [edge("ab", "a", "Service Alpha", "b", "Queue Beta")],
        seedIds: ["b"],
        bounds: { maxHops: 2 },
      }).paths,
    ).toHaveLength(0);
  });

  it("caps neighbors and visited nodes for each bounded expansion", () => {
    const result = findBoundedGraphPaths({
      query: "Service Alpha Queue Beta Queue Gamma Queue Delta",
      edges: [
        edge("ab", "a", "Service Alpha", "b", "Queue Beta"),
        edge("ac", "a", "Service Alpha", "c", "Queue Gamma"),
        edge("ad", "a", "Service Alpha", "d", "Queue Delta"),
      ],
      seedIds: ["a"],
      bounds: { maxHops: 1, maxNeighborsPerExpansion: 1, maxNodes: 1 },
    });

    expect(result.paths).toHaveLength(0);
    expect(result.clipping.neighborClips).toBe(2);
    expect(result.clipping.nodeClips).toBe(1);
  });

  it("caps seed count at two and path depth at two hops", () => {
    const result = findBoundedGraphPaths({
      query: "Seed Alpha Middle Target Seed Beta Seed Gamma",
      edges: [
        edge("a1", "seed-a", "Seed Alpha", "middle-a", "Middle Alpha"),
        edge("a2", "middle-a", "Middle Alpha", "target-a", "Target Alpha"),
        edge("a3", "target-a", "Target Alpha", "overflow-a", "Overflow Alpha"),
        edge("b1", "seed-b", "Seed Beta", "middle-b", "Middle Beta"),
        edge("b2", "middle-b", "Middle Beta", "target-b", "Target Beta"),
        edge("c1", "seed-c", "Seed Gamma", "target-c", "Target Gamma"),
      ],
      seedIds: ["seed-a", "seed-b", "seed-c"],
      bounds: {
        maxHops: GRAPH_RETRIEVAL_HARD_BOUNDS.maxHops + 1,
        maxNeighborsPerExpansion:
          GRAPH_RETRIEVAL_HARD_BOUNDS.maxNeighborsPerExpansion + 1,
        maxNodes: GRAPH_RETRIEVAL_HARD_BOUNDS.maxNodes + 1,
        maxEdges: GRAPH_RETRIEVAL_HARD_BOUNDS.maxEdges + 1,
        maxPaths: GRAPH_RETRIEVAL_HARD_BOUNDS.maxPaths + 1,
      },
    });

    expect(result.paths.every((path) => path.seedId !== "seed-c")).toBe(true);
    expect(
      Math.max(...result.paths.map((path) => path.edgeIds.length)),
    ).toBeLessThanOrEqual(2);
  });

  it("caps each expansion at twenty neighbors", () => {
    const result = findBoundedGraphPaths({
      query: "Root Alpha Node",
      edges: Array.from({ length: 21 }, (_, index) =>
        edge(
          `root-${index}`,
          "root",
          "Root Alpha",
          `node-${index}`,
          `Node ${index}`,
        ),
      ),
      seedIds: ["root"],
      bounds: {
        maxNeighborsPerExpansion:
          GRAPH_RETRIEVAL_HARD_BOUNDS.maxNeighborsPerExpansion + 1,
      },
    });

    expect(result.clipping.neighborClips).toBe(1);
  });

  it("caps the traversal at thirty visited nodes", () => {
    const firstHop = Array.from({ length: 20 }, (_, index) =>
      edge(
        `root-middle-${index}`,
        "root",
        "Root Alpha",
        `middle-${index}`,
        `Middle ${index}`,
      ),
    );
    const secondHop = Array.from({ length: 20 }, (_, index) =>
      edge(
        `middle-target-${index}`,
        `middle-${index}`,
        `Middle ${index}`,
        `target-${index}`,
        `Target ${index}`,
      ),
    );
    const result = findBoundedGraphPaths({
      query: "Root Alpha Middle Target",
      edges: [...firstHop, ...secondHop],
      seedIds: ["root"],
      bounds: { maxNodes: GRAPH_RETRIEVAL_HARD_BOUNDS.maxNodes + 1 },
    });

    expect(result.clipping.visitedNodes).toBe(30);
    expect(result.clipping.nodeClips).toBeGreaterThan(0);
  });

  it("caps traversal at sixty unique edges", () => {
    const middleIds = Array.from(
      { length: 20 },
      (_, index) => `middle-${index}`,
    );
    const firstHop = middleIds.map((middleId, index) =>
      edge(`root-${index}`, "root", "Root Alpha", middleId, `Middle ${index}`),
    );
    const secondHop = middleIds.flatMap((subjectId, subjectIndex) =>
      middleIds.flatMap((objectId, objectIndex) =>
        subjectIndex === objectIndex
          ? []
          : [
              edge(
                `middle-${subjectIndex}-${objectIndex}`,
                subjectId,
                `Middle ${subjectIndex}`,
                objectId,
                `Middle ${objectIndex}`,
              ),
            ],
      ),
    );
    const result = findBoundedGraphPaths({
      query: "Root Alpha Middle",
      edges: [...firstHop, ...secondHop],
      seedIds: ["root"],
      bounds: { maxEdges: GRAPH_RETRIEVAL_HARD_BOUNDS.maxEdges + 1 },
    });

    expect(result.clipping.visitedEdges).toBe(60);
    expect(result.clipping.edgeClips).toBeGreaterThan(0);
  });

  it("returns no more than three graph paths", () => {
    const result = findBoundedGraphPaths({
      query: "Root Alpha Leaf",
      edges: Array.from({ length: 4 }, (_, index) =>
        edge(
          `root-leaf-${index}`,
          "root",
          "Root Alpha",
          `leaf-${index}`,
          `Leaf ${index}`,
        ),
      ),
      seedIds: ["root"],
      bounds: { maxPaths: GRAPH_RETRIEVAL_HARD_BOUNDS.maxPaths + 1 },
    });

    expect(result.paths).toHaveLength(3);
    expect(result.clipping.pathLimitApplied).toBe(true);
  });

  it("refuses ambiguous same-name candidates across entity types", () => {
    const result = resolveGraphSeeds("Queue", [
      edge("one", "component", "Queue", "other", "Order Store"),
      edge("two", "organization", "Queue", "other-two", "Inventory", {
        subject: "Organization",
      }),
    ]);

    expect(result.seeds).toEqual([]);
    expect(result.ambiguousLabels).toContain("Queue");
  });
});
