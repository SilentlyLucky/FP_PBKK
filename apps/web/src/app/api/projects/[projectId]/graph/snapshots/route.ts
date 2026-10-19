import {
  getActiveGraphSnapshot,
  graphSnapshotIsCurrent,
  getProjectReadiness,
  listGraphSnapshots,
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
    const [snapshots, active] = await Promise.all([
      listGraphSnapshots(database.db, projectId),
      getActiveGraphSnapshot(database.db, projectId),
    ]);
    const activeSnapshot = active
      ? {
          id: active.snapshotId,
          state: active.state,
          current: await graphSnapshotIsCurrent(
            database.db,
            projectId,
            active.sourceManifest,
          ),
          sourceManifest: active.sourceManifest,
        }
      : null;
    return Response.json({ projectId, snapshots, activeSnapshot });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
