import {
  KnowledgeOperationError,
  MAX_KNOWLEDGE_PDF_FILE_BYTES,
  MAX_KNOWLEDGE_SOURCE_BYTES,
  validateKnowledgeText,
  type KnowledgeSourceInput,
  type SourcePermission,
} from "@promptlab/db";
import { extractPdfKnowledgePages } from "./pdf-knowledge.ts";

const MAX_MULTIPART_BYTES = MAX_KNOWLEDGE_PDF_FILE_BYTES + 32_768;

export type ParsedKnowledgeForm = Omit<KnowledgeSourceInput, "projectId"> & {
  rawBytes?: Uint8Array;
};

export async function parseKnowledgeSourceForm(
  request: Request,
): Promise<ParsedKnowledgeForm> {
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Compressed upload tidak didukung.",
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Gunakan formulir teks, Markdown, atau PDF.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    throw new KnowledgeOperationError(
      "SOURCE_TOO_LARGE",
      `File upload dibatasi ${MAX_KNOWLEDGE_PDF_FILE_BYTES} byte.`,
      {
        limitBytes: MAX_KNOWLEDGE_PDF_FILE_BYTES,
        actualBytes: declaredLength,
      },
    );
  }

  const reader = request.body?.getReader();
  const bodyParts: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_MULTIPART_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new KnowledgeOperationError(
          "SOURCE_TOO_LARGE",
          `File upload dibatasi ${MAX_KNOWLEDGE_PDF_FILE_BYTES} byte.`,
          {
            limitBytes: MAX_KNOWLEDGE_PDF_FILE_BYTES,
            actualBytes: totalBytes,
          },
        );
      }
      bodyParts.push(result.value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of bodyParts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  let fields: FormData;
  try {
    const parserRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Blob([bytes]),
    });
    fields = await parserRequest.formData();
  } catch {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Formulir sumber tidak dapat dibaca.",
    );
  }

  const file = fields.get("file");
  const sourceKind = fields.get("sourceKind");
  const permissionValue = fields.get("permission");
  const permission: SourcePermission =
    permissionValue === "campus_indexer_allowed"
      ? "campus_indexer_allowed"
      : "local_only";
  let displayName = "";
  let content = "";
  let sourceContentType: "text/plain" | "text/markdown" | "application/pdf";
  let kind: "upload" | "paste";
  let pages: Awaited<ReturnType<typeof extractPdfKnowledgePages>> | undefined;
  let rawBytes: Uint8Array | undefined;

  if (file instanceof File && file.size > 0) {
    displayName = file.name;
    const extension = displayName
      .match(/\.(md|markdown|txt|pdf)$/iu)?.[1]
      ?.toLowerCase();
    if (!extension) {
      throw new KnowledgeOperationError(
        "SOURCE_CONTENT_INVALID",
        "Pilih file .txt, .md, .markdown, atau .pdf.",
      );
    }
    if (extension === "pdf") {
      if (file.type.toLowerCase() !== "application/pdf") {
        throw new KnowledgeOperationError(
          "SOURCE_CONTENT_INVALID",
          "File .pdf harus memiliki MIME type application/pdf.",
        );
      }
      if (file.size > MAX_KNOWLEDGE_PDF_FILE_BYTES) {
        throw new KnowledgeOperationError(
          "SOURCE_TOO_LARGE",
          `File PDF dibatasi ${MAX_KNOWLEDGE_PDF_FILE_BYTES} byte.`,
          {
            limitBytes: MAX_KNOWLEDGE_PDF_FILE_BYTES,
            actualBytes: file.size,
          },
        );
      }
      rawBytes = new Uint8Array(await file.arrayBuffer());
      pages = await extractPdfKnowledgePages(new Uint8Array(rawBytes));
      content = pages.map((page) => page.content).join("\n\n");
      sourceContentType = "application/pdf";
    } else {
      if (file.size > MAX_KNOWLEDGE_SOURCE_BYTES) {
        throw new KnowledgeOperationError(
          "SOURCE_TOO_LARGE",
          `Sumber dibatasi ${MAX_KNOWLEDGE_SOURCE_BYTES} byte teks.`,
          {
            limitBytes: MAX_KNOWLEDGE_SOURCE_BYTES,
            actualBytes: file.size,
          },
        );
      }
      try {
        rawBytes = new Uint8Array(await file.arrayBuffer());
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          rawBytes,
        );
      } catch {
        throw new KnowledgeOperationError(
          "SOURCE_CONTENT_INVALID",
          "File harus berupa teks UTF-8 yang valid.",
        );
      }
      sourceContentType = extension === "txt" ? "text/plain" : "text/markdown";
    }
    kind = "upload";
  } else {
    const rawName = fields.get("displayName");
    const rawContent = fields.get("content");
    if (typeof rawName !== "string" || typeof rawContent !== "string") {
      throw new KnowledgeOperationError(
        "SOURCE_CONTENT_INVALID",
        "Isi nama dan teks sumber terlebih dahulu.",
      );
    }
    displayName = rawName;
    content = rawContent;
    rawBytes = new TextEncoder().encode(rawContent);
    const extension = displayName
      .match(/\.(md|markdown|txt)$/iu)?.[1]
      ?.toLowerCase();
    if (!extension) {
      throw new KnowledgeOperationError(
        "SOURCE_CONTENT_INVALID",
        "Nama sumber paste harus berakhiran .txt, .md, atau .markdown.",
      );
    }
    sourceContentType = extension === "txt" ? "text/plain" : "text/markdown";
    kind = "paste";
  }
  if (sourceKind === "upload" && kind !== "upload") {
    throw new KnowledgeOperationError(
      "SOURCE_CONTENT_INVALID",
      "Jenis sumber tidak sesuai.",
    );
  }
  const checked = validateKnowledgeText({ displayName, content });
  const sourceRefValue = fields.get("sourceRef");
  const sourceRef =
    typeof sourceRefValue === "string" ? sourceRefValue : undefined;
  const vaultPathValue = fields.get("vaultPath");
  const vaultNamespaceValue = fields.get("vaultNamespace");
  if (
    (vaultPathValue !== null && typeof vaultPathValue !== "string") ||
    (vaultNamespaceValue !== null && typeof vaultNamespaceValue !== "string")
  ) {
    throw new KnowledgeOperationError(
      "SOURCE_LOCATOR_INVALID",
      "Lokasi catatan harus berupa path Markdown relatif yang aman.",
    );
  }
  const vaultPath =
    typeof vaultPathValue === "string" ? vaultPathValue : undefined;
  const vaultNamespace =
    typeof vaultNamespaceValue === "string" ? vaultNamespaceValue : undefined;
  const vaultLocator = vaultPath?.trim()
    ? {
        path: vaultPath,
        ...(vaultNamespace?.trim() ? { namespace: vaultNamespace } : {}),
      }
    : vaultNamespace?.trim()
      ? { path: "", namespace: vaultNamespace }
      : undefined;
  return {
    displayName: checked.displayName,
    content: checked.content,
    contentType: sourceContentType,
    sourceKind: kind,
    permission,
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(vaultLocator === undefined ? {} : { vaultLocator }),
    ...(pages ? { pages } : {}),
    ...(rawBytes ? { rawBytes } : {}),
  };
}

export function knowledgeErrorResponse(error: unknown): Response {
  if (error instanceof KnowledgeOperationError) {
    const status =
      error.code === "PROJECT_NOT_FOUND" ||
      error.code === "SOURCE_NOT_FOUND" ||
      error.code === "BUILD_NOT_FOUND" ||
      error.code === "ASSERTION_NOT_FOUND"
        ? 404
        : error.code === "PROVIDER_UNAVAILABLE"
          ? 409
          : error.code === "BUILD_ALREADY_ACTIVE" ||
              error.code === "IDEMPOTENCY_CONFLICT" ||
              error.code === "ASSERTION_VERSION_CONFLICT" ||
              error.code === "ASSERTION_EVIDENCE_STALE" ||
              error.code === "BUILD_NOT_CANCELLABLE"
            ? 409
            : error.code === "SOURCE_TOO_LARGE" ||
                error.code === "SOURCE_PDF_PAGE_LIMIT"
              ? 413
              : 400;
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status },
    );
  }
  return Response.json(
    {
      error: "INTERNAL_ERROR",
      message: "Permintaan knowledge tidak dapat diproses.",
    },
    { status: 500 },
  );
}

export function campusIndexerInput() {
  return {
    keyConfigured: Boolean(process.env.PROMPTLAB_CAMPUS_API_KEY?.trim()),
    environmentModel: process.env.PROMPTLAB_CAMPUS_MODEL?.trim() || null,
  };
}
