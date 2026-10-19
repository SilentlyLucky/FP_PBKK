import { describe, expect, it } from "vitest";

import { parseKnowledgeMarkdownLinks } from "./knowledge-markdown.ts";

describe("pure Markdown note links", () => {
  it("parses Obsidian aliases and resolves relative Markdown paths and anchors", () => {
    const markdown =
      "[[Getting Started#First steps|Start here]]\n[Read the note](../shared/guide.md#Setup)";
    const links = parseKnowledgeMarkdownLinks(markdown, {
      sourcePath: "notes/source.md",
      knownNotes: [
        { id: "getting-started", path: "notes/Getting Started.md" },
        { id: "guide", path: "shared/guide.md" },
      ],
    });

    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      syntax: "obsidian",
      rawTarget: "Getting Started#First steps",
      normalizedVaultRelativeTarget: "Getting Started",
      anchor: "First steps",
      label: null,
      alias: "Start here",
      sourceLocation: {
        startOffset: 0,
        line: 1,
        column: 1,
      },
      resolution: {
        status: "resolved",
        note: { id: "getting-started", path: "notes/Getting Started.md" },
      },
    });
    expect(links[1]).toMatchObject({
      syntax: "markdown",
      rawTarget: "../shared/guide.md#Setup",
      normalizedVaultRelativeTarget: "shared/guide.md",
      anchor: "Setup",
      label: "Read the note",
      alias: null,
      sourceLocation: {
        startOffset: markdown.indexOf("[Read"),
        line: 2,
        column: 1,
      },
      resolution: {
        status: "resolved",
        note: { id: "guide", path: "shared/guide.md" },
      },
    });
    expect(links[1]?.sourceLocation.endOffset).toBe(markdown.length);
  });

  it("resolves caller-supplied IDs and marks basename ambiguity and misses", () => {
    const links = parseKnowledgeMarkdownLinks(
      "[[stable-id]] [[decision]] [[missing]]",
      {
        sourcePath: "notes/current.md",
        knownNotes: [
          { id: "stable-id", path: "reference/stable.md" },
          { id: "decision-a", path: "decisions/decision.md" },
          { id: "decision-b", path: "archive/decision.md" },
        ],
      },
    );

    expect(links[0]?.resolution).toEqual({
      status: "resolved",
      method: "id",
      note: { id: "stable-id", path: "reference/stable.md" },
    });
    expect(links[1]?.resolution).toEqual({
      status: "ambiguous",
      method: "basename",
      candidates: [
        { id: "decision-b", path: "archive/decision.md" },
        { id: "decision-a", path: "decisions/decision.md" },
      ],
    });
    expect(links[2]?.resolution).toEqual({
      status: "unresolved",
      method: "basename",
    });
  });

  it("treats .md and .markdown basename matches consistently", () => {
    const [link] = parseKnowledgeMarkdownLinks("[[Same]]", {
      sourcePath: "index.md",
      knownNotes: [
        { id: "same-md", path: "first/Same.md" },
        { id: "same-markdown", path: "second/Same.markdown" },
      ],
    });

    expect(link?.resolution).toEqual({
      status: "ambiguous",
      method: "basename",
      candidates: [
        { id: "same-md", path: "first/Same.md" },
        { id: "same-markdown", path: "second/Same.markdown" },
      ],
    });
  });

  it("omits links in fenced code, inline code, and image syntax", () => {
    const markdown = [
      "Visible [[known]]",
      "```md",
      "[[fenced]] [link](fenced.md)",
      "```",
      "~~~text",
      "[[tilde-fenced]]",
      "~~~",
      "Inline `[[inline]] [code](inline.md)` stays literal.",
      "![diagram](diagram.md)",
      "![[embedded-image.png]]",
      "[visible](visible.md)",
    ].join("\n");
    const links = parseKnowledgeMarkdownLinks(markdown, {
      sourcePath: "notes/current.md",
      knownNotes: [
        { id: "known", path: "notes/known.md" },
        { id: "visible", path: "notes/visible.md" },
      ],
    });

    expect(links.map((link) => link.rawTarget)).toEqual([
      "known",
      "visible.md",
    ]);
  });

  it("ignores escaped link openers and links nested in image descriptions", () => {
    const markdown = [
      "\\[[escaped-wiki]]",
      "\\[escaped Markdown](hidden.md)",
      "![diagram [nested](hidden.md)](diagram.png)",
      "\\\\[[active-wiki]]",
      "\\\\[active Markdown](visible.md)",
    ].join(" ");
    const links = parseKnowledgeMarkdownLinks(markdown, {
      sourcePath: "notes/current.md",
      knownNotes: [
        { id: "active-wiki", path: "notes/active-wiki.md" },
        { id: "hidden", path: "notes/hidden.md" },
        { id: "visible", path: "notes/visible.md" },
      ],
    });

    expect(links.map((link) => link.rawTarget)).toEqual([
      "active-wiki",
      "visible.md",
    ]);
  });

  it("decodes local URI paths and anchors relative to the source directory", () => {
    const links = parseKnowledgeMarkdownLinks(
      "[space](New%20Note.md#Hello%20there) [root](../root.md)",
      {
        sourcePath: "notes/current.md",
        knownNotes: [
          { id: "space", path: "notes/New Note.md" },
          { id: "root", path: "root.md" },
        ],
      },
    );

    expect(
      links.map((link) => ({
        target: link.normalizedVaultRelativeTarget,
        anchor: link.anchor,
        resolution: link.resolution.status,
      })),
    ).toEqual([
      {
        target: "notes/New Note.md",
        anchor: "Hello there",
        resolution: "resolved",
      },
      { target: "root.md", anchor: null, resolution: "resolved" },
    ]);
  });

  it("rejects traversal, absolute paths, and non-local schemes", () => {
    const markdown = [
      "[escape](../../outside.md)",
      "[[../outside]]",
      "[absolute](/vault/note.md)",
      "[drive](C:/notes/note.md)",
      "[external](https://example.org/note.md)",
      "[encoded external](https%3A%2F%2Fexample.org/note.md)",
      "[encoded escape](%2e%2e/%2e%2e/outside.md)",
      "[mail](mailto:notes@example.org)",
    ].join(" ");

    expect(
      parseKnowledgeMarkdownLinks(markdown, {
        sourcePath: "notes/current.md",
        knownNotes: [{ id: "outside", path: "outside.md" }],
      }),
    ).toEqual([]);
  });

  it("does not modify the input Markdown", () => {
    const markdown = "Before [[note#Heading|Alias]] after.";
    const original = markdown;

    parseKnowledgeMarkdownLinks(markdown, {
      sourcePath: "folder/current.md",
      knownNotes: [{ id: "note", path: "folder/note.md" }],
    });

    expect(markdown).toBe(original);
  });
});
