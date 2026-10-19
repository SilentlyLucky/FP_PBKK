import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlledEvaluationRequestSchema } from "@promptlab/contracts";

import { toOptimizerVisibleKnowledgeCase } from "./knowledge-evaluation.js";
import {
  aggregateKnowledgeShardStatuses,
  buildKnowledgeControlledShardManifests,
  KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS,
  type KnowledgeShardExecutionRecord,
} from "../fixtures/knowledge-integration/manifest.js";
import {
  KNOWLEDGE_DEVELOPMENT_CASES,
  KNOWLEDGE_HOLDOUT_CASES,
  KNOWLEDGE_INTEGRATION_CASES,
} from "../fixtures/knowledge-integration/cases.js";

const digest = "a".repeat(64);
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function fixtureCase(caseId: string) {
  const found = KNOWLEDGE_INTEGRATION_CASES.find(
    (item) => item.caseId === caseId,
  );
  if (!found) throw new Error(`Unknown fixture case: ${caseId}`);
  return found;
}

describe("knowledge controlled-evaluation shard manifests", () => {
  it("covers every development and holdout case exactly once in 7+13, 7+13, 6+14 shards", () => {
    expect(
      KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS.map((shard) => shard.splitCounts),
    ).toEqual([
      { development: 7, holdout: 13 },
      { development: 7, holdout: 13 },
      { development: 6, holdout: 14 },
    ]);

    const allReferences = KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS.flatMap(
      (shard) => shard.cases,
    );
    const caseIds = allReferences.map((item) => item.caseId);
    expect(caseIds).toHaveLength(60);
    expect(new Set(caseIds).size).toBe(60);
    expect(new Set(caseIds)).toEqual(
      new Set(KNOWLEDGE_INTEGRATION_CASES.map((item) => item.caseId)),
    );
    expect(
      allReferences.filter((item) => item.split === "development"),
    ).toHaveLength(20);
    expect(
      allReferences.filter((item) => item.split === "holdout"),
    ).toHaveLength(40);
    expect(KNOWLEDGE_DEVELOPMENT_CASES).toHaveLength(20);
    expect(KNOWLEDGE_HOLDOUT_CASES).toHaveLength(40);

    for (const shard of KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS) {
      const parsed = ControlledEvaluationRequestSchema.parse(shard.request);
      expect(parsed.cases).toHaveLength(20);
      expect(parsed.cases.some((item) => item.split === "development")).toBe(
        true,
      );
      expect(parsed.cases.some((item) => item.split === "holdout")).toBe(true);
      expect(parsed.cases.map((item) => item.id)).toEqual(
        shard.cases.map((item) => item.caseId),
      );
      for (const reference of shard.cases) {
        const fixture = fixtureCase(reference.caseId);
        const requestCase = parsed.cases.find(
          (item) => item.id === reference.caseId,
        );
        expect(reference.split).toBe(fixture.split);
        expect(reference.inputHash).toBe(sha256(fixture.input));
        expect(requestCase?.input).toBe(fixture.input);
        expect(reference.sourceIds).toEqual(
          [
            ...new Set(
              fixture.frozenSources.map(
                (source) =>
                  `${source.scopeId}:${source.sourceId}@${source.versionId}#${source.chunkId}`,
              ),
            ),
          ].sort(),
        );
      }
      const serializedManifest = JSON.stringify(shard);
      expect(serializedManifest).not.toContain("oracleJustification");
      expect(serializedManifest).not.toContain("exactStructuredAnswer");
      expect(serializedManifest).not.toContain("citationQuotes");
      expect(serializedManifest).not.toContain("frozenSources");
      for (const fixture of KNOWLEDGE_INTEGRATION_CASES.filter((item) =>
        shard.cases.some((reference) => reference.caseId === item.caseId),
      ))
        for (const source of fixture.frozenSources)
          expect(serializedManifest).not.toContain(source.text);
    }
  });

  it("enforces the existing 20-case cap and both-split requirement", () => {
    const request = KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS[0]!.request;
    const overLimit = {
      ...request,
      cases: [
        ...request.cases,
        {
          id: "extra-case-outside-frozen-shards",
          split: "development" as const,
          input: "This extra case must exceed the request cap.",
        },
      ],
    };
    expect(ControlledEvaluationRequestSchema.safeParse(overLimit).success).toBe(
      false,
    );
    expect(
      ControlledEvaluationRequestSchema.safeParse({
        ...request,
        cases: request.cases.filter((item) => item.split === "development"),
      }).success,
    ).toBe(false);
  });

  it("rebuilds stable membership, request, source, dataset, and manifest hashes", () => {
    const first = buildKnowledgeControlledShardManifests();
    const second = buildKnowledgeControlledShardManifests();
    expect(second).toEqual(first);
    expect(new Set(first.map((shard) => shard.requestId)).size).toBe(3);
    for (const shard of first) {
      for (const hash of [
        shard.datasetVersionHash,
        shard.membershipHash,
        shard.requestHash,
        shard.sourceManifestHash,
        shard.manifestHash,
      ])
        expect(hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(shard.provenance).toEqual({
        corpusStatus: "synthetic_unreviewed",
        generatedBy: "evals/fixtures/knowledge-integration/manifest.ts",
        targetExecution: "not_run",
      });
    }
  });

  it("keeps case IDs, split labels, gold, and source evidence out of optimizer projection", () => {
    for (const shard of KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS) {
      for (const requestCase of shard.request.cases) {
        const fixture = fixtureCase(requestCase.id);
        const visible = toOptimizerVisibleKnowledgeCase({
          caseId: requestCase.id,
          input: requestCase.input,
          split: requestCase.split,
          scopeId: fixture.scopeId,
          gold: fixture.gold,
          oracleJustification: fixture.oracleJustification,
          frozenSources: fixture.frozenSources,
        });
        expect(visible).toEqual({
          input: requestCase.input,
          scopeId: fixture.scopeId,
        });
        const serialized = JSON.stringify(visible);
        expect(serialized).not.toContain(requestCase.id);
        expect(serialized).not.toContain(requestCase.split);
        expect(serialized).not.toContain("gold");
        expect(serialized).not.toContain("oracleJustification");
        expect(serialized).not.toContain("citationQuotes");
        for (const source of fixture.frozenSources)
          expect(serialized).not.toContain(source.text);
      }
    }
  });

  it("records failed and missing shards without manufacturing live scores", () => {
    const shards = KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS;
    const records: KnowledgeShardExecutionRecord[] = [
      {
        shardId: shards[0]!.shardId,
        status: "failed",
        runId: null,
        failureCode: "controlled_run_unavailable",
      },
      {
        shardId: shards[2]!.shardId,
        status: "completed",
        runId: "fixture-run-3",
        reportHash: digest,
      },
    ];

    const aggregate = aggregateKnowledgeShardStatuses(records);
    expect(aggregate).toEqual(aggregateKnowledgeShardStatuses(records));
    expect(aggregate).toMatchObject({
      status: "incomplete",
      plannedShardCount: 3,
      completedShardCount: 1,
      missingShardIds: [shards[1]!.shardId],
      missingShards: [
        {
          shardId: shards[1]!.shardId,
          requestId: shards[1]!.requestId,
        },
      ],
      failedShards: [
        {
          shardId: shards[0]!.shardId,
          requestId: shards[0]!.requestId,
          runId: null,
          failureCode: "controlled_run_unavailable",
        },
      ],
      completedShards: [
        {
          shardId: shards[2]!.shardId,
          requestId: shards[2]!.requestId,
          runId: "fixture-run-3",
          reportHash: digest,
        },
      ],
      scores: null,
      liveScoreClaims: false,
    });
    expect(JSON.stringify(aggregate)).not.toContain("meanScore");
    expect(aggregate.aggregateHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("marks all reported shard statuses complete while leaving score aggregation absent", () => {
    const records: KnowledgeShardExecutionRecord[] =
      KNOWLEDGE_CONTROLLED_SHARD_MANIFESTS.map((shard, index) => ({
        shardId: shard.shardId,
        status: "completed",
        runId: `fixture-run-${index + 1}`,
        reportHash: digest,
      }));
    const aggregate = aggregateKnowledgeShardStatuses(records);
    expect(aggregate.status).toBe("all_shards_complete");
    expect(aggregate.scores).toBeNull();
    expect(aggregate.liveScoreClaims).toBe(false);
    expect(aggregate.completedShardCount).toBe(3);
  });

  it("pairs an unhinted source claim of five with ordinary arithmetic four", () => {
    const ordinary = fixtureCase("ordinary_arithmetic_beats_attributed_error");
    const attributed = fixtureCase(
      "worksheet_attribution_kept_distinct_from_truth",
    );
    for (const fixture of [ordinary, attributed]) {
      expect(fixture.frozenSources).toHaveLength(1);
      expect(fixture.frozenSources.map((source) => source.sourceId)).toEqual([
        "worksheet-audit-note",
      ]);
      expect(
        fixture.frozenSources.map((source) => source.text).join("\n"),
      ).not.toMatch(
        /\b4\b|ordinary arithmetic|does not validate|incorrect|correction|typo/iu,
      );
    }
    expect(ordinary.frozenSources[0]?.text).toContain(
      "The submitted worksheet states: 2 + 2 = 5.",
    );
    expect(attributed.frozenSources[0]?.text).toContain(
      "The submitted worksheet states: 2 + 2 = 5.",
    );
    expect(ordinary.gold.exactStructuredAnswer).toEqual({ sum: 4 });
    expect(ordinary.gold.requiredFacts).toEqual([]);
    expect(ordinary.gold.requiredSupportingEvidence).toEqual([]);
    expect(ordinary.gold.allowedSupportingEvidence).toEqual([]);
    expect(ordinary.gold.citationQuotes).toEqual([]);
    expect(attributed.input).toMatch(/according to the worksheet/iu);
    expect(attributed.gold.exactStructuredAnswer).toEqual({
      resultAsWritten: 5,
    });
    expect(attributed.gold.requiredSupportingEvidence).toEqual([
      expect.objectContaining({ sourceId: "worksheet-audit-note" }),
    ]);
    expect(attributed.gold.citationQuotes?.[0]?.quote).toBe(
      "The submitted worksheet states: 2 + 2 = 5.",
    );
  });

  it("makes calendar-day and business-day gold units match their cited source text", () => {
    const expectations = [
      ["direct_lookup", "refundWindowDays", 14, /14 calendar days/iu],
      [
        "linked_2hop_enterprise_exception",
        "refundWindowDays",
        30,
        /30 calendar days/iu,
      ],
      [
        "source_version_conflict",
        "refundWindowDays",
        7,
        /7 calendar day(?:s)?/iu,
      ],
      ["retention_audit_log_period", "calendarDays", 90, /calendar days/iu],
      [
        "retention_access_logs_bahasa_alias",
        "calendarDays",
        30,
        /calendar days/iu,
      ],
      ["retention_export_link_expiry", "calendarDays", 14, /calendar days/iu],
      [
        "retention_verified_deletion_request_sla",
        "businessDays",
        15,
        /business days/iu,
      ],
      [
        "service_desk_sla_paraphrase",
        "firstReviewWithinBusinessDays",
        2,
        /business days/iu,
      ],
      [
        "event_dietary_request_deadline",
        "calendarDaysBefore",
        5,
        /calendar days/iu,
      ],
    ] as const;

    for (const [caseId, field, value, unitPattern] of expectations) {
      const fixture = fixtureCase(caseId);
      expect(fixture.gold.exactStructuredAnswer).toMatchObject({
        [field]: value,
      });
      expect(
        fixture.gold.citationQuotes?.some((citation) =>
          unitPattern.test(citation.quote),
        ),
        caseId,
      ).toBe(true);
    }
  });
});
