import {
  getKnowledgeEmbeddingIndexReadiness,
  getProjectReadiness,
  listActiveGraphAssertions,
  listGraphBuilds,
  listKnowledgeSources,
} from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import {
  campusIndexerInput,
  knowledgeErrorResponse,
} from "@/lib/knowledge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const [readiness, sources, builds, graph] = await Promise.all([
      getProjectReadiness(database.db, projectId, campusIndexerInput()),
      listKnowledgeSources(database.db, projectId),
      listGraphBuilds(database.db, projectId),
      listActiveGraphAssertions(database.db, projectId, 100),
    ]);
    const semanticReadiness = await getKnowledgeEmbeddingIndexReadiness(
      database.db,
      { projectId, selectedSourceIds: sources.map((source) => source.id) },
    );
    const semanticReadinessBySource = new Map(
      semanticReadiness.map((item) => [item.sourceId, item]),
    );
    return Response.json({
      projectId,
      readiness,
      sources: sources.map((source) => ({
        ...source,
        semanticReadiness: semanticReadinessBySource.get(source.id) ?? null,
      })),
      builds,
      ...graph,
    });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
