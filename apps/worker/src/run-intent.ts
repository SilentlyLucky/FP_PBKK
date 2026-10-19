import {
  RunIntentConfigurationSchema,
  WorkspaceChatRequestSchema,
} from "@promptlab/contracts";
import { z } from "zod";

export const WorkspaceChatTargetSchema = z
  .strictObject({
    requestedModel: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(32).nullable(),
    reasoningEffortMode: z.enum(["selected", "auto"]).optional(),
  })
  .nullable();

export function workspaceChatTargetMatchesVerifiedConfiguration(input: {
  workspaceChat: unknown;
  verifiedTarget: unknown;
}): boolean {
  const chat = WorkspaceChatRequestSchema.safeParse(input.workspaceChat);
  const verifiedTarget = WorkspaceChatTargetSchema.safeParse(
    input.verifiedTarget,
  );
  if (!chat.success || !verifiedTarget.success) return false;
  if (chat.data.target === null) return verifiedTarget.data === null;
  return (
    verifiedTarget.data !== null &&
    verifiedTarget.data.requestedModel === chat.data.target.requestedModel &&
    verifiedTarget.data.reasoningEffort === chat.data.target.reasoningEffort &&
    (verifiedTarget.data.reasoningEffortMode ?? "selected") ===
      (chat.data.target.reasoningEffortMode ?? "selected")
  );
}

export function parsePersistedRunIntent(input: {
  provider: string;
  purpose: string;
  configSnapshot: Record<string, unknown>;
}) {
  const config = input.configSnapshot;
  return RunIntentConfigurationSchema.safeParse({
    runIntent: config.runIntent,
    provider: input.provider,
    purpose: input.purpose,
    ...(Object.hasOwn(config, "workspaceChat")
      ? { workspaceChat: config.workspaceChat }
      : {}),
    ...(Object.hasOwn(config, "optimization")
      ? { optimization: config.optimization }
      : {}),
    ...(Object.hasOwn(config, "controlledEvaluation")
      ? { controlledEvaluation: config.controlledEvaluation }
      : {}),
    ...(Object.hasOwn(config, "workspaceFileDraft")
      ? { workspaceFileDraft: config.workspaceFileDraft }
      : {}),
  });
}
