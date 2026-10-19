import { describe, expect, it } from "vitest";

import {
  GraphifyImportError,
  graphifyConfidenceRequiresReview,
  parseGraphifyExportImport,
} from "./graphify-export.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const chunkId = "33333333-3333-4333-8333-333333333333";
const checksum = "a".repeat(64);

function fixture() {
  return {
    graph: {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: "src_a_caller",
          label: "caller",
          file_type: "code",
          source_file: "src/a.ts",
          source_location: "L1",
        },
        {
          id: "src_a_callee",
          label: "callee",
          file_type: "code",
          source_file: "src/a.ts",
          source_location: "L2",
        },
      ],
      links: [
        {
          source: "src_a_caller",
          target: "src_a_callee",
          relation: "calls",
          source_file: "src/a.ts",
          source_location: "L1",
          confidence: "EXTRACTED",
          confidence_score: 1,
          key: 0,
        },
      ],
    },
    selectedSources: [{ documentId, documentVersionId: versionId, checksum }],
    nodeBindings: [
      {
        nodeId: "src_a_caller",
        sourceFile: "src/a.ts",
        documentId,
        documentVersionId: versionId,
        checksum,
        chunkId,
        spanStart: 0,
        spanEnd: 6,
      },
      {
        nodeId: "src_a_callee",
        sourceFile: "src/a.ts",
        documentId,
        documentVersionId: versionId,
        checksum,
        chunkId,
        spanStart: 7,
        spanEnd: 13,
      },
    ],
    linkBindings: [
      {
        linkIndex: 0,
        sourceFile: "src/a.ts",
        documentId,
        documentVersionId: versionId,
        checksum,
        chunkId,
        spanStart: 0,
        spanEnd: 13,
      },
    ],
  };
}

describe("Graphify node-link export adapter", () => {
  it("holds inferred, ambiguous, missing, and unknown confidence tiers for review", () => {
    expect(graphifyConfidenceRequiresReview("EXTRACTED")).toBe(false);
    expect(graphifyConfidenceRequiresReview("INFERRED")).toBe(true);
    expect(graphifyConfidenceRequiresReview("AMBIGUOUS")).toBe(true);
    expect(graphifyConfidenceRequiresReview(null)).toBe(true);
    expect(graphifyConfidenceRequiresReview("FUTURE_TIER")).toBe(true);
  });

  it("parses Graphify's nodes/links export and explicit provenance bindings", () => {
    const parsed = parseGraphifyExportImport(fixture());

    expect(parsed).toMatchObject({
      directed: true,
      nodes: [
        { id: "src_a_caller", fileType: "code", sourceLocation: "L1" },
        { id: "src_a_callee", fileType: "code", sourceLocation: "L2" },
      ],
      links: [
        {
          source: "src_a_caller",
          target: "src_a_callee",
          relation: "calls",
          confidence: "EXTRACTED",
          confidenceScore: 1,
        },
      ],
    });
  });

  it("rejects the intermediate extraction shape instead of guessing its schema", () => {
    const value = fixture() as unknown as Record<string, unknown>;
    const graph = value.graph as Record<string, unknown>;
    graph.edges = graph.links;
    delete graph.links;

    expect(() => parseGraphifyExportImport(value)).toThrow(GraphifyImportError);
  });

  it("rejects unresolved endpoints and missing endpoint bindings", () => {
    const unboundEndpoint = fixture();
    unboundEndpoint.graph.links[0]!.target = "missing-node";
    expect(() => parseGraphifyExportImport(unboundEndpoint)).toThrow(
      expect.objectContaining({ code: "GRAPHIFY_ENDPOINT_UNBOUND" }),
    );

    const missingNodeBinding = fixture();
    missingNodeBinding.nodeBindings.pop();
    expect(() => parseGraphifyExportImport(missingNodeBinding)).toThrow(
      expect.objectContaining({ code: "GRAPHIFY_NODE_UNBOUND" }),
    );
  });

  it("rejects mismatched source paths, versions, and ambiguous bindings", () => {
    const wrongPath = fixture();
    wrongPath.nodeBindings[0]!.sourceFile = "src/other.ts";
    expect(() => parseGraphifyExportImport(wrongPath)).toThrow(
      expect.objectContaining({ code: "GRAPHIFY_NODE_BINDING_MISMATCH" }),
    );

    const wrongVersion = fixture();
    wrongVersion.linkBindings[0]!.documentVersionId =
      "44444444-4444-4444-8444-444444444444";
    expect(() => parseGraphifyExportImport(wrongVersion)).toThrow(
      expect.objectContaining({ code: "GRAPHIFY_SOURCE_NOT_SELECTED" }),
    );

    const duplicateBinding = fixture();
    duplicateBinding.nodeBindings[1] = { ...duplicateBinding.nodeBindings[0]! };
    expect(() => parseGraphifyExportImport(duplicateBinding)).toThrow(
      expect.objectContaining({ code: "GRAPHIFY_NODE_BINDING_AMBIGUOUS" }),
    );
  });

  it("rejects Graphify hyperedges that the runtime graph cannot represent", () => {
    const value = fixture() as unknown as Record<string, unknown>;
    value.hyperedges = [
      { id: "group", nodes: ["src_a_caller", "src_a_callee"] },
    ];

    expect(() => parseGraphifyExportImport(value)).toThrow(
      expect.objectContaining({ code: "GRAPHIFY_HYPEREDGES_UNSUPPORTED" }),
    );
  });
});
