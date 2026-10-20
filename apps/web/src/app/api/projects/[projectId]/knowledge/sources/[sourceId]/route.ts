import {
  deleteKnowledgeSource,
  getKnowledgeSource,
  replaceKnowledgeSource,
  setKnowledgeSourcePermission,
} from "@promptlab/db";
import { knowledgeSnapshotStoreFromEnvironment } from "@promptlab/tools";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import {
  knowledgeErrorResponse,
  parseKnowledgeSourceForm,
} from "@/lib/knowledge-api";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; sourceId: string }> },
) {
  const { projectId: rawProjectId, sourceId: rawSourceId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const sourceId = parseRouteId(rawSourceId);
  if (!projectId || !sourceId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  try {
    const source = await getKnowledgeSource(database.db, projectId, sourceId);
    return Response.json({ source });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string; sourceId: string }> },
) {
  const { projectId: rawProjectId, sourceId: rawSourceId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const sourceId = parseRouteId(rawSourceId);
  if (!projectId || !sourceId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const { rawBytes, ...form } = await parseKnowledgeSourceForm(request);
    const snapshot = rawBytes
      ? await knowledgeSnapshotStoreFromEnvironment().put(projectId, rawBytes)
      : null;
    const source = await replaceKnowledgeSource(database.db, {
      ...form,
      projectId,
      sourceId,
      ...(snapshot
        ? {
            rawByteSha256: snapshot.sha256,
            rawByteSize: snapshot.size,
          }
        : {}),
    });
    return Response.json({ source });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; sourceId: string }> },
) {
  const { projectId: rawProjectId, sourceId: rawSourceId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const sourceId = parseRouteId(rawSourceId);
  if (!projectId || !sourceId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  try {
    await setKnowledgeSourcePermission(
      database.db,
      projectId,
      sourceId,
      "campus_indexer_allowed",
    );
    return Response.json({ sourceId, permission: "campus_indexer_allowed" });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string; sourceId: string }> },
) {
  const { projectId: rawProjectId, sourceId: rawSourceId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const sourceId = parseRouteId(rawSourceId);
  if (!projectId || !sourceId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  try {
    await deleteKnowledgeSource(database.db, projectId, sourceId);
    return Response.json({ sourceId, deleted: true });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
