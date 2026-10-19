import { createHash } from "node:crypto";

import { IdSchema } from "@promptlab/contracts";
import { and, eq, isNull, max } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";

const RollbackSchema = z.strictObject({ versionId: IdSchema });

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; promptId: string }> },
) {
  const { projectId: rawProjectId, promptId: rawPromptId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const promptId = parseRouteId(rawPromptId);
  if (!projectId || !promptId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = RollbackSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "INVALID_ROLLBACK_REQUEST" },
      { status: 400 },
    );

  try {
    const prompt = await database.db.transaction(async (tx) => {
      const [lockedPrompt] = await tx
        .select({
          id: schema.prompts.id,
          currentVersionId: schema.prompts.currentVersionId,
          name: schema.prompts.name,
        })
        .from(schema.prompts)
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, promptId),
            isNull(schema.prompts.deletedAt),
          ),
        )
        .for("update");
      if (!lockedPrompt) return null;
      const [source] = await tx
        .select({
          text: schema.promptVersions.text,
          invariantDefinition: schema.promptVersions.invariantDefinition,
        })
        .from(schema.promptVersions)
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            eq(schema.promptVersions.promptId, promptId),
            eq(schema.promptVersions.id, parsed.data.versionId),
          ),
        )
        .limit(1);
      if (!source) return "version_missing" as const;
      const [maximum] = await tx
        .select({ value: max(schema.promptVersions.version) })
        .from(schema.promptVersions)
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            eq(schema.promptVersions.promptId, promptId),
          ),
        );
      const contentHash = createHash("sha256")
        .update(source.text)
        .digest("hex");
      const invariantHash = createHash("sha256")
        .update(JSON.stringify(source.invariantDefinition))
        .digest("hex");
      const [version] = await tx
        .insert(schema.promptVersions)
        .values({
          projectId,
          promptId,
          version: (maximum?.value ?? 0) + 1,
          parentVersionId: lockedPrompt.currentVersionId,
          text: source.text,
          contentHash,
          invariantDefinition: source.invariantDefinition,
          invariantHash,
          createdBy: "rollback",
        })
        .returning({
          id: schema.promptVersions.id,
          version: schema.promptVersions.version,
          text: schema.promptVersions.text,
          invariants: schema.promptVersions.invariantDefinition,
        });
      if (!version) throw new Error("Rollback version insert returned no row");
      await tx
        .update(schema.prompts)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, promptId),
          ),
        );
      return {
        id: promptId,
        name: lockedPrompt.name,
        currentVersionId: version.id,
        version: version.version,
        text: version.text,
        invariants: version.invariants,
      };
    });
    if (!prompt)
      return Response.json({ error: "PROMPT_NOT_FOUND" }, { status: 404 });
    if (prompt === "version_missing")
      return Response.json(
        { error: "PROMPT_VERSION_NOT_FOUND" },
        { status: 404 },
      );
    return Response.json({ prompt }, { status: 201 });
  } catch {
    return safeApiFailure();
  }
}
