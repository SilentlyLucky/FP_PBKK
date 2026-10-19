import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatCompletionRequestInput,
  ProviderCompletion,
} from "@promptlab/contracts";
import { AgentDecisionSchema } from "@promptlab/agent";

const { reserveInferenceCall } = vi.hoisted(() => ({
  reserveInferenceCall:
    vi.fn<
      (provider: "campus_gateway" | "codex_app_server") => Promise<number>
    >(),
}));

vi.mock("@promptlab/providers/provider-smoke-ledger", () => ({
  reserveInferenceCall,
}));

import {
  completeWorkspaceChatDecision,
  parseWorkspaceChatDecision,
  workspaceChatDecisionJsonSchema,
  workspaceChatDecisionOutputInstructions,
} from "./workspace-chat-decision.ts";

const decision = {
  summary: "Prompt asli sudah memadai.",
  targetRecommendation: null,
  toolCalls: [],
  candidate: null,
  noChangeRecommended: true,
  finalText: "Prompt asli akan diteruskan ke Codex.",
  finish: true,
  clarificationRequired: false,
  clarification: null,
};

const request: ChatCompletionRequestInput = {
  model: "qwen3:14b",
  purpose: "optimizer",
  maxOutputTokens: 2_048,
  messages: [{ role: "user", content: "Choose a prompt." }],
};

const completion = {
  text: JSON.stringify(decision),
} as unknown as ProviderCompletion;

const retainedInvalidCampusResponse =
  '{"summary": "Prompt asli sudah memadai untuk menjawab pertanyaan refund kebijakan tanpa memerlukan peningkatan kejelasan atau struktur.", "targetRecommendation": null, "toolCalls": [], "candidate": null, "noChangeRecommended": true, "finalText": "{\'eligible\': true, \'refundWindowDays\': 30}", "finish": true, "clarificationRequired": false, "clarification": ""}';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("Workspace chat decision adapter", () => {
  it("parses a single schema-valid decision wrapped in provider text", () => {
    const text = [
      "<analysis>Private reasoning is ignored.</analysis>",
      "Decision:",
      "```json",
      JSON.stringify(decision),
      "```",
      "End of response.",
    ].join("\n");

    expect(parseWorkspaceChatDecision(text)).toMatchObject(decision);
  });

  it("rejects the retained Campus response at the clarification field", () => {
    const output = JSON.parse(retainedInvalidCampusResponse) as unknown;
    const validation = AgentDecisionSchema.safeParse(output);

    expect(validation.success).toBe(false);
    if (validation.success) return;
    expect(validation.error.issues).toEqual([
      expect.objectContaining({
        path: ["clarification"],
        code: "invalid_type",
        expected: "object",
        message: "Invalid input: expected object, received string",
      }),
    ]);
    expect(() =>
      parseWorkspaceChatDecision(retainedInvalidCampusResponse),
    ).toThrow("WORKSPACE_CHAT_OUTPUT_INVALID");
  });

  it("accepts the clarification object shape required by the decision schema", () => {
    const clarificationDecision = {
      ...decision,
      summary: "Satu pilihan penting diperlukan sebelum prompt dapat disusun.",
      noChangeRecommended: false,
      finalText: null,
      finish: false,
      clarificationRequired: true,
      clarification: {
        question: "Sasaran utama mana yang harus dipilih?",
        reasonCode: "objective_choice",
        choices: [],
        publicContext: null,
      },
    };

    expect(
      parseWorkspaceChatDecision(JSON.stringify(clarificationDecision)),
    ).toMatchObject(clarificationDecision);
  });

  it("generates a strict per-turn schema and shows valid decision examples", () => {
    const schema = workspaceChatDecisionJsonSchema(["search_knowledge"]);
    const properties = schema.properties as Record<string, unknown>;
    const toolCalls = properties.toolCalls as Record<string, unknown>;
    const items = toolCalls.items as Record<string, unknown>;
    const variants = items.oneOf as Array<Record<string, unknown>>;
    const toolNames = variants.map((variant) => {
      const variantProperties = variant.properties as Record<string, unknown>;
      return (variantProperties.name as Record<string, unknown>).const;
    });
    const clarification = properties.clarification as Record<string, unknown>;
    const clarificationVariants = clarification.anyOf as Array<
      Record<string, unknown>
    >;
    const clarificationObject = clarificationVariants.find(
      (variant) => variant.type === "object",
    );
    const instructions = workspaceChatDecisionOutputInstructions([
      "search_knowledge",
    ]);

    expect(schema.required).toEqual(Object.keys(properties));
    expect(schema.additionalProperties).toBe(false);
    expect(toolCalls.maxItems).toBe(1);
    expect(toolNames).toEqual(["search_knowledge"]);
    expect(
      clarificationVariants.some((variant) => variant.type === "null"),
    ).toBe(true);
    expect(clarificationObject?.properties).toMatchObject({
      question: { type: "string" },
      reasonCode: { type: "string" },
      choices: { type: "array" },
      publicContext: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    expect(instructions).toContain('"clarification": null');
    expect(instructions).toContain('"reasonCode": "objective_choice"');
    expect(instructions).toContain(
      "jangan jawab permintaan pengguna di finalText",
    );
    expect(instructions).not.toContain('"const": "call_codex_target"');
  });

  it("forbids tool calls on turns with no available tools", () => {
    const schema = workspaceChatDecisionJsonSchema([]);
    const properties = schema.properties as Record<string, unknown>;
    const toolCalls = properties.toolCalls as Record<string, unknown>;

    expect(toolCalls.maxItems).toBe(0);
    expect(toolCalls.items).toBe(false);
  });

  it("rejects malformed, ambiguous, and schema-invalid output", () => {
    expect(() => parseWorkspaceChatDecision("not JSON")).toThrow(
      "WORKSPACE_CHAT_OUTPUT_INVALID",
    );
    expect(() =>
      parseWorkspaceChatDecision(
        `${JSON.stringify(decision)}\n${JSON.stringify(decision)}`,
      ),
    ).toThrow("WORKSPACE_CHAT_OUTPUT_INVALID");
    expect(() =>
      parseWorkspaceChatDecision(JSON.stringify({ ...decision, summary: 42 })),
    ).toThrow("WORKSPACE_CHAT_OUTPUT_INVALID");
    expect(() =>
      parseWorkspaceChatDecision(
        JSON.stringify({
          ...decision,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          toolCalls: [
            {
              name: "search_all_sources",
              arguments: { query: "refund" },
            },
          ],
        }),
      ),
    ).toThrow("WORKSPACE_CHAT_OUTPUT_INVALID");
    expect(() =>
      parseWorkspaceChatDecision(
        JSON.stringify({
          ...decision,
          noChangeRecommended: false,
          finalText: null,
          finish: false,
          toolCalls: [
            {
              name: "search_knowledge",
              arguments: {
                query: "refund",
                sourceIds: [],
                limit: 5,
                unrestricted: true,
              },
            },
          ],
        }),
      ),
    ).toThrow("WORKSPACE_CHAT_OUTPUT_INVALID");
    expect(() =>
      workspaceChatDecisionJsonSchema(["search_everything"]),
    ).toThrow("WORKSPACE_CHAT_DECISION_TOOL_SCHEMA_MISMATCH");
  });

  it("reserves the Campus campaign call before counting and invoking inference", async () => {
    vi.stubEnv(
      "PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN",
      "workspace-chat-test-000000000001",
    );
    const order: string[] = [];
    reserveInferenceCall.mockImplementation(async (provider) => {
      order.push(`reserved:${provider}`);
      return 1;
    });
    const provider = {
      complete: vi.fn(
        async (
          _request: ChatCompletionRequestInput,
          _options?: { signal?: AbortSignal },
        ) => {
          order.push("inference");
          return completion;
        },
      ),
    };
    const controller = new AbortController();
    const onAttempt = vi.fn(() => order.push("attempt-counted"));

    await expect(
      completeWorkspaceChatDecision({
        campusChat: provider,
        request,
        signal: controller.signal,
        onAttempt,
      }),
    ).resolves.toBe(completion);

    expect(order).toEqual([
      "reserved:campus_gateway",
      "attempt-counted",
      "inference",
    ]);
    expect(provider.complete).toHaveBeenCalledExactlyOnceWith(request, {
      signal: controller.signal,
    });
  });

  it("does not count or invoke inference when campaign reservation fails", async () => {
    vi.stubEnv(
      "PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN",
      "workspace-chat-test-000000000002",
    );
    reserveInferenceCall.mockRejectedValue(new Error("campaign cap reached"));
    const provider = {
      complete: vi.fn(
        async (
          _request: ChatCompletionRequestInput,
          _options?: { signal?: AbortSignal },
        ) => completion,
      ),
    };
    const onAttempt = vi.fn();

    await expect(
      completeWorkspaceChatDecision({
        campusChat: provider,
        request,
        signal: new AbortController().signal,
        onAttempt,
      }),
    ).rejects.toThrow("campaign cap reached");

    expect(onAttempt).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("counts a reserved inference attempt when the provider call fails", async () => {
    vi.stubEnv(
      "PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN",
      "workspace-chat-test-000000000003",
    );
    reserveInferenceCall.mockResolvedValue(1);
    const provider = {
      complete: vi.fn(
        async (
          _request: ChatCompletionRequestInput,
          _options?: { signal?: AbortSignal },
        ) => {
          throw new Error("provider failed");
        },
      ),
    };
    const onAttempt = vi.fn();

    await expect(
      completeWorkspaceChatDecision({
        campusChat: provider,
        request,
        signal: new AbortController().signal,
        onAttempt,
      }),
    ).rejects.toThrow("provider failed");

    expect(reserveInferenceCall).toHaveBeenCalledExactlyOnceWith(
      "campus_gateway",
    );
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(provider.complete).toHaveBeenCalledOnce();
  });
});
