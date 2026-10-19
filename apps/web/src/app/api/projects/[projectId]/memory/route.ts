import {
  listVerifiedMemories,
  renderVerifiedMemoryWiki,
} from "@promptlab/agent/verified-memory";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  const audience = url.searchParams.get("audience") ?? "runtime";
  if (format !== "json" && format !== "markdown") {
    return Response.json({ error: "INVALID_MEMORY_FORMAT" }, { status: 400 });
  }
  if (audience !== "runtime" && audience !== "evaluator") {
    return Response.json({ error: "INVALID_MEMORY_AUDIENCE" }, { status: 400 });
  }
  if (format === "markdown" && audience !== "evaluator") {
    return Response.json(
      { error: "EVALUATOR_AUDIENCE_REQUIRED_FOR_EXPORT" },
      { status: 400 },
    );
  }

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  try {
    const requestedMemoryId = url.searchParams.get("memoryId");
    if (audience === "evaluator") {
      const result = await listVerifiedMemories(database.db, {
        projectId,
        audience: "evaluator",
        ...(requestedMemoryId ? { memoryId: requestedMemoryId } : {}),
        limit: 100,
      });
      if (requestedMemoryId && result.memories.length === 0) {
        return Response.json(
          { error: "VERIFIED_MEMORY_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (format === "markdown") {
        return new Response(
          renderVerifiedMemoryWiki(result.memories, { baseUrl: url.origin }),
          {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="promptlab-verified-memory-evaluator-export.md"',
            },
          },
        );
      }
      return Response.json({
        verifiedMemories: result.memories,
        truncated: result.truncated,
        evaluatorExportUrl: `/api/projects/${projectId}/memory?audience=evaluator`,
      });
    }

    const query = url.searchParams.get("query")?.trim();
    const result = await listVerifiedMemories(database.db, {
      projectId,
      audience: "runtime",
      ...(query ? { query } : {}),
      ...(requestedMemoryId ? { memoryId: requestedMemoryId } : {}),
      limit: Number(url.searchParams.get("limit") ?? 5),
    });
    if (requestedMemoryId && result.memories.length === 0) {
      return Response.json(
        { error: "VERIFIED_MEMORY_NOT_FOUND" },
        { status: 404 },
      );
    }
    return Response.json({
      verifiedMemories: result.memories,
      truncated: result.truncated,
      evaluatorExportUrl: `/api/projects/${projectId}/memory?audience=evaluator`,
    });
  } catch {
    return safeApiFailure();
  }
}
