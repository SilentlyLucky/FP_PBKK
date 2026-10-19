import { createHash } from "node:crypto";

import {
  ControlledEvaluationRequestSchema,
  type ControlledEvaluationRequest,
} from "@promptlab/contracts";

import { freezeExperimentSchedule } from "../../src/index.js";
import {
  KNOWLEDGE_DEVELOPMENT_CASES,
  KNOWLEDGE_HOLDOUT_CASES,
  type KnowledgeIntegrationFixtureCase,
} from "./cases.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

const sourceReference = (
  source: KnowledgeIntegrationFixtureCase["frozenSources"][number],
) =>
  `${source.scopeId}:${source.sourceId}@${source.versionId}#${source.chunkId}`;

function freezeFixtureSplit(
  split: "development" | "holdout",
  cases: readonly KnowledgeIntegrationFixtureCase[],
) {
  const datasetBody = cases.map((fixture) => ({
    caseId: fixture.caseId,
    input: fixture.input,
    scopeId: fixture.scopeId,
    taskFamily: fixture.taskFamily,
    oracleJustification: fixture.oracleJustification,
    gold: fixture.gold,
    frozenSources: fixture.frozenSources,
  }));
  const sourceIds = [
    ...new Set(
      cases.flatMap((fixture) => fixture.frozenSources.map(sourceReference)),
    ),
  ].sort();
  const sourceManifestHash = sha256(
    canonicalJson(
      cases
        .flatMap((fixture) => fixture.frozenSources)
        .map((source) => ({
          identity: sourceReference(source),
          text: source.text,
        })),
    ),
  );
  const noCallPolicyHash = sha256(
    "fixture manifest only; no provider or target calls",
  );

  return freezeExperimentSchedule({
    projectId: "synthetic-knowledge-fixtures",
    datasetId: "knowledge-integration",
    datasetVersionId: `flow0-${split}-20261019-${split === "development" ? "v3" : "v2"}`,
    datasetVersionHash: sha256(
      canonicalJson({
        format: "knowledge-fixture-v2",
        split,
        cases: datasetBody,
      }),
    ),
    split,
    cases: cases.map((fixture) => ({
      caseId: fixture.caseId,
      inputHash: sha256(fixture.input),
      split: fixture.split,
      sourceIds: fixture.frozenSources.map(sourceReference),
    })),
    repeats: 1,
    promptVersionId: "fixture-contract-only-no-run",
    promptHash: sha256("Flow 0 fixture contract; no prompt was executed"),
    target: {
      provider: "offline_fixture",
      requestedModel: "contract-only-no-call",
      reasoningEffort: null,
      policyHash: noCallPolicyHash,
    },
    retrieval: {
      sourceIds,
      sourceManifestHash,
      graphSnapshotId: null,
    },
    ...(split === "holdout" ? { holdoutEvaluationRequested: true } : {}),
  });
}

/** Offline schedules reuse the shared paired helper; they never execute target calls. */
export const KNOWLEDGE_FIXTURE_MANIFESTS = {
  development: freezeFixtureSplit("development", KNOWLEDGE_DEVELOPMENT_CASES),
  holdout: freezeFixtureSplit("holdout", KNOWLEDGE_HOLDOUT_CASES),
} as const;

const SHARD_SPECS = [
  { shardId: "knowledge-shard-1", development: 7, holdout: 13 },
  { shardId: "knowledge-shard-2", development: 7, holdout: 13 },
  { shardId: "knowledge-shard-3", development: 6, holdout: 14 },
] as const;

export interface KnowledgeControlledShardCaseReference {
  caseId: string;
  split: "development" | "holdout";
  inputHash: string;
  sourceIds: string[];
}

export interface KnowledgeControlledShardManifest {
  schemaVersion: "promptlab-knowledge-controlled-shard-v1";
  shardId: (typeof SHARD_SPECS)[number]["shardId"];
  datasetName: string;
  datasetVersion: string;
  datasetVersionHash: string;
  splitCounts: { development: number; holdout: number };
  cases: KnowledgeControlledShardCaseReference[];
  request: ControlledEvaluationRequest;
  requestId: string;
  membershipHash: string;
  requestHash: string;
  sourceManifestHash: string;
  provenance: {
    corpusStatus: "synthetic_unreviewed";
    generatedBy: "evals/fixtures/knowledge-integration/manifest.ts";
    targetExecution: "not_run";
  };
  manifestHash: string;
}

function sourceEntries(cases: readonly KnowledgeIntegrationFixtureCase[]) {
  const byIdentity = new Map<string, string>();
  for (const fixture of cases) {
    for (const source of fixture.frozenSources) {
      const identity = sourceReference(source);
      const previous = byIdentity.get(identity);
      if (previous !== undefined && previous !== source.text)
        throw new Error(
          `Conflicting frozen text for source identity: ${identity}`,
        );
      byIdentity.set(identity, source.text);
    }
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, text]) => ({ identity, text }));
}

function requestForCases(
  cases: readonly KnowledgeIntegrationFixtureCase[],
): ControlledEvaluationRequest {
  const promptHash = (text: string) => sha256(text);
  return ControlledEvaluationRequestSchema.parse({
    mode: "controlled_evaluation",
    format: "promptlab-controlled-evaluation-v1",
    datasetName: "Knowledge Integration Synthetic Fixtures",
    datasetVersion: "flow0-20261019-v3",
    promptId: "44444444-4444-4444-8444-444444444444",
    baselinePromptVersionId: "55555555-5555-4555-8555-555555555555",
    baselinePromptHash: promptHash("Flow 0 baseline placeholder; no calls"),
    candidatePromptVersionId: "66666666-6666-4666-8666-666666666666",
    candidatePromptHash: promptHash("Flow 0 candidate placeholder; no calls"),
    cases: cases.map((fixture) => ({
      id: fixture.caseId,
      split: fixture.split,
      input: fixture.input,
    })),
    arms: [
      { arm: "original", strategy: "lexical" },
      { arm: "rag", strategy: "lexical" },
      { arm: "graphrag", strategy: "graph" },
    ].map(({ arm, strategy }) => ({
      arm,
      provider: "codex_app_server",
      requestedModel: "contract-only-no-call",
      reasoningEffort: null,
      retrieval: { strategy, sourceIds: [], snapshotId: null },
      sources: [],
    })),
  });
}

/**
 * Build the three mixed-split request manifests accepted by the existing
 * controlled-evaluation contract. Request cases contain inputs plus the
 * schema-required ID and split; evaluator labels, gold annotations, and source
 * text stay in the fixture corpus.
 */
export function buildKnowledgeControlledShardManifests(): KnowledgeControlledShardManifest[] {
  if (
    KNOWLEDGE_DEVELOPMENT_CASES.length !== 20 ||
    KNOWLEDGE_HOLDOUT_CASES.length !== 40
  )
    throw new Error(
      "Knowledge fixture corpus must contain exactly 20/40 cases.",
    );

  const datasetVersionHash = sha256(
    canonicalJson({
      format: "knowledge-integration-dataset-v2",
      development: KNOWLEDGE_FIXTURE_MANIFESTS.development.datasetVersionHash,
      holdout: KNOWLEDGE_FIXTURE_MANIFESTS.holdout.datasetVersionHash,
    }),
  );
  const datasetName = "Knowledge Integration Synthetic Fixtures";
  const datasetVersion = "flow0-20261019-v3";
  let developmentOffset = 0;
  let holdoutOffset = 0;

  const shards = SHARD_SPECS.map((spec): KnowledgeControlledShardManifest => {
    const developmentCases = KNOWLEDGE_DEVELOPMENT_CASES.slice(
      developmentOffset,
      developmentOffset + spec.development,
    );
    const holdoutCases = KNOWLEDGE_HOLDOUT_CASES.slice(
      holdoutOffset,
      holdoutOffset + spec.holdout,
    );
    developmentOffset += spec.development;
    holdoutOffset += spec.holdout;
    if (
      developmentCases.length !== spec.development ||
      holdoutCases.length !== spec.holdout
    )
      throw new Error(`Fixture membership is incomplete for ${spec.shardId}.`);

    const selectedCases = [...developmentCases, ...holdoutCases];
    const request = requestForCases(selectedCases);
    const cases = selectedCases.map((fixture) => ({
      caseId: fixture.caseId,
      split: fixture.split,
      inputHash: sha256(fixture.input),
      sourceIds: [
        ...new Set(fixture.frozenSources.map(sourceReference)),
      ].sort(),
    }));
    const membershipHash = sha256(canonicalJson(cases));
    const requestHash = sha256(canonicalJson(request));
    const requestId = `${spec.shardId}:${requestHash.slice(0, 16)}`;
    const sourceManifestHash = sha256(
      canonicalJson(sourceEntries(selectedCases)),
    );
    const body = {
      schemaVersion: "promptlab-knowledge-controlled-shard-v1" as const,
      shardId: spec.shardId,
      datasetName,
      datasetVersion,
      datasetVersionHash,
      splitCounts: {
        development: developmentCases.length,
        holdout: holdoutCases.length,
      },
      cases,
      request,
      requestId,
      membershipHash,
      requestHash,
      sourceManifestHash,
      provenance: {
        corpusStatus: "synthetic_unreviewed" as const,
        generatedBy:
          "evals/fixtures/knowledge-integration/manifest.ts" as const,
        targetExecution: "not_run" as const,
      },
    };
    return {
      ...body,
      manifestHash: sha256(canonicalJson(body)),
    };
  });

  if (developmentOffset !== 20 || holdoutOffset !== 40)
    throw new Error("Shard allocation must cover all 20/40 fixture cases.");
  return shards;
}

export const KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS =
  buildKnowledgeControlledShardManifests();

export type KnowledgeShardExecutionRecord =
  | {
      shardId: string;
      status: "completed";
      runId: string;
      reportHash: string;
    }
  | {
      shardId: string;
      status: "failed";
      runId: string | null;
      failureCode: string;
    };

export interface KnowledgeShardStatusAggregate {
  schemaVersion: "promptlab-knowledge-shard-status-aggregate-v1";
  aggregationVersion: "status-only-v1";
  datasetVersionHash: string;
  status: "incomplete" | "all_shards_complete";
  plannedShardCount: number;
  completedShardCount: number;
  missingShardIds: string[];
  missingShards: Array<{ shardId: string; requestId: string }>;
  failedShards: Array<{
    shardId: string;
    requestId: string;
    runId: string | null;
    failureCode: string;
  }>;
  completedShards: Array<{
    shardId: string;
    requestId: string;
    runId: string;
    reportHash: string;
  }>;
  scores: null;
  liveScoreClaims: false;
  aggregateHash: string;
}

/** Record shard receipt/failure only; scored reports remain with the shared evaluator. */
export function aggregateKnowledgeShardStatuses(
  records: readonly KnowledgeShardExecutionRecord[],
  shards: readonly KnowledgeControlledShardManifest[] = KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS,
): KnowledgeShardStatusAggregate {
  const plannedIds = new Set<string>(shards.map((shard) => shard.shardId));
  if (plannedIds.size !== shards.length)
    throw new Error("Shard manifest IDs must be unique.");
  if (new Set(shards.map((shard) => shard.datasetVersionHash)).size > 1)
    throw new Error("Shard manifests must use one dataset version hash.");
  const byId = new Map<string, KnowledgeShardExecutionRecord>();
  for (const record of records) {
    if (!plannedIds.has(record.shardId))
      throw new Error(`Unknown shard status: ${record.shardId}`);
    if (byId.has(record.shardId))
      throw new Error(`Duplicate shard status: ${record.shardId}`);
    if (
      record.status === "completed" &&
      (!record.runId.trim() || !/^[a-f0-9]{64}$/u.test(record.reportHash))
    )
      throw new Error(
        "Completed shards require a run ID and SHA-256 report hash.",
      );
    if (record.status === "failed" && !record.failureCode.trim())
      throw new Error("Failed shards require a failure code.");
    byId.set(record.shardId, record);
  }

  const missingShardIds = shards
    .filter((shard) => !byId.has(shard.shardId))
    .map((shard) => shard.shardId);
  const missingShards = shards
    .filter((shard) => !byId.has(shard.shardId))
    .map(({ shardId, requestId }) => ({ shardId, requestId }));
  const failedShards = records
    .filter(
      (
        record,
      ): record is Extract<
        KnowledgeShardExecutionRecord,
        { status: "failed" }
      > => record.status === "failed",
    )
    .map(({ shardId, runId, failureCode }) => ({
      shardId,
      requestId: shards.find((shard) => shard.shardId === shardId)!.requestId,
      runId,
      failureCode,
    }))
    .sort((left, right) => left.shardId.localeCompare(right.shardId));
  const completedShards = records
    .filter(
      (
        record,
      ): record is Extract<
        KnowledgeShardExecutionRecord,
        { status: "completed" }
      > => record.status === "completed",
    )
    .map(({ shardId, runId, reportHash }) => ({
      shardId,
      requestId: shards.find((shard) => shard.shardId === shardId)!.requestId,
      runId,
      reportHash,
    }))
    .sort((left, right) => left.shardId.localeCompare(right.shardId));
  const status: KnowledgeShardStatusAggregate["status"] =
    missingShardIds.length === 0 && failedShards.length === 0
      ? "all_shards_complete"
      : "incomplete";
  const body = {
    schemaVersion: "promptlab-knowledge-shard-status-aggregate-v1" as const,
    aggregationVersion: "status-only-v1" as const,
    datasetVersionHash: shards[0]?.datasetVersionHash ?? "",
    status,
    plannedShardCount: shards.length,
    completedShardCount: completedShards.length,
    missingShardIds,
    missingShards,
    failedShards,
    completedShards,
    scores: null,
    liveScoreClaims: false as const,
  };
  return { ...body, aggregateHash: sha256(canonicalJson(body)) };
}
