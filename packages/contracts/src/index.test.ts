import { describe, expect, it } from "vitest";

import {
  AgentToolCallSchema,
  OptimizationClarificationAnswerRequestSchema,
  OptimizationClarificationSchema,
  GraphExtractionSchema,
  PromptQualityVoteSchema,
  PromptOptimizationOutcomeSchema,
  PromptOptimizationRequestSchema,
  PromptOptimizationRevisionOutcomeSchema,
  PromptOptimizationVerificationSchema,
  RunCreateSchema,
  RunIntentConfigurationSchema,
  RunRetrievalSelectionSchema,
  ToolNameSchema,
  WorkspaceRetrievalStrategySchema,
  WorkspaceRunRetrievalSelectionSchema,
  WorkspaceSourceManifestSchema,
  composeWorkspaceFileDraftPrompt,
  parseWorkspaceFileDraftPrompt,
} from "./index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const promptVersionId = "22222222-2222-4222-8222-222222222222";

describe("Workspace source manifest contract", () => {
  it("requires a version, checksum, and approved egress permission per source", () => {
    const manifest = {
      format: "promptlab-workspace-source-manifest-v1",
      sources: [
        {
          documentId: projectId,
          documentVersionId: promptVersionId,
          documentVersion: 3,
          checksum: "a".repeat(64),
          sourcePermission: "campus_indexer_allowed",
        },
      ],
    };

    expect(WorkspaceSourceManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      WorkspaceSourceManifestSchema.safeParse({
        ...manifest,
        sources: [{ ...manifest.sources[0], sourcePermission: "local_only" }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceSourceManifestSchema.safeParse({
        ...manifest,
        sources: [{ ...manifest.sources[0], untracked: true }],
      }).success,
    ).toBe(false);
  });

  it("retains full-context retrieval in the run contract", () => {
    expect(
      RunRetrievalSelectionSchema.parse({
        strategy: "full_context",
        sourceIds: [projectId],
      }).strategy,
    ).toBe("full_context");
  });

  it("accepts hybrid workspace retrieval without a graph snapshot", () => {
    expect(WorkspaceRetrievalStrategySchema.parse("hybrid")).toBe("hybrid");
    expect(
      WorkspaceRunRetrievalSelectionSchema.parse({
        strategy: "hybrid",
        sourceIds: [projectId],
      }),
    ).toEqual({ strategy: "hybrid", sourceIds: [projectId] });
  });
});

describe("verified memory search tool contract", () => {
  it("registers a bounded query and result limit", () => {
    expect(ToolNameSchema.parse("search_verified_memory")).toBe(
      "search_verified_memory",
    );
    expect(
      AgentToolCallSchema.parse({
        name: "search_verified_memory",
        arguments: { query: "  current task  " },
      }),
    ).toEqual({
      name: "search_verified_memory",
      arguments: { query: "current task", limit: 5 },
    });
    expect(
      AgentToolCallSchema.safeParse({
        name: "search_verified_memory",
        arguments: { query: "current task", limit: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("graph extraction contract", () => {
  it("defaults omitted nullable qualifiers to null", () => {
    const parsed = GraphExtractionSchema.parse({
      schemaVersion: "promptlab-graph-extraction-v1",
      projectId,
      runId: "33333333-3333-4333-8333-333333333333",
      documentVersionId: "44444444-4444-4444-8444-444444444444",
      chunkId: "55555555-5555-4555-8555-555555555555",
      requestedModel: "qwen3:14b",
      entities: [],
      relations: [
        {
          subjectLocalId: "even-number",
          predicate: "defines",
          objectLocalId: "integer",
          direction: "directed",
          qualifiers: { negated: null },
          quote: "Bilangan genap adalah bilangan bulat.",
          spanStart: 0,
          spanEnd: 38,
        },
      ],
    });

    expect(parsed.relations[0]?.qualifiers).toEqual({
      dateOrVersion: null,
      negated: null,
      modality: null,
      conditions: null,
    });
  });

  it("keeps relation qualifiers strict about unknown fields", () => {
    const result = GraphExtractionSchema.safeParse({
      schemaVersion: "promptlab-graph-extraction-v1",
      projectId,
      runId: "33333333-3333-4333-8333-333333333333",
      documentVersionId: "44444444-4444-4444-8444-444444444444",
      chunkId: "55555555-5555-4555-8555-555555555555",
      requestedModel: "qwen3:14b",
      entities: [],
      relations: [
        {
          subjectLocalId: "even-number",
          predicate: "defines",
          objectLocalId: "integer",
          direction: "directed",
          qualifiers: { unexpected: "value" },
          quote: "Bilangan genap adalah bilangan bulat.",
          spanStart: 0,
          spanEnd: 38,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("automatic prompt optimization contract", () => {
  it("defaults the objective and test cases when both are omitted", () => {
    expect(PromptOptimizationRequestSchema.parse({})).toEqual({
      objective:
        "Tingkatkan prompt berdasarkan analisis dan konteks yang tersedia.",
      maxIterations: 2,
      maxToolCalls: 6,
      testCases: [],
    });
  });

  it("keeps legacy outcomes valid and adds explicit no-change and rejection outcomes", () => {
    expect(PromptOptimizationOutcomeSchema.options).toEqual([
      "candidate_ready",
      "incomplete",
      "clarification_required",
      "no_change_recommended",
      "candidate_rejected",
    ]);
    expect(
      PromptOptimizationRevisionOutcomeSchema.parse("no_change_recommended"),
    ).toBe("no_change_recommended");
    expect(
      PromptOptimizationRevisionOutcomeSchema.parse("candidate_rejected"),
    ).toBe("candidate_rejected");
  });

  it("retains explicit one-iteration requests under the two-iteration default", () => {
    expect(
      PromptOptimizationRequestSchema.parse({ maxIterations: 1 }).maxIterations,
    ).toBe(1);
    expect(
      PromptOptimizationRequestSchema.parse({ maxIterations: 2 }).maxIterations,
    ).toBe(2);
    expect(
      PromptOptimizationRequestSchema.safeParse({ maxIterations: 3 }).success,
    ).toBe(false);
  });

  it("accepts only the public allowlisted clarification fields", () => {
    const clarification = OptimizationClarificationSchema.parse({
      id: "33333333-3333-4333-8333-333333333333",
      projectId,
      runId: "44444444-4444-4444-8444-444444444444",
      promptId: "55555555-5555-4555-8555-555555555555",
      promptVersionId,
      question: "Untuk siapa prompt ini terutama digunakan?",
      reasonCode: "audience",
      choices: ["Mahasiswa", "Pengajar"],
      publicContext: "Pilihan ini mengubah tingkat detail jawaban.",
      createdAt: "2026-10-15T00:00:00.000Z",
      lifecycle: "awaiting_answer",
    });

    expect(clarification.reasonCode).toBe("audience");
    expect(
      OptimizationClarificationSchema.safeParse({
        ...clarification,
        hiddenReasoning: "private chain of thought",
      }).success,
    ).toBe(false);
    expect(
      OptimizationClarificationSchema.safeParse({
        ...clarification,
        reasonCode: "miscellaneous",
      }).success,
    ).toBe(false);
  });

  it("validates answer retries with a bounded public answer and key", () => {
    expect(
      OptimizationClarificationAnswerRequestSchema.parse({
        answer: "Untuk mahasiswa tingkat awal.",
        idempotencyKey: "answer-retry-key-1",
      }),
    ).toEqual({
      answer: "Untuk mahasiswa tingkat awal.",
      idempotencyKey: "answer-retry-key-1",
    });
    expect(
      OptimizationClarificationAnswerRequestSchema.safeParse({
        answer: "ok",
        idempotencyKey: "short",
        chainOfThought: "hidden",
      }).success,
    ).toBe(false);
  });

  it("accepts a Codex target run without a user objective or test cases", () => {
    const parsed = RunCreateSchema.parse({
      projectId,
      promptVersionId,
      provider: "codex_app_server",
      requestedModel: "gpt-5.6-codex",
      reasoningEffort: "high",
      purpose: "target",
      intent: "prompt_optimization",
      idempotencyKey: "automatic-optimization-qa",
      optimization: {},
    });

    expect(parsed).toMatchObject({
      provider: "codex_app_server",
      requestedModel: "gpt-5.6-codex",
      reasoningEffort: "high",
      purpose: "target",
      optimization: {
        objective:
          "Tingkatkan prompt berdasarkan analisis dan konteks yang tersedia.",
        testCases: [],
      },
    });
  });

  it("requires normal Workspace chat to use Senopati and excludes optimizer runs", () => {
    const parsed = RunCreateSchema.parse({
      projectId,
      promptVersionId,
      provider: "campus_gateway",
      requestedModel: "senopati-model",
      purpose: "optimizer",
      intent: "workspace_chat",
      idempotencyKey: "workspace-chat-idempotency-1",
      retrieval: { strategy: "lexical", sourceIds: [] },
      workspaceChat: {
        format: "promptlab-workspace-chat-v1",
        target: null,
      },
    });
    expect(parsed.workspaceChat).toMatchObject({
      format: "promptlab-workspace-chat-v1",
      target: null,
    });
    expect(
      RunCreateSchema.safeParse({
        ...parsed,
        provider: "codex_app_server",
        purpose: "target",
      }).success,
    ).toBe(false);
    expect(
      RunCreateSchema.safeParse({
        ...parsed,
        optimization: {},
      }).success,
    ).toBe(false);
    expect(
      RunCreateSchema.safeParse({
        ...parsed,
        provider: "codex_app_server",
        purpose: "target",
        requestedModel: "gpt-5.6-codex",
      }).success,
    ).toBe(false);
    expect(
      RunCreateSchema.safeParse({
        ...parsed,
        controlledEvaluation: {},
      }).success,
    ).toBe(false);
  });

  it("round-trips Workspace Auto effort without changing its explicit model", () => {
    const request = RunCreateSchema.parse({
      projectId,
      promptVersionId,
      provider: "campus_gateway",
      requestedModel: "senopati-model",
      purpose: "optimizer",
      intent: "workspace_chat",
      idempotencyKey: "workspace-chat-auto-effort-1",
      retrieval: { strategy: "lexical", sourceIds: [] },
      workspaceChat: {
        format: "promptlab-workspace-chat-v1",
        target: {
          requestedModel: "gpt-6-luna",
          reasoningEffort: null,
          reasoningEffortMode: "auto",
        },
      },
    });
    const reloaded = RunCreateSchema.parse(JSON.parse(JSON.stringify(request)));

    expect(reloaded.workspaceChat?.target).toEqual({
      requestedModel: "gpt-6-luna",
      reasoningEffort: null,
      reasoningEffortMode: "auto",
    });
    expect(
      RunCreateSchema.safeParse({
        ...request,
        workspaceChat: {
          ...request.workspaceChat!,
          target: {
            requestedModel: "gpt-6-luna",
            reasoningEffort: "low",
            reasoningEffortMode: "auto",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires an explicit intent and rejects a mismatched persisted dispatch", () => {
    const directTarget = {
      projectId,
      promptVersionId,
      provider: "codex_app_server",
      requestedModel: "gpt-5.6-codex",
      purpose: "target",
      idempotencyKey: "unclassified-user-target",
    };
    expect(RunCreateSchema.safeParse(directTarget).success).toBe(false);
    expect(
      RunCreateSchema.safeParse({
        ...directTarget,
        intent: "workspace_chat",
      }).success,
    ).toBe(false);
    expect(
      RunIntentConfigurationSchema.safeParse({
        runIntent: "workspace_chat",
        provider: "campus_gateway",
        purpose: "optimizer",
      }).success,
    ).toBe(false);
    expect(
      RunIntentConfigurationSchema.safeParse({
        runIntent: "workspace_file_draft",
        provider: "codex_app_server",
        purpose: "target",
        workspaceFileDraft: {
          format: "promptlab-workspace-file-draft-run-v1",
          path: "notes/draft.md",
          snapshotHash: "a".repeat(64),
          readGrantId: projectId,
          writeGrantId: promptVersionId,
          taskOptimizationConsent: true,
        },
      }).success,
    ).toBe(true);
    expect(
      RunCreateSchema.safeParse({
        projectId,
        promptVersionId,
        provider: "codex_app_server",
        requestedModel: "gpt-5.6-codex",
        purpose: "target",
        intent: "workspace_file_draft",
        idempotencyKey: "draft-run-without-task-consent",
        workspaceFileDraft: {
          format: "promptlab-workspace-file-draft-run-v1",
          path: "notes/draft.md",
          snapshotHash: "a".repeat(64),
          readGrantId: projectId,
          writeGrantId: promptVersionId,
        },
      }).success,
    ).toBe(false);
    expect(
      RunIntentConfigurationSchema.safeParse({
        runIntent: "workspace_file_draft",
        provider: "codex_app_server",
        purpose: "target",
        workspaceFileDraft: {
          format: "promptlab-workspace-file-draft-run-v1",
          path: "notes/draft.md",
          snapshotHash: "a".repeat(64),
          readGrantId: projectId,
          writeGrantId: promptVersionId,
          taskOptimizationConsent: true,
        },
        workspaceChat: {
          format: "promptlab-workspace-chat-v1",
          target: null,
        },
      }).success,
    ).toBe(false);
  });

  it("shares one canonical file-draft prompt parser across app and worker", () => {
    const prompt = composeWorkspaceFileDraftPrompt({
      task: "Rewrite clearly",
      fileText: "untrusted content",
    });
    expect(parseWorkspaceFileDraftPrompt(prompt)).toEqual({
      task: "Rewrite clearly",
      fileText: "untrusted content",
    });
    expect(parseWorkspaceFileDraftPrompt(prompt + "\nextra")).toBeNull();
  });

  it("accepts representative cases without phrase-based quality assertions", () => {
    const parsed = PromptOptimizationRequestSchema.parse({
      testCases: [
        {
          id: "case-1",
          input: "Summarize the policy in one sentence.",
        },
      ],
    });

    expect(parsed.testCases).toEqual([
      {
        id: "case-1",
        input: "Summarize the policy in one sentence.",
        expectedTerms: [],
        forbiddenTerms: [],
      },
    ]);
  });

  it("accepts opt-in target selection and bounded independent verification fixtures", () => {
    const parsed = PromptOptimizationRequestSchema.parse({
      targetSelection: { model: "auto", reasoningEffort: "auto" },
      testCases: [
        {
          id: "math-case",
          input: "Return a JSON object with count and sum.",
          verification: {
            kind: "divisibility",
            startInclusive: 1,
            endInclusive: 1_000,
            includeDivisors: [3, 5],
            excludeDivisors: [7],
            expected: { count: "401", sum: "200995" },
          },
        },
      ],
    });

    expect(parsed.targetSelection).toEqual({
      model: "auto",
      reasoningEffort: "auto",
    });
    expect(parsed.testCases[0]?.verification).toMatchObject({
      kind: "divisibility",
      expected: { count: "401", sum: "200995" },
    });
    expect(
      PromptOptimizationVerificationSchema.safeParse({
        kind: "python_tests",
        tests: Array.from({ length: 41 }, (_, index) => ({
          id: `case-${index}`,
          n: 1,
          expectedOutput: "1",
        })),
      }).success,
    ).toBe(false);
  });

  it("round-trips Auto effort through run validation and JSON-backed configuration", () => {
    const request = RunCreateSchema.parse({
      projectId: "11111111-1111-4111-8111-111111111111",
      promptVersionId: "22222222-2222-4222-8222-222222222222",
      provider: "codex_app_server",
      requestedModel: "gpt-6.1-sol",
      purpose: "target",
      intent: "prompt_optimization",
      idempotencyKey: "auto-effort-roundtrip",
      optimization: {
        targetSelection: { model: "selected", reasoningEffort: "auto" },
      },
    });
    const persistedConfiguration = JSON.parse(
      JSON.stringify({ optimization: request.optimization }),
    ) as { optimization: unknown };
    const reloaded = PromptOptimizationRequestSchema.parse(
      persistedConfiguration.optimization,
    );

    expect(request.reasoningEffort).toBeUndefined();
    expect(reloaded.targetSelection).toEqual({
      model: "selected",
      reasoningEffort: "auto",
    });
    expect(PromptOptimizationRequestSchema.parse({}).targetSelection).toBe(
      undefined,
    );
  });

  it("requires an explicit user quality decision for a specific candidate", () => {
    expect(
      PromptQualityVoteSchema.parse({
        candidateId: "33333333-3333-4333-8333-333333333333",
        decision: "candidate_better",
      }),
    ).toEqual({
      candidateId: "33333333-3333-4333-8333-333333333333",
      decision: "candidate_better",
      note: "",
    });
    expect(
      PromptQualityVoteSchema.parse({
        candidateId: "33333333-3333-4333-8333-333333333333",
        decision: "inconclusive",
      }).decision,
    ).toBe("inconclusive");

    expect(
      PromptQualityVoteSchema.safeParse({
        vote: "new_better",
      }).success,
    ).toBe(false);
  });
});
