import { GraphAssertionReviewRequestSchema } from "@promptlab/contracts";
import { reviewGraphAssertion } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId } from "@/lib/api";
import { knowledgeErrorResponse } from "@/lib/knowledge-api";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; assertionId: string }> },
) {
  const { projectId: rawProjectId, assertionId: rawAssertionId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const assertionId = parseRouteId(rawAssertionId);
  if (!projectId || !assertionId) return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = GraphAssertionReviewRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "INVALID_REVIEW" }, { status: 400 });
  try {
    const review = await reviewGraphAssertion(database.db, {
      projectId,
      assertionId,
      version: parsed.data.version,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
    });
    return Response.json({ review });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
