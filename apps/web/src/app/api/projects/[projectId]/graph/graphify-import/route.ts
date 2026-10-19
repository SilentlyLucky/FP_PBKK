import { GraphifyImportError, importGraphifyExport } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMPORT_BYTES = 8_000_000;

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId) {
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  }
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
      return Response.json(
        { error: "GRAPHIFY_IMPORT_TOO_LARGE", maxBytes: MAX_IMPORT_BYTES },
        { status: 413 },
      );
    }
    body = JSON.parse(text) as unknown;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  try {
    const result = await importGraphifyExport(database.db, projectId, body);
    return Response.json({ import: result }, { status: 201 });
  } catch (error) {
    if (error instanceof GraphifyImportError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
