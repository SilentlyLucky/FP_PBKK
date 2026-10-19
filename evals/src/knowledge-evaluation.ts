import { createHash } from "node:crypto";

import type { EvaluationSplit } from "./index.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Scope is part of an evidence identity so cross-project matches cannot pass. */
export interface KnowledgeEvidenceIdentity {
  scopeId: string;
  sourceId: string;
  versionId: string;
  chunkId: string;
}

export interface KnowledgeCitation extends KnowledgeEvidenceIdentity {
  quote: string;
}

export interface FrozenKnowledgeSourceText extends KnowledgeEvidenceIdentity {
  text: string;
}

export interface KnowledgeCriticalConstraint {
  id: string;
  /** Dot-separated path inside the observed structured answer. */
  path: string;
  equals: JsonValue;
}

/** Evaluator-only labels. Do not pass this object to an optimizer or target. */
export interface KnowledgeGoldAnnotations {
  exactStructuredAnswer?: JsonValue;
  requiredFacts?: readonly string[];
  requiredSupportingEvidence?: readonly KnowledgeEvidenceIdentity[];
  allowedSupportingEvidence?: readonly KnowledgeEvidenceIdentity[];
  citationQuotes?: readonly KnowledgeCitation[];
  expectedAbstention?: boolean;
  criticalConstraints?: readonly KnowledgeCriticalConstraint[];
}

export interface KnowledgeEvaluationObservation {
  structuredAnswer?: JsonValue;
  /** Exact fact strings supplied by the caller; no semantic extraction occurs here. */
  statedFacts?: readonly string[];
  /** Evidence identities emitted as support for the observed answer. */
  supportingEvidence?: readonly KnowledgeEvidenceIdentity[];
  /** Each quote is checked against the frozen text for its full identity. */
  citations?: readonly KnowledgeCitation[];
  abstained?: boolean;
}

export type KnowledgeCostAmount =
  | {
      status: "known";
      amountUsd: number;
      measure: "provider_inference";
      basis: string;
    }
  | {
      status: "unknown";
      amountUsd: null;
      measure: "stage_total" | "run_total";
      reason: string;
    };

/** Per-stage monetary cost evidence; unknown values remain explicit. */
export interface KnowledgeRuntimeCostBreakdown {
  optimizer: KnowledgeCostAmount;
  retrieval: KnowledgeCostAmount;
  target: KnowledgeCostAmount;
  index: KnowledgeCostAmount;
  total: KnowledgeCostAmount;
}

export interface KnowledgeRuntimeEvidenceRecord extends KnowledgeEvidenceIdentity {
  quote: string;
  traceId: string;
}

/**
 * A deterministic evaluator record bound to the exact target input assembled
 * from runtime retrieval packs. The raw context is never copied into the
 * record; its SHA-256 and character count identify it without duplicating
 * potentially private source text.
 */
export interface KnowledgeRuntimeEvaluationRecord {
  schemaVersion: "promptlab-knowledge-runtime-evaluation-v1";
  evidenceClass: "offline_deterministic";
  caseId: string;
  targetContextHash: string;
  targetInputCharacters: number;
  retrieval: {
    evidence: readonly KnowledgeRuntimeEvidenceRecord[];
    strategies: readonly string[];
    traceIds: readonly string[];
  };
  observation: KnowledgeEvaluationObservation;
  metrics: KnowledgeCaseEvaluation;
  costs: KnowledgeRuntimeCostBreakdown;
}

export interface OptimizerVisibleKnowledgeCase {
  input: string;
  scopeId: string;
}

/**
 * Select only the fields an optimizer may see. In particular, gold answers,
 * evidence identities, source text, and future private annotations are omitted.
 */
export function toOptimizerVisibleKnowledgeCase<
  T extends {
    caseId: string;
    input: string;
    split: EvaluationSplit;
    scopeId: string;
  },
>(input: T): OptimizerVisibleKnowledgeCase {
  return {
    input: input.input,
    scopeId: input.scopeId,
  };
}

/** `score` is a ratio between zero and one, inclusive. */
export type FractionMetric =
  | { status: "scored"; score: number }
  | { status: "unscored"; score: null; reason: string };

export type BooleanMetric =
  | { status: "scored"; passed: boolean }
  | { status: "unscored"; passed: null; reason: string };

export interface KnowledgeCaseEvaluation {
  schemaVersion: "promptlab-knowledge-case-evaluation-v1";
  evidenceClass: "offline_deterministic";
  evidence: {
    /** Allowed observed identities divided by all observed identities. */
    precision: FractionMetric;
    /** Required identities observed divided by all required identities. */
    recall: FractionMetric;
  };
  exactStructuredAnswer: BooleanMetric;
  requiredFactsRecall: FractionMetric;
  /** Exact identity and quote-string overlap with gold labels, not semantics. */
  citationQuoteMatch: {
    /** Matched pairs divided by unique observed pairs; invalid entries count unmatched. */
    precision: FractionMetric;
    /** Matched pairs divided by unique expected pairs. */
    recall: FractionMetric;
  };
  abstention: BooleanMetric;
  criticalConstraints: BooleanMetric & {
    checked: number;
    failed: number;
  };
}

function unscoredFraction(reason: string): FractionMetric {
  return { status: "unscored", score: null, reason };
}

function unscoredBoolean(reason: string): BooleanMetric {
  return { status: "unscored", passed: null, reason };
}

function canonicalJson(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    if (items.some((item) => item === undefined)) return undefined;
    return `[${items.join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const fields = entries.map(([key, child]) => {
    const serialized = canonicalJson(child);
    return serialized === undefined
      ? undefined
      : `${JSON.stringify(key)}:${serialized}`;
  });
  if (fields.some((field) => field === undefined)) return undefined;
  return `{${fields.join(",")}}`;
}

function identityKey(identity: KnowledgeEvidenceIdentity): string | null {
  const values = [
    identity.scopeId,
    identity.sourceId,
    identity.versionId,
    identity.chunkId,
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0))
    return null;
  return JSON.stringify(values);
}

function uniqueIdentityKeys(identities: readonly KnowledgeEvidenceIdentity[]): {
  keys: Set<string>;
  invalidCount: number;
} {
  const keys = new Set<string>();
  let invalidCount = 0;
  for (const identity of identities) {
    const key = identityKey(identity);
    if (key === null) invalidCount += 1;
    else keys.add(key);
  }
  return { keys, invalidCount };
}

function citationKey(citation: KnowledgeCitation): string | null {
  const key = identityKey(citation);
  if (key === null || typeof citation.quote !== "string" || !citation.quote)
    return null;
  return JSON.stringify([key, citation.quote]);
}

function uniqueCitationKeys(citations: readonly KnowledgeCitation[]): {
  keys: Set<string>;
  invalidCount: number;
} {
  const keys = new Set<string>();
  let invalidCount = 0;
  for (const citation of citations) {
    const key = citationKey(citation);
    if (key === null) invalidCount += 1;
    else keys.add(key);
  }
  return { keys, invalidCount };
}

function exactAnswerMetric(
  gold: KnowledgeGoldAnnotations | null | undefined,
  observation: KnowledgeEvaluationObservation | null | undefined,
): BooleanMetric {
  if (!gold) return unscoredBoolean("gold_missing");
  if (!Object.hasOwn(gold, "exactStructuredAnswer"))
    return unscoredBoolean("exact_answer_not_labeled");
  if (!observation) return unscoredBoolean("observation_missing");
  if (observation.structuredAnswer === undefined)
    return unscoredBoolean("structured_answer_missing");
  const expected = canonicalJson(gold.exactStructuredAnswer);
  const actual = canonicalJson(observation.structuredAnswer);
  if (expected === undefined || actual === undefined)
    return unscoredBoolean("structured_answer_not_json");
  return { status: "scored", passed: expected === actual };
}

function evidenceMetrics(
  gold: KnowledgeGoldAnnotations | null | undefined,
  observation: KnowledgeEvaluationObservation | null | undefined,
): KnowledgeCaseEvaluation["evidence"] {
  if (!gold)
    return {
      precision: unscoredFraction("gold_missing"),
      recall: unscoredFraction("gold_missing"),
    };
  if (!observation)
    return {
      precision: unscoredFraction("observation_missing"),
      recall: unscoredFraction("observation_missing"),
    };
  if (observation.supportingEvidence === undefined)
    return {
      precision: unscoredFraction("supporting_evidence_missing"),
      recall: unscoredFraction("supporting_evidence_missing"),
    };

  const observed = uniqueIdentityKeys(observation.supportingEvidence);
  const hasRequired = Object.hasOwn(gold, "requiredSupportingEvidence");
  const hasAllowed = Object.hasOwn(gold, "allowedSupportingEvidence");
  const required = uniqueIdentityKeys(gold.requiredSupportingEvidence ?? []);
  const allowed = uniqueIdentityKeys(gold.allowedSupportingEvidence ?? []);
  if (
    (hasRequired && required.invalidCount) ||
    (hasAllowed && allowed.invalidCount)
  )
    return {
      precision: unscoredFraction("invalid_gold_identity"),
      recall: unscoredFraction("invalid_gold_identity"),
    };
  if (
    hasRequired &&
    hasAllowed &&
    [...required.keys].some((key) => !allowed.keys.has(key))
  )
    return {
      precision: unscoredFraction("inconsistent_gold_evidence"),
      recall: unscoredFraction("inconsistent_gold_evidence"),
    };

  const observedCount = observed.keys.size + observed.invalidCount;
  const matchedRequired = [...required.keys].filter((key) =>
    observed.keys.has(key),
  ).length;
  const matchedAllowed = [...observed.keys].filter((key) =>
    allowed.keys.has(key),
  ).length;

  return {
    precision: !hasAllowed
      ? unscoredFraction("allowed_evidence_not_labeled")
      : observedCount === 0
        ? unscoredFraction("no_observed_evidence")
        : {
            status: "scored",
            score: matchedAllowed / observedCount,
          },
    recall: !hasRequired
      ? unscoredFraction("required_evidence_not_labeled")
      : required.keys.size === 0
        ? unscoredFraction("no_required_evidence")
        : {
            status: "scored",
            score: matchedRequired / required.keys.size,
          },
  };
}

function requiredFactsMetric(
  gold: KnowledgeGoldAnnotations | null | undefined,
  observation: KnowledgeEvaluationObservation | null | undefined,
): FractionMetric {
  if (!gold) return unscoredFraction("gold_missing");
  if (!Object.hasOwn(gold, "requiredFacts"))
    return unscoredFraction("required_facts_not_labeled");
  if (!observation) return unscoredFraction("observation_missing");
  if (observation.statedFacts === undefined)
    return unscoredFraction("stated_facts_missing");
  const expected = new Set(gold.requiredFacts ?? []);
  if (expected.size === 0) return unscoredFraction("no_required_facts");
  const actual = new Set(observation.statedFacts);
  const matched = [...expected].filter((fact) => actual.has(fact)).length;
  return { status: "scored", score: matched / expected.size };
}

function citationMetrics(
  gold: KnowledgeGoldAnnotations | null | undefined,
  observation: KnowledgeEvaluationObservation | null | undefined,
  sourceTexts: readonly FrozenKnowledgeSourceText[] | null | undefined,
): KnowledgeCaseEvaluation["citationQuoteMatch"] {
  if (!gold)
    return {
      precision: unscoredFraction("gold_missing"),
      recall: unscoredFraction("gold_missing"),
    };
  if (!Object.hasOwn(gold, "citationQuotes"))
    return {
      precision: unscoredFraction("citation_quotes_not_labeled"),
      recall: unscoredFraction("citation_quotes_not_labeled"),
    };
  if (!observation)
    return {
      precision: unscoredFraction("observation_missing"),
      recall: unscoredFraction("observation_missing"),
    };
  if (observation.citations === undefined)
    return {
      precision: unscoredFraction("citations_missing"),
      recall: unscoredFraction("citations_missing"),
    };
  if (sourceTexts === undefined || sourceTexts === null)
    return {
      precision: unscoredFraction("frozen_source_text_missing"),
      recall: unscoredFraction("frozen_source_text_missing"),
    };

  const expectedKeys = uniqueCitationKeys(gold.citationQuotes ?? []);
  const observedKeys = uniqueCitationKeys(observation.citations);
  if (expectedKeys.invalidCount)
    return {
      precision: unscoredFraction("invalid_gold_citation"),
      recall: unscoredFraction("invalid_gold_citation"),
    };
  if (expectedKeys.keys.size === 0)
    return {
      precision: unscoredFraction("no_expected_citations"),
      recall: unscoredFraction("no_expected_citations"),
    };

  const sourceByIdentity = new Map<string, string>();
  const ambiguousSources = new Set<string>();
  for (const source of sourceTexts) {
    const key = identityKey(source);
    if (key === null) continue;
    const existing = sourceByIdentity.get(key);
    if (existing !== undefined && existing !== source.text)
      ambiguousSources.add(key);
    else sourceByIdentity.set(key, source.text);
  }

  for (const expectedCitation of gold.citationQuotes ?? []) {
    const key = identityKey(expectedCitation);
    if (key === null || ambiguousSources.has(key))
      return {
        precision: unscoredFraction("frozen_source_identity_ambiguous"),
        recall: unscoredFraction("frozen_source_identity_ambiguous"),
      };
    const sourceText = sourceByIdentity.get(key);
    if (sourceText === undefined)
      return {
        precision: unscoredFraction("expected_frozen_source_text_missing"),
        recall: unscoredFraction("expected_frozen_source_text_missing"),
      };
    if (!sourceText.includes(expectedCitation.quote))
      return {
        precision: unscoredFraction("gold_quote_not_in_frozen_source"),
        recall: unscoredFraction("gold_quote_not_in_frozen_source"),
      };
  }

  const correctCount = [...observedKeys.keys].filter((key) =>
    expectedKeys.keys.has(key),
  ).length;
  const observedCount = observedKeys.keys.size + observedKeys.invalidCount;
  return {
    precision:
      observedCount === 0
        ? unscoredFraction("no_observed_citations")
        : { status: "scored", score: correctCount / observedCount },
    recall: {
      status: "scored",
      score: correctCount / expectedKeys.keys.size,
    },
  };
}

function abstentionMetric(
  gold: KnowledgeGoldAnnotations | null | undefined,
  observation: KnowledgeEvaluationObservation | null | undefined,
): BooleanMetric {
  if (!gold) return unscoredBoolean("gold_missing");
  if (!Object.hasOwn(gold, "expectedAbstention"))
    return unscoredBoolean("abstention_expectation_not_labeled");
  if (!observation) return unscoredBoolean("observation_missing");
  if (observation.abstained === undefined)
    return unscoredBoolean("abstention_observation_missing");
  return {
    status: "scored",
    passed: observation.abstained === gold.expectedAbstention,
  };
}

function valueAtPath(
  value: unknown,
  path: string,
): { found: boolean; value: unknown } {
  if (!path) return { found: true, value };
  let current = value;
  for (const key of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function criticalConstraintMetric(
  gold: KnowledgeGoldAnnotations | null | undefined,
  observation: KnowledgeEvaluationObservation | null | undefined,
): KnowledgeCaseEvaluation["criticalConstraints"] {
  if (!gold)
    return {
      ...unscoredBoolean("gold_missing"),
      checked: 0,
      failed: 0,
    };
  if (!Object.hasOwn(gold, "criticalConstraints"))
    return {
      ...unscoredBoolean("critical_constraints_not_labeled"),
      checked: 0,
      failed: 0,
    };
  if (!gold.criticalConstraints?.length)
    return {
      ...unscoredBoolean("no_critical_constraints"),
      checked: 0,
      failed: 0,
    };
  if (!observation || observation.structuredAnswer === undefined)
    return {
      ...unscoredBoolean("structured_answer_missing"),
      checked: 0,
      failed: 0,
    };

  const invalidGold = gold.criticalConstraints.some(
    (constraint) => canonicalJson(constraint.equals) === undefined,
  );
  if (invalidGold)
    return {
      ...unscoredBoolean("invalid_critical_constraint"),
      checked: 0,
      failed: 0,
    };

  const failed = gold.criticalConstraints.filter((constraint) => {
    const actual = valueAtPath(observation.structuredAnswer, constraint.path);
    if (!actual.found) return true;
    return canonicalJson(actual.value) !== canonicalJson(constraint.equals);
  }).length;
  return {
    status: "scored",
    passed: failed === 0,
    checked: gold.criticalConstraints.length,
    failed,
  };
}

/**
 * Score deterministic, label-backed checks for one case. Citation quote
 * matching compares exact identity and quote pairs; it does not measure
 * semantic citation support or faithfulness.
 */
export function evaluateKnowledgeCase(input: {
  gold?: KnowledgeGoldAnnotations | null;
  observation?: KnowledgeEvaluationObservation | null;
  sourceTexts?: readonly FrozenKnowledgeSourceText[] | null;
}): KnowledgeCaseEvaluation {
  const gold = input.gold;
  const observation = input.observation;
  return {
    schemaVersion: "promptlab-knowledge-case-evaluation-v1",
    evidenceClass: "offline_deterministic",
    evidence: evidenceMetrics(gold, observation),
    exactStructuredAnswer: exactAnswerMetric(gold, observation),
    requiredFactsRecall: requiredFactsMetric(gold, observation),
    citationQuoteMatch: citationMetrics(gold, observation, input.sourceTexts),
    abstention: abstentionMetric(gold, observation),
    criticalConstraints: criticalConstraintMetric(gold, observation),
  };
}

/**
 * Bind deterministic labels and observed target output to the exact runtime
 * target input. This records deterministic metrics only; it makes no general
 * semantic-faithfulness claim.
 */
export function buildKnowledgeRuntimeEvaluationRecord(input: {
  caseId: string;
  targetInputText: string;
  retrieval: KnowledgeRuntimeEvaluationRecord["retrieval"];
  observation: KnowledgeEvaluationObservation;
  gold: KnowledgeGoldAnnotations;
  sourceTexts: readonly FrozenKnowledgeSourceText[];
  costs: KnowledgeRuntimeCostBreakdown;
}): KnowledgeRuntimeEvaluationRecord {
  for (const [stage, cost] of Object.entries(input.costs)) {
    if (
      cost.status === "known" &&
      (!Number.isFinite(cost.amountUsd) || cost.amountUsd < 0)
    ) {
      throw new Error(`Invalid known ${stage} cost.`);
    }
    if (
      cost.status === "unknown" &&
      (!cost.reason.trim() || cost.amountUsd !== null)
    ) {
      throw new Error(`Invalid unknown ${stage} cost.`);
    }
  }
  const targetContextHash = createHash("sha256")
    .update(input.targetInputText, "utf8")
    .digest("hex");
  return {
    schemaVersion: "promptlab-knowledge-runtime-evaluation-v1",
    evidenceClass: "offline_deterministic",
    caseId: input.caseId,
    targetContextHash,
    targetInputCharacters: input.targetInputText.length,
    retrieval: input.retrieval,
    observation: input.observation,
    metrics: evaluateKnowledgeCase({
      gold: input.gold,
      observation: input.observation,
      sourceTexts: input.sourceTexts,
    }),
    costs: input.costs,
  };
}
