import { schema, type Database } from "@promptlab/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gates = vi.hoisted(() => ({
  pilot: vi.fn(() => true),
  controlled: vi.fn(() => false),
}));

vi.mock("./experiment-acceptance.js", () => ({
  hasExperimentAcceptanceEvidence: gates.pilot,
}));
vi.mock("./controlled-evaluation-eligibility.js", () => ({
  controlledEvaluationPromptVersionIds: () => [],
  hasControlledEvaluationAcceptanceEvidence: gates.controlled,
}));

import {
  createPilotVerifiedMemory,
  listVerifiedMemories,
  type MemoryRun,
  type StoredExperimentEvent,
  type VerifiedMemoryGate,
} from "./verified-memory.js";
import { ExperimentPilotMetadataSchema } from "./experiment-metadata.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const promptVersionId = "44444444-4444-4444-8444-444444444444";
const acceptedAt = "2026-10-18T12:00:00.000Z";
const sourceId = "55555555-5555-4555-8555-555555555555";
const sourceVersionId = "66666666-6666-4666-8666-666666666666";
const digest = "a".repeat(64);

function fixture(
  source = false,
  options: { runId?: string; task?: string } = {},
) {
  const fixtureRunId = options.runId ?? runId;
  const task = options.task ?? "Summarize the current campus policy.";
  const metadata = ExperimentPilotMetadataSchema.parse({
    datasetName: "Memory fixture",
    datasetVersion: "v1",
    arm: source ? "rag" : "original",
    split: "development",
    caseId: "case-1",
    input: task,
    promptId: "77777777-7777-4777-8777-777777777777",
    promptVersionId,
    promptName: "Policy summary",
    promptVersion: 1,
    baselinePrompt: "Answer the policy question.",
    requestedModel: "fixture-model",
    reasoningEffort: null,
    retrieval: {
      strategy: "lexical",
      sourceIds: source ? [sourceId] : [],
      snapshotId: null,
    },
    activeSnapshotId: null,
    sources: source
      ? [
          {
            id: sourceId,
            title: "Policy source",
            version: 2,
            versionId: sourceVersionId,
            checksum: digest,
          },
        ]
      : [],
  });
  const run: MemoryRun & {
    promptVersionId: string;
    provider: string;
    purpose: string;
  } = {
    id: fixtureRunId,
    projectId,
    status: "succeeded",
    requestedModel: "fixture-model",
    configSnapshot: {
      optimization: {
        testCases: [{ id: metadata.caseId, input: metadata.input }],
      },
    },
    promptVersionId,
    provider: "codex_app_server",
    purpose: "target",
  };
  const candidateCase = {
    id: metadata.caseId,
    input: metadata.input,
    response: "Summarize the current campus policy in three points.",
    verificationEvidence: null,
  };
  const events: StoredExperimentEvent[] = [
    {
      projectId,
      runId: fixtureRunId,
      attemptId,
      sequence: 2,
      eventType: "evaluation.result",
      payload: {
        mode: "prompt_optimization",
        subject: "baseline",
        subjectId: "baseline",
      },
    },
    {
      projectId,
      runId: fixtureRunId,
      attemptId,
      sequence: 3,
      eventType: "evaluation.result",
      payload: {
        mode: "prompt_optimization",
        subject: "candidate",
        subjectId: "candidate-1",
      },
    },
    {
      projectId,
      runId: fixtureRunId,
      attemptId,
      sequence: 4,
      eventType: "run.completed",
      payload: {
        status: "succeeded",
        mode: "prompt_optimization",
        result: {
          status: "candidate_ready",
          baseline: { caseResults: [candidateCase] },
          candidate: {
            id: "candidate-1",
            prompt: "Answer in three concise policy points.",
            caseResults: [candidateCase],
          },
        },
      },
    },
  ];
  const gate: VerifiedMemoryGate = {
    decision: "accepted",
    evaluationEligible: true,
    sourceVersionsCurrent: true,
    acceptedDecisionSequence: 5,
    acceptedAt,
    sourceVersionManifest: {
      format: "promptlab-workspace-source-manifest-v1",
      sources: source
        ? [
            {
              documentId: sourceId,
              documentVersionId: sourceVersionId,
              documentVersion: 2,
              checksum: digest,
              sourcePermission: "campus_indexer_allowed",
            },
          ]
        : [],
    },
  };
  const memory = createPilotVerifiedMemory({ gate, run, metadata, events });
  if (!memory) throw new Error("fixture memory was not created");
  const marker = {
    projectId,
    runId: fixtureRunId,
    sequence: 1,
    createdAt: new Date(acceptedAt),
    payload: { metadata },
  };
  const decision = {
    projectId,
    runId: fixtureRunId,
    attemptId: null,
    sequence: 5,
    eventType: "experiment.decision",
    payload: {
      decision: "accepted",
      decidedAt: acceptedAt,
      verifiedMemory: memory,
    },
  };
  const currentSource = {
    documentId: sourceId,
    activeVersionId: sourceVersionId,
    deletedAt: null,
    permission: "campus_indexer_allowed",
    documentVersionId: sourceVersionId,
    documentVersion: 2,
    checksum: digest,
    eligible: true,
  };
  return { metadata, run, events, memory, marker, decision, currentSource };
}

interface FakeQuery extends PromiseLike<Record<string, unknown>[]> {
  from(table: unknown): FakeQuery;
  leftJoin(...args: unknown[]): FakeQuery;
  where(...args: unknown[]): FakeQuery;
  orderBy(...args: unknown[]): FakeQuery;
  limit(limit: number): Promise<Record<string, unknown>[]>;
}

function database(input: {
  markers?: Record<string, unknown>[];
  runs?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  sources?: Record<string, unknown>[];
}): Database {
  const rowsFor = (
    table: unknown,
    selection: Record<string, unknown>,
  ): Record<string, unknown>[] => {
    if (table === schema.runEvents) {
      return Object.hasOwn(selection, "createdAt")
        ? (input.markers ?? [])
        : (input.events ?? []);
    }
    if (table === schema.runs) return input.runs ?? [];
    if (table === schema.documents) return input.sources ?? [];
    return [];
  };
  return {
    select(selection: Record<string, unknown>) {
      let table: unknown;
      const query: FakeQuery = {
        from(value) {
          table = value;
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return Promise.resolve(rowsFor(table, selection));
        },
        then(resolve, reject) {
          return Promise.resolve(rowsFor(table, selection)).then(
            resolve,
            reject,
          );
        },
      };
      return query;
    },
  } as unknown as Database;
}

function runRows(fixtureData: ReturnType<typeof fixture>) {
  return [
    {
      ...fixtureData.run,
    },
  ];
}

function eventRows(fixtureData: ReturnType<typeof fixture>) {
  return [...fixtureData.events, fixtureData.decision] as unknown as Record<
    string,
    unknown
  >[];
}

describe("verified memory DB retrieval", () => {
  beforeEach(() => {
    gates.pilot.mockReturnValue(true);
    gates.controlled.mockReturnValue(false);
  });

  it("rebuilds and returns an accepted memory with a safe runtime projection", async () => {
    const value = fixture();
    const db = database({
      markers: [value.marker],
      runs: runRows(value),
      events: eventRows(value),
    });
    const result = await listVerifiedMemories(db, {
      projectId,
      query: "campus policy",
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      format: "promptlab-verified-memory-runtime-v1",
      memoryId: value.memory.memoryId,
      task: value.metadata.input,
      successConditions: [
        { verificationKind: null },
        { verificationKind: null },
      ],
    });
    expect(gates.pilot).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, experimentId: runId }),
    );
  });

  it("ranks task overlap and applies a hard result limit", async () => {
    const closest = fixture();
    const partial = fixture(false, {
      runId: "88888888-8888-4888-8888-888888888888",
      task: "Campus policy",
    });
    const result = await listVerifiedMemories(
      database({
        markers: [closest.marker, partial.marker],
        runs: [...runRows(closest), ...runRows(partial)],
        events: [...eventRows(closest), ...eventRows(partial)],
      }),
      { projectId, query: "current campus policy", limit: 1 },
    );
    expect(result.memories.map((memory) => memory.memoryId)).toEqual([
      closest.memory.memoryId,
    ]);
    expect(result.truncated).toBe(true);
  });

  it("invalidates a record after its source permission or version changes", async () => {
    const value = fixture(true);
    const db = database({
      markers: [value.marker],
      runs: runRows(value),
      events: eventRows(value),
      sources: [value.currentSource],
    });
    expect(
      (await listVerifiedMemories(db, { projectId })).memories,
    ).toHaveLength(1);
    const invalidated = database({
      markers: [value.marker],
      runs: runRows(value),
      events: eventRows(value),
      sources: [{ ...value.currentSource, permission: "unreviewed" }],
    });
    expect(
      (await listVerifiedMemories(invalidated, { projectId })).memories,
    ).toHaveLength(0);
    const staleVersion = database({
      markers: [value.marker],
      runs: runRows(value),
      events: eventRows(value),
      sources: [
        {
          ...value.currentSource,
          activeVersionId: "99999999-9999-4999-8999-999999999999",
          documentVersionId: "99999999-9999-4999-8999-999999999999",
          documentVersion: 3,
          checksum: "b".repeat(64),
        },
      ],
    });
    expect(
      (await listVerifiedMemories(staleVersion, { projectId })).memories,
    ).toHaveLength(0);
  });

  it("uses the latest decision and rejects a later rejection", async () => {
    const value = fixture();
    const laterRejection = {
      ...value.decision,
      sequence: 6,
      payload: { decision: "rejected", decidedAt: acceptedAt },
    };
    const result = await listVerifiedMemories(
      database({
        markers: [value.marker],
        runs: runRows(value),
        events: [...eventRows(value), laterRejection],
      }),
      { projectId },
    );
    expect(result.memories).toHaveLength(0);
  });

  it("isolates projects and does not trust a forged eligibility marker", async () => {
    const value = fixture();
    const forged = {
      ...value.marker,
      runId: "88888888-8888-4888-8888-888888888888",
      payload: {
        metadata: value.metadata,
        eligible: true,
        verifiedMemory: value.memory,
      },
    };
    const otherProjectMarker = {
      ...value.marker,
      projectId: otherProjectId,
      runId: "99999999-9999-4999-8999-999999999999",
    };
    const result = await listVerifiedMemories(
      database({
        markers: [forged, otherProjectMarker],
        runs: runRows(value),
        events: eventRows(value),
      }),
      { projectId },
    );
    expect(result.memories).toHaveLength(0);
    expect(gates.pilot).not.toHaveBeenCalled();

    const forgedMarkerOnly = {
      ...value.marker,
      payload: {
        metadata: value.metadata,
        eligible: true,
        verifiedMemory: value.memory,
      },
    };
    const markerOnly = await listVerifiedMemories(
      database({
        markers: [forgedMarkerOnly],
        runs: runRows(value),
        events: value.events as unknown as Record<string, unknown>[],
      }),
      { projectId },
    );
    expect(markerOnly.memories).toHaveLength(0);

    const forgedProvenanceDecision = {
      ...value.decision,
      payload: {
        ...value.decision.payload,
        verifiedMemory: {
          ...value.memory,
          evaluationProvenance: {
            ...value.memory.evaluationProvenance,
            evaluationSequences: [1, 3],
          },
        },
      },
    };
    const forgedProvenance = await listVerifiedMemories(
      database({
        markers: [value.marker],
        runs: runRows(value),
        events: [
          ...value.events,
          forgedProvenanceDecision,
        ] as unknown as Record<string, unknown>[],
      }),
      { projectId },
    );
    expect(forgedProvenance.memories).toHaveLength(0);
  });
});
