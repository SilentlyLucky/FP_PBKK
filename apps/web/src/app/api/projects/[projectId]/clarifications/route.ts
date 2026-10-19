import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import { derivePendingClarifications } from "@/lib/optimization-clarifications";

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
    const events = await database.db
      .select({
        id: schema.runEvents.id,
        projectId: schema.runEvents.projectId,
        runId: schema.runEvents.runId,
        sequence: schema.runEvents.sequence,
        eventType: schema.runEvents.eventType,
        payload: schema.runEvents.payload,
        createdAt: schema.runEvents.createdAt,
        runStatus: schema.runs.status,
        runPromptId: schema.promptVersions.promptId,
        runPromptVersionId: schema.runs.promptVersionId,
        currentPromptVersionId: schema.prompts.currentVersionId,
        promptDeletedAt: schema.prompts.deletedAt,
        projectDeletedAt: schema.projects.deletedAt,
      })
      .from(schema.runEvents)
      .innerJoin(
        schema.runs,
        and(
          eq(schema.runs.projectId, schema.runEvents.projectId),
          eq(schema.runs.id, schema.runEvents.runId),
        ),
      )
      .innerJoin(
        schema.promptVersions,
        and(
          eq(schema.promptVersions.projectId, schema.runs.projectId),
          eq(schema.promptVersions.id, schema.runs.promptVersionId),
        ),
      )
      .innerJoin(
        schema.prompts,
        and(
          eq(schema.prompts.projectId, schema.promptVersions.projectId),
          eq(schema.prompts.id, schema.promptVersions.promptId),
        ),
      )
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.runEvents.projectId),
      )
      .where(
        and(
          eq(schema.runEvents.projectId, projectId),
          eq(schema.runs.status, "queued"),
          isNull(schema.prompts.deletedAt),
          isNull(schema.projects.deletedAt),
          inArray(schema.runEvents.eventType, [
            "optimization.clarification.requested",
            "optimization.clarification.answered",
          ]),
        ),
      )
      .orderBy(asc(schema.runEvents.sequence));
    const clarifications = derivePendingClarifications(projectId, events);
    return Response.json({ clarifications });
  } catch {
    return safeApiFailure();
  }
}
