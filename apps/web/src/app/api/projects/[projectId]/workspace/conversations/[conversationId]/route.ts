import {
  deleteWorkspaceConversation,
  saveWorkspaceConversation,
} from "@promptlab/db";

import { parseWorkspaceConversationRecord } from "@/lib/workspace-conversation-record";
import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string; conversationId: string }> },
) {
  const { projectId: rawProjectId, conversationId: rawConversationId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const conversationId = parseRouteId(rawConversationId);
  if (!projectId || !conversationId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const conversation = parseWorkspaceConversationRecord(body);
  if (!conversation || conversation.id !== conversationId)
    return Response.json(
      { error: "INVALID_WORKSPACE_CONVERSATION" },
      { status: 400 },
    );

  try {
    await saveWorkspaceConversation(database.db, projectId, conversation);
    return Response.json({ saved: true });
  } catch {
    return safeApiFailure();
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string; conversationId: string }> },
) {
  const { projectId: rawProjectId, conversationId: rawConversationId } =
    await context.params;
  const projectId = parseRouteId(rawProjectId);
  const conversationId = parseRouteId(rawConversationId);
  if (!projectId || !conversationId)
    return Response.json({ error: "INVALID_RESOURCE_ID" }, { status: 400 });

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const deletion = await deleteWorkspaceConversation(
      database.db,
      projectId,
      conversationId,
    );
    if (deletion === "active_run") {
      return Response.json(
        {
          error: "WORKSPACE_CONVERSATION_RUN_ACTIVE",
          message: "Batalkan atau tunggu run selesai sebelum menghapus chat.",
        },
        { status: 409 },
      );
    }
    if (deletion === "prompt_in_use") {
      return Response.json(
        {
          error: "WORKSPACE_CONVERSATION_PROMPT_IN_USE",
          message:
            "Snapshot prompt terhubung ke run lain. Tidak ada data yang dihapus.",
        },
        { status: 409 },
      );
    }
    return new Response(null, { status: 204 });
  } catch {
    return safeApiFailure();
  }
}
