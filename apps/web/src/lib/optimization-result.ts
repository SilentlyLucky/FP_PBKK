export type UsageStatus = "reported" | "estimated" | "unknown";

export interface UsageMetric {
  value: number | null;
  status: UsageStatus;
}

export interface OptimizationUsage {
  input: UsageMetric;
  output: UsageMetric;
  total: UsageMetric;
}

export type OptimizationRevisionOutcome =
  | "candidate_ready"
  | "incomplete"
  | "no_change_recommended"
  | "candidate_rejected";

export interface OptimizationAnswer {
  caseId: string;
  input: string;
  text: string;
  usage: OptimizationUsage;
  latencyMs: number | null;
  source: "user" | "generated" | null;
  verification: Record<string, unknown> | null;
  verificationEvidence: Record<string, unknown> | null;
}

export interface OptimizationTargetSelectionEvidence {
  selection: {
    model: "selected" | "auto";
    reasoningEffort: "selected" | "auto";
  };
  requestedModel: string;
  resolvedModel: string;
  requestedReasoningEffort: string | null;
  resolvedReasoningEffort: string | null;
  sentReasoningEffort: string | null;
  modelResolution: string;
  effortResolution: string;
  capabilitySource: string;
  observedAt: string;
  modelCatalogPosition: number | null;
  modelCatalogCount: number | null;
  modelCapabilities: {
    displayName: string;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: string[];
    inputModalities: string[];
  };
  selectionReason?: string;
}

export interface OptimizationCandidate {
  id: string;
  prompt: string;
  outcome: OptimizationRevisionOutcome | null;
  draftVersionId: string | null;
  testingStatus: "ready" | "rejected" | "incomplete" | null;
  evidenceBoundToPrompt: boolean;
  evidenceEligible: boolean;
  changeSummary: string | null;
  riskSummary: string | null;
  invariantStatus: string | null;
  invariantsPreserved: boolean | null;
  answers: OptimizationAnswer[];
  usage: OptimizationUsage;
  latencyMs: number | null;
}

export const LEGACY_UNTESTED_CANDIDATE = {
  runId: "57bb62bb-18df-42a8-a2d4-0275c1f486e1",
  candidateId: "0d2c7769-5ea7-41c0-9f9d-c53b2d9c22bb",
  draftVersionId: "b5b6b3f5-7d3e-423f-8fdd-be1023e03949",
} as const;

export function isLegacyUnverifiedOptimizationCandidate(input: {
  runId: string;
  candidate: Pick<OptimizationCandidate, "id" | "draftVersionId">;
}): boolean {
  return (
    input.runId === LEGACY_UNTESTED_CANDIDATE.runId &&
    (input.candidate.id === LEGACY_UNTESTED_CANDIDATE.candidateId ||
      input.candidate.draftVersionId ===
        LEGACY_UNTESTED_CANDIDATE.draftVersionId)
  );
}

export function canApplyOptimizationCandidate(input: {
  runId: string;
  resultStatus: string | null;
  candidate: OptimizationCandidate;
}): boolean {
  return (
    input.resultStatus === "candidate_ready" &&
    input.candidate.outcome === "candidate_ready" &&
    input.candidate.testingStatus === "ready" &&
    input.candidate.evidenceBoundToPrompt &&
    input.candidate.evidenceEligible &&
    input.candidate.draftVersionId !== null &&
    input.candidate.invariantsPreserved !== false &&
    !isLegacyUnverifiedOptimizationCandidate({
      runId: input.runId,
      candidate: input.candidate,
    })
  );
}

export interface OptimizationResult {
  status: string | null;
  baseline: {
    prompt: string;
    answers: OptimizationAnswer[];
    usage: OptimizationUsage;
    latencyMs: number | null;
  };
  candidates: OptimizationCandidate[];
  latestCandidateId: string | null;
  reviewableCandidateId: string | null;
  selectedCandidate: OptimizationCandidate | null;
  selectionConsistent: boolean;
  optimizer: {
    model: string | null;
    calls: number | null;
    usage: OptimizationUsage;
    elapsedMs: number | null;
  };
  optimizationOverheadMs: number | null;
  targetSelection: OptimizationTargetSelectionEvidence | null;
  qualityVote: "old_better" | "new_better" | "equal" | "inconclusive" | null;
  qualityNote: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsageMetric(value: unknown): UsageMetric {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return { value, status: "reported" };
  const metric = asRecord(value);
  const count = numberValue(metric?.value ?? metric?.tokens);
  const rawStatus = stringValue(metric?.status);
  const status: UsageStatus =
    rawStatus === "reported" || rawStatus === "measured"
      ? "reported"
      : rawStatus === "estimated"
        ? "estimated"
        : "unknown";
  return {
    value: count !== null && count >= 0 && status !== "unknown" ? count : null,
    status: count === null ? "unknown" : status,
  };
}

export function parseUsage(value: unknown): OptimizationUsage {
  const usage = asRecord(value);
  if (!usage) {
    const unknown = { value: null, status: "unknown" as const };
    return { input: unknown, output: unknown, total: unknown };
  }
  const input = parseUsageMetric(usage.inputTokens ?? usage.input);
  const output = parseUsageMetric(usage.outputTokens ?? usage.output);
  const explicitTotal = usage.totalTokens ?? usage.total;
  const total =
    explicitTotal !== undefined
      ? parseUsageMetric(explicitTotal)
      : input.value !== null && output.value !== null
        ? {
            value: input.value + output.value,
            status:
              input.status === "estimated" || output.status === "estimated"
                ? ("estimated" as const)
                : ("reported" as const),
          }
        : { value: null, status: "unknown" as const };
  return { input, output, total };
}

export function parseAnswers(value: unknown): OptimizationAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OptimizationAnswer[] => {
    const answer = asRecord(item);
    if (!answer) return [];
    const caseId = stringValue(answer.caseId) ?? stringValue(answer.id);
    const text = stringValue(answer.text) ?? stringValue(answer.answer);
    if (caseId === null || text === null) return [];
    const source = stringValue(answer.source);
    return [
      {
        caseId,
        input: stringValue(answer.input) ?? "",
        text,
        usage: parseUsage(answer.usage),
        latencyMs: numberValue(answer.latencyMs),
        source: source === "user" || source === "generated" ? source : null,
        verification: asRecord(answer.verification),
        verificationEvidence: asRecord(answer.verificationEvidence),
      },
    ];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseTargetSelection(
  value: unknown,
): OptimizationTargetSelectionEvidence | null {
  const target = asRecord(value);
  const selection = asRecord(target?.selection);
  const capabilities = asRecord(target?.modelCapabilities);
  const selectionReason = stringValue(target?.selectionReason);
  const modelMode = stringValue(selection?.model);
  const effortMode = stringValue(selection?.reasoningEffort);
  if (
    !target ||
    !capabilities ||
    (modelMode !== "selected" && modelMode !== "auto") ||
    (effortMode !== "selected" && effortMode !== "auto")
  ) {
    return null;
  }
  const requestedModel = stringValue(target.requestedModel);
  const resolvedModel = stringValue(target.resolvedModel);
  const observedAt = stringValue(target.observedAt);
  const capabilitySource = stringValue(target.capabilitySource);
  const modelResolution = stringValue(target.modelResolution);
  const effortResolution = stringValue(target.effortResolution);
  if (
    requestedModel === null ||
    resolvedModel === null ||
    observedAt === null ||
    capabilitySource === null ||
    modelResolution === null ||
    effortResolution === null
  ) {
    return null;
  }
  return {
    selection: { model: modelMode, reasoningEffort: effortMode },
    requestedModel,
    resolvedModel,
    requestedReasoningEffort: stringValue(target.requestedReasoningEffort),
    resolvedReasoningEffort: stringValue(target.resolvedReasoningEffort),
    sentReasoningEffort: stringValue(target.sentReasoningEffort),
    modelResolution,
    effortResolution,
    capabilitySource,
    observedAt,
    modelCatalogPosition: numberValue(target.modelCatalogPosition),
    modelCatalogCount: numberValue(target.modelCatalogCount),
    modelCapabilities: {
      displayName: stringValue(capabilities.displayName) ?? "",
      defaultReasoningEffort:
        stringValue(capabilities.defaultReasoningEffort) ?? "",
      supportedReasoningEfforts: stringArray(
        capabilities.supportedReasoningEfforts,
      ),
      inputModalities: stringArray(capabilities.inputModalities),
    },
    ...(selectionReason !== null ? { selectionReason } : {}),
  };
}

function invariantStatus(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (["pass", "passed", "preserved", "succeeded"].includes(value)) return true;
  if (["fail", "failed", "violated", "rejected"].includes(value)) return false;
  return null;
}

function qualityVoteFromDecision(
  value: unknown,
): "old_better" | "new_better" | "equal" | "inconclusive" | null {
  if (value === "old_better" || value === "original_better")
    return "old_better";
  if (value === "new_better" || value === "candidate_better")
    return "new_better";
  return value === "equal" || value === "inconclusive" ? value : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseRevisionOutcome(
  value: unknown,
): OptimizationRevisionOutcome | null {
  return value === "candidate_ready" ||
    value === "incomplete" ||
    value === "no_change_recommended" ||
    value === "candidate_rejected"
    ? value
    : null;
}

function outcomeFromTestingStatus(
  value: unknown,
): OptimizationRevisionOutcome | null {
  return value === "ready"
    ? "candidate_ready"
    : value === "incomplete"
      ? "incomplete"
      : value === "rejected"
        ? "candidate_rejected"
        : null;
}

function parseCandidate(
  value: unknown,
  index: number,
  resultStatus: string | null,
): OptimizationCandidate | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const prompt = stringValue(candidate.prompt);
  if (prompt === null) return null;
  const metrics = asRecord(candidate.metrics);
  const testingStatus =
    candidate.testingStatus === "ready" ||
    candidate.testingStatus === "rejected" ||
    candidate.testingStatus === "incomplete"
      ? candidate.testingStatus
      : null;
  const outcome = hasOwn(candidate, "outcome")
    ? parseRevisionOutcome(candidate.outcome)
    : (outcomeFromTestingStatus(testingStatus) ??
      parseRevisionOutcome(resultStatus));

  return {
    id: stringValue(candidate.id) ?? `candidate-${index + 1}`,
    prompt,
    outcome,
    draftVersionId: stringValue(candidate.draftVersionId),
    testingStatus,
    evidenceBoundToPrompt: candidate.evidenceBoundToPrompt === true,
    evidenceEligible: candidate.evidenceEligible === true,
    changeSummary: stringValue(candidate.changeSummary),
    riskSummary: stringValue(candidate.riskSummary),
    invariantStatus: stringValue(candidate.invariantStatus),
    invariantsPreserved: invariantStatus(
      candidate.invariantsPreserved ?? candidate.invariantStatus,
    ),
    answers: parseAnswers(candidate.answers ?? candidate.caseResults),
    usage: parseUsage(candidate.aggregateUsage ?? metrics ?? candidate.usage),
    latencyMs: numberValue(
      candidate.totalTargetLatencyMs ??
        metrics?.latencyMs ??
        candidate.latencyMs,
    ),
  };
}

function sameCandidateRevision(
  left: OptimizationCandidate,
  right: OptimizationCandidate,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nullableCandidateId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseOptimizationResult(
  value: unknown,
  fallbackPrompt: string,
): OptimizationResult | null {
  const result = asRecord(value);
  const baseline = asRecord(result?.baseline);
  if (!result || !baseline) return null;
  const status = stringValue(result.status);
  const hasReviewableId = hasOwn(result, "reviewableCandidateId");
  const hasLatestId = hasOwn(result, "latestCandidateId");
  const hasExplicitSelection = hasReviewableId || hasLatestId;
  const hasCandidatesArray = Array.isArray(result.candidates);
  const candidateValues: unknown[] = Array.isArray(result.candidates)
    ? result.candidates.length === 0 &&
      !hasExplicitSelection &&
      result.candidate !== null &&
      result.candidate !== undefined
      ? [result.candidate]
      : result.candidates
    : result.candidate === null || result.candidate === undefined
      ? []
      : [result.candidate];
  const parsedCandidates = candidateValues.map((item, index) =>
    parseCandidate(item, index, status),
  );
  const candidates = parsedCandidates.filter(
    (candidate): candidate is OptimizationCandidate => candidate !== null,
  );
  const hasLegacyCandidate = hasOwn(result, "candidate");
  let selectionConsistent =
    candidates.length === candidateValues.length &&
    candidateValues.every((value) => {
      const candidate = asRecord(value);
      return typeof candidate?.id === "string" && candidate.id.length > 0;
    }) &&
    new Set(candidates.map((candidate) => candidate.id)).size ===
      candidates.length;
  let selectedCandidate: OptimizationCandidate | null = null;
  let reviewableCandidateId: string | null = null;
  let latestCandidateId = candidates.at(-1)?.id ?? null;

  if (hasExplicitSelection) {
    const declaredReviewableId = nullableCandidateId(
      result.reviewableCandidateId,
    );
    const declaredLatestId = nullableCandidateId(result.latestCandidateId);
    let explicitCandidatesAreValid =
      hasCandidatesArray &&
      hasReviewableId &&
      hasLatestId &&
      declaredReviewableId !== undefined &&
      declaredLatestId !== undefined &&
      candidates.length === candidateValues.length;

    for (let index = 0; index < candidateValues.length; index += 1) {
      const rawCandidate = asRecord(candidateValues[index]);
      const parsedCandidate = parsedCandidates[index];
      if (
        !rawCandidate ||
        !parsedCandidate ||
        typeof rawCandidate.id !== "string" ||
        rawCandidate.id.length === 0 ||
        !hasOwn(rawCandidate, "outcome") ||
        parseRevisionOutcome(rawCandidate.outcome) === null ||
        (parsedCandidate.outcome === "candidate_ready" &&
          parsedCandidate.testingStatus !== "ready")
      ) {
        explicitCandidatesAreValid = false;
      }
    }

    const expectedLatestId = candidates.at(-1)?.id ?? null;
    let expectedReviewableCandidate: OptimizationCandidate | null = null;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (
        candidate?.outcome === "candidate_ready" &&
        candidate.testingStatus === "ready" &&
        candidate.evidenceEligible
      ) {
        expectedReviewableCandidate = candidate;
        break;
      }
    }
    const expectedReviewableId = expectedReviewableCandidate?.id ?? null;

    selectionConsistent =
      selectionConsistent &&
      explicitCandidatesAreValid &&
      declaredLatestId === expectedLatestId &&
      declaredReviewableId === expectedReviewableId;
    latestCandidateId =
      declaredLatestId === undefined ? expectedLatestId : declaredLatestId;
    reviewableCandidateId =
      declaredReviewableId === undefined ? null : declaredReviewableId;

    if (hasLegacyCandidate) {
      const legacyValue = result.candidate;
      const targetCandidate =
        expectedReviewableCandidate ?? candidates.at(-1) ?? null;
      if (legacyValue === null || legacyValue === undefined) {
        if (targetCandidate) selectionConsistent = false;
      } else {
        const targetIndex = targetCandidate
          ? candidates.findIndex(
              (candidate) => candidate.id === targetCandidate.id,
            )
          : 0;
        const legacyCandidate = parseCandidate(
          legacyValue,
          Math.max(0, targetIndex),
          status,
        );
        if (
          !targetCandidate ||
          !legacyCandidate ||
          !sameCandidateRevision(legacyCandidate, targetCandidate)
        ) {
          selectionConsistent = false;
        }
      }
    }

    if (selectionConsistent && declaredReviewableId) {
      selectedCandidate =
        candidates.find((candidate) => candidate.id === declaredReviewableId) ??
        null;
    }
  } else if (hasCandidatesArray) {
    if (candidates.length > 0) {
      if (!hasLegacyCandidate || result.candidate === null) {
        selectionConsistent = false;
      } else {
        const rawLegacyCandidate = asRecord(result.candidate);
        const legacyIndex = rawLegacyCandidate
          ? candidates.findIndex(
              (candidate) =>
                candidate.id === stringValue(rawLegacyCandidate.id),
            )
          : -1;
        const legacyCandidate =
          legacyIndex < 0
            ? null
            : parseCandidate(result.candidate, legacyIndex, status);
        const matchingCandidate =
          legacyIndex < 0 ? null : (candidates[legacyIndex] ?? null);
        if (
          !rawLegacyCandidate ||
          typeof rawLegacyCandidate.id !== "string" ||
          !legacyCandidate ||
          !matchingCandidate ||
          !sameCandidateRevision(legacyCandidate, matchingCandidate)
        ) {
          selectionConsistent = false;
        } else if (
          selectionConsistent &&
          legacyCandidate.outcome === "candidate_ready" &&
          legacyCandidate.testingStatus === "ready"
        ) {
          selectedCandidate = matchingCandidate;
        }
      }
    }
    reviewableCandidateId = selectedCandidate?.id ?? null;
  } else {
    const legacyCandidate = candidates[0] ?? null;
    if (
      selectionConsistent &&
      legacyCandidate?.outcome === "candidate_ready" &&
      legacyCandidate.testingStatus === "ready" &&
      legacyCandidate.evidenceEligible
    ) {
      selectedCandidate = legacyCandidate;
      reviewableCandidateId = legacyCandidate.id;
    }
  }
  const optimizer = asRecord(result.optimizer ?? result.optimizationOverhead);
  const baselineMetrics = asRecord(baseline.metrics);

  return {
    status,
    baseline: {
      prompt: stringValue(baseline.prompt) ?? fallbackPrompt,
      answers: parseAnswers(baseline.answers ?? baseline.caseResults),
      usage: parseUsage(
        baseline.aggregateUsage ?? baselineMetrics ?? baseline.usage,
      ),
      latencyMs: numberValue(
        baseline.totalTargetLatencyMs ??
          baselineMetrics?.latencyMs ??
          baseline.latencyMs,
      ),
    },
    candidates,
    latestCandidateId,
    reviewableCandidateId,
    selectedCandidate,
    selectionConsistent,
    optimizer: {
      model:
        stringValue(optimizer?.model) ?? stringValue(optimizer?.requestedModel),
      calls: numberValue(optimizer?.calls),
      usage: parseUsage(optimizer?.usage),
      elapsedMs: numberValue(
        optimizer?.elapsedMs ?? optimizer?.providerElapsedMs,
      ),
    },
    optimizationOverheadMs: numberValue(
      result.optimizationOverheadMs ?? optimizer?.overheadMs,
    ),
    targetSelection: parseTargetSelection(result.targetSelection),
    qualityVote: qualityVoteFromDecision(result.qualityVote),
    qualityNote: stringValue(result.qualityNote),
  };
}
