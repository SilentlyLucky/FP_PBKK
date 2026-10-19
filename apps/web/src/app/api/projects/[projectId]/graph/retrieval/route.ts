import { GraphRetrievalPreviewRequestSchema } from "@promptlab/contracts";
import {
  retrieveKnowledgeContext,
  type GraphRetrievalBounds,
} from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import { knowledgeErrorResponse } from "@/lib/knowledge-api";

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const hasSnapshot =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.hasOwn(body, "snapshotId");
  const rawSnapshotId =
    hasSnapshot && body && typeof body === "object"
      ? (body as Record<string, unknown>).snapshotId
      : undefined;
  const requestBody =
    hasSnapshot && body && typeof body === "object" && !Array.isArray(body)
      ? Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== "snapshotId"),
        )
      : body;
  const snapshotId =
    typeof rawSnapshotId === "string" ? parseRouteId(rawSnapshotId) : null;
  if (
    (hasSnapshot && rawSnapshotId !== null && rawSnapshotId !== undefined && !snapshotId) ||
    (hasSnapshot && rawSnapshotId !== null && typeof rawSnapshotId !== "string")
  ) {
    return Response.json({ error: "INVALID_GRAPH_SNAPSHOT" }, { status: 400 });
  }
  const parsed = GraphRetrievalPreviewRequestSchema.safeParse(requestBody);
  if (!parsed.success) return Response.json({ error: "INVALID_GRAPH_QUERY" }, { status: 400 });
  try {
    const bounds = Object.fromEntries(
      Object.entries(parsed.data.bounds ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<GraphRetrievalBounds>;
    const result = await retrieveKnowledgeContext(database.db, {
      projectId,
      query: parsed.data.query,
      strategy: parsed.data.strategy,
      sourceIds: parsed.data.sourceIds,
      ...(snapshotId ? { snapshotId } : {}),
      runId: null,
      ...(Object.keys(bounds).length ? { bounds } : {}),
    });
    return Response.json({ retrieval: result });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
