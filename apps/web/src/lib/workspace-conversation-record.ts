import { IdSchema } from "@promptlab/contracts";

import type { StoredWorkspaceConversation } from "@promptlab/db";
import { parseWorkspaceConversation } from "./workspace-conversations.js";

export function parseWorkspaceConversationRecord(
  value: unknown,
): StoredWorkspaceConversation | null {
  const conversation = parseWorkspaceConversation(value);
  const id = IdSchema.safeParse(conversation?.id);
  if (
    !conversation ||
    !id.success ||
    !Number.isFinite(Date.parse(conversation.updatedAt))
  ) {
    return null;
  }

  return {
    id: id.data,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    conversation: conversation as unknown as Record<string, unknown>,
  };
}
