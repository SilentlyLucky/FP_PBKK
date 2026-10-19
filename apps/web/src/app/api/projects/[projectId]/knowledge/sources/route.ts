import {
  createKnowledgeSource,
  MAX_KNOWLEDGE_SOURCE_BYTES,
} from "@promptlab/db";
import { knowledgeSnapshotStoreFromEnvironment } from "@promptlab/tools";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import {
  knowledgeErrorResponse,
  parseKnowledgeSourceForm,
} from "@/lib/knowledge-api";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId) return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const { rawBytes, ...form } = await parseKnowledgeSourceForm(request);
    const snapshot = rawBytes
      ? await knowledgeSnapshotStoreFromEnvironment().put(projectId, rawBytes)
      : null;
    const source = await createKnowledgeSource(database.db, {
      ...form,
      projectId,
      ...(snapshot
        ? {
            rawByteSha256: snapshot.sha256,
            rawByteSize: snapshot.size,
          }
        : {}),
    });
    return Response.json({ source }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "KnowledgeOperationError" &&
      "code" in error &&
      error.code === "SOURCE_TOO_LARGE"
    ) {
      const details =
        "details" in error && error.details && typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : {};
      return Response.json(
        {
          error: "SOURCE_TOO_LARGE",
          maxBytes:
            typeof details.limitBytes === "number"
              ? details.limitBytes
              : MAX_KNOWLEDGE_SOURCE_BYTES,
          details,
        },
        { status: 413 },
      );
    }
    return knowledgeErrorResponse(error);
  }
}
