import { describe, expect, it } from "vitest";

import { KnowledgeOperationError } from "@promptlab/db";
import { extractPdfKnowledgePages } from "./pdf-knowledge.ts";
import { parseKnowledgeSourceForm } from "./knowledge-api.ts";

function makeTextPdf(pages: string[]): Uint8Array {
  const pageIds = pages.map((_, index) => index + 3);
  const fontId = pageIds.length + 3;
  const contentIds = pages.map((_, index) => fontId + index + 1);
  const objects = new Map<number, string>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  for (let index = 0; index < pages.length; index += 1) {
    const pageId = pageIds[index]!;
    const contentId = contentIds[index]!;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000000 300] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
  }
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let index = 0; index < pages.length; index += 1) {
    const textOperators = (pages[index]!.match(/[\s\S]{1,500}/gu) ?? [""])
      .map((part) => {
        const escaped = part
          .replaceAll("\\", "\\\\")
          .replaceAll("(", "\\(")
          .replaceAll(")", "\\)");
        return `1 0 0 1 72 200 Tm (${escaped}) Tj`;
      })
      .join(" ");
    const stream = `BT /F1 12 Tf ${textOperators} ET`;
    objects.set(
      contentIds[index]!,
      `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}\nendstream`,
    );
  }

  let output = Buffer.from("%PDF-1.4\n", "binary");
  const offsets = [0];
  for (let id = 1; id <= objects.size; id += 1) {
    offsets[id] = output.byteLength;
    output = Buffer.concat([
      output,
      Buffer.from(`${id} 0 obj\n${objects.get(id)}\nendobj\n`, "binary"),
    ]);
  }
  const xrefOffset = output.byteLength;
  const xref = [
    `xref\n0 ${objects.size + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  return new Uint8Array(Buffer.concat([output, Buffer.from(xref, "binary")]));
}

function uploadRequest(bytes: Uint8Array, type = "application/pdf"): Request {
  const form = new FormData();
  const fileBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(fileBytes).set(bytes);
  form.set("sourceKind", "upload");
  form.set("permission", "local_only");
  form.set("file", new File([fileBytes], "fixture.pdf", { type }));
  return new Request("http://localhost/api/knowledge", {
    method: "POST",
    body: form,
  });
}

describe("Knowledge PDF intake", () => {
  it("extracts text from every page and retains page numbers", async () => {
    const pages = await extractPdfKnowledgePages(
      makeTextPdf(["First page evidence", "Second page evidence"]),
    );
    expect(pages).toEqual([
      { pageNumber: 1, content: "First page evidence" },
      { pageNumber: 2, content: "Second page evidence" },
    ]);
  });

  it("accepts a PDF upload through the existing multipart intake", async () => {
    const rawBytes = makeTextPdf(["PDF source provenance"]);
    const parsed = await parseKnowledgeSourceForm(
      uploadRequest(rawBytes),
    );
    expect(parsed).toMatchObject({
      displayName: "fixture.pdf",
      content: "PDF source provenance",
      contentType: "application/pdf",
      sourceKind: "upload",
      permission: "local_only",
      pages: [{ pageNumber: 1, content: "PDF source provenance" }],
    });
    expect(parsed.rawBytes).toEqual(rawBytes);
  });

  it("rejects missing text layers instead of silently dropping pages", async () => {
    await expect(
      extractPdfKnowledgePages(makeTextPdf([""])),
    ).rejects.toMatchObject({
      code: "SOURCE_PDF_TEXT_MISSING",
    });
  });

  it("enforces page and extracted-text limits", async () => {
    await expect(
      extractPdfKnowledgePages(
        makeTextPdf(
          Array.from({ length: 51 }, (_, index) => `Page ${index + 1}`),
        ),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_PDF_PAGE_LIMIT" });
    await expect(
      extractPdfKnowledgePages(makeTextPdf(["x".repeat(98_305)])),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });

  it("requires the PDF MIME type before extraction", async () => {
    await expect(
      parseKnowledgeSourceForm(
        uploadRequest(makeTextPdf(["text"]), "application/octet-stream"),
      ),
    ).rejects.toBeInstanceOf(KnowledgeOperationError);
  });

  it("passes a vault-relative Markdown locator separately from sourceRef", async () => {
    const form = new FormData();
    form.set("sourceKind", "paste");
    form.set("permission", "local_only");
    form.set("displayName", "guide.md");
    form.set("content", "[[Overview|Read the overview]]");
    form.set("sourceRef", "https://example.org/guide");
    form.set("vaultPath", "notes/guide.md");

    const parsed = await parseKnowledgeSourceForm(
      new Request("http://localhost/api/knowledge", {
        method: "POST",
        body: form,
      }),
    );

    expect(parsed.sourceRef).toBe("https://example.org/guide");
    expect(parsed.vaultLocator).toEqual({ path: "notes/guide.md" });
    expect(parsed.rawBytes).toEqual(
      new TextEncoder().encode("[[Overview|Read the overview]]"),
    );
  });
});
