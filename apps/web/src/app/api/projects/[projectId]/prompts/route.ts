import { createHash } from "node:crypto";

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";

const NewPromptSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  text: z.string().min(1).max(100_000),
  invariants: z.array(z.string().trim().min(1).max(500)).max(40).default([]),
});

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
    const prompts = await database.db
      .select({
        id: schema.prompts.id,
        name: schema.prompts.name,
        currentVersionId: schema.prompts.currentVersionId,
        version: schema.promptVersions.version,
        text: schema.promptVersions.text,
        invariants: schema.promptVersions.invariantDefinition,
      })
      .from(schema.prompts)
      .leftJoin(
        schema.promptVersions,
        and(
          eq(schema.prompts.projectId, schema.promptVersions.projectId),
          eq(schema.prompts.id, schema.promptVersions.promptId),
          eq(schema.prompts.currentVersionId, schema.promptVersions.id),
        ),
      )
      .where(
        and(
          eq(schema.prompts.projectId, projectId),
          isNull(schema.prompts.deletedAt),
          isNotNull(schema.prompts.currentVersionId),
        ),
      )
      .orderBy(desc(schema.prompts.updatedAt));
    return Response.json({ prompts });
  } catch {
    return safeApiFailure();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = NewPromptSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "INVALID_PROMPT" }, { status: 400 });
  const contentHash = createHash("sha256")
    .update(parsed.data.text)
    .digest("hex");
  const invariantHash = createHash("sha256")
    .update(JSON.stringify(parsed.data.invariants))
    .digest("hex");

  try {
    const prompt = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.prompts)
        .values({ projectId, name: parsed.data.name })
        .returning({
          id: schema.prompts.id,
          name: schema.prompts.name,
        });
      if (!created) throw new Error("Prompt insert returned no row");
      const [version] = await tx
        .insert(schema.promptVersions)
        .values({
          projectId,
          promptId: created.id,
          version: 1,
          text: parsed.data.text,
          contentHash,
          invariantDefinition: parsed.data.invariants,
          invariantHash,
        })
        .returning({
          id: schema.promptVersions.id,
          version: schema.promptVersions.version,
          text: schema.promptVersions.text,
          invariants: schema.promptVersions.invariantDefinition,
        });
      if (!version) throw new Error("Prompt version insert returned no row");
      await tx
        .update(schema.prompts)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, created.id),
          ),
        );
      return {
        ...created,
        currentVersionId: version.id,
        version: version.version,
        text: version.text,
        invariants: version.invariants,
      };
    });
    return Response.json({ prompt }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23503")
      return safeApiFailure(409);
    return safeApiFailure();
  }
}
