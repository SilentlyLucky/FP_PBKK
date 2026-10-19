import {
  PromptOptimizationRequestSchema,
  RunRetrievalSelectionSchema,
} from "@promptlab/contracts";
import { isOptimizationCandidateEvidenceEligible } from "./evidence-manifest.js";

import {
  ExperimentPilotMetadataSchema,
  isExperimentPilotConfigurationValid,
  type ExperimentPilotMetadata,
} from "./experiment-metadata.js";

type JsonRecord = Record<string, unknown>;

export interface ExperimentAcceptanceRun {
  id: string;
  projectId: string;
  status: string;
  promptVersionId: string | null;
  provider: string;
  purpose: string;
  requestedModel: string;
  configSnapshot: Record<string, unknown>;
}

export interface ExperimentAcceptanceEvent {
  projectId: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  eventType: string;
  payload: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as JsonRecord;
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
  if (leftRecord || rightRecord) {
    if (!leftRecord || !rightRecord) return false;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      sameJson(leftKeys, rightKeys) &&
      leftKeys.every((key) => sameJson(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
}

function isRecordArray(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(asRecord);
  return records.every((record) => record !== null)
    ? (records as JsonRecord[])
    : null;
}

function sameSentEffort(action: JsonRecord, sentEffort: unknown): boolean {
  const actionEffort = action.reasoningEffort;
  return sentEffort === null
    ? actionEffort === undefined || actionEffort === null
    : actionEffort === sentEffort;
}

function hasPassedVerification(
  evidenceValue: unknown,
  verificationValue: unknown,
): boolean {
  const evidence = asRecord(evidenceValue);
  const verification = asRecord(verificationValue);
  if (
    !evidence ||
    !verification ||
    evidence.kind !== verification.kind ||
    evidence.status !== "passed"
  ) {
    return false;
  }

  if (verification.kind === "divisibility") {
    const expected = asRecord(verification.expected);
    const actual = asRecord(evidence.actual);
    return Boolean(
      evidence.reasonCode === null &&
      expected &&
      actual &&
      sameJson(evidence.expected, expected) &&
      sameJson(evidence.reference, expected) &&
      sameJson(actual, expected),
    );
  }

  if (verification.kind === "python_tests") {
    const expectedTests = isRecordArray(verification.tests);
    const actualFixtures = isRecordArray(evidence.fixtures);
    const execution = asRecord(evidence.execution);
    if (
      !expectedTests ||
      !actualFixtures ||
      !execution ||
      execution.status !== "passed" ||
      expectedTests.length !== actualFixtures.length
    ) {
      return false;
    }
    return expectedTests.every((expected) => {
      const fixture = actualFixtures.find((item) => item.id === expected.id);
      return Boolean(
        fixture &&
        fixture.expectedOutput === expected.expectedOutput &&
        fixture.referenceOutput === expected.expectedOutput &&
        fixture.expectedMatchesReference === true &&
        fixture.actualOutput === expected.expectedOutput &&
        fixture.status === "passed" &&
        fixture.reasonCode === null,
      );
    });
  }

  return false;
}

function hasValidFailedVerification(
  evidenceValue: unknown,
  verificationValue: unknown,
): boolean {
  const evidence = asRecord(evidenceValue);
  const verification = asRecord(verificationValue);
  if (
    !evidence ||
    !verification ||
    evidence.kind !== verification.kind ||
    evidence.status !== "failed"
  ) {
    return false;
  }

  if (verification.kind === "divisibility") {
    const expected = asRecord(verification.expected);
    const actual = asRecord(evidence.actual);
    const actualHasExpectedShape = Boolean(
      actual &&
      typeof actual.count === "string" &&
      typeof actual.sum === "string" &&
      sameJson(Object.keys(actual).sort(), ["count", "sum"]),
    );
    return Boolean(
      expected &&
      sameJson(evidence.expected, expected) &&
      sameJson(evidence.reference, expected) &&
      ((evidence.actual === null &&
        evidence.reasonCode ===
          "answer_must_be_a_json_object_with_exact_count_and_sum") ||
        (actualHasExpectedShape &&
          !sameJson(actual, expected) &&
          evidence.reasonCode === "answer_does_not_match_expected_values")),
    );
  }

  if (verification.kind === "python_tests") {
    const expectedTests = isRecordArray(verification.tests);
    const actualFixtures = isRecordArray(evidence.fixtures);
    const execution = asRecord(evidence.execution);
    const executionFailureCodes = [
      "candidate_answer_missing",
      "candidate_code_ambiguous",
      "candidate_execution_error",
      "candidate_execution_timeout",
      "sandbox_output_limit",
    ];
    if (
      !expectedTests ||
      !actualFixtures ||
      !execution ||
      (execution.status !== "passed" && execution.status !== "failed") ||
      (execution.status === "passed" && execution.reasonCode !== null) ||
      (execution.status === "failed" &&
        (typeof execution.reasonCode !== "string" ||
          !executionFailureCodes.includes(execution.reasonCode))) ||
      expectedTests.length !== actualFixtures.length
    ) {
      return false;
    }

    let hasFailedFixture = false;
    let hasExecutionFailure = false;
    const fixturesAreValid = expectedTests.every((expected) => {
      const fixture = actualFixtures.find((item) => item.id === expected.id);
      if (
        !fixture ||
        fixture.expectedOutput !== expected.expectedOutput ||
        fixture.referenceOutput !== expected.expectedOutput ||
        fixture.expectedMatchesReference !== true
      ) {
        return false;
      }

      if (
        fixture.status === "passed" &&
        fixture.actualOutput === expected.expectedOutput &&
        fixture.reasonCode === null
      ) {
        return true;
      }

      if (
        fixture.status === "failed" &&
        typeof fixture.actualOutput === "string" &&
        fixture.actualOutput !== expected.expectedOutput &&
        fixture.reasonCode === "candidate_output_does_not_match_expected"
      ) {
        hasFailedFixture = true;
        hasExecutionFailure = true;
        return true;
      }

      if (
        fixture.status === "failed" &&
        fixture.actualOutput === null &&
        (fixture.reasonCode === "candidate_execution_error" ||
          fixture.reasonCode === "candidate_execution_timeout") &&
        execution.status === "failed"
      ) {
        hasFailedFixture = true;
        return true;
      }

      return false;
    });
    return (
      fixturesAreValid &&
      hasFailedFixture &&
      (execution.status === "passed" || hasExecutionFailure)
    );
  }

  return false;
}

function isCompleteCaseResult(
  value: unknown,
  expectedCase: JsonRecord,
  allowValidFailure = false,
): value is JsonRecord {
  const result = asRecord(value);
  if (
    !result ||
    result.id !== expectedCase.id ||
    result.input !== expectedCase.input ||
    result.source !== "user" ||
    typeof result.answer !== "string" ||
    !asRecord(result.usage) ||
    (result.latencyMs !== null &&
      (typeof result.latencyMs !== "number" ||
        !Number.isFinite(result.latencyMs) ||
        result.latencyMs < 0)) ||
    !sameJson(result.verification, expectedCase.verification)
  ) {
    return false;
  }

  return expectedCase.verification === undefined
    ? result.verificationEvidence === null
    : hasPassedVerification(
        result.verificationEvidence,
        expectedCase.verification,
      ) ||
        (allowValidFailure &&
          hasValidFailedVerification(
            result.verificationEvidence,
            expectedCase.verification,
          ));
}

function evaluationMatches(
  event: ExperimentAcceptanceEvent,
  subject: "baseline" | "candidate",
  subjectId: string,
  results: JsonRecord[],
): boolean {
  const payload = asRecord(event.payload);
  const evaluated = isRecordArray(payload?.caseResults);
  if (
    !payload ||
    !evaluated ||
    payload.mode !== "prompt_optimization" ||
    payload.subject !== subject ||
    payload.subjectId !== subjectId ||
    evaluated.length !== results.length
  ) {
    return false;
  }
  return results.every((result, index) => {
    const evaluation = evaluated[index]!;
    return (
      evaluation.caseId === result.id &&
      evaluation.text === result.answer &&
      sameJson(
        {
          id: evaluation.id,
          input: evaluation.input,
          source: evaluation.source,
          verification: evaluation.verification,
          answer: evaluation.answer,
          verificationEvidence: evaluation.verificationEvidence,
        },
        {
          id: result.id,
          input: result.input,
          source: result.source,
          verification: result.verification,
          answer: result.answer,
          verificationEvidence: result.verificationEvidence,
        },
      )
    );
  });
}

function evaluationSourcesMatchPilot(
  metadata: ExperimentPilotMetadata,
  candidate: JsonRecord,
): boolean {
  const evaluationManifest = asRecord(candidate.evaluationManifest);
  const sources = isRecordArray(evaluationManifest?.sourceManifest);
  if (!evaluationManifest || !sources) return false;
  const expected = metadata.sources
    .map((source) => ({
      documentId: source.id,
      documentVersionId: source.versionId,
      documentVersion: source.version,
      checksum: source.checksum,
    }))
    .sort((left, right) =>
      left.documentVersionId.localeCompare(right.documentVersionId),
    );
  return sameJson(sources, expected);
}

function evaluationArmMatchesPilot(
  metadata: ExperimentPilotMetadata,
  candidate: JsonRecord,
): boolean {
  const evaluationManifest = asRecord(candidate.evaluationManifest);
  const evidencePacks = isRecordArray(evaluationManifest?.evidencePacks);
  const pack = evidencePacks?.[0];
  if (
    !evaluationManifest ||
    !evidencePacks ||
    evidencePacks.length !== 1 ||
    !pack
  ) {
    return false;
  }

  const expectedStrategy =
    metadata.arm === "original"
      ? "none"
      : metadata.arm === "rag"
        ? "lexical"
        : "graph";
  const expectedSnapshotId =
    metadata.arm === "graphrag" ? metadata.activeSnapshotId : null;
  return (
    pack.requestedStrategy === expectedStrategy &&
    pack.strategyUsed === expectedStrategy &&
    pack.selectedSnapshotId === expectedSnapshotId &&
    pack.usedSnapshotId === expectedSnapshotId &&
    pack.fallbackReason === null &&
    sameJson(
      [
        ...(Array.isArray(pack.selectedSourceIds)
          ? pack.selectedSourceIds
          : []),
      ].sort(),
      metadata.sources.map((source) => source.id).sort(),
    )
  );
}

/**
 * Accept only a successful, same-attempt pair backed by stored target calls,
 * evaluation events, the frozen execution snapshot, and the completed result.
 */
export function hasExperimentAcceptanceEvidence(input: {
  projectId: string;
  experimentId: string;
  run: ExperimentAcceptanceRun;
  metadata: unknown;
  events: readonly ExperimentAcceptanceEvent[];
}): boolean {
  const metadataResult = ExperimentPilotMetadataSchema.safeParse(
    input.metadata,
  );
  if (
    !metadataResult.success ||
    !isExperimentPilotConfigurationValid(metadataResult.data) ||
    input.run.projectId !== input.projectId ||
    input.run.id !== input.experimentId ||
    input.run.status !== "succeeded"
  ) {
    return false;
  }
  const metadata = metadataResult.data;

  if (
    input.run.promptVersionId !== metadata.promptVersionId ||
    input.run.provider !== "codex_app_server" ||
    input.run.purpose !== "target" ||
    input.run.requestedModel !== metadata.requestedModel
  ) {
    return false;
  }

  const rawEffort = input.run.configSnapshot.reasoningEffort;
  const frozenEffort =
    rawEffort === undefined || rawEffort === null
      ? null
      : typeof rawEffort === "string"
        ? rawEffort
        : undefined;
  const retrieval = RunRetrievalSelectionSchema.safeParse(
    input.run.configSnapshot.retrieval,
  );
  const optimization = PromptOptimizationRequestSchema.safeParse(
    input.run.configSnapshot.optimization,
  );
  if (
    frozenEffort === undefined ||
    frozenEffort !== metadata.reasoningEffort ||
    !retrieval.success ||
    !sameJson(retrieval.data, metadata.retrieval) ||
    !optimization.success ||
    optimization.data.maxIterations !== 1 ||
    optimization.data.testCases.length !== 1 ||
    optimization.data.testCases[0]?.id !== metadata.caseId ||
    optimization.data.testCases[0]?.input !== metadata.input
  ) {
    return false;
  }

  const expectedCase: JsonRecord = {
    id: metadata.caseId,
    input: metadata.input,
    source: "user",
    ...(optimization.data.testCases[0]?.verification
      ? { verification: optimization.data.testCases[0].verification }
      : {}),
  };
  const snapshot = asRecord(
    input.run.configSnapshot.optimizationExecutionSnapshot,
  );
  const snapshotCases = isRecordArray(snapshot?.testCases);
  const snapshotSources = snapshot?.sourceIds;
  const snapshotHistory = isRecordArray(snapshot?.history);
  if (
    !snapshot ||
    snapshot.preflightComplete !== true ||
    !snapshotCases ||
    snapshotCases.length !== 1 ||
    !sameJson(snapshotCases[0], expectedCase) ||
    !Array.isArray(snapshotSources) ||
    !sameJson(
      [...snapshotSources].sort(),
      [...metadata.retrieval.sourceIds].sort(),
    ) ||
    snapshot.retrievalStrategy !== metadata.retrieval.strategy ||
    snapshot.graphSnapshotId !== (metadata.retrieval.snapshotId ?? null) ||
    !snapshotHistory ||
    !snapshotHistory.every(
      (item) => typeof item.id === "string" && typeof item.summary === "string",
    )
  ) {
    return false;
  }

  const scopedEvents = input.events
    .filter(
      (event) =>
        event.projectId === input.projectId &&
        event.runId === input.experimentId,
    )
    .filter((event) => Number.isInteger(event.sequence) && event.sequence > 0)
    .sort((left, right) => left.sequence - right.sequence);
  const completion = scopedEvents
    .filter((event) => event.eventType === "run.completed")
    .at(-1);
  const attemptId = completion?.attemptId;
  const completionPayload = asRecord(completion?.payload);
  if (
    !completion ||
    !attemptId ||
    !completionPayload ||
    completionPayload.status !== "succeeded" ||
    completionPayload.mode !== "prompt_optimization" ||
    completionPayload.requestedModel !== metadata.requestedModel
  ) {
    return false;
  }

  const attemptEvents = scopedEvents.filter(
    (event) =>
      event.attemptId === attemptId && event.sequence < completion.sequence,
  );
  const result = asRecord(completionPayload.result);
  const baseline = asRecord(result?.baseline);
  const candidate = asRecord(result?.candidate);
  const baselineCases = isRecordArray(baseline?.caseResults);
  const candidateCases = isRecordArray(candidate?.caseResults);
  const targetSelection = asRecord(result?.targetSelection);
  const frozenTargetSelection = asRecord(snapshot.targetSelection);
  const actionEvents = attemptEvents.filter((event) => {
    const payload = asRecord(event.payload);
    return (
      payload?.mode === "prompt_optimization" && payload.phase === "target_test"
    );
  });
  const usageEvents = attemptEvents.filter((event) => {
    const payload = asRecord(event.payload);
    return (
      payload?.mode === "prompt_optimization" &&
      payload.provider === "codex_app_server" &&
      payload.purpose === "target" &&
      payload.caseId === metadata.caseId &&
      payload.source === "user" &&
      (payload.subject === "baseline" || payload.subject === "candidate")
    );
  });
  const evaluationEvents = attemptEvents.filter(
    (event) =>
      event.eventType === "evaluation.result" &&
      asRecord(event.payload)?.mode === "prompt_optimization",
  );

  if (
    result?.status !== "candidate_ready" ||
    result.clarificationRequired !== false ||
    !baseline ||
    baseline.prompt !== metadata.baselinePrompt ||
    !candidate ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.prompt !== "string" ||
    candidate.prompt.length === 0 ||
    candidate.testingStatus !== "ready" ||
    candidate.evidenceBoundToPrompt !== true ||
    typeof candidate.id !== "string" ||
    !isOptimizationCandidateEvidenceEligible({
      runId: input.experimentId,
      runStatus: input.run.status,
      runConfigSnapshot: input.run.configSnapshot,
      completionAttemptId: completion.attemptId,
      completionPayload,
      candidateId: candidate.id,
    }) ||
    !evaluationSourcesMatchPilot(metadata, candidate) ||
    !evaluationArmMatchesPilot(metadata, candidate) ||
    candidate.invariantStatus === "violated" ||
    candidate.invariantsPreserved === false ||
    !asRecord(result.comparison) ||
    !baselineCases ||
    !candidateCases ||
    baselineCases.length !== 1 ||
    candidateCases.length !== 1 ||
    !isCompleteCaseResult(baselineCases[0], expectedCase, true) ||
    !isCompleteCaseResult(candidateCases[0], expectedCase) ||
    !targetSelection ||
    !frozenTargetSelection ||
    !sameJson(targetSelection, frozenTargetSelection) ||
    !sameJson(completionPayload.targetSelection, targetSelection) ||
    targetSelection.requestedModel !== metadata.requestedModel ||
    targetSelection.requestedReasoningEffort !== metadata.reasoningEffort ||
    typeof targetSelection.resolvedModel !== "string" ||
    targetSelection.resolvedModel.length === 0 ||
    targetSelection.resolvedModel !== completionPayload.resolvedModel ||
    targetSelection.sentReasoningEffort !== completionPayload.reasoningEffort ||
    actionEvents.length !== 2 ||
    usageEvents.length !== 2 ||
    evaluationEvents.length !== 2
  ) {
    return false;
  }

  const baselineUsage = usageEvents.find(
    (event) => asRecord(event.payload)?.subject === "baseline",
  );
  const candidateUsage = usageEvents.find(
    (event) => asRecord(event.payload)?.subject === "candidate",
  );
  const baselineEvaluation = evaluationEvents.find((event) => {
    const payload = asRecord(event.payload);
    return payload?.subject === "baseline" && payload.subjectId === "baseline";
  });
  const candidateEvaluation = evaluationEvents.find((event) => {
    const payload = asRecord(event.payload);
    return (
      payload?.subject === "candidate" && payload.subjectId === candidate.id
    );
  });
  const baselineUsagePayload = asRecord(baselineUsage?.payload);
  const candidateUsagePayload = asRecord(candidateUsage?.payload);
  const [baselineAction, candidateAction] = actionEvents;
  const baselineActionPayload = asRecord(baselineAction?.payload);
  const candidateActionPayload = asRecord(candidateAction?.payload);
  const selection = asRecord(targetSelection.selection);
  const sentEffort = targetSelection.sentReasoningEffort;

  if (
    !baselineUsage ||
    !candidateUsage ||
    !baselineEvaluation ||
    !candidateEvaluation ||
    !baselineUsagePayload ||
    !candidateUsagePayload ||
    !baselineAction ||
    !candidateAction ||
    !baselineActionPayload ||
    !candidateActionPayload ||
    !selection ||
    typeof baselineUsagePayload.responseId !== "string" ||
    baselineUsagePayload.responseId.length === 0 ||
    typeof candidateUsagePayload.responseId !== "string" ||
    candidateUsagePayload.responseId.length === 0 ||
    baselineUsagePayload.responseId === candidateUsagePayload.responseId ||
    baselineUsagePayload.responseModel !==
      candidateUsagePayload.responseModel ||
    baselineActionPayload.caseId !== metadata.caseId ||
    candidateActionPayload.caseId !== metadata.caseId ||
    baselineActionPayload.source !== "user" ||
    candidateActionPayload.source !== "user" ||
    baselineActionPayload.model !== targetSelection.resolvedModel ||
    candidateActionPayload.model !== targetSelection.resolvedModel ||
    baselineActionPayload.modelSelection !== selection.model ||
    candidateActionPayload.modelSelection !== selection.model ||
    baselineActionPayload.effortSelection !== selection.reasoningEffort ||
    candidateActionPayload.effortSelection !== selection.reasoningEffort ||
    !sameSentEffort(baselineActionPayload, sentEffort) ||
    !sameSentEffort(candidateActionPayload, sentEffort) ||
    !evaluationMatches(
      baselineEvaluation,
      "baseline",
      "baseline",
      baselineCases,
    ) ||
    !evaluationMatches(
      candidateEvaluation,
      "candidate",
      candidate.id,
      candidateCases,
    ) ||
    !(
      baselineAction.sequence < baselineUsage.sequence &&
      baselineUsage.sequence < baselineEvaluation.sequence &&
      baselineEvaluation.sequence < candidateAction.sequence &&
      candidateAction.sequence < candidateUsage.sequence &&
      candidateUsage.sequence < candidateEvaluation.sequence &&
      candidateEvaluation.sequence < completion.sequence
    )
  ) {
    return false;
  }

  return true;
}
