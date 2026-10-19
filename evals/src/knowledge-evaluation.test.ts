import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildKnowledgeRuntimeEvaluationRecord,
  evaluateKnowledgeCase,
  toOptimizerVisibleKnowledgeCase,
  type KnowledgeEvaluationObservation,
} from "./knowledge-evaluation.js";
import { REQUIRED_CORPUS_COUNTS } from "./index.js";
import {
  KNOWLEDGE_DEVELOPMENT_CASES,
  KNOWLEDGE_HOLDOUT_CASES,
  KNOWLEDGE_INTEGRATION_CASES,
  KNOWLEDGE_INTEGRATION_IDENTITIES,
  KNOWLEDGE_RUNTIME_SMOKE_CASES,
  type KnowledgeIntegrationFixtureCase,
} from "../fixtures/knowledge-integration/cases.js";
import { KNOWLEDGE_FIXTURE_MANIFESTS } from "../fixtures/knowledge-integration/manifest.js";

function fixtureCase(caseId: string): KnowledgeIntegrationFixtureCase {
  const found = KNOWLEDGE_INTEGRATION_CASES.find(
    (item) => item.caseId === caseId,
  );
  if (!found) throw new Error(`Unknown fixture case: ${caseId}`);
  return found;
}

function matchingObservation(
  item: KnowledgeIntegrationFixtureCase,
): KnowledgeEvaluationObservation {
  const observation: KnowledgeEvaluationObservation = {};
  if (item.gold.exactStructuredAnswer !== undefined)
    observation.structuredAnswer = item.gold.exactStructuredAnswer;
  if (item.gold.requiredFacts !== undefined)
    observation.statedFacts = item.gold.requiredFacts;
  if (item.gold.requiredSupportingEvidence !== undefined)
    observation.supportingEvidence = item.gold.requiredSupportingEvidence;
  if (item.gold.citationQuotes !== undefined)
    observation.citations = item.gold.citationQuotes;
  if (item.gold.expectedAbstention !== undefined)
    observation.abstained = item.gold.expectedAbstention;
  return observation;
}

describe("deterministic knowledge evaluation", () => {
  it("scores exact answers, required facts, evidence, citations, and constraints reproducibly", () => {
    const item = fixtureCase("direct_lookup");
    const input = {
      gold: item.gold,
      observation: matchingObservation(item),
      sourceTexts: item.frozenSources,
    };
    const result = evaluateKnowledgeCase(input);

    expect(evaluateKnowledgeCase(input)).toEqual(result);
    expect(result).toMatchObject({
      evidenceClass: "offline_deterministic",
      evidence: {
        precision: { status: "scored", score: 1 },
        recall: { status: "scored", score: 1 },
      },
      exactStructuredAnswer: { status: "scored", passed: true },
      requiredFactsRecall: { status: "scored", score: 1 },
      citationQuoteMatch: {
        precision: { status: "scored", score: 1 },
        recall: { status: "scored", score: 1 },
      },
      abstention: { status: "scored", passed: true },
      criticalConstraints: {
        status: "scored",
        passed: true,
        checked: 2,
        failed: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain("faithfulness");
  });

  it("computes evidence precision against allowed identities and recall against required identities", () => {
    const item = fixtureCase("linked_2hop_enterprise_exception");
    const observation = matchingObservation(item);
    observation.supportingEvidence = [
      ...item.gold.requiredSupportingEvidence!,
      KNOWLEDGE_INTEGRATION_IDENTITIES.unrelated90,
    ];

    const result = evaluateKnowledgeCase({
      gold: item.gold,
      observation,
      sourceTexts: item.frozenSources,
    });
    expect(result.evidence).toEqual({
      precision: { status: "scored", score: 2 / 3 },
      recall: { status: "scored", score: 1 },
    });
  });

  it("answers digital-product extension eligibility without implying a refund window", () => {
    const item = fixtureCase("enterprise_digital_exclusion");

    expect(item.gold.exactStructuredAnswer).toEqual({
      enterpriseExtensionEligible: false,
      digitalProductsExcluded: true,
    });
    expect(item.gold.requiredFacts).toEqual([
      "Digital products are excluded from the Enterprise refund extension.",
    ]);
    expect(item.gold.citationQuotes).toHaveLength(1);
    expect(item.gold.citationQuotes?.[0]?.quote).toBe(
      "Digital products are excluded\nfrom the Enterprise refund extension.",
    );
    expect(item.gold.criticalConstraints).toEqual([
      {
        id: "digital-product-excluded",
        path: "digitalProductsExcluded",
        equals: true,
      },
      {
        id: "digital-product-not-eligible",
        path: "enterpriseExtensionEligible",
        equals: false,
      },
    ]);
  });

  it("rejects a fabricated citation quote even when the source identity is right", () => {
    const item = fixtureCase("direct_lookup");
    const observation = matchingObservation(item);
    observation.citations = [
      {
        ...item.gold.citationQuotes![0]!,
        quote: "Refunds are always available for 90 days.",
      },
    ];

    const result = evaluateKnowledgeCase({
      gold: item.gold,
      observation,
      sourceTexts: item.frozenSources,
    });
    expect(result.citationQuoteMatch).toEqual({
      precision: { status: "scored", score: 0 },
      recall: { status: "scored", score: 0 },
    });
  });

  it("rejects wrong source versions and cross-project evidence identities", () => {
    const versionCase = fixtureCase("source_version_conflict");
    const wrongVersion = matchingObservation(versionCase);
    wrongVersion.supportingEvidence = [
      {
        ...KNOWLEDGE_INTEGRATION_IDENTITIES.policy14,
        chunkId: "standard-window",
      },
    ];
    wrongVersion.citations = [
      {
        ...versionCase.gold.citationQuotes![0]!,
        versionId: "v1",
      },
    ];
    const versionResult = evaluateKnowledgeCase({
      gold: versionCase.gold,
      observation: wrongVersion,
      sourceTexts: versionCase.frozenSources,
    });
    expect(versionResult.evidence).toEqual({
      precision: { status: "scored", score: 0 },
      recall: { status: "scored", score: 0 },
    });
    expect(versionResult.citationQuoteMatch).toEqual({
      precision: { status: "scored", score: 0 },
      recall: { status: "scored", score: 0 },
    });

    const scopeCase = fixtureCase("scope_isolation");
    const wrongScope = matchingObservation(scopeCase);
    wrongScope.supportingEvidence = [
      KNOWLEDGE_INTEGRATION_IDENTITIES.unrelated90,
    ];
    wrongScope.citations = [
      {
        ...scopeCase.gold.citationQuotes![0]!,
        scopeId: "project-beta",
      },
    ];
    const scopeResult = evaluateKnowledgeCase({
      gold: scopeCase.gold,
      observation: wrongScope,
      sourceTexts: scopeCase.frozenSources,
    });
    expect(scopeResult.evidence).toEqual({
      precision: { status: "scored", score: 0 },
      recall: { status: "scored", score: 0 },
    });
    expect(scopeResult.citationQuoteMatch).toEqual({
      precision: { status: "scored", score: 0 },
      recall: { status: "scored", score: 0 },
    });
  });

  it("checks abstention and keeps absent labels or frozen source text unscored", () => {
    const item = fixtureCase("no_evidence_abstention");
    const result = evaluateKnowledgeCase({
      gold: item.gold,
      observation: matchingObservation(item),
      sourceTexts: item.frozenSources,
    });
    expect(result.abstention).toEqual({ status: "scored", passed: true });
    expect(result.evidence.precision).toMatchObject({
      status: "unscored",
      score: null,
    });
    expect(result.evidence.recall).toMatchObject({
      status: "unscored",
      score: null,
    });
    expect(result.citationQuoteMatch.precision).toMatchObject({
      status: "unscored",
      score: null,
    });

    const direct = fixtureCase("direct_lookup");
    const missingGold = evaluateKnowledgeCase({
      gold: null,
      observation: matchingObservation(direct),
      sourceTexts: direct.frozenSources,
    });
    expect(missingGold.exactStructuredAnswer).toEqual({
      status: "unscored",
      passed: null,
      reason: "gold_missing",
    });
    expect(missingGold.evidence.recall.score).toBeNull();

    const missingContext = evaluateKnowledgeCase({
      gold: direct.gold,
      observation: matchingObservation(direct),
    });
    expect(missingContext.citationQuoteMatch.precision).toEqual({
      status: "unscored",
      score: null,
      reason: "frozen_source_text_missing",
    });
  });

  it("keeps missing and explicitly empty labels distinguishable", () => {
    const observation: KnowledgeEvaluationObservation = {
      structuredAnswer: null,
      statedFacts: [],
      supportingEvidence: [],
      citations: [],
      abstained: false,
    };
    const missing = evaluateKnowledgeCase({
      gold: {},
      observation,
      sourceTexts: [],
    });
    expect(missing.exactStructuredAnswer).toMatchObject({
      status: "unscored",
      reason: "exact_answer_not_labeled",
    });
    expect(missing.evidence).toEqual({
      precision: {
        status: "unscored",
        score: null,
        reason: "allowed_evidence_not_labeled",
      },
      recall: {
        status: "unscored",
        score: null,
        reason: "required_evidence_not_labeled",
      },
    });
    expect(missing.requiredFactsRecall).toMatchObject({
      status: "unscored",
      reason: "required_facts_not_labeled",
    });
    expect(missing.citationQuoteMatch.precision).toMatchObject({
      status: "unscored",
      reason: "citation_quotes_not_labeled",
    });
    expect(missing.abstention).toMatchObject({
      status: "unscored",
      reason: "abstention_expectation_not_labeled",
    });
    expect(missing.criticalConstraints).toMatchObject({
      status: "unscored",
      reason: "critical_constraints_not_labeled",
    });

    const empty = evaluateKnowledgeCase({
      gold: {
        exactStructuredAnswer: null,
        requiredFacts: [],
        requiredSupportingEvidence: [],
        allowedSupportingEvidence: [],
        citationQuotes: [],
        expectedAbstention: false,
        criticalConstraints: [],
      },
      observation,
      sourceTexts: [],
    });
    expect(empty.exactStructuredAnswer).toEqual({
      status: "scored",
      passed: true,
    });
    expect(empty.evidence).toEqual({
      precision: {
        status: "unscored",
        score: null,
        reason: "no_observed_evidence",
      },
      recall: {
        status: "unscored",
        score: null,
        reason: "no_required_evidence",
      },
    });
    expect(empty.requiredFactsRecall).toMatchObject({
      status: "unscored",
      reason: "no_required_facts",
    });
    expect(empty.citationQuoteMatch.precision).toMatchObject({
      status: "unscored",
      reason: "no_expected_citations",
    });
    expect(empty.abstention).toEqual({ status: "scored", passed: true });
    expect(empty.criticalConstraints).toMatchObject({
      status: "unscored",
      reason: "no_critical_constraints",
      checked: 0,
      failed: 0,
    });
  });

  it("keeps labels, evidence text, and oracle rationale out of optimizer-visible cases", () => {
    for (const item of KNOWLEDGE_INTEGRATION_CASES) {
      const visible = toOptimizerVisibleKnowledgeCase(item);
      expect(visible).toEqual({
        input: item.input,
        scopeId: item.scopeId,
      });
      const serialized = JSON.stringify(visible);
      expect(serialized).not.toContain(item.caseId);
      expect(serialized).not.toContain("development");
      expect(serialized).not.toContain("holdout");
      expect(serialized).not.toContain("gold");
      expect(serialized).not.toContain("exactStructuredAnswer");
      expect(serialized).not.toContain("oracleJustification");
      expect(serialized).not.toContain("citationQuotes");
      expect(serialized).not.toContain("frozenSources");
      expect(serialized).not.toContain("taskFamily");
      for (const source of item.frozenSources)
        expect(serialized).not.toContain(source.text);
    }
  });

  it("contains the original seven smoke cases and the requested 20/40 fixture split", () => {
    expect(KNOWLEDGE_RUNTIME_SMOKE_CASES.map((item) => item.caseId)).toEqual([
      "direct_lookup",
      "linked_2hop_enterprise_exception",
      "enterprise_digital_exclusion",
      "no_evidence_abstention",
      "source_version_conflict",
      "scope_isolation",
      "malicious_quoted_instruction",
    ]);
    expect(KNOWLEDGE_RUNTIME_SMOKE_CASES).toHaveLength(7);
    expect(KNOWLEDGE_DEVELOPMENT_CASES).toHaveLength(
      REQUIRED_CORPUS_COUNTS.development,
    );
    expect(KNOWLEDGE_HOLDOUT_CASES).toHaveLength(
      REQUIRED_CORPUS_COUNTS.holdout,
    );
    expect(KNOWLEDGE_INTEGRATION_CASES).toHaveLength(60);
    expect(
      KNOWLEDGE_DEVELOPMENT_CASES.every((item) => item.split === "development"),
    ).toBe(true);
    expect(
      KNOWLEDGE_HOLDOUT_CASES.every((item) => item.split === "holdout"),
    ).toBe(true);
    expect(
      KNOWLEDGE_RUNTIME_SMOKE_CASES.every(
        (item) => item.split === "development",
      ),
    ).toBe(true);
  });

  it("keeps case IDs, task families, source anchors, and evaluator oracles internally consistent", () => {
    const caseIds = KNOWLEDGE_INTEGRATION_CASES.map((item) => item.caseId);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(
      new Set(
        KNOWLEDGE_INTEGRATION_CASES.map((item) => item.oracleJustification),
      ).size,
    ).toBe(caseIds.length);

    const developmentFamilies = new Set(
      KNOWLEDGE_DEVELOPMENT_CASES.map((item) => item.taskFamily),
    );
    expect(
      KNOWLEDGE_HOLDOUT_CASES.some((item) =>
        developmentFamilies.has(item.taskFamily),
      ),
    ).toBe(false);

    const identityKey = (identity: {
      scopeId: string;
      sourceId: string;
      versionId: string;
      chunkId: string;
    }) =>
      JSON.stringify([
        identity.scopeId,
        identity.sourceId,
        identity.versionId,
        identity.chunkId,
      ]);
    const developmentSourceIdentities = new Set(
      KNOWLEDGE_DEVELOPMENT_CASES.flatMap((item) =>
        item.frozenSources.map(identityKey),
      ),
    );
    expect(
      KNOWLEDGE_HOLDOUT_CASES.some((item) =>
        item.frozenSources.some((source) =>
          developmentSourceIdentities.has(identityKey(source)),
        ),
      ),
    ).toBe(false);

    for (const item of KNOWLEDGE_INTEGRATION_CASES) {
      expect(item.oracleJustification.trim().length).toBeGreaterThan(20);
      const frozenByIdentity = new Map(
        item.frozenSources.map((source) => [identityKey(source), source]),
      );
      const citations = item.gold.citationQuotes ?? [];
      for (const citation of citations) {
        const source = frozenByIdentity.get(identityKey(citation));
        expect(source, `${item.caseId} citation source`).toBeDefined();
        expect(source!.text, `${item.caseId} quote`).toContain(citation.quote);
      }
      for (const identity of [
        ...(item.gold.requiredSupportingEvidence ?? []),
        ...(item.gold.allowedSupportingEvidence ?? []),
      ]) {
        expect(identity.scopeId).toBe(item.scopeId);
        expect(frozenByIdentity.has(identityKey(identity))).toBe(true);
      }

      if (item.gold.expectedAbstention) {
        expect(item.gold.exactStructuredAnswer).toEqual({ abstained: true });
        expect(item.gold.requiredSupportingEvidence).toEqual([]);
        expect(item.gold.citationQuotes).toEqual([]);
      } else if (item.caseId === "ordinary_arithmetic_beats_attributed_error") {
        expect(item.gold.exactStructuredAnswer).toEqual({ sum: 4 });
        expect(item.gold.requiredFacts).toEqual([]);
        expect(item.gold.requiredSupportingEvidence).toEqual([]);
        expect(item.gold.allowedSupportingEvidence).toEqual([]);
        expect(item.gold.citationQuotes).toEqual([]);
        expect(item.frozenSources).toHaveLength(1);
        expect(item.frozenSources[0]?.text).toContain("2 + 2 = 5");
      } else {
        expect(item.gold.requiredFacts!.length).toBeGreaterThan(0);
        expect(item.gold.requiredSupportingEvidence!.length).toBeGreaterThan(0);
        expect(item.gold.citationQuotes!.length).toBeGreaterThan(0);
        expect(
          item.gold.requiredSupportingEvidence!.every((identity) =>
            item.gold.allowedSupportingEvidence!.some(
              (allowed) => identityKey(allowed) === identityKey(identity),
            ),
          ),
        ).toBe(true);
      }
    }
  });

  it("freezes separate evaluation-only development and holdout manifests with the shared helper", () => {
    const development = KNOWLEDGE_FIXTURE_MANIFESTS.development;
    const holdout = KNOWLEDGE_FIXTURE_MANIFESTS.holdout;
    expect(development.split).toBe("development");
    expect(holdout.split).toBe("holdout");
    expect(new Set(development.cells.map((cell) => cell.caseId))).toEqual(
      new Set(KNOWLEDGE_DEVELOPMENT_CASES.map((item) => item.caseId)),
    );
    expect(new Set(holdout.cells.map((cell) => cell.caseId))).toEqual(
      new Set(KNOWLEDGE_HOLDOUT_CASES.map((item) => item.caseId)),
    );
    const developmentIds = new Set(
      development.cells.map((cell) => cell.caseId),
    );
    expect(holdout.cells.some((cell) => developmentIds.has(cell.caseId))).toBe(
      false,
    );
    expect(development.cells).toHaveLength(20 * 3);
    expect(holdout.cells).toHaveLength(40 * 3);
    expect(development.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(holdout.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    for (const manifest of [development, holdout]) {
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain("oracleJustification");
      expect(serialized).not.toContain("exactStructuredAnswer");
      expect(serialized).not.toContain("citationQuotes");
      expect(serialized).not.toContain("frozenSources");
    }
  });

  it("verifies every labeled citation quote against its fixture's frozen source text", () => {
    for (const item of KNOWLEDGE_INTEGRATION_CASES) {
      if (!item.gold.citationQuotes?.length) continue;
      const result = evaluateKnowledgeCase({
        gold: item.gold,
        observation: matchingObservation(item),
        sourceTexts: item.frozenSources,
      });
      expect(result.citationQuoteMatch).toEqual({
        precision: { status: "scored", score: 1 },
        recall: { status: "scored", score: 1 },
      });
    }
  });

  it("confirms each fixture's stated oracle outcome without scoring the runtime", () => {
    for (const item of KNOWLEDGE_INTEGRATION_CASES) {
      const result = evaluateKnowledgeCase({
        gold: item.gold,
        observation: matchingObservation(item),
        sourceTexts: item.frozenSources,
      });
      expect(result.exactStructuredAnswer).toEqual({
        status: "scored",
        passed: true,
      });
      expect(result.criticalConstraints.passed).toBe(true);
      expect(result.criticalConstraints.failed).toBe(0);
      expect(result.abstention, item.caseId).toEqual({
        status: "scored",
        passed: true,
      });
      if ((item.gold.requiredFacts ?? []).length > 0)
        expect(result.requiredFactsRecall).toEqual({
          status: "scored",
          score: 1,
        });
      if ((item.gold.requiredSupportingEvidence ?? []).length > 0)
        expect(result.evidence.recall).toEqual({ status: "scored", score: 1 });
    }
  });

  it("binds scored output to the actual target input hash and preserves unknown costs", () => {
    const item = fixtureCase("direct_lookup");
    const targetInputText = "Prompt\n\nRuntime evidence pack";
    const observation = matchingObservation(item);
    const record = buildKnowledgeRuntimeEvaluationRecord({
      caseId: item.caseId,
      targetInputText,
      retrieval: {
        evidence: [
          {
            ...KNOWLEDGE_INTEGRATION_IDENTITIES.policy14,
            quote: item.frozenSources[0]!.text,
            traceId: "runtime-trace",
          },
        ],
        strategies: ["lexical"],
        traceIds: ["runtime-trace"],
      },
      observation,
      gold: item.gold,
      sourceTexts: item.frozenSources,
      costs: {
        optimizer: {
          status: "known",
          amountUsd: 0,
          measure: "provider_inference",
          basis: "offline mocked optimizer",
        },
        retrieval: {
          status: "unknown",
          amountUsd: null,
          measure: "stage_total",
          reason: "Local database infrastructure cost is not metered.",
        },
        target: {
          status: "known",
          amountUsd: 0,
          measure: "provider_inference",
          basis: "offline mocked target",
        },
        index: {
          status: "known",
          amountUsd: 0,
          measure: "provider_inference",
          basis: "offline mocked indexer",
        },
        total: {
          status: "unknown",
          amountUsd: null,
          measure: "run_total",
          reason: "Retrieval infrastructure cost is not metered.",
        },
      },
    });

    expect(record).toMatchObject({
      schemaVersion: "promptlab-knowledge-runtime-evaluation-v1",
      evidenceClass: "offline_deterministic",
      caseId: item.caseId,
      targetContextHash: createHash("sha256")
        .update(targetInputText, "utf8")
        .digest("hex"),
      targetInputCharacters: targetInputText.length,
      metrics: {
        exactStructuredAnswer: { status: "scored", passed: true },
      },
      costs: {
        optimizer: { status: "known", amountUsd: 0 },
        retrieval: { status: "unknown", amountUsd: null },
        target: { status: "known", amountUsd: 0 },
        index: { status: "known", amountUsd: 0 },
        total: { status: "unknown", amountUsd: null },
      },
    });
  });
});
