import { z } from "zod";

export {
  composeWorkspaceFileDraftPrompt,
  MAX_WORKSPACE_FILE_DRAFT_TASK_CHARACTERS,
  parseWorkspaceFileDraftPrompt,
} from "./workspace-file-draft.js";

export const IdSchema = z.uuid();
export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const ProjectCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().max(2_000).nullable().default(null),
});

export const PromptVersionCreateSchema = z.strictObject({
  projectId: IdSchema,
  promptId: IdSchema.nullable().default(null),
  text: z.string().min(1).max(100_000),
  parentVersionId: IdSchema.nullable().default(null),
  invariants: z.array(z.string().trim().min(1).max(500)).max(40).default([]),
});

export const RunPurposeSchema = z.enum([
  "optimizer",
  "target",
  "evaluator",
  "auxiliary",
  "graph_indexing",
  "graph_query_model",
]);

export const RunStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "cancel_requested",
  "paused_quota",
  "paused_auth_required",
  "succeeded",
  "failed",
  "canceled",
  "interrupted_unknown",
]);

export const ProviderIdSchema = z.enum([
  "campus_gateway",
  "codex_app_server",
  "claude_cli",
  "fixture",
]);

export const UsageMetricSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reported"),
    value: z.number().int().nonnegative().safe(),
    observedAt: IsoTimestampSchema,
    method: z.string().min(1).max(120),
  }),
  z.strictObject({
    status: z.literal("estimated"),
    value: z.number().int().nonnegative().safe(),
    observedAt: IsoTimestampSchema,
    method: z.string().min(1).max(120),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    value: z.null(),
    reason: z.string().min(1).max(240),
  }),
]);

export const UsageSnapshotSchema = z.strictObject({
  inputTokens: UsageMetricSchema,
  outputTokens: UsageMetricSchema,
  cacheReadTokens: UsageMetricSchema,
  cacheWriteTokens: UsageMetricSchema,
  completeness: z.enum(["complete", "partial", "unknown"]),
  responseId: z.string().max(300).nullable(),
  mapperVersion: z.string().min(1).max(80),
});

export const CapabilityStatusSchema = z.enum([
  "supported",
  "unsupported",
  "policy_restricted",
  "unknown",
  "not_observed",
  "not_exposed",
  "failed",
  "blocked",
]);

export const CapabilityEvidenceSchema = z.strictObject({
  status: CapabilityStatusSchema,
  checkedAt: IsoTimestampSchema.nullable(),
  adapterVersion: z.string().max(120).nullable(),
  evidenceRef: z.string().max(300).nullable(),
  reason: z.string().max(500).nullable(),
});

export const ProviderCapabilitySchema = z.strictObject({
  provider: ProviderIdSchema,
  role: z.enum(["optimizer", "target", "evaluator", "auxiliary"]),
  connectionStatus: z.enum([
    "unavailable",
    "configured_unverified",
    "verified",
    "blocked",
  ]),
  requestedModel: z.string().max(200).nullable(),
  responseModel: z.string().max(200).nullable(),
  endpointLabel: z.string().max(200).nullable(),
  capabilities: z.strictObject({
    streamText: CapabilityEvidenceSchema,
    reportedUsage: CapabilityEvidenceSchema,
    cacheReadReporting: CapabilityEvidenceSchema,
    cacheWriteReporting: CapabilityEvidenceSchema,
    cancellation: CapabilityEvidenceSchema,
    remoteCancellation: CapabilityEvidenceSchema,
    structuredOutput: CapabilityEvidenceSchema,
    toolCalls: CapabilityEvidenceSchema,
    quotaReporting: CapabilityEvidenceSchema,
  }),
});

export const ProviderConnectionStateSchema = z.strictObject({
  provider: ProviderIdSchema,
  status: z.enum([
    "unavailable",
    "configured_unverified",
    "verified",
    "blocked",
  ]),
  role: z.enum(["optimizer", "target", "evaluator", "auxiliary"]),
  requestedModel: z.string().max(200).nullable(),
  responseModel: z.string().max(200).nullable(),
  endpointLabel: z.string().max(200).nullable(),
  checkedAt: IsoTimestampSchema.nullable(),
  reason: z.string().max(500).nullable(),
  capabilities: z.record(z.string(), CapabilityEvidenceSchema),
});

export const ChatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(100_000),
});

export const ChatCompletionRequestSchema = z.strictObject({
  model: z.string().trim().min(1).max(200),
  messages: z.array(ChatMessageSchema).min(1).max(100),
  maxOutputTokens: z.number().int().min(1).max(8_000).default(512),
  purpose: RunPurposeSchema,
});

export const ProviderCompletionSchema = z.strictObject({
  provider: ProviderIdSchema,
  requestedModel: z.string().max(200),
  responseModel: z.string().max(200).nullable(),
  responseId: z.string().max(300).nullable(),
  text: z.string().max(100_000),
  usage: UsageSnapshotSchema,
  observedAt: IsoTimestampSchema,
});

export const RetrievalStrategySchema = z.enum([
  "lexical",
  "graph",
  "full_context",
]);

export const WorkspaceRetrievalStrategySchema = z.enum([
  "auto",
  "lexical",
  "hybrid",
  "graph",
  "full_context",
]);

export const RunRetrievalSelectionSchema = z.strictObject({
  strategy: RetrievalStrategySchema,
  // An empty selection means no sources; it never expands to every project source.
  sourceIds: z.array(IdSchema).max(20).default([]),
  // Experiments freeze the graph snapshot selected at setup time. Legacy runs
  // omit this and resolve their snapshot in the worker preflight.
  snapshotId: IdSchema.nullable().optional(),
});

export const WorkspaceRunRetrievalSelectionSchema = z.strictObject({
  strategy: WorkspaceRetrievalStrategySchema,
  // An empty selection means no sources; it never expands to every project source.
  sourceIds: z.array(IdSchema).max(20).default([]),
  // The server may freeze a compatible graph snapshot for Auto at enqueue.
  // Clients may select this only for explicit GraphRAG.
  snapshotId: IdSchema.nullable().optional(),
});

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const EvaluationSourceVersionSchema = z.strictObject({
  documentId: IdSchema,
  documentVersionId: IdSchema,
  documentVersion: z.number().int().positive(),
  checksum: z.string().min(1).max(256),
});

export const WorkspaceSourceManifestEntrySchema =
  EvaluationSourceVersionSchema.extend({
    sourcePermission: z.literal("campus_indexer_allowed"),
  });

export type WorkspaceSourceManifestEntry = z.infer<
  typeof WorkspaceSourceManifestEntrySchema
>;

export const WorkspaceSourceManifestSchema = z.strictObject({
  format: z.literal("promptlab-workspace-source-manifest-v1"),
  sources: z.array(WorkspaceSourceManifestEntrySchema).max(20),
});

export type WorkspaceSourceManifest = z.infer<
  typeof WorkspaceSourceManifestSchema
>;

export const EvaluationEvidenceItemSchema = z.strictObject({
  id: z.string().trim().min(1).max(300),
  kind: z.enum(["graph", "chunk"]),
  documentId: IdSchema,
  documentName: z.string().max(500),
  documentVersionId: IdSchema,
  documentVersion: z.number().int().positive(),
  chunkId: IdSchema,
  sourceChecksum: z.string().min(1).max(256),
  quote: z.string().max(10_000),
  contentHash: Sha256Schema,
  assertionVersionIds: z.array(IdSchema).max(40),
});

export const EvaluationEvidencePackSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(80),
  requestedStrategy: z.enum([
    "none",
    "lexical",
    "graph",
    "full_context",
    "hybrid",
  ]),
  strategyUsed: z.enum(["none", "lexical", "graph", "full_context", "hybrid"]),
  selectedSnapshotId: IdSchema.nullable(),
  usedSnapshotId: IdSchema.nullable(),
  fallbackReason: z.string().max(300).nullable(),
  selectedSourceIds: z.array(IdSchema).max(20),
  sourceManifest: z.array(EvaluationSourceVersionSchema).max(20),
  contextText: z.string().max(100_000),
  contextHash: Sha256Schema,
  evidence: z.array(EvaluationEvidenceItemSchema).max(100),
  graphPaths: z
    .array(
      z.strictObject({
        entityIds: z.array(IdSchema).max(40),
        labels: z.array(z.string().max(300)).max(40),
        assertionVersionIds: z.array(IdSchema).max(40),
        predicates: z.array(z.string().max(300)).max(40),
        evidenceIds: z.array(z.string().max(300)).max(40),
      }),
    )
    .max(40),
  estimatedContextTokens: z.number().int().nonnegative(),
  contextBudgetTokens: z.number().int().nonnegative(),
  clipping: z.record(z.string(), z.unknown()),
});

export const EvaluationCaseManifestSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(80),
  input: z.string().min(1).max(10_000),
  inputHash: Sha256Schema,
  inputCharacters: z.number().int().positive().max(10_000),
  source: z.enum(["user", "generated"]),
  split: z.enum(["development", "holdout"]),
  verificationHash: Sha256Schema.nullable(),
});

export const EvaluationResponseReferenceSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(80),
  responseId: z.string().trim().min(1).max(300),
  responseModel: z.string().trim().min(1).max(200),
  provider: ProviderIdSchema,
  attemptId: z.string().trim().min(1).max(120),
  requestHash: Sha256Schema,
  contextHash: Sha256Schema,
  answerHash: Sha256Schema,
});

export const EvaluationEvidenceManifestSchema = z.strictObject({
  format: z.literal("promptlab-evaluation-evidence-v1"),
  manifestHash: Sha256Schema,
  runId: z.string().trim().min(1).max(120),
  attemptId: z.string().trim().min(1).max(120),
  candidateRevisionId: z.string().trim().min(1).max(120),
  revision: z.number().int().positive().max(2),
  baselinePromptHash: Sha256Schema,
  candidatePromptHash: Sha256Schema,
  invariantsHash: Sha256Schema,
  caseManifest: z.array(EvaluationCaseManifestSchema).min(1).max(20),
  sourceManifest: z.array(EvaluationSourceVersionSchema).max(20),
  graph: z.strictObject({
    requestedStrategy: z.enum([
      "none",
      "lexical",
      "graph",
      "full_context",
      "hybrid",
    ]),
    selectedSnapshotId: IdSchema.nullable(),
    usedSnapshotIds: z.array(IdSchema).max(20),
    strategyUsed: z.enum([
      "none",
      "lexical",
      "graph",
      "full_context",
      "hybrid",
      "mixed",
    ]),
    fallbackReasons: z.array(z.string().max(300)).max(20),
  }),
  workspaceSnapshot: z.strictObject({
    mode: z.enum(["none", "frozen"]),
    snapshotId: z.string().max(120).nullable(),
    contentHash: Sha256Schema.nullable(),
  }),
  target: z.strictObject({
    provider: ProviderIdSchema,
    requestedModel: z.string().trim().min(1).max(200),
    resolvedModel: z.string().trim().min(1).max(200),
    requestedEffort: z.string().max(80).nullable(),
    resolvedEffort: z.string().max(80).nullable(),
    sentEffort: z.string().max(80).nullable(),
    providerVersion: z.string().max(120).nullable(),
    selection: z.record(z.string(), z.unknown()),
  }),
  policy: z.strictObject({
    version: z.string().trim().min(1).max(120),
    hash: Sha256Schema,
    caseSplit: z.enum(["development_only", "development_and_holdout"]),
  }),
  configuration: z.strictObject({
    runConfigHash: Sha256Schema,
    optimizerConfigHash: Sha256Schema,
    targetConfigHash: Sha256Schema,
    retrievalConfigHash: Sha256Schema,
    frozen: z.record(z.string(), z.unknown()),
  }),
  evidencePacks: z.array(EvaluationEvidencePackSchema).min(1).max(20),
  responses: z.strictObject({
    baseline: z.array(EvaluationResponseReferenceSchema).min(1).max(20),
    candidate: z.array(EvaluationResponseReferenceSchema).min(1).max(20),
  }),
});

const OptimizationDecimalIntegerSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,99})$/u);

export const PromptOptimizationDivisibilityVerificationSchema = z
  .strictObject({
    kind: z.literal("divisibility"),
    startInclusive: z.number().int().min(1).max(1_000_000_000_000),
    endInclusive: z.number().int().min(1).max(1_000_000_000_000),
    includeDivisors: z
      .array(z.number().int().min(1).max(1_000_000))
      .min(1)
      .max(5),
    excludeDivisors: z
      .array(z.number().int().min(1).max(1_000_000))
      .max(5)
      .default([]),
    expected: z.strictObject({
      count: OptimizationDecimalIntegerSchema,
      sum: OptimizationDecimalIntegerSchema,
    }),
  })
  .superRefine((verification, context) => {
    if (verification.endInclusive < verification.startInclusive) {
      context.addIssue({
        code: "custom",
        message: "The inclusive range end must not precede its start.",
        path: ["endInclusive"],
      });
    }
    for (const [name, values] of [
      ["includeDivisors", verification.includeDivisors],
      ["excludeDivisors", verification.excludeDivisors],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${name} must contain distinct divisors.`,
          path: [name],
        });
      }
    }
  });

export const PromptOptimizationPythonFixtureSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(80),
    n: z.number().int().min(1).max(35),
    blocked: z
      .array(
        z.strictObject({
          row: z.number().int().min(0).max(34),
          column: z.number().int().min(0).max(34),
        }),
      )
      .max(1_225)
      .default([]),
    expectedOutput: OptimizationDecimalIntegerSchema,
  })
  .superRefine((fixture, context) => {
    const cells = fixture.blocked.map(({ row, column }) => `${row},${column}`);
    if (new Set(cells).size !== cells.length) {
      context.addIssue({
        code: "custom",
        message: "Blocked coordinates must be unique.",
        path: ["blocked"],
      });
    }
    fixture.blocked.forEach(({ row, column }, index) => {
      if (row >= fixture.n || column >= fixture.n) {
        context.addIssue({
          code: "custom",
          message: "Blocked coordinates must be inside the n by n grid.",
          path: ["blocked", index],
        });
      }
    });
  });

export const PromptOptimizationPythonTestsVerificationSchema = z
  .strictObject({
    kind: z.literal("python_tests"),
    tests: z.array(PromptOptimizationPythonFixtureSchema).min(1).max(40),
  })
  .superRefine((verification, context) => {
    const ids = verification.tests.map((fixture) => fixture.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Python verification fixture IDs must be unique.",
        path: ["tests"],
      });
    }
  });

export const PromptOptimizationVerificationSchema = z.discriminatedUnion(
  "kind",
  [
    PromptOptimizationDivisibilityVerificationSchema,
    PromptOptimizationPythonTestsVerificationSchema,
  ],
);

const ControlledEvaluationSourceSchema = z.strictObject({
  documentId: IdSchema,
  title: z.string().trim().min(1).max(240),
  documentVersionId: IdSchema,
  documentVersion: z.number().int().positive(),
  checksum: z.string().min(1).max(256),
});

export const ControlledEvaluationCaseSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  split: z.enum(["development", "holdout"]),
  input: z.string().trim().min(1).max(10_000),
  // These fields are evaluator-side only. The controlled evaluator copies only
  // id, input, and split into its target-call metadata.
  label: z.string().trim().max(500).nullable().default(null),
  verification: PromptOptimizationVerificationSchema.optional(),
});

export const ControlledEvaluationArmSchema = z.strictObject({
  arm: z.enum(["original", "rag", "graphrag"]),
  provider: z.literal("codex_app_server"),
  requestedModel: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(32).nullable(),
  retrieval: RunRetrievalSelectionSchema,
  sources: z.array(ControlledEvaluationSourceSchema).max(20),
});

export const ControlledEvaluationRequestSchema = z
  .strictObject({
    mode: z.literal("controlled_evaluation"),
    format: z.literal("promptlab-controlled-evaluation-v1"),
    datasetName: z.string().trim().min(1).max(120),
    datasetVersion: z.string().trim().min(1).max(80),
    promptId: IdSchema,
    baselinePromptVersionId: IdSchema,
    baselinePromptHash: Sha256Schema,
    candidatePromptVersionId: IdSchema,
    candidatePromptHash: Sha256Schema,
    cases: z.array(ControlledEvaluationCaseSchema).min(2).max(20),
    arms: z.array(ControlledEvaluationArmSchema).min(1).max(3),
  })
  .superRefine((request, context) => {
    const caseIds = request.cases.map((testCase) => testCase.id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: "custom",
        message: "Controlled evaluation case IDs must be unique.",
        path: ["cases"],
      });
    }
    if (
      !request.cases.some((testCase) => testCase.split === "development") ||
      !request.cases.some((testCase) => testCase.split === "holdout")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Controlled evaluation requires development and holdout cases.",
        path: ["cases"],
      });
    }
    const armIds = request.arms.map((arm) => arm.arm);
    if (new Set(armIds).size !== armIds.length) {
      context.addIssue({
        code: "custom",
        message: "Each retrieval arm may appear only once.",
        path: ["arms"],
      });
    }
    if (request.baselinePromptVersionId === request.candidatePromptVersionId) {
      context.addIssue({
        code: "custom",
        message:
          "Baseline and candidate must be different saved prompt versions.",
        path: ["candidatePromptVersionId"],
      });
    }
    if (request.baselinePromptHash === request.candidatePromptHash) {
      context.addIssue({
        code: "custom",
        message: "Baseline and candidate prompt text must differ.",
        path: ["candidatePromptHash"],
      });
    }
  });

export const ControlledEvaluationAnswerSchema = z.strictObject({
  status: z.enum(["succeeded", "failed"]),
  promptHash: Sha256Schema,
  requestHash: Sha256Schema,
  contextHash: Sha256Schema,
  answerHash: Sha256Schema.nullable(),
  responseId: z.string().max(300).nullable(),
  responseModel: z.string().max(200).nullable(),
  provider: z.literal("codex_app_server"),
  text: z.string().max(100_000).nullable(),
  usage: UsageSnapshotSchema.nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().max(120).nullable(),
  verificationEvidence: z.record(z.string(), z.unknown()).nullable(),
});

export const ControlledEvaluationPairSchema = z.strictObject({
  arm: z.enum(["original", "rag", "graphrag"]),
  caseId: z.string().trim().min(1).max(80),
  split: z.enum(["development", "holdout"]),
  inputHash: Sha256Schema,
  contextHash: Sha256Schema,
  pairConfigHash: Sha256Schema,
  baseline: ControlledEvaluationAnswerSchema,
  candidate: ControlledEvaluationAnswerSchema,
  judgment: z.enum([
    "subjective",
    "both_passed",
    "candidate_failed",
    "baseline_failed",
    "both_failed",
    "inconclusive",
  ]),
});

export const ControlledEvaluationCaseManifestSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(80),
  split: z.enum(["development", "holdout"]),
  inputHash: Sha256Schema,
  inputCharacters: z.number().int().positive().max(10_000),
  labelHash: Sha256Schema.nullable(),
  verificationHash: Sha256Schema.nullable(),
});

export const ControlledEvaluationArmManifestSchema = z.strictObject({
  arm: z.enum(["original", "rag", "graphrag"]),
  configurationHash: Sha256Schema,
  requestedModel: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().max(32).nullable(),
  retrieval: RunRetrievalSelectionSchema,
  sources: z.array(ControlledEvaluationSourceSchema).max(20),
  evidencePacks: z.array(EvaluationEvidencePackSchema).min(2).max(20),
});

export const ControlledEvaluationManifestSchema = z.strictObject({
  format: z.literal("promptlab-controlled-evaluation-manifest-v1"),
  manifestHash: Sha256Schema,
  runId: IdSchema,
  attemptId: IdSchema,
  configurationHash: Sha256Schema,
  baselinePromptHash: Sha256Schema,
  candidatePromptHash: Sha256Schema,
  cases: z.array(ControlledEvaluationCaseManifestSchema).min(2).max(20),
  arms: z.array(ControlledEvaluationArmManifestSchema).min(1).max(3),
  pairs: z.array(ControlledEvaluationPairSchema).min(2).max(120),
});

export const ControlledEvaluationReportSchema = z.strictObject({
  mode: z.literal("controlled_evaluation"),
  status: z.enum(["complete", "partial"]),
  runId: IdSchema,
  attemptId: IdSchema,
  configurationHash: Sha256Schema,
  baselinePromptHash: Sha256Schema,
  candidatePromptHash: Sha256Schema,
  expectedRequestCount: z.number().int().positive().max(120),
  optimizerLineage: z.strictObject({
    status: z.literal("not_used"),
    calls: z.literal(0),
    overheadMs: z.null(),
  }),
  pairs: z.array(ControlledEvaluationPairSchema).min(2).max(120),
  manifest: ControlledEvaluationManifestSchema,
});

export const PromptOptimizationTargetSelectionSchema = z.strictObject({
  model: z.enum(["selected", "auto"]),
  reasoningEffort: z.enum(["selected", "auto"]),
});

export const PromptOptimizationTestCaseSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  input: z.string().trim().min(1).max(10_000),
  expectedTerms: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  forbiddenTerms: z
    .array(z.string().trim().min(1).max(200))
    .max(20)
    .default([]),
  verification: PromptOptimizationVerificationSchema.optional(),
});

export const PromptOptimizationRequestSchema = z
  .strictObject({
    objective: z
      .string()
      .trim()
      .max(1_000)
      .default(
        "Tingkatkan prompt berdasarkan analisis dan konteks yang tersedia.",
      ),
    // The default allows one candidate and one optional refinement; the hard cap is two.
    maxIterations: z.number().int().min(1).max(2).default(2),
    // Caps allowlisted tool invocations; model calls have a separate worker cap.
    maxToolCalls: z.number().int().min(1).max(8).default(6),
    // Users may provide representative inputs; Senopati creates a small set
    // when this is empty. Expected/forbidden phrase assertions are optional
    // legacy metadata and never decide which answer is higher quality.
    testCases: z.array(PromptOptimizationTestCaseSchema).max(3).default([]),
    // Omission preserves the explicit run model/effort selected by the user.
    // Automatic selection is opt-in and resolved from the worker's live
    // Codex model/list response before any baseline or candidate target call.
    targetSelection: PromptOptimizationTargetSelectionSchema.optional(),
  })
  .superRefine((optimization, context) => {
    const ids = optimization.testCases.map((testCase) => testCase.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Optimization test case IDs must be unique.",
        path: ["testCases"],
      });
    }
  });

/** Normal Workspace chat is orchestrated by Senopati; Codex is an optional target tool. */
export const WorkspaceChatRequestSchema = z
  .strictObject({
    format: z.literal("promptlab-workspace-chat-v1"),
    target: z
      .strictObject({
        requestedModel: z.string().trim().min(1).max(200),
        reasoningEffort: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .nullable()
          .default(null),
        // Omission retains the historical selected/default behavior.
        reasoningEffortMode: z.enum(["selected", "auto"]).optional(),
      })
      .nullable()
      .default(null),
  })
  .superRefine((workspaceChat, context) => {
    if (
      workspaceChat.target?.reasoningEffortMode === "auto" &&
      workspaceChat.target.reasoningEffort !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Auto effort cannot include a manually selected effort.",
        path: ["target", "reasoningEffort"],
      });
    }
  });

export const RunIntentSchema = z.enum([
  "workspace_chat",
  "prompt_optimization",
  "controlled_evaluation",
  "workspace_file_draft",
]);

export type RunIntent = z.infer<typeof RunIntentSchema>;

/** Run metadata for the separately authorized local file-draft target path. */
export const WorkspaceFileDraftRunSchema = z.strictObject({
  format: z.literal("promptlab-workspace-file-draft-run-v1"),
  path: z.string().trim().min(1).max(4_096),
  snapshotHash: Sha256Schema,
  readGrantId: IdSchema,
  writeGrantId: IdSchema,
  taskOptimizationConsent: z.literal(true),
});

/** Validates intent against persisted flags before a run can be dispatched. */
export const RunIntentConfigurationSchema = z
  .strictObject({
    runIntent: RunIntentSchema,
    provider: ProviderIdSchema,
    purpose: RunPurposeSchema,
    workspaceChat: WorkspaceChatRequestSchema.optional(),
    optimization: PromptOptimizationRequestSchema.optional(),
    controlledEvaluation: ControlledEvaluationRequestSchema.optional(),
    workspaceFileDraft: WorkspaceFileDraftRunSchema.optional(),
  })
  .superRefine((config, context) => {
    const hasWorkspaceChat = config.workspaceChat !== undefined;
    const hasOptimization = config.optimization !== undefined;
    const hasControlledEvaluation = config.controlledEvaluation !== undefined;
    const hasWorkspaceFileDraft = config.workspaceFileDraft !== undefined;
    const matches = (() => {
      switch (config.runIntent) {
        case "workspace_chat":
          return (
            hasWorkspaceChat &&
            !hasOptimization &&
            !hasControlledEvaluation &&
            !hasWorkspaceFileDraft &&
            config.provider === "campus_gateway" &&
            config.purpose === "optimizer"
          );
        case "prompt_optimization":
          return (
            !hasWorkspaceChat &&
            hasOptimization &&
            !hasControlledEvaluation &&
            !hasWorkspaceFileDraft &&
            config.provider === "codex_app_server" &&
            config.purpose === "target"
          );
        case "controlled_evaluation":
          return (
            !hasWorkspaceChat &&
            !hasOptimization &&
            hasControlledEvaluation &&
            !hasWorkspaceFileDraft &&
            config.provider === "codex_app_server" &&
            config.purpose === "target"
          );
        case "workspace_file_draft":
          return (
            !hasWorkspaceChat &&
            !hasOptimization &&
            !hasControlledEvaluation &&
            hasWorkspaceFileDraft &&
            config.provider === "codex_app_server" &&
            config.purpose === "target"
          );
      }
    })();
    if (!matches) {
      context.addIssue({
        code: "custom",
        message: "Run intent does not match its provider, purpose, and mode.",
        path: ["runIntent"],
      });
    }
  });

// Optimization outcomes describe recommendation state. Provider execution
// failures and cancellation remain represented by RunStatusSchema.
export const PromptOptimizationOutcomeSchema = z.enum([
  "candidate_ready",
  "incomplete",
  "clarification_required",
  "no_change_recommended",
  "candidate_rejected",
]);

export const PromptOptimizationRevisionOutcomeSchema = z.enum([
  "candidate_ready",
  "incomplete",
  "no_change_recommended",
  "candidate_rejected",
]);

export const OptimizationClarificationReasonSchema = z.enum([
  "objective_choice",
  "audience",
  "output_format",
  "source_scope",
  "evaluation_criteria",
  "user_feedback",
]);

/** The only model-authored clarification content that may be shown to a user. */
export const OptimizationClarificationQuestionSchema = z.strictObject({
  question: z.string().trim().min(5).max(500),
  reasonCode: OptimizationClarificationReasonSchema,
  choices: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
  publicContext: z.string().trim().max(300).nullable().default(null),
});

export const OptimizationClarificationRequestedEventSchema =
  OptimizationClarificationQuestionSchema.extend({
    promptId: IdSchema,
    promptVersionId: IdSchema,
  });

export const OptimizationClarificationAnswerRequestSchema = z.strictObject({
  answer: z.string().trim().min(1).max(2_000),
  idempotencyKey: z.string().trim().min(8).max(160),
});

export const OptimizationClarificationAnsweredEventSchema = z.strictObject({
  clarificationId: IdSchema,
  answer: z.string().trim().min(1).max(2_000),
  promptId: IdSchema,
  promptVersionId: IdSchema,
  idempotencyKeyHash: z.string().length(64),
  answerHash: z.string().length(64),
});

export const OptimizationClarificationLifecycleSchema = z.enum([
  "awaiting_answer",
  "resumed",
  "expired",
  "canceled",
]);

export const OptimizationClarificationSchema =
  OptimizationClarificationQuestionSchema.extend({
    id: IdSchema,
    projectId: IdSchema,
    runId: IdSchema,
    promptId: IdSchema,
    promptVersionId: IdSchema,
    createdAt: IsoTimestampSchema,
    lifecycle: OptimizationClarificationLifecycleSchema,
  });

export const RunCreateSchema = z
  .strictObject({
    projectId: IdSchema,
    promptVersionId: IdSchema,
    provider: ProviderIdSchema,
    requestedModel: z.string().trim().min(1).max(200),
    // Codex model catalogs advertise their own effort levels. Omitted means the
    // selected model's default, and other providers do not accept this field.
    reasoningEffort: z.string().trim().min(1).max(32).optional(),
    purpose: RunPurposeSchema,
    intent: RunIntentSchema,
    idempotencyKey: z.string().trim().min(8).max(160),
    retrieval: WorkspaceRunRetrievalSelectionSchema.optional(),
    workspaceChat: WorkspaceChatRequestSchema.optional(),
    workspaceFileDraft: WorkspaceFileDraftRunSchema.optional(),
    optimization: PromptOptimizationRequestSchema.optional(),
    controlledEvaluation: ControlledEvaluationRequestSchema.optional(),
  })
  .superRefine((run, context) => {
    if (run.retrieval?.strategy === "auto" && run.intent !== "workspace_chat") {
      context.addIssue({
        code: "custom",
        message: "Auto retrieval is available only for Workspace chat.",
        path: ["retrieval", "strategy"],
      });
    }
    const intentResult = RunIntentConfigurationSchema.safeParse({
      runIntent: run.intent,
      provider: run.provider,
      purpose: run.purpose,
      ...(run.workspaceChat ? { workspaceChat: run.workspaceChat } : {}),
      ...(run.optimization ? { optimization: run.optimization } : {}),
      ...(run.controlledEvaluation
        ? { controlledEvaluation: run.controlledEvaluation }
        : {}),
      ...(run.workspaceFileDraft
        ? { workspaceFileDraft: run.workspaceFileDraft }
        : {}),
    });
    if (!intentResult.success) {
      context.addIssue({
        code: "custom",
        message: "Run intent does not match its provider, purpose, and mode.",
        path: ["intent"],
      });
    }
    if (run.optimization && run.controlledEvaluation) {
      context.addIssue({
        code: "custom",
        message:
          "A run cannot combine prompt optimization and controlled evaluation.",
        path: ["controlledEvaluation"],
      });
    }
    if (run.workspaceChat && (run.optimization || run.controlledEvaluation)) {
      context.addIssue({
        code: "custom",
        message:
          "Workspace chat cannot combine with optimization or evaluation runs.",
        path: ["workspaceChat"],
      });
    }
    if (
      run.workspaceChat &&
      (run.provider !== "campus_gateway" || run.purpose !== "optimizer")
    ) {
      context.addIssue({
        code: "custom",
        message: "Workspace chat requires the verified Senopati connection.",
        path: ["workspaceChat"],
      });
    }
    if (run.controlledEvaluation) {
      if (run.provider !== "codex_app_server" || run.purpose !== "target") {
        context.addIssue({
          code: "custom",
          message: "Controlled evaluation requires a Codex target run.",
          path: ["controlledEvaluation"],
        });
      }
      if (
        run.controlledEvaluation.baselinePromptVersionId !== run.promptVersionId
      ) {
        context.addIssue({
          code: "custom",
          message: "The run prompt version must be the saved baseline version.",
          path: ["controlledEvaluation", "baselinePromptVersionId"],
        });
      }
      if (
        run.controlledEvaluation.arms.some(
          (arm) => arm.requestedModel !== run.requestedModel,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Every controlled evaluation arm must use the run's verified model.",
          path: ["controlledEvaluation", "arms"],
        });
      }
      if (
        run.controlledEvaluation.arms.some(
          (arm) => arm.reasoningEffort !== (run.reasoningEffort ?? null),
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Every controlled evaluation arm must use the run's selected effort.",
          path: ["controlledEvaluation", "arms"],
        });
      }
    }
  });

export const RunEventTypeSchema = z.enum([
  "run.status",
  "agent.finished",
  "agent.action",
  "tool.started",
  "tool.completed",
  "candidate.proposed",
  "output.delta",
  "usage.snapshot",
  "quota.snapshot",
  "evaluation.result",
  "optimization.vote",
  "optimization.clarification.requested",
  "optimization.clarification.answered",
  "run.completed",
  "run.failed",
]);

export const PromptQualityVoteSchema = z.strictObject({
  candidateId: IdSchema,
  decision: z.enum([
    "original_better",
    "candidate_better",
    "equal",
    "inconclusive",
  ]),
  note: z.string().trim().max(500).default(""),
});

export const RunEventSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  sequence: z.number().int().positive(),
  timestamp: IsoTimestampSchema,
  eventType: RunEventTypeSchema,
  attemptId: IdSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export const GraphQueryBoundsSchema = z.strictObject({
  maxSeeds: z.number().int().min(1).max(2).default(2),
  maxHops: z.number().int().min(0).max(2).default(2),
  maxNeighborsPerExpansion: z.number().int().min(1).max(20).default(20),
  maxNodes: z.number().int().min(1).max(30).default(30),
  maxEdges: z.number().int().min(1).max(60).default(60),
  maxPaths: z.number().int().min(1).max(3).default(3),
  maxEstimatedContextTokens: z.number().int().min(1).max(3_000).default(3_000),
});

export const KnowledgeSourcePermissionSchema = z.enum([
  "local_only",
  "campus_indexer_allowed",
]);

export const KnowledgeRetrievalStrategySchema = z.enum([
  "lexical",
  "graph",
  "full_context",
]);

export const GraphBuildPreviewRequestSchema = z.strictObject({
  sourceIds: z.array(IdSchema).min(1).max(20),
  maxModelCalls: z.number().int().min(1).max(240).optional(),
});

export const GraphBuildEnqueueRequestSchema =
  GraphBuildPreviewRequestSchema.extend({
    maxModelCalls: z.number().int().min(1).max(240),
    idempotencyKey: z.string().trim().min(8).max(160),
    allowCampusEgress: z.literal(true),
  });

export const GraphBuildJobSchema = z.strictObject({
  projectId: IdSchema,
  buildId: IdSchema,
  runId: IdSchema,
});

export const GraphBuildStateSchema = z.enum([
  "queued",
  "extracting",
  "validating",
  "ready_to_activate",
  "active",
  "partial",
  "failed",
  "cancelled",
]);

export const GraphEntityTypeSchema = z.enum([
  "Person",
  "Organization",
  "Concept",
  "Rule",
  "Component",
  "Task",
]);

export const GraphPredicateSchema = z.enum([
  "uses",
  "part_of",
  "depends_on",
  "owned_by",
  "managed_by",
  "monitored_by",
  "implements",
  "requires",
  "applies_to",
  "has_role",
  "located_in",
  "precedes",
  "supersedes",
  "constrains",
  "defines",
  "operates",
]);

export const GraphExtractionSchema = z.strictObject({
  schemaVersion: z.literal("promptlab-graph-extraction-v1"),
  projectId: IdSchema,
  runId: IdSchema,
  documentVersionId: IdSchema,
  chunkId: IdSchema,
  requestedModel: z.string().trim().min(1).max(200),
  entities: z
    .array(
      z.strictObject({
        localId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        type: GraphEntityTypeSchema,
        label: z.string().trim().min(1).max(180),
        aliases: z.array(z.string().trim().min(1).max(180)).max(10),
        quote: z.string().min(1).max(1_000),
        spanStart: z.number().int().nonnegative(),
        spanEnd: z.number().int().positive(),
      }),
    )
    .max(50),
  relations: z
    .array(
      z.strictObject({
        subjectLocalId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        predicate: GraphPredicateSchema,
        objectLocalId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        direction: z.literal("directed"),
        qualifiers: z.strictObject({
          dateOrVersion: z.string().max(200).nullable().default(null),
          negated: z.boolean().nullable().default(null),
          modality: z.string().max(120).nullable().default(null),
          conditions: z.string().max(500).nullable().default(null),
        }),
        quote: z.string().min(1).max(2_000),
        spanStart: z.number().int().nonnegative(),
        spanEnd: z.number().int().positive(),
      }),
    )
    .max(50),
});

export const GraphRetrievalPreviewRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(2_000),
  strategy: KnowledgeRetrievalStrategySchema,
  sourceIds: z.array(IdSchema).max(20).default([]),
  bounds: GraphQueryBoundsSchema.partial().optional(),
});

export const GraphAssertionReviewRequestSchema = z.strictObject({
  version: z.number().int().positive(),
  decision: z.enum(["accept", "reject"]),
  reason: z.string().trim().max(500).default(""),
});

export const AgentBudgetSchema = z.strictObject({
  maxDecisionTurns: z.number().int().min(1).max(5).default(4),
  maxToolCalls: z.number().int().min(1).max(8).default(8),
  maxCandidates: z.number().int().min(0).max(2).default(2),
  maxRevisions: z.number().int().min(0).max(1).default(1),
  maxDurationMs: z.number().int().min(1_000).max(180_000).default(180_000),
  graph: GraphQueryBoundsSchema.default({
    maxSeeds: 2,
    maxHops: 2,
    maxNeighborsPerExpansion: 20,
    maxNodes: 30,
    maxEdges: 60,
    maxPaths: 3,
    maxEstimatedContextTokens: 3_000,
  }),
});

const ToolBase = {
  analyze_history: z.strictObject({
    messageIds: z.array(IdSchema).max(100),
    window: z.number().int().min(1).max(200),
  }),
  search_knowledge: z.strictObject({
    query: z.string().trim().min(1).max(2_000),
    sourceIds: z.array(IdSchema).max(50).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  search_verified_memory: z.strictObject({
    query: z.string().trim().min(1).max(2_000),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  get_source: z.strictObject({ chunkId: IdSchema }),
  estimate_tokens: z.strictObject({ text: z.string().max(100_000) }),
  inspect_capabilities: z.strictObject({ provider: ProviderIdSchema }),
  validate_candidate: z.strictObject({
    candidateText: z.string().min(1).max(100_000),
    invariants: z.array(z.string().min(1).max(500)).max(40),
  }),
  evaluate_subset: z.strictObject({
    candidateId: IdSchema,
    developmentCaseIds: z.array(IdSchema).max(3),
  }),
  search_graph_entities: z.strictObject({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  traverse_graph: z.strictObject({
    seedEntityIds: z.array(IdSchema).min(1).max(2),
    maxHops: z.number().int().min(0).max(2).default(2),
    maxNeighborsPerExpansion: z.number().int().min(1).max(20).default(20),
    maxNodes: z.number().int().min(1).max(30).default(30),
    maxEdges: z.number().int().min(1).max(60).default(60),
    maxPaths: z.number().int().min(1).max(3).default(3),
    maxEstimatedContextTokens: z
      .number()
      .int()
      .min(1)
      .max(3_000)
      .default(3_000),
  }),
  get_graph_evidence: z.strictObject({
    assertionIds: z.array(IdSchema).min(1).max(60),
  }),
  get_graph_status: z.strictObject({}),
  call_codex_target: z.strictObject({
    // The target receives the complete optimized prompt plus bounded source
    // evidence selected by the server.
    prompt: z.string().trim().min(1).max(50_000),
  }),
} as const;

export const ToolNameSchema = z.enum([
  "analyze_history",
  "search_knowledge",
  "search_verified_memory",
  "get_source",
  "estimate_tokens",
  "inspect_capabilities",
  "validate_candidate",
  "evaluate_subset",
  "search_graph_entities",
  "traverse_graph",
  "get_graph_evidence",
  "get_graph_status",
  "call_codex_target",
]);

export const AgentToolCallSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("analyze_history"),
    arguments: ToolBase.analyze_history,
  }),
  z.strictObject({
    name: z.literal("search_knowledge"),
    arguments: ToolBase.search_knowledge,
  }),
  z.strictObject({
    name: z.literal("search_verified_memory"),
    arguments: ToolBase.search_verified_memory,
  }),
  z.strictObject({
    name: z.literal("get_source"),
    arguments: ToolBase.get_source,
  }),
  z.strictObject({
    name: z.literal("estimate_tokens"),
    arguments: ToolBase.estimate_tokens,
  }),
  z.strictObject({
    name: z.literal("inspect_capabilities"),
    arguments: ToolBase.inspect_capabilities,
  }),
  z.strictObject({
    name: z.literal("validate_candidate"),
    arguments: ToolBase.validate_candidate,
  }),
  z.strictObject({
    name: z.literal("evaluate_subset"),
    arguments: ToolBase.evaluate_subset,
  }),
  z.strictObject({
    name: z.literal("search_graph_entities"),
    arguments: ToolBase.search_graph_entities,
  }),
  z.strictObject({
    name: z.literal("traverse_graph"),
    arguments: ToolBase.traverse_graph,
  }),
  z.strictObject({
    name: z.literal("get_graph_evidence"),
    arguments: ToolBase.get_graph_evidence,
  }),
  z.strictObject({
    name: z.literal("get_graph_status"),
    arguments: ToolBase.get_graph_status,
  }),
  z.strictObject({
    name: z.literal("call_codex_target"),
    arguments: ToolBase.call_codex_target,
  }),
]);

export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
export type AgentBudgetInput = Omit<Partial<AgentBudget>, "graph"> & {
  graph?: Partial<GraphQueryBounds>;
};
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
export type CapabilityEvidence = z.infer<typeof CapabilityEvidenceSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionRequestInput = z.input<
  typeof ChatCompletionRequestSchema
>;
export type ProviderCompletion = z.infer<typeof ProviderCompletionSchema>;
export type ProviderConnectionState = z.infer<
  typeof ProviderConnectionStateSchema
>;
export type GraphQueryBounds = z.infer<typeof GraphQueryBoundsSchema>;
export type GraphBuildJob = z.infer<typeof GraphBuildJobSchema>;
export type GraphBuildState = z.infer<typeof GraphBuildStateSchema>;
export type GraphExtraction = z.infer<typeof GraphExtractionSchema>;
export type GraphRetrievalPreviewRequest = z.infer<
  typeof GraphRetrievalPreviewRequestSchema
>;
export type KnowledgeRetrievalStrategy = z.infer<
  typeof KnowledgeRetrievalStrategySchema
>;
export type KnowledgeSourcePermission = z.infer<
  typeof KnowledgeSourcePermissionSchema
>;
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type RunPurpose = z.infer<typeof RunPurposeSchema>;
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type RunCreate = z.infer<typeof RunCreateSchema>;
export type RunRetrievalSelection = z.infer<typeof RunRetrievalSelectionSchema>;
export type WorkspaceRunRetrievalSelection = z.infer<
  typeof WorkspaceRunRetrievalSelectionSchema
>;
export type EvaluationSourceVersion = z.infer<
  typeof EvaluationSourceVersionSchema
>;
export type EvaluationEvidenceItem = z.infer<
  typeof EvaluationEvidenceItemSchema
>;
export type EvaluationEvidencePack = z.infer<
  typeof EvaluationEvidencePackSchema
>;
export type EvaluationCaseManifest = z.infer<
  typeof EvaluationCaseManifestSchema
>;
export type EvaluationResponseReference = z.infer<
  typeof EvaluationResponseReferenceSchema
>;
export type EvaluationEvidenceManifest = z.infer<
  typeof EvaluationEvidenceManifestSchema
>;
export type ControlledEvaluationRequest = z.infer<
  typeof ControlledEvaluationRequestSchema
>;
export type ControlledEvaluationCase = z.infer<
  typeof ControlledEvaluationCaseSchema
>;
export type ControlledEvaluationArm = z.infer<
  typeof ControlledEvaluationArmSchema
>;
export type ControlledEvaluationPair = z.infer<
  typeof ControlledEvaluationPairSchema
>;
export type ControlledEvaluationManifest = z.infer<
  typeof ControlledEvaluationManifestSchema
>;
export type ControlledEvaluationReport = z.infer<
  typeof ControlledEvaluationReportSchema
>;
export type PromptOptimizationRequest = z.infer<
  typeof PromptOptimizationRequestSchema
>;
export type PromptOptimizationOutcome = z.infer<
  typeof PromptOptimizationOutcomeSchema
>;
export type PromptOptimizationRevisionOutcome = z.infer<
  typeof PromptOptimizationRevisionOutcomeSchema
>;
export type PromptOptimizationTestCase = z.infer<
  typeof PromptOptimizationTestCaseSchema
>;
export type PromptOptimizationVerification = z.infer<
  typeof PromptOptimizationVerificationSchema
>;
export type PromptOptimizationTargetSelection = z.infer<
  typeof PromptOptimizationTargetSelectionSchema
>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type UsageMetric = z.infer<typeof UsageMetricSchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
