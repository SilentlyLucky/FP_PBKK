import {
  ControlledEvaluationReportSchema,
  ControlledEvaluationRequestSchema,
  WorkspaceSourceManifestSchema,
  type ControlledEvaluationRequest,
  type WorkspaceSourceManifest,
} from "@promptlab/contracts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  isWorkspaceSourceManifestCurrent,
  parseWorkspaceSourceManifest,
  schema,
  type Database,
} from "@promptlab/db";
import { z } from "zod";

import {
  ExperimentPilotMetadataSchema,
  parseStoredControlledEvaluationMetadata,
  parseStoredExperimentPilotMetadata,
  type ExperimentPilotMetadata,
} from "./experiment-metadata.js";
import {
  hasExperimentAcceptanceEvidence,
  type ExperimentAcceptanceRun,
} from "./experiment-acceptance.js";
import {
  controlledEvaluationPromptVersionIds,
  hasControlledEvaluationAcceptanceEvidence,
} from "./controlled-evaluation-eligibility.js";

const EvaluationProvenanceSchema = z.strictObject({
  mode: z.enum(["pilot", "controlled_evaluation"]),
  runId: z.string().uuid(),
  attemptId: z.string().uuid(),
  completionSequence: z.number().int().positive(),
  evaluationSequences: z.array(z.number().int().positive()).min(1),
  manifestHash: z.string().min(1).nullable(),
  status: z.enum(["succeeded", "complete"]),
});

const SuccessConditionSchema = z.strictObject({
  arm: z.enum(["original", "rag", "graphrag"]).nullable(),
  caseId: z.string().min(1).max(80),
  split: z.enum(["development", "holdout"]),
  subject: z.enum(["baseline", "candidate"]),
  criterion: z.unknown().nullable(),
  outcome: z.string().min(1).max(80),
  judgment: z.string().min(1).max(80).nullable(),
  evidenceSequence: z.number().int().positive(),
});

export const VerifiedMemoryRecordSchema = z.strictObject({
  format: z.literal("promptlab-verified-memory-v1"),
  status: z.literal("eligible_accepted_experiment"),
  memoryId: z.string().min(1).max(160),
  projectId: z.string().uuid(),
  experimentId: z.string().uuid(),
  runId: z.string().uuid(),
  acceptedDecisionSequence: z.number().int().positive(),
  acceptedAt: z.string().datetime({ offset: true }),
  task: z.string().min(1).max(210_000),
  strategy: z.record(z.string(), z.unknown()),
  scope: z.record(z.string(), z.unknown()),
  constraints: z.record(z.string(), z.unknown()),
  evaluationProvenance: EvaluationProvenanceSchema,
  sourceVersionManifest: WorkspaceSourceManifestSchema,
  successConditions: z.array(SuccessConditionSchema).min(1).max(120),
  interpretation: z.literal(
    "Experiment-scoped evidence; acceptance does not establish general truth.",
  ),
});

export const VerifiedMemorySourceCitationQuerySchema = z.strictObject({
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type VerifiedMemoryRecord = z.infer<typeof VerifiedMemoryRecordSchema>;
export type VerifiedMemorySourceManifest = WorkspaceSourceManifest;

export interface VerifiedMemoryRuntimeCondition {
  arm: VerifiedMemoryRecord["successConditions"][number]["arm"];
  caseId: string;
  split: "development";
  subject: VerifiedMemoryRecord["successConditions"][number]["subject"];
  verificationKind: string | null;
  outcome: string;
  judgment: string | null;
  evidenceSequence: number;
}

export interface VerifiedMemoryRuntimeProjection {
  format: "promptlab-verified-memory-runtime-v1";
  status: "eligible_accepted_experiment";
  memoryId: string;
  projectId: string;
  experimentId: string;
  runId: string;
  acceptedDecisionSequence: number;
  acceptedAt: string;
  task: string;
  strategy: Record<string, unknown>;
  scope: {
    datasetName: string;
    datasetVersion: string;
    cases: Array<{ id: string; split: "development" }>;
  };
  constraints: Record<string, unknown>;
  evaluationProvenance: VerifiedMemoryRecord["evaluationProvenance"];
  sourceVersionManifest: VerifiedMemorySourceManifest;
  successConditions: VerifiedMemoryRuntimeCondition[];
  interpretation: VerifiedMemoryRecord["interpretation"];
}

export interface VerifiedMemoryListInput {
  projectId: string;
  query?: string;
  memoryId?: string;
  limit?: number;
}

export interface VerifiedMemoryListResult<T> {
  memories: T[];
  truncated: boolean;
}

const MAX_VERIFIED_MEMORY_MARKERS = 100;
const MAX_VERIFIED_MEMORY_EVENTS = 25_000;
const MAX_VERIFIED_MEMORY_QUERY_LENGTH = 2_000;
const DEFAULT_VERIFIED_MEMORY_LIMIT = 5;
const MAX_VERIFIED_MEMORY_RUNTIME_LIMIT = 20;
const MAX_VERIFIED_MEMORY_EXPORT_LIMIT = 100;

export async function isVerifiedMemorySourceManifestCurrent(
  db: Database,
  projectId: string,
  manifest: VerifiedMemorySourceManifest,
): Promise<boolean> {
  const parsed = parseWorkspaceSourceManifest(manifest);
  return (
    parsed !== null && isWorkspaceSourceManifestCurrent(db, projectId, parsed)
  );
}

type JsonRecord = Record<string, unknown>;

export interface StoredExperimentEvent {
  projectId: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  eventType: string;
  payload: unknown;
}

export interface MemoryRun {
  id: string;
  projectId: string;
  status: string;
  requestedModel: string;
  configSnapshot: Record<string, unknown>;
}

export interface VerifiedMemoryGate {
  decision: string;
  evaluationEligible: boolean;
  sourceVersionsCurrent: boolean;
  acceptedDecisionSequence: number;
  acceptedAt: string;
  sourceVersionManifest: VerifiedMemorySourceManifest;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asRecordArray(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(asRecord);
  return records.every((record) => record !== null)
    ? (records as JsonRecord[])
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    sameJson(leftKeys, rightKeys) &&
    leftKeys.every((key) => sameJson(leftRecord[key], rightRecord[key]))
  );
}

function normalizedSourceManifest(
  sources: readonly {
    documentId: string;
    documentVersionId: string;
    documentVersion: number;
    checksum: string;
  }[],
): VerifiedMemorySourceManifest | null {
  const byDocumentId = new Map<
    string,
    {
      documentId: string;
      documentVersionId: string;
      documentVersion: number;
      checksum: string;
      sourcePermission: "campus_indexer_allowed";
    }
  >();
  for (const source of sources) {
    const entry = {
      ...source,
      sourcePermission: "campus_indexer_allowed" as const,
    };
    const prior = byDocumentId.get(entry.documentId);
    if (prior && !sameJson(prior, entry)) return null;
    byDocumentId.set(entry.documentId, entry);
  }

  const parsed = WorkspaceSourceManifestSchema.safeParse({
    format: "promptlab-workspace-source-manifest-v1",
    sources: [...byDocumentId.values()].sort((left, right) =>
      left.documentId < right.documentId
        ? -1
        : left.documentId > right.documentId
          ? 1
          : 0,
    ),
  });
  return parsed.success ? parsed.data : null;
}

export function sourceManifestForExperiment(
  metadata: ExperimentPilotMetadata | ControlledEvaluationRequest,
): VerifiedMemorySourceManifest | null {
  if ("arms" in metadata) {
    return normalizedSourceManifest(
      metadata.arms.flatMap((arm) =>
        arm.sources.map((source) => ({
          documentId: source.documentId,
          documentVersionId: source.documentVersionId,
          documentVersion: source.documentVersion,
          checksum: source.checksum,
        })),
      ),
    );
  }
  return normalizedSourceManifest(
    metadata.sources.map((source) => ({
      documentId: source.id,
      documentVersionId: source.versionId,
      documentVersion: source.version,
      checksum: source.checksum,
    })),
  );
}

export function verifiedMemoryMatchesMetadata(
  memory: VerifiedMemoryRecord,
  metadata: ExperimentPilotMetadata | ControlledEvaluationRequest,
): boolean {
  const expected = sourceManifestForExperiment(metadata);
  return expected !== null && sameJson(memory.sourceVersionManifest, expected);
}

export function verifiedMemoryMatchesDerivedRecord(
  memory: VerifiedMemoryRecord,
  expected: VerifiedMemoryRecord,
): boolean {
  return sameJson(memory, expected);
}

export function parseVerifiedMemoryRecord(
  value: unknown,
): VerifiedMemoryRecord | null {
  const parsed = VerifiedMemoryRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function scopedEvents(
  run: MemoryRun,
  events: readonly StoredExperimentEvent[],
): StoredExperimentEvent[] {
  return events
    .filter(
      (event) => event.projectId === run.projectId && event.runId === run.id,
    )
    .filter((event) => Number.isInteger(event.sequence) && event.sequence > 0)
    .sort((left, right) => left.sequence - right.sequence);
}

function createRecord(
  gate: VerifiedMemoryGate,
  input: Omit<
    VerifiedMemoryRecord,
    | "format"
    | "status"
    | "memoryId"
    | "acceptedDecisionSequence"
    | "acceptedAt"
    | "interpretation"
  >,
): VerifiedMemoryRecord | null {
  if (
    gate.decision !== "accepted" ||
    !gate.evaluationEligible ||
    !gate.sourceVersionsCurrent ||
    !Number.isInteger(gate.acceptedDecisionSequence) ||
    gate.acceptedDecisionSequence < 1 ||
    input.evaluationProvenance.evaluationSequences.length === 0
  ) {
    return null;
  }

  const parsed = VerifiedMemoryRecordSchema.safeParse({
    format: "promptlab-verified-memory-v1",
    status: "eligible_accepted_experiment",
    memoryId: `${input.runId}:decision:${gate.acceptedDecisionSequence}`,
    ...input,
    acceptedDecisionSequence: gate.acceptedDecisionSequence,
    acceptedAt: gate.acceptedAt,
    sourceVersionManifest: gate.sourceVersionManifest,
    interpretation:
      "Experiment-scoped evidence; acceptance does not establish general truth.",
  });
  return parsed.success ? parsed.data : null;
}

export function createPilotVerifiedMemory(input: {
  gate: VerifiedMemoryGate;
  run: MemoryRun;
  metadata: unknown;
  events: readonly StoredExperimentEvent[];
}): VerifiedMemoryRecord | null {
  const parsedMetadata = ExperimentPilotMetadataSchema.safeParse(
    input.metadata,
  );
  const expectedManifest = parsedMetadata.success
    ? sourceManifestForExperiment(parsedMetadata.data)
    : null;
  if (
    !parsedMetadata.success ||
    !expectedManifest ||
    !sameJson(input.gate.sourceVersionManifest, expectedManifest) ||
    input.run.status !== "succeeded"
  ) {
    return null;
  }
  const metadata = parsedMetadata.data;
  const events = scopedEvents(input.run, input.events);
  const completion = events
    .filter((event) => event.eventType === "run.completed")
    .at(-1);
  const completionPayload = asRecord(completion?.payload);
  const result = asRecord(completionPayload?.result);
  const candidate = asRecord(result?.candidate);
  const baseline = asRecord(result?.baseline);
  const candidateCases = asRecordArray(candidate?.caseResults);
  const baselineCases = asRecordArray(baseline?.caseResults);
  const evaluationEvents = events.filter((event) => {
    const payload = asRecord(event.payload);
    return (
      event.attemptId === completion?.attemptId &&
      event.eventType === "evaluation.result" &&
      payload?.mode === "prompt_optimization"
    );
  });
  const candidateEvaluation = evaluationEvents.find((event) => {
    const payload = asRecord(event.payload);
    return (
      payload?.subject === "candidate" && payload.subjectId === candidate?.id
    );
  });
  const baselineEvaluation = evaluationEvents.find((event) => {
    const payload = asRecord(event.payload);
    return payload?.subject === "baseline" && payload.subjectId === "baseline";
  });
  const optimization = asRecord(input.run.configSnapshot.optimization);
  const configuredCases = asRecordArray(optimization?.testCases);
  const configuredCase = configuredCases?.find(
    (testCase) => testCase.id === metadata.caseId,
  );
  const candidateCase = candidateCases?.find(
    (testCase) => testCase.id === metadata.caseId,
  );
  const baselineCase = baselineCases?.find(
    (testCase) => testCase.id === metadata.caseId,
  );
  if (
    !completion ||
    !completion.attemptId ||
    !completionPayload ||
    completionPayload.status !== "succeeded" ||
    completionPayload.mode !== "prompt_optimization" ||
    result?.status !== "candidate_ready" ||
    typeof candidate?.id !== "string" ||
    typeof candidate.prompt !== "string" ||
    !candidateCase ||
    !baselineCase ||
    candidateCase.input !== metadata.input ||
    baselineCase.input !== metadata.input ||
    !configuredCase ||
    evaluationEvents.length !== 2 ||
    !candidateEvaluation ||
    !baselineEvaluation
  ) {
    return null;
  }

  const criterion = configuredCase.verification ?? null;
  const candidateEvidence = asRecord(candidateCase.verificationEvidence);
  const baselineEvidence = asRecord(baselineCase.verificationEvidence);
  const candidateOutcome = criterion ? candidateEvidence?.status : "not_scored";
  const baselineOutcome = criterion ? baselineEvidence?.status : "not_scored";
  if (criterion && candidateOutcome !== "passed") return null;

  return createRecord(input.gate, {
    projectId: input.run.projectId,
    experimentId: input.run.id,
    runId: input.run.id,
    task: metadata.input,
    strategy: {
      arm: metadata.arm,
      retrievalStrategy: metadata.retrieval.strategy,
      candidateId: candidate.id,
      candidatePrompt: candidate.prompt,
    },
    scope: {
      datasetName: metadata.datasetName,
      datasetVersion: metadata.datasetVersion,
      split: metadata.split,
      cases: [
        { id: metadata.caseId, split: metadata.split, input: metadata.input },
      ],
    },
    constraints: {
      promptId: metadata.promptId,
      promptVersionId: metadata.promptVersionId,
      promptVersion: metadata.promptVersion,
      requestedModel: metadata.requestedModel,
      reasoningEffort: metadata.reasoningEffort,
      retrieval: metadata.retrieval,
      sourceIds: metadata.sources.map((source) => source.id),
    },
    evaluationProvenance: {
      mode: "pilot",
      runId: input.run.id,
      attemptId: completion.attemptId,
      completionSequence: completion.sequence,
      evaluationSequences: evaluationEvents.map((event) => event.sequence),
      manifestHash: null,
      status: "succeeded",
    },
    sourceVersionManifest: input.gate.sourceVersionManifest,
    successConditions: [
      {
        arm: metadata.arm,
        caseId: metadata.caseId,
        split: metadata.split,
        subject: "baseline",
        criterion,
        outcome:
          typeof baselineOutcome === "string" ? baselineOutcome : "not_scored",
        judgment: null,
        evidenceSequence: baselineEvaluation.sequence,
      },
      {
        arm: metadata.arm,
        caseId: metadata.caseId,
        split: metadata.split,
        subject: "candidate",
        criterion,
        outcome:
          typeof candidateOutcome === "string"
            ? candidateOutcome
            : "not_scored",
        judgment: null,
        evidenceSequence: candidateEvaluation.sequence,
      },
    ],
  });
}

export function createControlledEvaluationVerifiedMemory(input: {
  gate: VerifiedMemoryGate;
  run: MemoryRun;
  metadata: unknown;
  events: readonly StoredExperimentEvent[];
}): VerifiedMemoryRecord | null {
  const parsedMetadata = ControlledEvaluationRequestSchema.safeParse(
    input.metadata,
  );
  const expectedManifest = parsedMetadata.success
    ? sourceManifestForExperiment(parsedMetadata.data)
    : null;
  if (
    !parsedMetadata.success ||
    !expectedManifest ||
    !sameJson(input.gate.sourceVersionManifest, expectedManifest) ||
    input.run.status !== "succeeded"
  ) {
    return null;
  }
  const metadata = parsedMetadata.data;
  const completion = scopedEvents(input.run, input.events)
    .filter((event) => event.eventType === "run.completed")
    .at(-1);
  const completionPayload = asRecord(completion?.payload);
  const reportResult = ControlledEvaluationReportSchema.safeParse(
    completionPayload?.controlledEvaluation,
  );
  if (
    !completion ||
    !completion.attemptId ||
    !completionPayload ||
    completionPayload.status !== "succeeded" ||
    completionPayload.mode !== "controlled_evaluation" ||
    !reportResult.success ||
    reportResult.data.status !== "complete" ||
    reportResult.data.runId !== input.run.id ||
    reportResult.data.attemptId !== completion.attemptId
  ) {
    return null;
  }

  const report = reportResult.data;
  const successConditions = report.pairs.map((pair) => {
    const testCase = metadata.cases.find((item) => item.id === pair.caseId);
    const criterion = testCase?.verification ?? null;
    const evidence = asRecord(pair.candidate.verificationEvidence);
    const outcome = criterion ? evidence?.status : "not_scored";
    return {
      arm: pair.arm,
      caseId: pair.caseId,
      split: pair.split,
      subject: "candidate" as const,
      criterion,
      outcome: typeof outcome === "string" ? outcome : "not_scored",
      judgment: pair.judgment,
      evidenceSequence: completion.sequence,
    };
  });
  if (
    successConditions.length === 0 ||
    successConditions.some(
      (condition) =>
        condition.criterion !== null && condition.outcome !== "passed",
    )
  ) {
    return null;
  }

  return createRecord(input.gate, {
    projectId: input.run.projectId,
    experimentId: input.run.id,
    runId: input.run.id,
    task: metadata.cases.map((testCase) => testCase.input).join("\n\n"),
    strategy: {
      baselinePromptVersionId: metadata.baselinePromptVersionId,
      baselinePromptHash: metadata.baselinePromptHash,
      candidatePromptVersionId: metadata.candidatePromptVersionId,
      candidatePromptHash: metadata.candidatePromptHash,
      arms: metadata.arms.map((arm) => ({
        arm: arm.arm,
        requestedModel: arm.requestedModel,
        reasoningEffort: arm.reasoningEffort,
        retrieval: arm.retrieval,
        sourceIds: arm.sources.map((source) => source.documentId),
      })),
    },
    scope: {
      datasetName: metadata.datasetName,
      datasetVersion: metadata.datasetVersion,
      cases: metadata.cases.map((testCase) => ({
        id: testCase.id,
        split: testCase.split,
        input: testCase.input,
      })),
    },
    constraints: {
      promptId: metadata.promptId,
      baselinePromptVersionId: metadata.baselinePromptVersionId,
      baselinePromptHash: metadata.baselinePromptHash,
      candidatePromptVersionId: metadata.candidatePromptVersionId,
      candidatePromptHash: metadata.candidatePromptHash,
      requestedModels: [
        ...new Set(metadata.arms.map((arm) => arm.requestedModel)),
      ],
      reasoningEfforts: [
        ...new Set(metadata.arms.map((arm) => arm.reasoningEffort)),
      ],
    },
    evaluationProvenance: {
      mode: "controlled_evaluation",
      runId: input.run.id,
      attemptId: completion.attemptId,
      completionSequence: completion.sequence,
      evaluationSequences: [completion.sequence],
      manifestHash: report.manifest.manifestHash,
      status: "complete",
    },
    sourceVersionManifest: input.gate.sourceVersionManifest,
    successConditions,
  });
}

type VerifiedMemoryMetadata =
  ExperimentPilotMetadata | ControlledEvaluationRequest;
type VerifiedMemoryAcceptanceRun = MemoryRun & ExperimentAcceptanceRun;

export function projectVerifiedMemoryForRuntime(
  memory: VerifiedMemoryRecord,
  metadata: VerifiedMemoryMetadata,
): VerifiedMemoryRuntimeProjection {
  const cases =
    "cases" in metadata
      ? metadata.cases
      : [
          {
            id: metadata.caseId,
            split: "development" as const,
            input: metadata.input,
          },
        ];
  const developmentCases = cases.filter(
    (testCase) => testCase.split === "development",
  );
  return {
    format: "promptlab-verified-memory-runtime-v1",
    status: memory.status,
    memoryId: memory.memoryId,
    projectId: memory.projectId,
    experimentId: memory.experimentId,
    runId: memory.runId,
    acceptedDecisionSequence: memory.acceptedDecisionSequence,
    acceptedAt: memory.acceptedAt,
    task: developmentCases.map((testCase) => testCase.input).join("\n\n"),
    strategy: memory.strategy,
    scope: {
      datasetName: metadata.datasetName,
      datasetVersion: metadata.datasetVersion,
      cases: developmentCases.map((testCase) => ({
        id: testCase.id,
        split: "development" as const,
      })),
    },
    constraints: memory.constraints,
    evaluationProvenance: memory.evaluationProvenance,
    sourceVersionManifest: memory.sourceVersionManifest,
    successConditions: memory.successConditions
      .filter((condition) => condition.split === "development")
      .map((condition) => {
        const criterion = asRecord(condition.criterion);
        return {
          arm: condition.arm,
          caseId: condition.caseId,
          split: "development",
          subject: condition.subject,
          verificationKind:
            typeof criterion?.kind === "string" ? criterion.kind : null,
          outcome: condition.outcome,
          judgment: condition.judgment,
          evidenceSequence: condition.evidenceSequence,
        };
      }),
    interpretation: memory.interpretation,
  };
}

function queryTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

function taskRelevance(task: string, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const taskTerms = new Set(queryTerms(task));
  const matched = terms.filter((term) => taskTerms.has(term)).length;
  if (matched === 0) return 0;
  const normalizedTask = task.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const exactPhrase = normalizedTask.includes(normalizedQuery) ? 1 : 0;
  return exactPhrase + matched / terms.length;
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.min(DEFAULT_VERIFIED_MEMORY_LIMIT, maximum);
  }
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

async function loadEligibleVerifiedMemories(
  db: Database,
  projectId: string,
): Promise<{
  entries: Array<{
    record: VerifiedMemoryRecord;
    runtime: VerifiedMemoryRuntimeProjection;
  }>;
  truncated: boolean;
}> {
  const markerRows = await db
    .select({
      projectId: schema.runEvents.projectId,
      runId: schema.runEvents.runId,
      sequence: schema.runEvents.sequence,
      createdAt: schema.runEvents.createdAt,
      payload: schema.runEvents.payload,
    })
    .from(schema.runEvents)
    .where(
      and(
        eq(schema.runEvents.projectId, projectId),
        eq(schema.runEvents.eventType, "experiment.created"),
      ),
    )
    .orderBy(desc(schema.runEvents.createdAt))
    .limit(MAX_VERIFIED_MEMORY_MARKERS + 1);
  const markerScanTruncated = markerRows.length > MAX_VERIFIED_MEMORY_MARKERS;
  const scopedMarkerRows = markerRows
    .slice(0, MAX_VERIFIED_MEMORY_MARKERS)
    .filter(
      (marker) =>
        marker.projectId === projectId &&
        Number.isInteger(marker.sequence) &&
        marker.sequence > 0,
    );
  const firstMarkerByRun = new Map<string, (typeof scopedMarkerRows)[number]>();
  for (const marker of [...scopedMarkerRows].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    const prior = firstMarkerByRun.get(marker.runId);
    if (!prior || marker.sequence < prior.sequence) {
      firstMarkerByRun.set(marker.runId, marker);
    }
  }
  const runIds = [...firstMarkerByRun.keys()];
  if (runIds.length === 0) {
    return { entries: [], truncated: markerScanTruncated };
  }

  const [runRows, eventRows] = await Promise.all([
    db
      .select({
        id: schema.runs.id,
        projectId: schema.runs.projectId,
        status: schema.runs.status,
        promptVersionId: schema.runs.promptVersionId,
        provider: schema.runs.provider,
        purpose: schema.runs.purpose,
        requestedModel: schema.runs.requestedModel,
        configSnapshot: schema.runs.configSnapshot,
      })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, projectId),
          inArray(schema.runs.id, runIds),
        ),
      ),
    db
      .select({
        projectId: schema.runEvents.projectId,
        runId: schema.runEvents.runId,
        attemptId: schema.runEvents.attemptId,
        sequence: schema.runEvents.sequence,
        eventType: schema.runEvents.eventType,
        payload: schema.runEvents.payload,
      })
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.projectId, projectId),
          inArray(schema.runEvents.runId, runIds),
        ),
      )
      .orderBy(asc(schema.runEvents.sequence))
      .limit(MAX_VERIFIED_MEMORY_EVENTS + 1),
  ]);
  if (eventRows.length > MAX_VERIFIED_MEMORY_EVENTS) {
    return { entries: [], truncated: true };
  }

  const scopedRunRows = runRows.filter(
    (run) => run.projectId === projectId && firstMarkerByRun.has(run.id),
  );
  const runById = new Map(scopedRunRows.map((run) => [run.id, run]));
  const scopedEvents = eventRows.filter(
    (event) =>
      event.projectId === projectId &&
      firstMarkerByRun.has(event.runId) &&
      Number.isInteger(event.sequence) &&
      event.sequence > 0,
  );
  const eventsByRun = new Map<string, StoredExperimentEvent[]>();
  const latestDecisionByRun = new Map<string, (typeof scopedEvents)[number]>();
  for (const event of scopedEvents) {
    const runEvents = eventsByRun.get(event.runId) ?? [];
    runEvents.push(event);
    eventsByRun.set(event.runId, runEvents);
    if (event.eventType === "experiment.decision") {
      const prior = latestDecisionByRun.get(event.runId);
      if (!prior || event.sequence > prior.sequence) {
        latestDecisionByRun.set(event.runId, event);
      }
    }
  }

  const controlledPromptIds = [
    ...new Set(
      [...firstMarkerByRun.values()].flatMap((marker) =>
        controlledEvaluationPromptVersionIds(
          asRecord(marker.payload)?.metadata,
        ),
      ),
    ),
  ];
  const promptRows = controlledPromptIds.length
    ? await db
        .select({
          projectId: schema.promptVersions.projectId,
          id: schema.promptVersions.id,
          text: schema.promptVersions.text,
        })
        .from(schema.promptVersions)
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            inArray(schema.promptVersions.id, controlledPromptIds),
          ),
        )
    : [];
  const promptById = new Map(
    promptRows
      .filter((prompt) => prompt.projectId === projectId)
      .map((prompt) => [prompt.id, prompt.text]),
  );

  const entries: Array<{
    record: VerifiedMemoryRecord;
    runtime: VerifiedMemoryRuntimeProjection;
  }> = [];
  for (const [runId, marker] of firstMarkerByRun) {
    const run = runById.get(runId) as VerifiedMemoryAcceptanceRun | undefined;
    const latestDecision = latestDecisionByRun.get(runId);
    const markerPayload = asRecord(marker.payload);
    const decisionPayload = asRecord(latestDecision?.payload);
    if (
      !run ||
      run.projectId !== projectId ||
      !latestDecision ||
      latestDecision.projectId !== projectId ||
      latestDecision.runId !== runId ||
      !markerPayload ||
      !decisionPayload ||
      decisionPayload.decision !== "accepted"
    ) {
      continue;
    }

    const memory = parseVerifiedMemoryRecord(decisionPayload.verifiedMemory);
    if (
      !memory ||
      memory.projectId !== projectId ||
      memory.runId !== run.id ||
      memory.experimentId !== marker.runId ||
      memory.acceptedDecisionSequence !== latestDecision.sequence ||
      memory.acceptedAt !== decisionPayload.decidedAt
    ) {
      continue;
    }

    const events = eventsByRun.get(runId) ?? [];
    const controlledMetadata = parseStoredControlledEvaluationMetadata(
      markerPayload.metadata,
    );
    let metadata: VerifiedMemoryMetadata;
    let eligible: boolean;
    if (controlledMetadata) {
      if (memory.evaluationProvenance.mode !== "controlled_evaluation") {
        continue;
      }
      metadata = controlledMetadata;
      eligible = hasControlledEvaluationAcceptanceEvidence({
        experimentId: runId,
        run,
        markerMetadata: controlledMetadata,
        events,
        baselinePrompt:
          promptById.get(controlledMetadata.baselinePromptVersionId) ?? "",
        candidatePrompt:
          promptById.get(controlledMetadata.candidatePromptVersionId) ?? "",
      });
    } else {
      const pilotMetadata = parseStoredExperimentPilotMetadata(
        markerPayload.metadata,
      );
      if (
        !pilotMetadata ||
        pilotMetadata.legacy ||
        memory.evaluationProvenance.mode !== "pilot"
      ) {
        continue;
      }
      metadata = pilotMetadata.metadata;
      eligible = hasExperimentAcceptanceEvidence({
        projectId,
        experimentId: runId,
        run,
        metadata: pilotMetadata.metadata,
        events,
      });
    }
    if (!eligible || !verifiedMemoryMatchesMetadata(memory, metadata)) {
      continue;
    }

    const sourcesCurrent = await isVerifiedMemorySourceManifestCurrent(
      db,
      projectId,
      memory.sourceVersionManifest,
    );
    if (!sourcesCurrent) continue;
    const gate: VerifiedMemoryGate = {
      decision: "accepted",
      evaluationEligible: eligible,
      sourceVersionsCurrent: sourcesCurrent,
      acceptedDecisionSequence: latestDecision.sequence,
      acceptedAt: memory.acceptedAt,
      sourceVersionManifest: memory.sourceVersionManifest,
    };
    const memoryInput = { gate, run, metadata, events };
    const derivedMemory = controlledMetadata
      ? createControlledEvaluationVerifiedMemory(memoryInput)
      : createPilotVerifiedMemory(memoryInput);
    if (
      !derivedMemory ||
      !verifiedMemoryMatchesDerivedRecord(memory, derivedMemory)
    ) {
      continue;
    }
    entries.push({
      record: memory,
      runtime: projectVerifiedMemoryForRuntime(memory, metadata),
    });
  }

  return {
    entries,
    truncated: markerScanTruncated,
  };
}

/**
 * Rebuilds eligibility from project-scoped events before returning any memory.
 * The default runtime audience is redacted; evaluator export requires an
 * explicit audience option.
 */
export function listVerifiedMemories(
  db: Database,
  input: VerifiedMemoryListInput & { audience: "evaluator" },
): Promise<VerifiedMemoryListResult<VerifiedMemoryRecord>>;
export function listVerifiedMemories(
  db: Database,
  input: VerifiedMemoryListInput & { audience?: "runtime" },
): Promise<VerifiedMemoryListResult<VerifiedMemoryRuntimeProjection>>;
export async function listVerifiedMemories(
  db: Database,
  input: VerifiedMemoryListInput & { audience?: "runtime" | "evaluator" },
): Promise<
  | VerifiedMemoryListResult<VerifiedMemoryRecord>
  | VerifiedMemoryListResult<VerifiedMemoryRuntimeProjection>
> {
  const audience = input.audience ?? "runtime";
  const query =
    typeof input.query === "string"
      ? input.query.trim().slice(0, MAX_VERIFIED_MEMORY_QUERY_LENGTH)
      : "";
  const maximum =
    audience === "evaluator"
      ? MAX_VERIFIED_MEMORY_EXPORT_LIMIT
      : MAX_VERIFIED_MEMORY_RUNTIME_LIMIT;
  const limit = boundedLimit(input.limit, maximum);
  const loaded = await loadEligibleVerifiedMemories(db, input.projectId);
  const matching = loaded.entries
    .filter(
      ({ record }) => !input.memoryId || record.memoryId === input.memoryId,
    )
    .map((entry) => ({
      ...entry,
      relevance: query ? taskRelevance(entry.runtime.task, query) : 0,
    }))
    .filter((entry) => !query || entry.relevance > 0)
    .sort((left, right) => {
      if (query && left.relevance !== right.relevance) {
        return right.relevance - left.relevance;
      }
      const byDate =
        left.record.acceptedAt < right.record.acceptedAt
          ? 1
          : left.record.acceptedAt > right.record.acceptedAt
            ? -1
            : 0;
      return (
        byDate || left.record.memoryId.localeCompare(right.record.memoryId)
      );
    });
  const selected = matching.slice(0, limit);
  return {
    memories:
      audience === "evaluator"
        ? selected.map(({ record }) => record)
        : selected.map(({ runtime }) => runtime),
    truncated: loaded.truncated || matching.length > limit,
  } as
    | VerifiedMemoryListResult<VerifiedMemoryRecord>
    | VerifiedMemoryListResult<VerifiedMemoryRuntimeProjection>;
}

function sortRecords(
  records: readonly VerifiedMemoryRecord[],
): VerifiedMemoryRecord[] {
  return [...records].sort((left, right) => {
    const byDate =
      left.acceptedAt < right.acceptedAt
        ? -1
        : left.acceptedAt > right.acceptedAt
          ? 1
          : 0;
    if (byDate !== 0) return byDate;
    return left.memoryId < right.memoryId
      ? -1
      : left.memoryId > right.memoryId
        ? 1
        : 0;
  });
}

function anchorFor(memory: VerifiedMemoryRecord): string {
  return `memory-${memory.memoryId.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`;
}

function markdownCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r?\n/g, "<br>");
}

function codeFenceFor(value: string): string {
  const longest = Math.max(
    0,
    ...(value.match(/`+/g) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(value: string, language = ""): string {
  const fence = codeFenceFor(value);
  return `${fence}${language}\n${value}\n${fence}`;
}

function inlineCode(value: string): string {
  const fence = codeFenceFor(value);
  return `${fence}${value}${fence}`;
}

function eventCitation(
  memory: VerifiedMemoryRecord,
  sequence: number,
  label: string,
  baseUrl: string,
): string {
  const eventApi = `${baseUrl}/api/projects/${memory.projectId}/runs/${memory.runId}/events?after=${sequence - 1}`;
  return `[${label}](${eventApi})`;
}

function renderLesson(memory: VerifiedMemoryRecord, baseUrl: string): string[] {
  const lines = [
    `<a id="${anchorFor(memory)}"></a>`,
    `## Experiment-scoped record ${memory.experimentId}`,
    "",
    `Decision: accepted at ${memory.acceptedAt} (${eventCitation(memory, memory.acceptedDecisionSequence, `decision event ${memory.acceptedDecisionSequence}`, baseUrl)}).`,
    "",
    "### Task",
    "",
    fenced(memory.task),
    "",
    "### Strategy",
    "",
    fenced(JSON.stringify(memory.strategy, null, 2), "json"),
    "",
    "### Scope",
    "",
    fenced(JSON.stringify(memory.scope, null, 2), "json"),
    "",
    "### Constraints",
    "",
    fenced(JSON.stringify(memory.constraints, null, 2), "json"),
    "",
    "### Recorded success conditions",
    "",
  ];
  for (const condition of memory.successConditions) {
    const criterion =
      condition.criterion === null
        ? "No structured verifier configured"
        : `Configured criterion: ${inlineCode(JSON.stringify(condition.criterion))}`;
    lines.push(
      `- ${condition.subject} / ${condition.arm ?? "unspecified arm"} / ${markdownCell(condition.caseId)} (${condition.split}): ${markdownCell(condition.outcome)}; ${criterion}; judgment: ${markdownCell(condition.judgment ?? "not recorded")}; ${eventCitation(memory, condition.evidenceSequence, `evidence event ${condition.evidenceSequence}`, baseUrl)}.`,
    );
  }
  lines.push(
    "",
    "### Evaluation provenance",
    "",
    `- Mode: ${memory.evaluationProvenance.mode}; status: ${memory.evaluationProvenance.status}; attempt: ${memory.evaluationProvenance.attemptId}.`,
    `- Completion: ${eventCitation(memory, memory.evaluationProvenance.completionSequence, `event ${memory.evaluationProvenance.completionSequence}`, baseUrl)}.`,
    `- Evaluation events: ${memory.evaluationProvenance.evaluationSequences.map((sequence) => eventCitation(memory, sequence, `event ${sequence}`, baseUrl)).join(", ")}.`,
    `- Manifest hash: ${memory.evaluationProvenance.manifestHash ?? "not recorded"}.`,
    "",
    "### Source versions",
    "",
  );
  if (memory.sourceVersionManifest.sources.length === 0) {
    lines.push("- No external source versions were selected.");
  } else {
    lines.push(
      "| Source | Version | Version ID | Checksum |",
      "| --- | ---: | --- | --- |",
    );
    for (const source of memory.sourceVersionManifest.sources) {
      const sourceUrl = `${baseUrl}/api/projects/${memory.projectId}/memory/citations/${source.documentId}/versions/${source.documentVersionId}?checksum=${encodeURIComponent(source.checksum)}`;
      lines.push(
        `| [${source.documentId}](${sourceUrl}) | ${source.documentVersion} | ${source.documentVersionId} | ${markdownCell(source.checksum)} |`,
      );
    }
  }
  lines.push("", `> ${memory.interpretation}`, "");
  return lines;
}

export function renderVerifiedMemoryWiki(
  records: readonly VerifiedMemoryRecord[],
  options: { baseUrl?: string } = {},
): string {
  const sorted = sortRecords(records);
  const baseUrl = (options.baseUrl ?? "http://localhost").replace(/\/+$/u, "");
  const lines = [
    "# PromptLab verified memory evaluator export",
    "",
    "> Evaluator-facing export of experiment records that remain eligible at export time. It may contain held-out inputs and private verification criteria; keep it out of optimizer and target prompts. Acceptance does not establish general truth.",
    "",
    "## Index",
    "",
  ];
  if (sorted.length === 0) {
    lines.push("No currently eligible verified experiment memories.", "");
  } else {
    lines.push(
      "| Accepted | Task | Lesson | Experiment | Evaluation |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const memory of sorted) {
      lines.push(
        `| ${markdownCell(memory.acceptedAt)} | ${markdownCell(memory.task)} | [Open lesson](#${anchorFor(memory)}) | ${memory.experimentId} | ${memory.evaluationProvenance.mode} / ${memory.evaluationProvenance.status} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Decision log", "");
  if (sorted.length === 0) {
    lines.push("No currently eligible decision records.", "");
  } else {
    for (const memory of sorted) {
      lines.push(
        `- ${memory.acceptedAt}: accepted experiment ${memory.experimentId}; ${eventCitation(memory, memory.acceptedDecisionSequence, `decision event ${memory.acceptedDecisionSequence}`, baseUrl)}; evaluation ${memory.evaluationProvenance.mode} (${memory.evaluationProvenance.status}).`,
      );
    }
    lines.push("");
  }

  lines.push("## Lessons", "");
  for (const memory of sorted) lines.push(...renderLesson(memory, baseUrl));
  return `${lines.join("\n")}\n`;
}
