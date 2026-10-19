import {
  KnowledgeOperationError,
  MAX_KNOWLEDGE_PDF_PAGES,
  MAX_KNOWLEDGE_SOURCE_BYTES,
  type KnowledgePageInput,
} from "@promptlab/db";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPdfKnowledgePages(
  bytes: Uint8Array,
): Promise<KnowledgePageInput[]> {
  if (bytes.byteLength < 8) {
    throw new KnowledgeOperationError(
      "SOURCE_PDF_INVALID",
      "File tidak terbaca sebagai PDF.",
    );
  }
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1_024));
  if (!header.includes("%PDF-")) {
    throw new KnowledgeOperationError(
      "SOURCE_PDF_INVALID",
      "File tidak memiliki header PDF yang valid.",
    );
  }

  const loadingTask = getDocument({
    data: bytes,
    stopAtErrors: true,
    useWasm: false,
    useWorkerFetch: false,
  });
  try {
    const document = await loadingTask.promise;
    if (
      !Number.isSafeInteger(document.numPages) ||
      document.numPages < 1 ||
      document.numPages > MAX_KNOWLEDGE_PDF_PAGES
    ) {
      throw new KnowledgeOperationError(
        "SOURCE_PDF_PAGE_LIMIT",
        `PDF dibatasi ${MAX_KNOWLEDGE_PDF_PAGES} halaman.`,
        { maxPages: MAX_KNOWLEDGE_PDF_PAGES, actualPages: document.numPages },
      );
    }

    const pages: KnowledgePageInput[] = [];
    let extractedBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const textParts: string[] = [];
        const textReader = page.streamTextContent().getReader();
        let pageBytes = 0;
        let itemCount = 0;
        try {
          while (true) {
            const result = await textReader.read();
            if (result.done) break;
            for (const item of result.value.items) {
              if (!("str" in item) || typeof item.str !== "string") continue;
              const separator = itemCount === 0 ? "" : item.hasEOL ? "\n" : " ";
              pageBytes +=
                Buffer.byteLength(separator, "utf8") +
                Buffer.byteLength(item.str, "utf8");
              if (
                extractedBytes + pageBytes + (pages.length ? 2 : 0) >
                MAX_KNOWLEDGE_SOURCE_BYTES
              ) {
                throw new KnowledgeOperationError(
                  "SOURCE_TOO_LARGE",
                  `Teks hasil ekstraksi PDF dibatasi ${MAX_KNOWLEDGE_SOURCE_BYTES} byte.`,
                  {
                    limitBytes: MAX_KNOWLEDGE_SOURCE_BYTES,
                    actualBytes:
                      extractedBytes + pageBytes + (pages.length ? 2 : 0),
                  },
                );
              }
              textParts.push(`${separator}${item.str}`);
              itemCount += 1;
            }
          }
        } finally {
          textReader.releaseLock();
        }
        const text = textParts
          .join("")
          .replace(/[\t ]+\n/gu, "\n")
          .replace(/\n{3,}/gu, "\n\n")
          .trim();
        if (!text) {
          throw new KnowledgeOperationError(
            "SOURCE_PDF_TEXT_MISSING",
            `Halaman ${pageNumber} tidak memiliki lapisan teks yang dapat diekstrak. PDF hasil scan atau OCR tidak didukung.`,
            { pageNumber },
          );
        }
        extractedBytes +=
          Buffer.byteLength(text, "utf8") + (pages.length ? 2 : 0);
        if (extractedBytes > MAX_KNOWLEDGE_SOURCE_BYTES) {
          throw new KnowledgeOperationError(
            "SOURCE_TOO_LARGE",
            `Teks hasil ekstraksi PDF dibatasi ${MAX_KNOWLEDGE_SOURCE_BYTES} byte.`,
            {
              limitBytes: MAX_KNOWLEDGE_SOURCE_BYTES,
              actualBytes: extractedBytes,
            },
          );
        }
        pages.push({ pageNumber, content: text });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } catch (error) {
    if (error instanceof KnowledgeOperationError) throw error;
    throw new KnowledgeOperationError(
      "SOURCE_PDF_INVALID",
      "PDF tidak dapat dibaca atau teksnya tidak dapat diekstrak.",
    );
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
