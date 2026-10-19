import {
  ControlledEvaluationReportSchema,
  type ControlledEvaluationRequest,
} from "@promptlab/contracts";
import { isControlledEvaluationReportIntact } from "./controlled-evaluation.js";

import { parseStoredControlledEvaluationMetadata } from "./experiment-metadata.js";
import type {
  ExperimentAcceptanceEvent,
  ExperimentAcceptanceRun,
} from "./experiment-acceptance.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
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

export function hasControlledEvaluationAcceptanceEvidence(input: {
  experimentId: string;
  run: ExperimentAcceptanceRun;
  markerMetadata: unknown;
  events: readonly ExperimentAcceptanceEvent[];
  baselinePrompt: string;
  candidatePrompt: string;
}): boolean {
  const metadata = parseStoredControlledEvaluationMetadata(
    input.markerMetadata,
  );
  const configured = parseStoredControlledEvaluationMetadata(
    input.run.configSnapshot.controlledEvaluation,
  );
  if (
    input.run.status !== "succeeded" ||
    input.run.id !== input.experimentId ||
    input.run.provider !== "codex_app_server" ||
    input.run.purpose !== "target" ||
    !metadata ||
    !configured ||
    !sameJson(metadata, configured) ||
    input.run.promptVersionId !== metadata.baselinePromptVersionId
  ) {
    return false;
  }

  const completions = input.events.filter(
    (event) =>
      event.projectId === input.run.projectId &&
      event.runId === input.experimentId &&
      event.eventType === "run.completed",
  );
  if (completions.length !== 1) return false;
  const completionEvent = completions[0]!;
  const completion = asRecord(completionEvent.payload);
  const report = ControlledEvaluationReportSchema.safeParse(
    completion?.controlledEvaluation,
  );
  if (
    !completion ||
    completion.status !== "succeeded" ||
    completion.mode !== "controlled_evaluation" ||
    !completionEvent.attemptId ||
    !report.success ||
    !isControlledEvaluationReportIntact({
      request: metadata,
      report: report.data,
      runId: input.experimentId,
      attemptId: completionEvent.attemptId,
      baselinePrompt: input.baselinePrompt,
      candidatePrompt: input.candidatePrompt,
    }) ||
    report.data.status !== "complete"
  ) {
    return false;
  }

  return report.data.pairs.every((pair) => {
    if (
      pair.baseline.status !== "succeeded" ||
      pair.candidate.status !== "succeeded"
    ) {
      return false;
    }
    const testCase = metadata.cases.find((item) => item.id === pair.caseId);
    if (!testCase?.verification) return true;
    return pair.candidate.verificationEvidence?.status === "passed";
  });
}

export function controlledEvaluationPromptVersionIds(value: unknown): string[] {
  const metadata = parseStoredControlledEvaluationMetadata(value);
  return metadata
    ? [metadata.baselinePromptVersionId, metadata.candidatePromptVersionId]
    : [];
}

export function controlledEvaluationMetadataRecord(
  value: unknown,
): ControlledEvaluationRequest | null {
  return parseStoredControlledEvaluationMetadata(value);
}
