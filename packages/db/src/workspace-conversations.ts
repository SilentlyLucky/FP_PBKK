import { IdSchema } from "@promptlab/contracts";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Database } from "./index.ts";
import { schema } from "./schema.ts";

export interface StoredWorkspaceConversation {
  id: string;
  title: string;
  updatedAt: string;
  conversation: Record<string, unknown>;
}

type WorkspaceConversationDeletion = "deleted" | "active_run" | "prompt_in_use";

function addValidId(value: unknown, target: Set<string>): void {
  const parsed = IdSchema.safeParse(value);
  if (parsed.success) target.add(parsed.data);
}

export async function listWorkspaceConversations(
  database: Database,
  projectId: string,
): Promise<StoredWorkspaceConversation[]> {
  const rows = await database
    .select({
      id: schema.workspaceConversations.id,
      title: schema.workspaceConversations.title,
      updatedAt: schema.workspaceConversations.updatedAt,
      conversation: schema.workspaceConversations.conversation,
    })
    .from(schema.workspaceConversations)
    .where(eq(schema.workspaceConversations.projectId, projectId))
    .orderBy(desc(schema.workspaceConversations.updatedAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    conversation: row.conversation,
  }));
}

export async function saveWorkspaceConversations(
  database: Database,
  projectId: string,
  conversations: readonly StoredWorkspaceConversation[],
): Promise<void> {
  if (!conversations.length) return;

  await database
    .insert(schema.workspaceConversations)
    .values(
      conversations.map((conversation) => ({
        id: conversation.id,
        projectId,
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt),
        conversation: conversation.conversation,
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.workspaceConversations.projectId,
        schema.workspaceConversations.id,
      ],
      set: {
        title: sql`excluded.title`,
        updatedAt: sql`excluded.updated_at`,
        conversation: sql`excluded.conversation`,
      },
      setWhere: sql`excluded.updated_at >= ${schema.workspaceConversations.updatedAt}`,
    });
}

export async function saveWorkspaceConversation(
  database: Database,
  projectId: string,
  conversation: StoredWorkspaceConversation,
): Promise<void> {
  await saveWorkspaceConversations(database, projectId, [conversation]);
}

export async function deleteWorkspaceConversation(
  database: Database,
  projectId: string,
  conversationId: string,
): Promise<WorkspaceConversationDeletion> {
  return database.transaction(async (tx) => {
    const [stored] = await tx
      .select({ conversation: schema.workspaceConversations.conversation })
      .from(schema.workspaceConversations)
      .where(
        and(
          eq(schema.workspaceConversations.projectId, projectId),
          eq(schema.workspaceConversations.id, conversationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!stored) return "deleted";

    const runIds = new Set<string>();
    const promptIds = new Set<string>();
    const data = stored.conversation;
    addValidId(data.promptId, promptIds);
    if (Array.isArray(data.turns)) {
      for (const value of data.turns) {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          continue;
        const turn = value as Record<string, unknown>;
        addValidId(turn.runId, runIds);
        addValidId(turn.promptId, promptIds);
      }
    }

    const runIdList = [...runIds];
    const promptIdList = [...promptIds];
    const activeStatuses = new Set([
      "created",
      "queued",
      "running",
      "cancel_requested",
    ]);
    if (runIdList.length) {
      const runs = await tx
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.projectId, projectId),
            inArray(schema.runs.id, runIdList),
          ),
        )
        .for("update");
      if (runs.some((run) => activeStatuses.has(run.status)))
        return "active_run";
    }

    const promptVersions = promptIdList.length
      ? await tx
          .select({ id: schema.promptVersions.id })
          .from(schema.promptVersions)
          .where(
            and(
              eq(schema.promptVersions.projectId, projectId),
              inArray(schema.promptVersions.promptId, promptIdList),
            ),
          )
      : [];
    const promptVersionIds = promptVersions.map((version) => version.id);
    if (promptVersionIds.length) {
      const unrelatedRuns = runIdList.length
        ? await tx
            .select({ id: schema.runs.id })
            .from(schema.runs)
            .where(
              and(
                eq(schema.runs.projectId, projectId),
                inArray(schema.runs.promptVersionId, promptVersionIds),
                notInArray(schema.runs.id, runIdList),
              ),
            )
            .limit(1)
        : await tx
            .select({ id: schema.runs.id })
            .from(schema.runs)
            .where(
              and(
                eq(schema.runs.projectId, projectId),
                inArray(schema.runs.promptVersionId, promptVersionIds),
              ),
            )
            .limit(1);
      if (unrelatedRuns.length) return "prompt_in_use";
    }

    if (runIdList.length) {
      await tx
        .delete(schema.outbox)
        .where(
          and(
            eq(schema.outbox.projectId, projectId),
            inArray(schema.outbox.aggregateId, runIdList),
          ),
        );
      await tx
        .delete(schema.runs)
        .where(
          and(
            eq(schema.runs.projectId, projectId),
            inArray(schema.runs.id, runIdList),
          ),
        );
    }
    if (promptIdList.length) {
      await tx
        .update(schema.prompts)
        .set({ currentVersionId: null })
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            inArray(schema.prompts.id, promptIdList),
          ),
        );
      await tx
        .delete(schema.promptVersions)
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            inArray(schema.promptVersions.promptId, promptIdList),
          ),
        );
      await tx
        .delete(schema.prompts)
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            inArray(schema.prompts.id, promptIdList),
          ),
        );
    }
    await tx
      .delete(schema.workspaceConversations)
      .where(
        and(
          eq(schema.workspaceConversations.projectId, projectId),
          eq(schema.workspaceConversations.id, conversationId),
        ),
      );
    return "deleted";
  });
}
