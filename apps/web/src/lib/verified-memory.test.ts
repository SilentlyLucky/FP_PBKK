import {
  ControlledEvaluationRequestSchema,
  ControlledEvaluationReportSchema,
} from "@promptlab/contracts";
import type { Database } from "@promptlab/db";
import { describe, expect, it } from "vitest";

import {
  createControlledEvaluationVerifiedMemory,
  createPilotVerifiedMemory,
  isVerifiedMemorySourceManifestCurrent,
  parseVerifiedMemoryRecord,
  projectVerifiedMemoryForRuntime,
  renderVerifiedMemoryWiki,
  sourceManifestForExperiment,
  verifiedMemoryMatchesDerivedRecord,
  verifiedMemoryMatchesMetadata,
  type MemoryRun,
  type StoredExperimentEvent,
  type VerifiedMemoryGate,
} from "./verified-memory.js";
import { ExperimentPilotMetadataSchema } from "./experiment-pilot.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const promptId = "44444444-4444-4444-8444-444444444444";
const promptVersionId = "55555555-5555-4555-8555-555555555555";
const baselinePromptVersionId = "66666666-6666-4666-8666-666666666666";
const candidatePromptVersionId = "77777777-7777-4777-8777-777777777777";
const digest = "a".repeat(64);
const acceptedAt = "2026-10-18T12:00:00.000Z";

const emptyManifest = {
  format: "promptlab-workspace-source-manifest-v1" as const,
  sources: [],
};

function gate(overrides: Partial<VerifiedMemoryGate> = {}): VerifiedMemoryGate {
  return {
    decision: "accepted",
    evaluationEligible: true,
    sourceVersionsCurrent: true,
    acceptedDecisionSequence: 10,
    acceptedAt,
    sourceVersionManifest: emptyManifest,
    ...overrides,
  };
}

function run(configSnapshot: Record<string, unknown>): MemoryRun {
  return {
    id: experimentId,
    projectId,
    status: "succeeded",
    requestedModel: "fixture-model",
    configSnapshot,
  };
}

interface FakeSourceQuery {
  from(...args: unknown[]): FakeSourceQuery;
  leftJoin(...args: unknown[]): FakeSourceQuery;
  where(...args: unknown[]): FakeSourceQuery;
  orderBy(...args: unknown[]): FakeSourceQuery;
  limit(limit: number): Promise<Record<string, unknown>[]>;
}

function sourceDatabase(rows: Record<string, unknown>[]): Database {
  const query: FakeSourceQuery = {
    from: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => rows,
  };
  return { select: () => query } as unknown as Database;
}

function pilotFixture() {
  const metadata = ExperimentPilotMetadataSchema.parse({
    datasetName: "One case fixture",
    datasetVersion: "v1",
    arm: "original",
    split: "development",
    caseId: "case-1",
    input: "Count the items in the supplied list.",
    promptId,
    promptVersionId,
    promptName: "Fixture prompt",
    promptVersion: 2,
    baselinePrompt: "Return a count.",
    requestedModel: "fixture-model",
    reasoningEffort: null,
    retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
    activeSnapshotId: null,
    sources: [],
  });
  const configuredRetrieval = {
    strategy: "lexical",
    sourceIds: [],
    snapshotId: null,
  };
  const fixtureRun = run({
    reasoningEffort: null,
    retrieval: configuredRetrieval,
    optimization: {
      maxIterations: 1,
      testCases: [{ id: "case-1", input: metadata.input }],
    },
  });
  const events: StoredExperimentEvent[] = [
    {
      projectId,
      runId: experimentId,
      attemptId,
      sequence: 3,
      eventType: "evaluation.result",
      payload: {
        mode: "prompt_optimization",
        subject: "baseline",
        subjectId: "baseline",
      },
    },
    {
      projectId,
      runId: experimentId,
      attemptId,
      sequence: 5,
      eventType: "evaluation.result",
      payload: {
        mode: "prompt_optimization",
        subject: "candidate",
        subjectId: "candidate-1",
      },
    },
    {
      projectId,
      runId: experimentId,
      attemptId,
      sequence: 6,
      eventType: "run.completed",
      payload: {
        status: "succeeded",
        mode: "prompt_optimization",
        result: {
          status: "candidate_ready",
          baseline: {
            caseResults: [
              {
                id: "case-1",
                input: metadata.input,
                verificationEvidence: null,
              },
            ],
          },
          candidate: {
            id: "candidate-1",
            prompt: "Return a count as a JSON integer.",
            caseResults: [
              {
                id: "case-1",
                input: metadata.input,
                verificationEvidence: null,
              },
            ],
          },
        },
      },
    },
  ];
  const memory = createPilotVerifiedMemory({
    gate: gate(),
    run: fixtureRun,
    metadata,
    events,
  });
  return { metadata, memory };
}

function controlledFixture() {
  const metadata = ControlledEvaluationRequestSchema.parse({
    mode: "controlled_evaluation",
    format: "promptlab-controlled-evaluation-v1",
    datasetName: "Two case fixture",
    datasetVersion: "v1",
    promptId,
    baselinePromptVersionId,
    baselinePromptHash: digest,
    candidatePromptVersionId,
    candidatePromptHash: "b".repeat(64),
    cases: [
      { id: "dev", split: "development", input: "Development task." },
      { id: "holdout", split: "holdout", input: "Holdout task." },
    ],
    arms: [
      {
        arm: "original",
        provider: "codex_app_server",
        requestedModel: "fixture-model",
        reasoningEffort: null,
        retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
        sources: [],
      },
    ],
  });
  const fixtureRun = run({ controlledEvaluation: metadata });
  const answer = (subject: "baseline" | "candidate") => ({
    status: "succeeded" as const,
    promptHash: digest,
    requestHash: digest,
    contextHash: digest,
    answerHash: null,
    responseId: `${subject}-response`,
    responseModel: "fixture-model",
    provider: "codex_app_server" as const,
    text: "Fixture answer.",
    usage: null,
    latencyMs: 1,
    errorCode: null,
    verificationEvidence: null,
  });
  const pairs = metadata.cases.map((testCase) => ({
    arm: "original" as const,
    caseId: testCase.id,
    split: testCase.split,
    inputHash: digest,
    contextHash: digest,
    pairConfigHash: digest,
    baseline: answer("baseline"),
    candidate: answer("candidate"),
    judgment: "subjective" as const,
  }));
  const pack = (caseId: string) => ({
    caseId,
    requestedStrategy: "none" as const,
    strategyUsed: "none" as const,
    selectedSnapshotId: null,
    usedSnapshotId: null,
    fallbackReason: null,
    selectedSourceIds: [],
    sourceManifest: [],
    contextText: "",
    contextHash: digest,
    evidence: [],
    graphPaths: [],
    estimatedContextTokens: 0,
    contextBudgetTokens: 1000,
    clipping: {},
  });
  const report = ControlledEvaluationReportSchema.parse({
    mode: "controlled_evaluation",
    status: "complete",
    runId: experimentId,
    attemptId,
    configurationHash: digest,
    baselinePromptHash: metadata.baselinePromptHash,
    candidatePromptHash: metadata.candidatePromptHash,
    expectedRequestCount: 4,
    optimizerLineage: { status: "not_used", calls: 0, overheadMs: null },
    pairs,
    manifest: {
      format: "promptlab-controlled-evaluation-manifest-v1",
      manifestHash: "c".repeat(64),
      runId: experimentId,
      attemptId,
      configurationHash: digest,
      baselinePromptHash: metadata.baselinePromptHash,
      candidatePromptHash: metadata.candidatePromptHash,
      cases: metadata.cases.map((testCase) => ({
        caseId: testCase.id,
        split: testCase.split,
        inputHash: digest,
        inputCharacters: testCase.input.length,
        labelHash: null,
        verificationHash: null,
      })),
      arms: [
        {
          arm: "original",
          configurationHash: digest,
          requestedModel: "fixture-model",
          reasoningEffort: null,
          retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
          sources: [],
          evidencePacks: [pack("dev"), pack("holdout")],
        },
      ],
      pairs,
    },
  });
  const events: StoredExperimentEvent[] = [
    {
      projectId,
      runId: experimentId,
      attemptId,
      sequence: 9,
      eventType: "run.completed",
      payload: {
        status: "succeeded",
        mode: "controlled_evaluation",
        controlledEvaluation: report,
      },
    },
  ];
  return {
    metadata,
    memory: createControlledEvaluationVerifiedMemory({
      gate: gate(),
      run: fixtureRun,
      metadata,
      events,
    }),
  };
}

describe("verified experiment memory", () => {
  it("records a pilot task only with accepted, eligible evaluation evidence", () => {
    const { metadata, memory } = pilotFixture();
    const fixtureRun = run({
      optimization: {
        testCases: [{ id: "case-1", input: metadata.input }],
      },
    });
    expect(memory).toMatchObject({
      format: "promptlab-verified-memory-v1",
      status: "eligible_accepted_experiment",
      task: metadata.input,
      strategy: {
        arm: "original",
        candidateId: "candidate-1",
      },
      evaluationProvenance: {
        mode: "pilot",
        completionSequence: 6,
        evaluationSequences: [3, 5],
      },
      successConditions: [
        { subject: "baseline", outcome: "not_scored", criterion: null },
        { subject: "candidate", outcome: "not_scored", criterion: null },
      ],
      interpretation:
        "Experiment-scoped evidence; acceptance does not establish general truth.",
    });
    expect(memory && verifiedMemoryMatchesMetadata(memory, metadata)).toBe(
      true,
    );
    expect(
      memory &&
        verifiedMemoryMatchesDerivedRecord(memory, {
          ...memory,
          evaluationProvenance: {
            ...memory.evaluationProvenance,
            evaluationSequences: [2, 5],
          },
        }),
    ).toBe(false);
    expect(
      createPilotVerifiedMemory({
        gate: gate(),
        run: fixtureRun,
        metadata,
        events: [],
      }),
    ).toBeNull();
    expect(
      createPilotVerifiedMemory({
        gate: gate({ evaluationEligible: false }),
        run: fixtureRun,
        metadata,
        events: [],
      }),
    ).toBeNull();
  });

  it("stores controlled evaluation conditions and the recorded manifest hash", () => {
    const { metadata, memory } = controlledFixture();
    expect(memory).toMatchObject({
      task: "Development task.\n\nHoldout task.",
      evaluationProvenance: {
        mode: "controlled_evaluation",
        completionSequence: 9,
        evaluationSequences: [9],
        manifestHash: "c".repeat(64),
      },
      successConditions: [
        { caseId: "dev", outcome: "not_scored", judgment: "subjective" },
        { caseId: "holdout", outcome: "not_scored", judgment: "subjective" },
      ],
    });
    expect(memory && verifiedMemoryMatchesMetadata(memory, metadata)).toBe(
      true,
    );
  });

  it("keeps holdout inputs and verifier labels out of runtime memory projection", () => {
    const { metadata, memory } = controlledFixture();
    expect(memory).not.toBeNull();
    const privateMetadata = ControlledEvaluationRequestSchema.parse({
      ...metadata,
      cases: metadata.cases.map((testCase) => ({
        ...testCase,
        input:
          testCase.split === "holdout" ? "GOLD_HOLDOUT_INPUT" : testCase.input,
        label: testCase.split === "holdout" ? "GOLD_PRIVATE_LABEL" : null,
        ...(testCase.split === "holdout"
          ? {
              verification: {
                kind: "python_tests",
                tests: [
                  {
                    id: "gold-test",
                    n: 1,
                    expectedOutput: "731",
                    blocked: [],
                  },
                ],
              },
            }
          : {}),
      })),
    });
    const privateMemory = {
      ...memory!,
      task: "Development task.\n\nGOLD_HOLDOUT_INPUT",
      successConditions: memory!.successConditions.map((condition) =>
        condition.split === "holdout"
          ? {
              ...condition,
              criterion: {
                kind: "python_tests",
                tests: [{ expectedOutput: "731" }],
              },
            }
          : condition,
      ),
    };
    const projection = projectVerifiedMemoryForRuntime(
      privateMemory,
      privateMetadata,
    );
    const serialized = JSON.stringify(projection);
    expect(projection.task).toBe("Development task.");
    expect(projection.scope.cases.map((testCase) => testCase.id)).toEqual([
      "dev",
    ]);
    expect(projection.successConditions).toHaveLength(1);
    expect(serialized).not.toContain("GOLD_HOLDOUT_INPUT");
    expect(serialized).not.toContain("GOLD_PRIVATE_LABEL");
    expect(serialized).not.toContain("731");
    expect(serialized).not.toContain('"criterion"');
  });

  it("keeps source versions explicit and rejects legacy or malformed records", () => {
    const source = {
      id: "88888888-8888-4888-8888-888888888888",
      title: "Frozen source",
      version: 3,
      versionId: "99999999-9999-4999-8999-999999999999",
      checksum: digest,
    };
    const metadata = ExperimentPilotMetadataSchema.parse({
      datasetName: "Source fixture",
      datasetVersion: "v1",
      arm: "rag",
      split: "development",
      caseId: "case-1",
      input: "Use a source.",
      promptId,
      promptVersionId,
      promptName: "Fixture prompt",
      promptVersion: 2,
      baselinePrompt: "Baseline.",
      requestedModel: "fixture-model",
      reasoningEffort: null,
      retrieval: {
        strategy: "lexical",
        sourceIds: [source.id],
        snapshotId: null,
      },
      activeSnapshotId: null,
      sources: [source],
    });
    expect(sourceManifestForExperiment(metadata)).toEqual({
      format: "promptlab-workspace-source-manifest-v1",
      sources: [
        {
          documentId: source.id,
          documentVersionId: source.versionId,
          documentVersion: source.version,
          checksum: source.checksum,
          sourcePermission: "campus_indexer_allowed",
        },
      ],
    });
    expect(parseVerifiedMemoryRecord({ legacy: true })).toBeNull();
    expect(
      parseVerifiedMemoryRecord({ ...pilotFixture().memory, format: "legacy" }),
    ).toBeNull();
  });

  it("revalidates the active source version and permission", async () => {
    const source = {
      id: "88888888-8888-4888-8888-888888888888",
      title: "Frozen source",
      version: 3,
      versionId: "99999999-9999-4999-8999-999999999999",
      checksum: digest,
    };
    const metadata = ExperimentPilotMetadataSchema.parse({
      datasetName: "Source fixture",
      datasetVersion: "v1",
      arm: "rag",
      split: "development",
      caseId: "case-1",
      input: "Use a source.",
      promptId,
      promptVersionId,
      promptName: "Fixture prompt",
      promptVersion: 2,
      baselinePrompt: "Baseline.",
      requestedModel: "fixture-model",
      reasoningEffort: null,
      retrieval: {
        strategy: "lexical",
        sourceIds: [source.id],
        snapshotId: null,
      },
      activeSnapshotId: null,
      sources: [source],
    });
    const manifest = sourceManifestForExperiment(metadata)!;
    const currentRow = {
      documentId: source.id,
      activeVersionId: source.versionId,
      deletedAt: null,
      permission: "campus_indexer_allowed",
      documentVersionId: source.versionId,
      documentVersion: source.version,
      checksum: source.checksum,
      eligible: true,
    };

    expect(
      await isVerifiedMemorySourceManifestCurrent(
        sourceDatabase([currentRow]),
        projectId,
        manifest,
      ),
    ).toBe(true);
    expect(
      await isVerifiedMemorySourceManifestCurrent(
        sourceDatabase([
          {
            ...currentRow,
            documentVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
        ]),
        projectId,
        manifest,
      ),
    ).toBe(false);
    expect(
      await isVerifiedMemorySourceManifestCurrent(
        sourceDatabase([{ ...currentRow, permission: "unreviewed" }]),
        projectId,
        manifest,
      ),
    ).toBe(false);
  });

  it("exports a stable cited index, decision log, and lesson without source contents", () => {
    const { memory } = pilotFixture();
    expect(memory).not.toBeNull();
    const exportOnce = renderVerifiedMemoryWiki([memory!]);
    const exportTwice = renderVerifiedMemoryWiki([memory!]);
    const citedExport = renderVerifiedMemoryWiki([
      {
        ...memory!,
        sourceVersionManifest: {
          format: "promptlab-workspace-source-manifest-v1",
          sources: [
            {
              documentId: "88888888-8888-4888-8888-888888888888",
              documentVersionId: "99999999-9999-4999-8999-999999999999",
              documentVersion: 3,
              checksum: digest,
              sourcePermission: "campus_indexer_allowed",
            },
          ],
        },
      },
    ]);

    expect(exportOnce).toBe(exportTwice);
    expect(exportOnce).toContain("## Index");
    expect(exportOnce).toContain("## Decision log");
    expect(exportOnce).toContain("## Lessons");
    expect(exportOnce).toContain("http://localhost/api/projects/");
    expect(exportOnce).toContain(
      "/runs/22222222-2222-4222-8222-222222222222/events?after=9",
    );
    expect(exportOnce).toContain("No external source versions were selected.");
    expect(exportOnce).toContain("No structured verifier configured");
    expect(citedExport).toContain("http://localhost/api/projects/");
    expect(citedExport).toContain(
      "/memory/citations/88888888-8888-4888-8888-888888888888/versions/99999999-9999-4999-8999-999999999999",
    );
    expect(citedExport).toContain(digest);
  });
});
