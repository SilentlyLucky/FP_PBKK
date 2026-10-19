import { getProjectReadiness } from "@promptlab/db";

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
    const readiness = await getProjectReadiness(database.db, projectId, campusIndexerInput());
    return Response.json({ readiness });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
