import { and, asc, eq, isNull } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { VerifiedMemorySourceCitationQuerySchema } from "@promptlab/agent/verified-memory";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      projectId: string;
      sourceId: string;
      versionId: string;
    }>;
  },
) {
  const {
    projectId: rawProjectId,
    sourceId: rawSourceId,
    versionId: rawVersionId,
  } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  const sourceId = parseRouteId(rawSourceId);
  const versionId = parseRouteId(rawVersionId);
  if (!projectId || !sourceId || !versionId) {
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  }
  const parsedQuery = VerifiedMemorySourceCitationQuerySchema.safeParse({
    checksum: new URL(request.url).searchParams.get("checksum"),
  });
  if (!parsedQuery.success) {
    return Response.json({ error: "INVALID_SOURCE_CITATION" }, { status: 400 });
  }

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;
  try {
    const [source] = await database.db
      .select({
        id: schema.documents.id,
        name: schema.documents.displayName,
        deletedAt: schema.documents.deletedAt,
        versionId: schema.documentVersions.id,
        version: schema.documentVersions.version,
        checksum: schema.documentVersions.checksum,
        eligible: schema.documentVersions.eligible,
        contentType: schema.documentVersions.contentType,
      })
      .from(schema.documents)
      .innerJoin(
        schema.documentVersions,
        and(
          eq(schema.documentVersions.projectId, schema.documents.projectId),
          eq(schema.documentVersions.documentId, schema.documents.id),
          eq(schema.documentVersions.id, versionId),
        ),
      )
      .where(
        and(
          eq(schema.documents.projectId, projectId),
          eq(schema.documents.id, sourceId),
          isNull(schema.documents.deletedAt),
          eq(schema.documentVersions.projectId, projectId),
          eq(schema.documentVersions.checksum, parsedQuery.data.checksum),
          eq(schema.documentVersions.eligible, true),
        ),
      )
      .limit(1);
    if (!source) {
      return Response.json(
        { error: "SOURCE_VERSION_NOT_FOUND" },
        { status: 404 },
      );
    }
    const chunks = await database.db
      .select({
        ordinal: schema.chunks.ordinal,
        heading: schema.chunks.heading,
        pageNumber: schema.chunks.pageNumber,
        content: schema.chunks.content,
        contentHash: schema.chunks.contentHash,
      })
      .from(schema.chunks)
      .where(
        and(
          eq(schema.chunks.projectId, projectId),
          eq(schema.chunks.documentVersionId, versionId),
        ),
      )
      .orderBy(asc(schema.chunks.ordinal))
      .limit(500);
    return Response.json({
      source: {
        id: source.id,
        name: source.name,
        versionId: source.versionId,
        version: source.version,
        checksum: source.checksum,
        contentType: source.contentType,
      },
      chunks,
    });
  } catch {
    return safeApiFailure();
  }
}
