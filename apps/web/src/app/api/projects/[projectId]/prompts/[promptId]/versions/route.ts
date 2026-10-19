import { createHash } from "node:crypto";

import { IdSchema } from "@promptlab/contracts";
import { and, desc, eq, isNull, max } from "drizzle-orm";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";

const NewVersionSchema = z.strictObject({
  text: z.string().min(1).max(100_000),
  invariants: z.array(z.string().trim().min(1).max(500)).max(40).default([]),
  parentVersionId: IdSchema.nullable().default(null),
});

export async function GET(
  _request: Request,
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

  try {
    const versions = await database.db
      .select({
        id: schema.promptVersions.id,
        version: schema.promptVersions.version,
        parentVersionId: schema.promptVersions.parentVersionId,
        text: schema.promptVersions.text,
        invariants: schema.promptVersions.invariantDefinition,
        createdAt: schema.promptVersions.createdAt,
      })
      .from(schema.promptVersions)
      .where(
        and(
          eq(schema.promptVersions.projectId, projectId),
          eq(schema.promptVersions.promptId, promptId),
        ),
      )
      .orderBy(desc(schema.promptVersions.version));
    return Response.json({ versions });
  } catch {
    return safeApiFailure();
  }
}

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
  const parsed = NewVersionSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "INVALID_PROMPT_VERSION" }, { status: 400 });

  try {
    const prompt = await database.db.transaction(async (tx) => {
      const [lockedPrompt] = await tx
        .select({ id: schema.prompts.id })
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
      if (parsed.data.parentVersionId) {
        const [parent] = await tx
          .select({ id: schema.promptVersions.id })
          .from(schema.promptVersions)
          .where(
            and(
              eq(schema.promptVersions.projectId, projectId),
              eq(schema.promptVersions.promptId, promptId),
              eq(schema.promptVersions.id, parsed.data.parentVersionId),
            ),
          )
          .limit(1);
        if (!parent) return "parent_missing" as const;
      }
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
        .update(parsed.data.text)
        .digest("hex");
      const invariantHash = createHash("sha256")
        .update(JSON.stringify(parsed.data.invariants))
        .digest("hex");
      const [version] = await tx
        .insert(schema.promptVersions)
        .values({
          projectId,
          promptId,
          version: (maximum?.value ?? 0) + 1,
          parentVersionId: parsed.data.parentVersionId,
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
      const [updated] = await tx
        .update(schema.prompts)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, promptId),
          ),
        )
        .returning({ id: schema.prompts.id, name: schema.prompts.name });
      if (!updated)
        throw new Error("Prompt row disappeared while version was locked");
      return {
        ...updated,
        currentVersionId: version.id,
        version: version.version,
        text: version.text,
        invariants: version.invariants,
      };
    });
    if (!prompt)
      return Response.json({ error: "PROMPT_NOT_FOUND" }, { status: 404 });
    if (prompt === "parent_missing")
      return Response.json(
        { error: "INVALID_PARENT_VERSION" },
        { status: 400 },
      );
    return Response.json({ prompt }, { status: 201 });
  } catch {
    return safeApiFailure();
  }
}
