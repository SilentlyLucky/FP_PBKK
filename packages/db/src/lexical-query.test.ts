import { describe, expect, it } from "vitest";

import { lexicalTaskTerms } from "./lexical-query.ts";

describe("lexical query tokenization", () => {
  it("keeps a single-digit arithmetic anchor and deduplicates repeated operands", () => {
    expect(lexicalTaskTerms("Berapa 2+2?")).toEqual(["2"]);
  });

  it("drops Indonesian attribution framing without losing the numeric anchor", () => {
    expect(lexicalTaskTerms("Menurut dokumen, berapa 2+2?")).toEqual(["2"]);
  });

  it("keeps distinct multi-digit and word terms for ordinary lexical queries", () => {
    expect(lexicalTaskTerms("Sebutkan harga paket 2026 dan 2026")).toEqual([
      "sebutkan",
      "harga",
      "paket",
      "2026",
    ]);
  });
});
