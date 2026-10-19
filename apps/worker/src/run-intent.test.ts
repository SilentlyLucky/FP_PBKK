import { describe, expect, it } from "vitest";

import {
  parsePersistedRunIntent,
  workspaceChatTargetMatchesVerifiedConfiguration,
} from "./run-intent.js";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("persisted run intent dispatch", () => {
  it("matches a Workspace chat target to the server-verified target snapshot", () => {
    const workspaceChat = {
      format: "promptlab-workspace-chat-v1",
      target: {
        requestedModel: "gpt-6-codex",
        reasoningEffort: "medium",
      },
    };
    expect(
      workspaceChatTargetMatchesVerifiedConfiguration({
        workspaceChat,
        verifiedTarget: workspaceChat.target,
      }),
    ).toBe(true);
    expect(
      workspaceChatTargetMatchesVerifiedConfiguration({
        workspaceChat,
        verifiedTarget: {
          ...workspaceChat.target,
          reasoningEffort: "high",
        },
      }),
    ).toBe(false);
    expect(
      workspaceChatTargetMatchesVerifiedConfiguration({
        workspaceChat: {
          format: "promptlab-workspace-chat-v1",
          target: null,
        },
        verifiedTarget: workspaceChat.target,
      }),
    ).toBe(false);
    const autoChat = {
      format: "promptlab-workspace-chat-v1",
      target: {
        requestedModel: "gpt-6-luna",
        reasoningEffort: null,
        reasoningEffortMode: "auto",
      },
    };
    expect(
      workspaceChatTargetMatchesVerifiedConfiguration({
        workspaceChat: autoChat,
        verifiedTarget: autoChat.target,
      }),
    ).toBe(true);
    expect(
      workspaceChatTargetMatchesVerifiedConfiguration({
        workspaceChat: autoChat,
        verifiedTarget: {
          requestedModel: "gpt-6-luna",
          reasoningEffort: null,
        },
      }),
    ).toBe(false);
  });

  it("routes only a workspace chat config to mandatory optimization", () => {
    const parsed = parsePersistedRunIntent({
      provider: "campus_gateway",
      purpose: "optimizer",
      configSnapshot: {
        runIntent: "workspace_chat",
        workspaceChat: {
          format: "promptlab-workspace-chat-v1",
          target: {
            requestedModel: "gpt-6-codex",
            reasoningEffort: null,
            reasoningEffortMode: "auto",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.runIntent).toBe("workspace_chat");
      expect(parsed.data.workspaceChat?.target?.reasoningEffortMode).toBe(
        "auto",
      );
    }
  });

  it("fails closed for an unclassified direct target run", () => {
    const parsed = parsePersistedRunIntent({
      provider: "codex_app_server",
      purpose: "target",
      configSnapshot: { retrieval: { strategy: "lexical", sourceIds: [] } },
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps prompt optimization target work separate from workspace chat", () => {
    const parsed = parsePersistedRunIntent({
      provider: "codex_app_server",
      purpose: "target",
      configSnapshot: {
        runIntent: "prompt_optimization",
        optimization: {},
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.runIntent).toBe("prompt_optimization");
  });

  it("allows file-draft target work only with its intent payload", () => {
    const parsed = parsePersistedRunIntent({
      provider: "codex_app_server",
      purpose: "target",
      configSnapshot: {
        runIntent: "workspace_file_draft",
        workspaceFileDraft: {
          format: "promptlab-workspace-file-draft-run-v1",
          path: "notes/draft.md",
          snapshotHash: "a".repeat(64),
          readGrantId: projectId,
          writeGrantId: "22222222-2222-4222-8222-222222222222",
          taskOptimizationConsent: true,
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.runIntent).toBe("workspace_file_draft");
    expect(
      parsePersistedRunIntent({
        provider: "codex_app_server",
        purpose: "target",
        configSnapshot: {
          runIntent: "workspace_file_draft",
          workspaceFileDraft: {
            format: "promptlab-workspace-file-draft-run-v1",
            path: "notes/draft.md",
            snapshotHash: "a".repeat(64),
            readGrantId: projectId,
            writeGrantId: "22222222-2222-4222-8222-222222222222",
            taskOptimizationConsent: true,
          },
          optimization: {},
        },
      }).success,
    ).toBe(false);
  });
});
