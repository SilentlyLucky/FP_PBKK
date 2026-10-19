import {
  listWorkspaceConversations,
  saveWorkspaceConversations,
} from "@promptlab/db";
import { z } from "zod";

import { parseWorkspaceConversation } from "@/lib/workspace-conversations";
import { parseWorkspaceConversationRecord } from "@/lib/workspace-conversation-record";
import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConversationListSchema = z.strictObject({
  conversations: z.array(z.unknown()).max(100),
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
    const stored = await listWorkspaceConversations(database.db, projectId);
    const conversations = stored.map((row) => {
      const parsed = parseWorkspaceConversation(row.conversation);
      return parsed
        ? { ...parsed, id: row.id, title: row.title, updatedAt: row.updatedAt }
        : null;
    });
    if (conversations.some((conversation) => conversation === null))
      return safeApiFailure();
    return Response.json({ conversations });
  } catch {
    return safeApiFailure();
  }
}

export async function PUT(
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
  const parsed = ConversationListSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "INVALID_WORKSPACE_CONVERSATIONS" },
      { status: 400 },
    );

  const conversations = parsed.data.conversations.map(
    parseWorkspaceConversationRecord,
  );
  if (
    conversations.some((conversation) => conversation === null) ||
    new Set(conversations.map((conversation) => conversation?.id)).size !==
      conversations.length
  ) {
    return Response.json(
      { error: "INVALID_WORKSPACE_CONVERSATIONS" },
      { status: 400 },
    );
  }

  try {
    await saveWorkspaceConversations(
      database.db,
      projectId,
      conversations.filter(
        (conversation): conversation is NonNullable<typeof conversation> =>
          conversation !== null,
      ),
    );
    return Response.json({ saved: conversations.length });
  } catch {
    return safeApiFailure();
  }
}
