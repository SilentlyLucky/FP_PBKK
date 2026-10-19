import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isControlledEvaluationConfigurationValid,
  isControlledEvaluationReportIntact,
  runControlledEvaluation,
  sha256Json,
  sha256Text,
  type ControlledEvaluationInvocation,
  type ControlledEvaluationTargetCall,
} from "@promptlab/agent";
import {
  ControlledEvaluationRequestSchema,
  type ControlledEvaluationArm,
  type ControlledEvaluationReport,
} from "@promptlab/contracts";
import {
  createDatabaseClient,
  schema,
  type DatabaseClient,
  type WorkspaceSourceManifest,
} from "@promptlab/db";
import {
  listVerifiedMemories,
  type VerifiedMemoryRecord,
  type VerifiedMemoryRuntimeProjection,
} from "@promptlab/agent/verified-memory";

import { hasControlledEvaluationAcceptanceEvidence } from "./controlled-evaluation-eligibility.ts";
import { POST as postDecision } from "./route.js";
import { GET as getMemory } from "../../../memory/route.js";
import { GET as getSourceCitation } from "../../../memory/citations/[sourceId]/versions/[versionId]/route.js";
import type {
  ExperimentAcceptanceEvent,
  ExperimentAcceptanceRun,
} from "./acceptance-eligibility.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const promptId = "44444444-4444-4444-8444-444444444444";
const baselinePromptVersionId = "55555555-5555-4555-8555-555555555555";
const candidatePromptVersionId = "66666666-6666-4666-8666-666666666666";
const sourceId = "77777777-7777-4777-8777-777777777777";
const sourceVersionId = "88888888-8888-4888-8888-888888888888";
const snapshotId = "99999999-9999-4999-8999-999999999999";
const otherAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const baselinePrompt = "Answer clearly using only the supplied context.";
const candidatePrompt = "Give a concise, accurate answer grounded in context.";
const requestedModel = "gpt-5.6";

const validDivisibilityVerification = {
  kind: "divisibility" as const,
  startInclusive: 1,
  endInclusive: 2,
  includeDivisors: [1],
  excludeDivisors: [],
  expected: { count: "2", sum: "3" },
};

const invalidFixtureVerification = {
  ...validDivisibilityVerification,
  expected: { count: "99", sum: "99" },
};

type ScenarioOptions = {
  verification?: "valid" | "invalid_fixture";
  holdoutVerification?: "valid";
  holdoutInput?: string;
  holdoutCaseId?: string;
  failedCall?: { caseId: string; subject: "baseline" | "candidate" };
  failedVerification?: boolean;
  projectId?: string;
  runId?: string;
  attemptId?: string;
  promptId?: string;
  baselinePromptVersionId?: string;
  candidatePromptVersionId?: string;
  sourceId?: string;
  sourceVersionId?: string;
};

function createArm(
  armName: ControlledEvaluationArm["arm"],
  sourceId = "77777777-7777-4777-8777-777777777777",
  sourceVersionId = "88888888-8888-4888-8888-888888888888",
): ControlledEvaluationArm {
  const original = armName === "original";
  const graph = armName === "graphrag";
  return {
    arm: armName,
    provider: "codex_app_server",
    requestedModel,
    reasoningEffort: null,
    retrieval: {
      strategy: graph ? "graph" : "lexical",
      sourceIds: original ? [] : [sourceId],
      snapshotId: graph ? snapshotId : null,
    },
    sources: original
      ? []
      : [
          {
            documentId: sourceId,
            title: "Frozen source",
            documentVersionId: sourceVersionId,
            documentVersion: 7,
            checksum: "a".repeat(64),
          },
        ],
  };
}

function createRequest(options: ScenarioOptions = {}) {
  const sourceId = options.sourceId;
  const sourceVersionId = options.sourceVersionId;
  const holdoutVerification =
    options.holdoutVerification === "valid"
      ? {
          kind: "divisibility" as const,
          startInclusive: 10,
          endInclusive: 20,
          includeDivisors: [10],
          excludeDivisors: [],
          expected: { count: "2", sum: "30" },
        }
      : undefined;
  return ControlledEvaluationRequestSchema.parse({
    mode: "controlled_evaluation",
    format: "promptlab-controlled-evaluation-v1",
    datasetName: "Deterministic eligibility fixture",
    datasetVersion: "1",
    promptId: options.promptId ?? promptId,
    baselinePromptVersionId:
      options.baselinePromptVersionId ?? baselinePromptVersionId,
    baselinePromptHash: sha256Text(baselinePrompt),
    candidatePromptVersionId:
      options.candidatePromptVersionId ?? candidatePromptVersionId,
    candidatePromptHash: sha256Text(candidatePrompt),
    cases: [
      {
        id: "development-case",
        split: "development",
        input: "Count the integers from 1 to 2 and their sum.",
        ...(options.verification
          ? {
              verification:
                options.verification === "invalid_fixture"
                  ? invalidFixtureVerification
                  : validDivisibilityVerification,
            }
          : {}),
      },
      {
        id: options.holdoutCaseId ?? "holdout-case",
        split: "holdout",
        input:
          options.holdoutInput ??
          "Summarize the supplied evidence in one sentence.",
        ...(holdoutVerification ? { verification: holdoutVerification } : {}),
      },
    ],
    arms: [
      createArm("original", sourceId, sourceVersionId),
      createArm("rag", sourceId, sourceVersionId),
      createArm("graphrag", sourceId, sourceVersionId),
    ],
  });
}

function evidencePack(arm: ControlledEvaluationArm, caseId: string) {
  const isOriginal = arm.arm === "original";
  const isGraphRag = arm.arm === "graphrag";
  const contextText = isOriginal
    ? ""
    : `Frozen ${arm.arm} source excerpt for ${caseId}.`;
  return {
    caseId,
    requestedStrategy: isOriginal
      ? ("none" as const)
      : isGraphRag
        ? ("graph" as const)
        : ("lexical" as const),
    strategyUsed: isOriginal
      ? ("none" as const)
      : isGraphRag
        ? ("graph" as const)
        : ("lexical" as const),
    selectedSnapshotId: isGraphRag ? (arm.retrieval.snapshotId ?? null) : null,
    usedSnapshotId: isGraphRag ? (arm.retrieval.snapshotId ?? null) : null,
    fallbackReason: null,
    selectedSourceIds: [...arm.retrieval.sourceIds],
    sourceManifest: arm.sources.map(
      ({ documentId, documentVersionId, documentVersion, checksum }) => ({
        documentId,
        documentVersionId,
        documentVersion,
        checksum,
      }),
    ),
    contextText,
    contextHash: sha256Text(contextText),
    evidence: [],
    graphPaths: [],
    estimatedContextTokens: isOriginal ? 0 : 6,
    contextBudgetTokens: 1_000,
    clipping: {},
  };
}

function offlineUsage(responseId: string) {
  const unknownMetric = {
    status: "unknown" as const,
    value: null,
    reason: "Deterministic offline evaluator fixture.",
  };
  return {
    inputTokens: unknownMetric,
    outputTokens: unknownMetric,
    cacheReadTokens: unknownMetric,
    cacheWriteTokens: unknownMetric,
    completeness: "unknown" as const,
    responseId,
    mapperVersion: "controlled-evaluation-test-v1",
  };
}

async function createScenario(options: ScenarioOptions = {}) {
  const scenarioRunId = options.runId ?? experimentId;
  const scenarioAttemptId = options.attemptId ?? attemptId;
  const scenarioProjectId = options.projectId ?? projectId;
  const request = createRequest(options);
  const generatedReport = await runControlledEvaluation({
    runId: scenarioRunId,
    attemptId: scenarioAttemptId,
    request,
    baselinePrompt,
    candidatePrompt,
    signal: new AbortController().signal,
    resolveEvidence: async (resolvedArm, cases) =>
      cases.map((testCase) => evidencePack(resolvedArm, testCase.id)),
    invoke: async (
      call: ControlledEvaluationTargetCall,
    ): Promise<ControlledEvaluationInvocation> => {
      if (
        options.failedCall?.caseId === call.caseId &&
        options.failedCall.subject === call.subject
      ) {
        return { status: "failed", errorCode: "offline_fixture_failure" };
      }

      const responseId = `${call.caseId}-${call.subject}`;
      const invalidAnswer =
        call.caseId === "development-case" &&
        call.subject === "candidate" &&
        (options.failedVerification ||
          options.verification === "invalid_fixture");
      return {
        status: "succeeded",
        text: invalidAnswer
          ? JSON.stringify({ count: "0", sum: "0" })
          : call.caseId === (options.holdoutCaseId ?? "holdout-case") &&
              options.holdoutVerification === "valid"
            ? JSON.stringify({ count: "2", sum: "30" })
            : JSON.stringify({ count: "2", sum: "3" }),
        responseId,
        responseModel: requestedModel,
        usage: offlineUsage(responseId),
        latencyMs: 1,
      };
    },
  });

  const report = structuredClone(generatedReport);
  const metadata = structuredClone(request);
  const run: ExperimentAcceptanceRun = {
    id: scenarioRunId,
    projectId: scenarioProjectId,
    status: "succeeded",
    promptVersionId: request.baselinePromptVersionId,
    provider: "codex_app_server",
    purpose: "target",
    requestedModel,
    configSnapshot: { controlledEvaluation: structuredClone(request) },
  };
  return { request, report, metadata, run };
}

function completedEvent(
  report: ControlledEvaluationReport,
  options: { runId?: string; attemptId?: string } = {},
): ExperimentAcceptanceEvent {
  return {
    projectId,
    runId: options.runId ?? experimentId,
    attemptId: options.attemptId ?? attemptId,
    sequence: 1,
    eventType: "run.completed",
    payload: {
      status: "succeeded",
      mode: "controlled_evaluation",
      controlledEvaluation: report,
    },
  };
}

function rehashManifest(report: ControlledEvaluationReport): void {
  const unsignedManifest = structuredClone(report.manifest) as Record<
    string,
    unknown
  >;
  delete unsignedManifest.manifestHash;
  report.manifest.manifestHash = sha256Json(unsignedManifest);
}

function isEligible(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  overrides: {
    report?: ControlledEvaluationReport;
    markerMetadata?: unknown;
    run?: ExperimentAcceptanceRun;
    event?: ExperimentAcceptanceEvent;
    baselinePrompt?: string;
    candidatePrompt?: string;
  } = {},
): boolean {
  const report = overrides.report ?? scenario.report;
  return hasControlledEvaluationAcceptanceEvidence({
    experimentId: scenario.run.id,
    run: overrides.run ?? scenario.run,
    markerMetadata: overrides.markerMetadata ?? scenario.metadata,
    events: [overrides.event ?? completedEvent(report)],
    baselinePrompt: overrides.baselinePrompt ?? baselinePrompt,
    candidatePrompt: overrides.candidatePrompt ?? candidatePrompt,
  });
}

describe("Controlled evaluation acceptance evidence", () => {
  it("requires all three arms with matching model, effort, and frozen RAG sources", () => {
    const request = createRequest();
    expect(isControlledEvaluationConfigurationValid(request)).toBe(true);

    const partial = structuredClone(request);
    partial.arms = partial.arms.filter((arm) => arm.arm !== "rag");
    expect(ControlledEvaluationRequestSchema.safeParse(partial).success).toBe(
      true,
    );
    expect(isControlledEvaluationConfigurationValid(partial)).toBe(false);

    const differentModel = structuredClone(request);
    differentModel.arms.find((arm) => arm.arm === "graphrag")!.requestedModel =
      "another-model";
    expect(isControlledEvaluationConfigurationValid(differentModel)).toBe(
      false,
    );

    const differentEffort = structuredClone(request);
    differentEffort.arms.find((arm) => arm.arm === "rag")!.reasoningEffort =
      "high";
    expect(isControlledEvaluationConfigurationValid(differentEffort)).toBe(
      false,
    );

    const differentSourceVersion = structuredClone(request);
    differentSourceVersion.arms.find(
      (arm) => arm.arm === "graphrag",
    )!.sources[0]!.documentVersion = 8;
    expect(
      isControlledEvaluationConfigurationValid(differentSourceVersion),
    ).toBe(false);

    const differentChecksum = structuredClone(request);
    differentChecksum.arms.find(
      (arm) => arm.arm === "graphrag",
    )!.sources[0]!.checksum = "another-source-checksum";
    expect(isControlledEvaluationConfigurationValid(differentChecksum)).toBe(
      false,
    );
  });

  it("accepts complete, bound evidence generated by the offline evaluator", async () => {
    const scenario = await createScenario();

    expect(scenario.report.status).toBe("complete");
    expect(scenario.report.expectedRequestCount).toBe(12);
    expect(scenario.report.manifest.arms.map((arm) => arm.arm)).toEqual([
      "original",
      "rag",
      "graphrag",
    ]);
    expect(
      isControlledEvaluationReportIntact({
        request: scenario.request,
        report: scenario.report,
        runId: experimentId,
        attemptId,
        baselinePrompt,
        candidatePrompt,
      }),
    ).toBe(true);
    expect(isEligible(scenario)).toBe(true);
  });

  it("rejects candidate text that differs from the bound prompt", async () => {
    const scenario = await createScenario();

    expect(
      isEligible(scenario, { candidatePrompt: `${candidatePrompt} Changed.` }),
    ).toBe(false);
  });

  it("rejects a candidate prompt hash detached from the report manifest", async () => {
    const scenario = await createScenario();
    const report = structuredClone(scenario.report);
    report.candidatePromptHash = sha256Text("A different candidate prompt.");

    expect(isEligible(scenario, { report })).toBe(false);
  });

  it("rejects baseline prompt text that differs from the bound prompt", async () => {
    const scenario = await createScenario();

    expect(
      isEligible(scenario, { baselinePrompt: "A changed baseline prompt." }),
    ).toBe(false);
  });

  it("rejects stored configuration that differs from the acceptance marker", async () => {
    const scenario = await createScenario();
    const run = structuredClone(scenario.run);
    const configured = run.configSnapshot.controlledEvaluation as {
      arms: Array<{ requestedModel: string }>;
    };
    configured.arms[0]!.requestedModel = "another-model";

    expect(isEligible(scenario, { run })).toBe(false);
  });

  it("rejects report context detached from its frozen evidence pack", async () => {
    const scenario = await createScenario();
    const report = structuredClone(scenario.report);
    report.manifest.arms.find(
      (arm) => arm.arm === "graphrag",
    )!.evidencePacks[0]!.contextText = "A different source context.";
    rehashManifest(report);

    expect(isEligible(scenario, { report })).toBe(false);
  });

  it("rejects source-version evidence that differs from the frozen arm", async () => {
    const scenario = await createScenario();
    const report = structuredClone(scenario.report);
    report.manifest.arms.find(
      (arm) => arm.arm === "graphrag",
    )!.evidencePacks[0]!.sourceManifest[0]!.documentVersion = 8;
    rehashManifest(report);

    expect(isEligible(scenario, { report })).toBe(false);
  });

  it("rejects a report with a missing case pair", async () => {
    const scenario = await createScenario();
    const report = structuredClone(scenario.report);
    report.pairs.pop();

    expect(isEligible(scenario, { report })).toBe(false);
  });

  it("rejects a report with a failed target call", async () => {
    const scenario = await createScenario({
      failedCall: { caseId: "development-case", subject: "candidate" },
    });

    expect(scenario.report.status).toBe("partial");
    expect(isEligible(scenario)).toBe(false);
  });

  it("rejects invalid fixture verification evidence", async () => {
    const scenario = await createScenario({ verification: "invalid_fixture" });

    expect(
      scenario.report.pairs[0]!.candidate.verificationEvidence,
    ).toMatchObject({ status: "invalid_fixture" });
    expect(isEligible(scenario)).toBe(false);
  });

  it("rejects a candidate that fails configured verification", async () => {
    const scenario = await createScenario({
      verification: "valid",
      failedVerification: true,
    });

    expect(
      scenario.report.pairs[0]!.candidate.verificationEvidence,
    ).toMatchObject({ status: "failed" });
    expect(isEligible(scenario)).toBe(false);
  });

  it("rejects a report bound to a different run", async () => {
    const scenario = await createScenario();
    const report = structuredClone(scenario.report);
    report.runId = otherRunId;

    expect(isEligible(scenario, { report })).toBe(false);
  });

  it("rejects an event attempt that differs from the report attempt", async () => {
    const scenario = await createScenario();

    expect(
      isEligible(scenario, {
        event: completedEvent(scenario.report, { attemptId: otherAttemptId }),
      }),
    ).toBe(false);
  });

  it("rejects lexical fallback evidence represented as GraphRAG", async () => {
    const scenario = await createScenario();
    const report = structuredClone(scenario.report);
    const pack = report.manifest.arms.find((arm) => arm.arm === "graphrag")!
      .evidencePacks[0]!;
    pack.strategyUsed = "lexical";
    pack.usedSnapshotId = null;
    pack.fallbackReason = "no_lexical_graph_seed";
    rehashManifest(report);

    expect(isEligible(scenario, { report })).toBe(false);
  });
});

const integrationConnectionString =
  process.env.PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL;
const integrationRequested =
  process.env.PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS === "1" &&
  Boolean(integrationConnectionString);
const requiredIntegrationTables = [
  "projects",
  "prompts",
  "prompt_versions",
  "documents",
  "document_versions",
  "chunks",
  "runs",
  "model_attempts",
  "run_events",
];
const integrationProjectIds: string[] = [];
let integrationClient: DatabaseClient | undefined;
let previousDatabaseUrl: string | undefined;
let previousGlobalClient: DatabaseClient | undefined;

interface RuntimeMemoryApiPayload {
  verifiedMemories: VerifiedMemoryRuntimeProjection[];
  truncated: boolean;
}

describe.skipIf(!integrationRequested)(
  "Verified memory acceptance lifecycle integration",
  () => {
    beforeAll(async () => {
      const connectionString = integrationConnectionString!;
      const target = new URL(connectionString);
      const databaseName = decodeURIComponent(
        target.pathname.replace(/^\/+/, ""),
      );
      if (
        !["127.0.0.1", "localhost"].includes(target.hostname) ||
        target.port !== "56432" ||
        !/^promptlab_knowledge_test_[a-f0-9]{32}$/iu.test(databaseName)
      ) {
        throw new Error(
          "Verified memory lifecycle integration requires a disposable UUID-named database on loopback port 56432, configured with PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL.",
        );
      }

      const connected = createDatabaseClient(connectionString);
      integrationClient = connected;
      previousDatabaseUrl = process.env.PROMPTLAB_DATABASE_URL;
      const globalForPromptLab = globalThis as typeof globalThis & {
        promptLabDatabaseClient?: DatabaseClient;
      };
      previousGlobalClient = globalForPromptLab.promptLabDatabaseClient;
      globalForPromptLab.promptLabDatabaseClient = connected;
      process.env.PROMPTLAB_DATABASE_URL = connectionString;

      const tables = await connected.pool.query<{ tablename: string }>(
        `select tablename from pg_tables
         where schemaname = 'public' and tablename = any($1::text[])`,
        [requiredIntegrationTables],
      );
      const presentTables = new Set(tables.rows.map((row) => row.tablename));
      const missingTables = requiredIntegrationTables.filter(
        (table) => !presentTables.has(table),
      );
      if (missingTables.length) {
        throw new Error(
          `Verified memory lifecycle integration database is missing migrated tables: ${missingTables.join(", ")}.`,
        );
      }
    }, 15_000);

    afterAll(async () => {
      const connected = integrationClient;
      if (!connected) return;
      if (integrationProjectIds.length) {
        await connected.db
          .update(schema.prompts)
          .set({ currentVersionId: null })
          .where(inArray(schema.prompts.projectId, integrationProjectIds));
        await connected.db
          .delete(schema.projects)
          .where(inArray(schema.projects.id, integrationProjectIds));
      }
      const globalForPromptLab = globalThis as typeof globalThis & {
        promptLabDatabaseClient?: DatabaseClient;
      };
      if (globalForPromptLab.promptLabDatabaseClient === connected) {
        if (previousGlobalClient) {
          globalForPromptLab.promptLabDatabaseClient = previousGlobalClient;
        } else {
          delete globalForPromptLab.promptLabDatabaseClient;
        }
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.PROMPTLAB_DATABASE_URL;
      } else {
        process.env.PROMPTLAB_DATABASE_URL = previousDatabaseUrl;
      }
      await connected.pool.end();
    }, 20_000);

    it("accepts, redacts, cites, and invalidates real PostgreSQL evidence", async () => {
      const connected = integrationClient;
      if (!connected) throw new Error("Integration database was not prepared.");

      const generated = {
        projectId: randomUUID(),
        runId: randomUUID(),
        attemptId: randomUUID(),
        promptId: randomUUID(),
        baselinePromptVersionId: randomUUID(),
        candidatePromptVersionId: randomUUID(),
        sourceId: randomUUID(),
        sourceVersionId: randomUUID(),
      };
      const scenario = await createScenario({
        ...generated,
        holdoutVerification: "valid",
        holdoutInput: "PRIVATE_HOLDOUT_INPUT_MUST_NOT_REACH_RUNTIME",
        holdoutCaseId: "PRIVATE_HOLDOUT_CASE_ID",
      });
      integrationProjectIds.push(generated.projectId);

      const [project] = await connected.db
        .insert(schema.projects)
        .values({
          id: generated.projectId,
          ownerId: `integration-${generated.runId}`,
          name: `verified-memory-${generated.runId}`,
        })
        .returning({ id: schema.projects.id });
      if (!project) throw new Error("Integration project insert failed.");

      await connected.db.insert(schema.prompts).values({
        projectId: generated.projectId,
        id: scenario.request.promptId,
        name: "Verified memory integration prompt",
      });
      await connected.db.insert(schema.promptVersions).values([
        {
          projectId: generated.projectId,
          id: scenario.request.baselinePromptVersionId,
          promptId: scenario.request.promptId,
          version: 1,
          text: baselinePrompt,
          contentHash: sha256Text(baselinePrompt),
          invariantHash: sha256Text("[]"),
        },
        {
          projectId: generated.projectId,
          id: scenario.request.candidatePromptVersionId,
          promptId: scenario.request.promptId,
          version: 2,
          text: candidatePrompt,
          contentHash: sha256Text(candidatePrompt),
          invariantHash: sha256Text("[]"),
        },
      ]);
      await connected.db
        .update(schema.prompts)
        .set({ currentVersionId: scenario.request.candidatePromptVersionId })
        .where(
          and(
            eq(schema.prompts.projectId, generated.projectId),
            eq(schema.prompts.id, scenario.request.promptId),
          ),
        );

      const source = scenario.request.arms
        .flatMap((arm) => arm.sources)
        .find((item) => item.documentId === generated.sourceId);
      if (!source) throw new Error("Integration source fixture is missing.");
      await connected.db.insert(schema.documents).values({
        projectId: generated.projectId,
        id: source.documentId,
        displayName: "Verified memory source.md",
        sourceKind: "text",
        trust: "campus_indexer_allowed",
      });
      await connected.db.insert(schema.documentVersions).values({
        projectId: generated.projectId,
        id: source.documentVersionId,
        documentId: source.documentId,
        version: source.documentVersion,
        checksum: source.checksum,
        contentType: "text/markdown",
        extractStatus: "ready",
        eligible: true,
      });
      await connected.db
        .update(schema.documents)
        .set({ activeVersionId: source.documentVersionId })
        .where(
          and(
            eq(schema.documents.projectId, generated.projectId),
            eq(schema.documents.id, source.documentId),
          ),
        );
      await connected.db.insert(schema.chunks).values({
        projectId: generated.projectId,
        documentVersionId: source.documentVersionId,
        ordinal: 0,
        content: "The frozen source supports the verified evaluation case.",
        contentHash: sha256Text(
          "The frozen source supports the verified evaluation case.",
        ),
      });

      await connected.db.insert(schema.runs).values({
        projectId: generated.projectId,
        id: scenario.run.id,
        promptVersionId: scenario.run.promptVersionId,
        purpose: "target",
        provider: "codex_app_server",
        requestedModel,
        status: "succeeded",
        idempotencyKey: `verified-memory-${generated.runId}`,
        configSnapshot: scenario.run.configSnapshot,
      });
      await connected.db.insert(schema.modelAttempts).values({
        projectId: generated.projectId,
        id: scenario.report.attemptId,
        runId: scenario.run.id,
        attemptNumber: 1,
        provider: "codex_app_server",
        purpose: "target",
        requestedModel,
        status: "succeeded",
      });
      await connected.db.insert(schema.runEvents).values([
        {
          projectId: generated.projectId,
          runId: scenario.run.id,
          sequence: 1,
          eventType: "experiment.created",
          payload: { metadata: scenario.metadata },
        },
        {
          projectId: generated.projectId,
          runId: scenario.run.id,
          attemptId: scenario.report.attemptId,
          sequence: 2,
          eventType: "run.completed",
          payload: {
            status: "succeeded",
            mode: "controlled_evaluation",
            controlledEvaluation: scenario.report,
          },
        },
      ]);

      const decisionRequest = (
        targetProjectId: string,
        targetRunId: string,
        decision: "accepted" | "rejected",
      ) =>
        postDecision(
          new Request(
            `http://localhost/api/projects/${targetProjectId}/experiments/${targetRunId}/decision`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                decision,
                note: "Disposable integration proof.",
              }),
            },
          ),
          {
            params: Promise.resolve({
              projectId: targetProjectId,
              experimentId: targetRunId,
            }),
          },
        );
      const runtimeRequest = (targetProjectId: string) =>
        getMemory(
          new Request(
            `http://localhost/api/projects/${targetProjectId}/memory`,
          ),
          { params: Promise.resolve({ projectId: targetProjectId }) },
        );

      const accepted = await decisionRequest(
        generated.projectId,
        scenario.run.id,
        "accepted",
      );
      const acceptedText = await accepted.text();
      expect(accepted.status, acceptedText).toBe(200);
      const acceptedBody = JSON.parse(acceptedText) as { sequence: number };
      expect(acceptedBody.sequence).toBe(3);

      const evaluatorResult = await listVerifiedMemories(connected.db, {
        projectId: generated.projectId,
        audience: "evaluator",
      });
      expect(evaluatorResult.memories).toHaveLength(1);
      const evaluatorMemory = evaluatorResult.memories[0] as
        VerifiedMemoryRecord | undefined;
      if (!evaluatorMemory) throw new Error("Accepted memory was not rebuilt.");
      expect(evaluatorMemory.successConditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: "PRIVATE_HOLDOUT_CASE_ID",
            split: "holdout",
            judgment: expect.any(String),
            criterion: expect.objectContaining({
              expected: { count: "2", sum: "30" },
            }),
          }),
        ]),
      );

      const runtimeResponse = await runtimeRequest(generated.projectId);
      expect(runtimeResponse.status).toBe(200);
      const runtimePayload =
        (await runtimeResponse.json()) as RuntimeMemoryApiPayload;
      expect(runtimePayload.verifiedMemories).toHaveLength(1);
      const runtimeJson = JSON.stringify(runtimePayload.verifiedMemories[0]);
      expect(runtimeJson).toContain("Count the integers from 1 to 2");
      expect(runtimeJson).not.toContain(
        "PRIVATE_HOLDOUT_INPUT_MUST_NOT_REACH_RUNTIME",
      );
      expect(runtimeJson).not.toContain("PRIVATE_HOLDOUT_CASE_ID");
      expect(runtimeJson).not.toContain('"sum":"30"');
      expect(runtimePayload.verifiedMemories[0]?.successConditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ split: "development" }),
        ]),
      );
      expect(
        runtimePayload.verifiedMemories[0]?.successConditions,
      ).toHaveLength(3);
      expect(
        runtimePayload.verifiedMemories[0]?.successConditions.every(
          (condition) => condition.split === "development",
        ),
      ).toBe(true);

      const sourceManifest: WorkspaceSourceManifest =
        evaluatorMemory.sourceVersionManifest;
      const { createVerifiedMemorySearchHandler } =
        await import("../../../../../../../../../worker/src/verified-memory-tools.ts");
      const searchMemory = createVerifiedMemorySearchHandler({
        db: connected.db,
        sourceIds: sourceManifest.sources.map((item) => item.documentId),
        sourceManifest,
      });
      const memoryToolResult = await searchMemory(
        { query: "Count the integers from 1 to 2" },
        {
          scope: {
            projectId: generated.projectId,
            allowedSourceIds: new Set(
              sourceManifest.sources.map((item) => item.documentId),
            ),
            allowedChunkIds: new Set(),
            allowedHistoryMessageIds: new Set(),
            developmentCaseIds: new Set(["development-case"]),
            candidateIds: new Set(),
            graphEntityIds: new Set(),
            graphAssertionIds: new Set(),
          },
          signal: new AbortController().signal,
        },
      );
      expect(memoryToolResult).toMatchObject({
        available: true,
        resultCount: 1,
      });
      const toolJson = JSON.stringify(memoryToolResult);
      expect(toolJson).not.toContain(
        "PRIVATE_HOLDOUT_INPUT_MUST_NOT_REACH_RUNTIME",
      );
      expect(toolJson).not.toContain("PRIVATE_HOLDOUT_CASE_ID");
      expect(toolJson).not.toContain('"sum":"30"');

      const evaluatorExport = await getMemory(
        new Request(
          `http://localhost/api/projects/${generated.projectId}/memory?format=markdown&audience=evaluator`,
        ),
        { params: Promise.resolve({ projectId: generated.projectId }) },
      );
      expect(evaluatorExport.status).toBe(200);
      const exportText = await evaluatorExport.text();
      expect(exportText).toContain(
        "PRIVATE_HOLDOUT_INPUT_MUST_NOT_REACH_RUNTIME",
      );
      expect(exportText).toContain("PRIVATE_HOLDOUT_CASE_ID");
      const citationHref = exportText.match(
        /\]\((http:\/\/localhost\/api\/projects\/[^)]+\/memory\/citations\/[^)]+)\)/u,
      )?.[1];
      expect(citationHref).toBeDefined();
      if (!citationHref)
        throw new Error("Source citation URL was not exported.");
      const citationUrl = new URL(citationHref);
      const citationParts = citationUrl.pathname.split("/");
      const sourceAt = citationParts.indexOf("citations") + 1;
      const versionAt = citationParts.indexOf("versions") + 1;
      const sourceId = citationParts[sourceAt];
      const sourceVersionId = citationParts[versionAt];
      const checksum = citationUrl.searchParams.get("checksum");
      expect(sourceId).toBe(generated.sourceId);
      expect(sourceVersionId).toBe(generated.sourceVersionId);
      expect(checksum).toBe("a".repeat(64));
      const citationContext = {
        params: Promise.resolve({
          projectId: generated.projectId,
          sourceId: sourceId!,
          versionId: sourceVersionId!,
        }),
      };
      const validCitation = await getSourceCitation(
        new Request(citationHref),
        citationContext,
      );
      expect(validCitation.status).toBe(200);
      expect(await validCitation.json()).toMatchObject({
        source: {
          id: generated.sourceId,
          versionId: generated.sourceVersionId,
          version: 7,
          checksum: "a".repeat(64),
        },
        chunks: [
          expect.objectContaining({
            content: "The frozen source supports the verified evaluation case.",
          }),
        ],
      });
      citationUrl.searchParams.set("checksum", "b".repeat(64));
      const invalidCitation = await getSourceCitation(
        new Request(citationUrl),
        citationContext,
      );
      expect(invalidCitation.status).toBe(404);

      const rejected = await decisionRequest(
        generated.projectId,
        scenario.run.id,
        "rejected",
      );
      expect(rejected.status).toBe(200);
      expect(
        (
          await listVerifiedMemories(connected.db, {
            projectId: generated.projectId,
            audience: "runtime",
          })
        ).memories,
      ).toHaveLength(0);

      const otherProjectId = randomUUID();
      const otherRunId = randomUUID();
      integrationProjectIds.push(otherProjectId);
      await connected.db.insert(schema.projects).values({
        id: otherProjectId,
        ownerId: `integration-${otherRunId}`,
        name: `other-memory-${otherRunId}`,
      });
      await connected.db.insert(schema.runs).values({
        projectId: otherProjectId,
        id: otherRunId,
        purpose: "target",
        provider: "codex_app_server",
        requestedModel,
        status: "succeeded",
        idempotencyKey: `other-memory-${otherRunId}`,
      });
      await connected.db.insert(schema.runEvents).values({
        projectId: otherProjectId,
        runId: otherRunId,
        sequence: 1,
        eventType: "experiment.created",
        payload: { metadata: scenario.metadata },
      });
      const otherRejected = await decisionRequest(
        otherProjectId,
        otherRunId,
        "rejected",
      );
      expect(otherRejected.status).toBe(200);
      const otherProjectMemories = await listVerifiedMemories(connected.db, {
        projectId: otherProjectId,
        audience: "runtime",
      });
      expect(otherProjectMemories.memories).toHaveLength(0);
      expect(
        (
          await listVerifiedMemories(connected.db, {
            projectId: generated.projectId,
            audience: "evaluator",
          })
        ).memories,
      ).toHaveLength(0);

      const reaccepted = await decisionRequest(
        generated.projectId,
        scenario.run.id,
        "accepted",
      );
      expect(reaccepted.status).toBe(200);
      expect(
        (
          await listVerifiedMemories(connected.db, {
            projectId: generated.projectId,
            audience: "runtime",
          })
        ).memories,
      ).toHaveLength(1);

      await connected.db
        .update(schema.documents)
        .set({ trust: "local_only" })
        .where(
          and(
            eq(schema.documents.projectId, generated.projectId),
            eq(schema.documents.id, generated.sourceId),
          ),
        );
      expect(
        (
          await listVerifiedMemories(connected.db, {
            projectId: generated.projectId,
            audience: "runtime",
          })
        ).memories,
      ).toHaveLength(0);
      const stalePermissionTool = await searchMemory(
        { query: "Count the integers from 1 to 2" },
        {
          scope: {
            projectId: generated.projectId,
            allowedSourceIds: new Set(
              sourceManifest.sources.map((item) => item.documentId),
            ),
            allowedChunkIds: new Set(),
            allowedHistoryMessageIds: new Set(),
            developmentCaseIds: new Set(["development-case"]),
            candidateIds: new Set(),
            graphEntityIds: new Set(),
            graphAssertionIds: new Set(),
          },
          signal: new AbortController().signal,
        },
      );
      expect(stalePermissionTool).toMatchObject({
        available: false,
        reason: "frozen_sources_stale",
      });
      const revokedCitation = await getSourceCitation(
        new Request(citationHref),
        citationContext,
      );
      expect(revokedCitation.status).toBe(404);

      await connected.db
        .update(schema.documents)
        .set({ trust: "campus_indexer_allowed" })
        .where(
          and(
            eq(schema.documents.projectId, generated.projectId),
            eq(schema.documents.id, generated.sourceId),
          ),
        );
      await connected.db.insert(schema.documentVersions).values({
        projectId: generated.projectId,
        id: randomUUID(),
        documentId: generated.sourceId,
        version: 8,
        checksum: "b".repeat(64),
        contentType: "text/markdown",
        extractStatus: "ready",
        eligible: true,
      });
      const [currentVersion] = await connected.db
        .select({ id: schema.documentVersions.id })
        .from(schema.documentVersions)
        .where(
          and(
            eq(schema.documentVersions.projectId, generated.projectId),
            eq(schema.documentVersions.documentId, generated.sourceId),
            eq(schema.documentVersions.version, 8),
          ),
        );
      if (!currentVersion)
        throw new Error("Replacement source version is missing.");
      await connected.db
        .update(schema.documents)
        .set({ activeVersionId: currentVersion.id })
        .where(
          and(
            eq(schema.documents.projectId, generated.projectId),
            eq(schema.documents.id, generated.sourceId),
          ),
        );
      expect(
        (
          await listVerifiedMemories(connected.db, {
            projectId: generated.projectId,
            audience: "runtime",
          })
        ).memories,
      ).toHaveLength(0);
      const staleVersionTool = await searchMemory(
        { query: "Count the integers from 1 to 2" },
        {
          scope: {
            projectId: generated.projectId,
            allowedSourceIds: new Set(
              sourceManifest.sources.map((item) => item.documentId),
            ),
            allowedChunkIds: new Set(),
            allowedHistoryMessageIds: new Set(),
            developmentCaseIds: new Set(["development-case"]),
            candidateIds: new Set(),
            graphEntityIds: new Set(),
            graphAssertionIds: new Set(),
          },
          signal: new AbortController().signal,
        },
      );
      expect(staleVersionTool).toMatchObject({
        available: false,
        reason: "frozen_sources_stale",
      });
      const historicalCitation = await getSourceCitation(
        new Request(citationHref),
        citationContext,
      );
      expect(historicalCitation.status).toBe(200);
    }, 45_000);
  },
);
