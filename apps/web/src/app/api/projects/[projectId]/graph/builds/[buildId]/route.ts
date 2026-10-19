import { getGraphBuild } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import { knowledgeErrorResponse } from "@/lib/knowledge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; buildId: string }> },
) {
  const { projectId: rawProjectId, buildId: rawBuildId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const buildId = parseRouteId(rawBuildId);
  if (!projectId || !buildId) return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  try {
    const build = await getGraphBuild(database.db, projectId, buildId);
    return Response.json({ build });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
