import {
  getKnowledgeReferencePack,
  getProjectReadiness,
  importKnowledgeReferencePack,
} from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import { campusIndexerInput, knowledgeErrorResponse } from "@/lib/knowledge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId) return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  try {
    await getProjectReadiness(database.db, projectId, campusIndexerInput());
    return Response.json(getKnowledgeReferencePack());
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

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
  const keys =
    body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body)
      : [];
  if (
    keys.length !== 1 ||
    keys[0] !== "permission" ||
    (body as { permission?: unknown } | null)?.permission !== "local_only"
  ) {
    return Response.json(
      { error: "LOCAL_ONLY_REQUIRED", message: "Paket hanya dapat diimpor sebagai local-only." },
      { status: 400 },
    );
  }

  try {
    const result = await importKnowledgeReferencePack(
      database.db,
      projectId,
      "local_only",
    );
    return Response.json(result);
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
