import {
  GraphBuildEnqueueRequestSchema,
} from "@promptlab/contracts";
import { enqueueGraphBuild, previewGraphBuild, schema } from "@promptlab/db";
import { and, eq } from "drizzle-orm";
import { providerPurposePolicy } from "@promptlab/providers/policy";

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
  const parsed = GraphBuildEnqueueRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "INVALID_GRAPH_BUILD_REQUEST", message: "Sumber dan budget build tidak valid." },
      { status: 400 },
    );
  }
  const policy = providerPurposePolicy("campus_gateway", "graph_indexing");
  if (!policy.supported || !policy.executable || policy.role !== "optimizer") {
    return Response.json({ error: "GRAPH_INDEXING_POLICY_BLOCKED" }, { status: 409 });
  }
  try {
    const providerInput = campusIndexerInput();
    const requestedModel = providerInput.environmentModel;
    const preview = await previewGraphBuild(
      database.db,
      projectId,
      { sourceIds: parsed.data.sourceIds, maxModelCalls: parsed.data.maxModelCalls, requestedModel },
      providerInput,
    );
    if (!preview.providerReady || !requestedModel) {
      return Response.json(
        { error: "PROVIDER_UNAVAILABLE", message: preview.providerReason, preview: { ...preview, sourceManifest: undefined, sourceManifestHash: undefined } },
        { status: 409 },
      );
    }
    const [connection] = await database.db
      .select({ id: schema.providerConnections.id })
      .from(schema.providerConnections)
      .where(
        and(
          eq(schema.providerConnections.projectId, projectId),
          eq(schema.providerConnections.provider, "campus_gateway"),
          eq(schema.providerConnections.role, policy.role),
          eq(schema.providerConnections.connectionStatus, "verified"),
          eq(schema.providerConnections.requestedModel, requestedModel),
        ),
      )
      .limit(1);
    if (!connection) {
      return Response.json({ error: "PROVIDER_UNAVAILABLE", message: "Koneksi campus optimizer belum diverifikasi." }, { status: 409 });
    }
    const result = await enqueueGraphBuild(database.db, {
      projectId,
      sourceIds: parsed.data.sourceIds,
      requestedModel,
      maxModelCalls: parsed.data.maxModelCalls,
      idempotencyKey: parsed.data.idempotencyKey,
      providerConnectionId: connection.id,
    });
    return Response.json({ build: result }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
