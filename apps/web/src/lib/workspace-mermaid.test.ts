import { describe, expect, it } from "vitest";

import { parseMermaidFlowchart } from "./workspace-mermaid.js";

describe("safe Mermaid flowchart preview", () => {
  it("parses a labeled decision flow into bounded nodes and edges", () => {
    const diagram = parseMermaidFlowchart(`flowchart TD
      A[Permintaan] --> B{Sumber dipilih?}
      B -->|Ya| C[Gunakan konteks]
      B -->|Tidak| D[Jawab langsung]`);

    expect(diagram).toMatchObject({
      direction: "TB",
      nodes: [
        { id: "A", label: "Permintaan", shape: "rectangle" },
        { id: "B", label: "Sumber dipilih?", shape: "decision" },
        { id: "C", label: "Gunakan konteks", shape: "rectangle" },
        { id: "D", label: "Jawab langsung", shape: "rectangle" },
      ],
      edges: [
        { from: "A", to: "B", label: null },
        { from: "B", to: "C", label: "Ya" },
        { from: "B", to: "D", label: "Tidak" },
      ],
    });
    expect(diagram?.width).toBeGreaterThan(0);
    expect(diagram?.height).toBeGreaterThan(0);
  });

  it("supports a left-to-right sequence and forward node declarations", () => {
    const diagram = parseMermaidFlowchart(`graph LR
      A --> B --> C
      A[Mulai]
      C(Celah)`);

    expect(diagram).toMatchObject({
      direction: "LR",
      nodes: [
        { id: "A", label: "Mulai" },
        { id: "B", label: "B" },
        { id: "C", label: "Celah", shape: "rounded" },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    });
  });

  it.each([
    "sequenceDiagram\nA->>B: hi",
    "flowchart TD\nsubgraph private\nA --> B\nend",
    "flowchart TD\nA --> B\nB --> A",
    `flowchart TD\n${Array.from({ length: 30 }, (_, index) => `N${index} --> N${index + 1}`).join("\n")}`,
  ])(
    "returns no preview for unsupported, cyclic, or oversized syntax: %s",
    (source) => {
      expect(parseMermaidFlowchart(source)).toBeNull();
    },
  );

  it("keeps labels as plain text and ignores Mermaid comments", () => {
    const diagram = parseMermaidFlowchart(`flowchart TD
      A[<script>alert(1)</script>] --> B[Jawaban]
      %% comment`);

    expect(diagram?.nodes[0]?.label).toBe("<script>alert(1)</script>");
  });
});
