import { createHash } from "node:crypto";

import { and, eq, isNull, max } from "drizzle-orm";
import { IdSchema } from "@promptlab/contracts";
import { schema } from "@promptlab/db";
import { z } from "zod";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WorkspacePromptSchema = z.strictObject({
  promptId: IdSchema.nullable(),
  name: z.string().trim().min(1).max(160),
  text: z.string().min(1).max(100_000),
  parentVersionId: IdSchema.nullable(),
});

/**
 * Store the immutable prompt snapshot used by a Workspace chat run without
 * changing the prompt's active version. Candidate activation remains an
 * explicit action through the normal prompt version API.
 */
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
  const parsed = WorkspacePromptSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "INVALID_WORKSPACE_PROMPT" },
      { status: 400 },
    );
  if (!parsed.data.promptId && parsed.data.parentVersionId) {
    return Response.json({ error: "INVALID_PARENT_VERSION" }, { status: 400 });
  }

  try {
    const prompt = await database.db.transaction(async (tx) => {
      let promptId = parsed.data.promptId;
      let name = parsed.data.name;
      if (promptId) {
        const [lockedPrompt] = await tx
          .select({ id: schema.prompts.id, name: schema.prompts.name })
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
        name = lockedPrompt.name;
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
      } else {
        const [created] = await tx
          .insert(schema.prompts)
          .values({ projectId, name })
          .returning({ id: schema.prompts.id });
        if (!created)
          throw new Error("Workspace prompt insert returned no row");
        promptId = created.id;
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
      const invariants: string[] = [];
      const contentHash = createHash("sha256")
        .update(parsed.data.text)
        .digest("hex");
      const invariantHash = createHash("sha256")
        .update(JSON.stringify(invariants))
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
          invariantDefinition: invariants,
          invariantHash,
        })
        .returning({
          id: schema.promptVersions.id,
          version: schema.promptVersions.version,
          text: schema.promptVersions.text,
        });
      if (!version)
        throw new Error("Workspace prompt version insert returned no row");

      // Intentionally leave prompts.currentVersionId untouched. New chat
      // prompts remain inactive until a user explicitly activates a candidate.
      const [storedPrompt] = await tx
        .select({ currentVersionId: schema.prompts.currentVersionId })
        .from(schema.prompts)
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, promptId),
          ),
        )
        .limit(1);
      return {
        id: promptId,
        name,
        versionId: version.id,
        version: version.version,
        text: version.text,
        currentVersionId: storedPrompt?.currentVersionId ?? null,
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
