import { GraphBuildPreviewRequestSchema } from "@promptlab/contracts";
import { previewGraphBuild } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import {
  campusIndexerInput,
  knowledgeErrorResponse,
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = GraphBuildPreviewRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "INVALID_GRAPH_BUILD_PREVIEW" }, { status: 400 });
  try {
    const preview = await previewGraphBuild(
      database.db,
      projectId,
      {
        sourceIds: parsed.data.sourceIds,
        requestedModel: process.env.PROMPTLAB_CAMPUS_MODEL?.trim() || null,
        ...(parsed.data.maxModelCalls === undefined
          ? {}
          : { maxModelCalls: parsed.data.maxModelCalls }),
      },
      campusIndexerInput(),
    );
    const { sourceManifest: _manifest, sourceManifestHash: _manifestHash, ...publicPreview } = preview;
    return Response.json({ preview: publicPreview });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
