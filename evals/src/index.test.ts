import { describe, expect, it } from "vitest";

import {
  buildPairedRepeatedReport,
  freezeExperimentSchedule,
  toOptimizerVisibleCase,
  type EvaluationObservation,
} from "./index.js";

const digest = "a".repeat(64);

function manifest() {
  return freezeExperimentSchedule({
    projectId: "project",
    datasetId: "dataset",
    datasetVersionId: "dataset-v1",
    datasetVersionHash: digest,
    split: "development",
    cases: [
      {
        caseId: "case-b",
        inputHash: "b".repeat(64),
        split: "development",
        sourceIds: [],
      },
      {
        caseId: "case-a",
        inputHash: "c".repeat(64),
        split: "development",
        sourceIds: [],
      },
    ],
    repeats: 2,
    promptVersionId: "prompt-v1",
    promptHash: "d".repeat(64),
    target: {
      provider: "fixture",
      requestedModel: "offline-fixture",
      reasoningEffort: null,
      policyHash: "e".repeat(64),
    },
    retrieval: {
      sourceIds: [],
      sourceManifestHash: null,
      graphSnapshotId: null,
    },
  });
}

describe("evaluation isolation and paired reports", () => {
  it("serializes only optimizer-safe fields from a holdout case", () => {
    const storedCase = {
      caseId: "held-1",
      input: "A unit test fixture input.",
      split: "holdout" as const,
      sourceIds: ["source-1"],
      goldAnswer: "private fixture label",
      rubric: { answer: "private rubric" },
    };

    const visible = toOptimizerVisibleCase(storedCase);
    expect(visible).toEqual({
      input: "A unit test fixture input.",
      sourceIds: ["source-1"],
    });
    expect(JSON.stringify(visible)).not.toContain("private fixture label");
    expect(JSON.stringify(visible)).not.toContain("private rubric");
    expect(JSON.stringify(visible)).not.toContain("held-1");
    expect(JSON.stringify(visible)).not.toContain("holdout");
  });

  it("freezes stable paired cells across three arms and repeated runs", () => {
    const first = manifest();
    const second = manifest();
    expect(first).toEqual(second);
    expect(first.cells).toHaveLength(12);
    for (const caseId of ["case-a", "case-b"]) {
      for (const repeat of [1, 2]) {
        expect(
          first.cells
            .filter((cell) => cell.caseId === caseId && cell.repeat === repeat)
            .map((cell) => cell.arm),
        ).toEqual(["A", "R", "G"]);
      }
    }
  });

  it("creates a deterministic case-paired repeated report and leaves corpus gates explicit", () => {
    const frozen = manifest();
    const observations: EvaluationObservation[] = [];
    for (const caseId of ["case-a", "case-b"]) {
      for (const repeat of [1, 2]) {
        observations.push(
          {
            caseId,
            arm: "A",
            repeat,
            status: "succeeded",
            score: 80,
            criticalConstraintsPassed: true,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            durationMs: null,
            responseId: null,
          },
          {
            caseId,
            arm: "R",
            repeat,
            status: "succeeded",
            score: 82,
            criticalConstraintsPassed: true,
            inputTokens: null,
            outputTokens: 13,
            cacheReadTokens: null,
            durationMs: null,
            responseId: "response-r",
          },
          {
            caseId,
            arm: "G",
            repeat,
            status: "unavailable",
            score: null,
            criticalConstraintsPassed: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            durationMs: null,
            responseId: null,
            unavailableReason: "graph_unavailable",
          },
        );
      }
    }

    const input = {
      manifest: frozen,
      observations,
      datasetCounts: { development: 2, holdout: 0 },
    };
    const report = buildPairedRepeatedReport(input);
    expect(buildPairedRepeatedReport(input)).toEqual(report);
    expect(report.comparisons).toMatchObject([
      {
        candidate: "R",
        pairedCases: 2,
        meanScoreDelta: 2,
        confidence95: { lower: 2, upper: 2 },
        outcome: "inconclusive",
      },
      {
        candidate: "G",
        pairedCases: 0,
        meanScoreDelta: null,
        outcome: "inconclusive",
      },
    ]);
    expect(report.arms.find((arm) => arm.arm === "G")).toMatchObject({
      unavailableCells: 4,
      meanScore: null,
    });
    expect(report.corpusGate).toEqual({
      developmentCases: 2,
      holdoutCases: 0,
      developmentReady: false,
      holdoutReady: false,
    });
  });
});
