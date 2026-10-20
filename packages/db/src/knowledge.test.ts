import { describe, expect, it } from "vitest";

import {
  getKnowledgeReferencePack,
  normalizeKnowledgeSourceRef,
} from "./index.ts";

describe("curated Knowledge reference pack", () => {
  it("keeps its bounded source, chunk, and provenance manifest intact", () => {
    const pack = getKnowledgeReferencePack();
    const sourceIds = new Set(pack.publicSources.map((source) => source.id));

    expect(pack.metadata).toMatchObject({
      schema_version: "1.0",
      corpus_id: "promptlab-general-knowledge-seed-2026-10",
      status: "ready",
    });
    expect(pack.publicSources).toHaveLength(9);
    expect(pack.previews).toHaveLength(10);
    for (const source of pack.publicSources) {
      expect(source.url).toMatch(/^https:\/\//u);
      expect(source.publisher).not.toBe("");
      expect(source.accessed_at_utc).toMatch(/Z$/u);
      expect(source.sections_used.length).toBeGreaterThan(0);
      expect(source.license_caveat).not.toBe("");
    }
    for (const chunk of pack.previews) {
      expect(sourceIds.has(chunk.source_id)).toBe(true);
      expect(chunk.summary.trim().split(/\s+/u).length).toBeLessThanOrEqual(140);
      expect(chunk.evidence_excerpt).not.toBe("");
      expect(chunk.source_section).not.toBe("");
    }
  });

  it("canonicalizes HTTPS references and rejects unsafe schemes", () => {
    expect(normalizeKnowledgeSourceRef("https://EXAMPLE.org/a#section")).toBe(
      "https://example.org/a",
    );
    expect(normalizeKnowledgeSourceRef(null)).toBeNull();
    expect(() => normalizeKnowledgeSourceRef("http://example.org/a")).toThrow(
      "URL HTTPS",
    );
    expect(() =>
      normalizeKnowledgeSourceRef("https://user:password@example.org/a"),
    ).toThrow("URL HTTPS");
  });
});
