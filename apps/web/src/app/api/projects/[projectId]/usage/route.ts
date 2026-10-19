import { desc, eq } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import { parseSanitizedUsageSnapshot } from "@/lib/usage-snapshot";

export const runtime = "nodejs";

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
    const records = await database.db
      .select({
        id: schema.usageRecords.id,
        purpose: schema.usageRecords.purpose,
        provider: schema.usageRecords.provider,
        inputTokens: schema.usageRecords.inputTokens,
        outputTokens: schema.usageRecords.outputTokens,
        cacheReadTokens: schema.usageRecords.cacheReadTokens,
        cacheWriteTokens: schema.usageRecords.cacheWriteTokens,
        provenance: schema.usageRecords.provenance,
        completeness: schema.usageRecords.completeness,
        mapperVersion: schema.usageRecords.mapperVersion,
        sanitizedRawUsage: schema.usageRecords.sanitizedRawUsage,
        createdAt: schema.usageRecords.createdAt,
      })
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.projectId, projectId))
      .orderBy(desc(schema.usageRecords.createdAt))
      .limit(50);
    return Response.json({
      records: records.map((record) => ({
        ...record,
        sanitizedRawUsage: parseSanitizedUsageSnapshot(
          record.sanitizedRawUsage,
        ),
      })),
    });
  } catch {
    return safeApiFailure();
  }
}
