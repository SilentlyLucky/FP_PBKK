import { describe, expect, it } from "vitest";
import { ControlledEvaluationRequestSchema } from "@promptlab/contracts";
import type {
  ControlledEvaluationPair,
  ControlledEvaluationReport,
} from "@promptlab/contracts";
import type {
  ControlledEvaluationRecord,
  ExperimentPilotRecord,
} from "@/lib/experiment-pilot";
import {
  assessControlledPair,
  canAcceptControlledEvaluation,
  experimentHistoryLabel,
  parseControlledCaseDraft,
  parseControlledEvaluationReport,
} from "./controlled-evaluation-ui";

const runId = "00000000-0000-4000-8000-000000000001";
const attemptId = "00000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64);

function pair(
  caseId: string,
  judgment: ControlledEvaluationPair["judgment"],
): ControlledEvaluationPair {
  const answer: ControlledEvaluationPair["baseline"] = {
    status: "succeeded",
    promptHash: hash,
    requestHash: hash,
    contextHash: hash,
    answerHash: hash,
    responseId: null,
    responseModel: "codex-test",
    provider: "codex_app_server",
    text: "Jawaban tersimpan",
    usage: null,
    latencyMs: 12,
    errorCode: null,
    verificationEvidence: null,
  };
  return {
    arm: "original",
    caseId,
    split: caseId === "holdout-1" ? "holdout" : "development",
    inputHash: hash,
    contextHash: hash,
    pairConfigHash: hash,
    baseline: answer,
    candidate: { ...answer },
    judgment,
  };
}

function controlledReport(): ControlledEvaluationReport {
  const pairs = [
    pair("development-1", "subjective"),
    pair("holdout-1", "subjective"),
  ];
  const evidencePack = (caseId: string) => ({
    caseId,
    requestedStrategy: "none" as const,
    strategyUsed: "none" as const,
    selectedSnapshotId: null,
    usedSnapshotId: null,
    fallbackReason: null,
    selectedSourceIds: [],
    sourceManifest: [],
    contextText: "",
    contextHash: hash,
    evidence: [],
    graphPaths: [],
    estimatedContextTokens: 0,
    contextBudgetTokens: 0,
    clipping: {},
  });
  return {
    mode: "controlled_evaluation",
    status: "complete",
    runId,
    attemptId,
    configurationHash: hash,
    baselinePromptHash: hash,
    candidatePromptHash: "b".repeat(64),
    expectedRequestCount: 4,
    optimizerLineage: { status: "not_used", calls: 0, overheadMs: null },
    pairs,
    manifest: {
      format: "promptlab-controlled-evaluation-manifest-v1",
      manifestHash: hash,
      runId,
      attemptId,
      configurationHash: hash,
      baselinePromptHash: hash,
      candidatePromptHash: "b".repeat(64),
      cases: [
        {
          caseId: "development-1",
          split: "development",
          inputHash: hash,
          inputCharacters: 5,
          labelHash: null,
          verificationHash: null,
        },
        {
          caseId: "holdout-1",
          split: "holdout",
          inputHash: hash,
          inputCharacters: 5,
          labelHash: null,
          verificationHash: null,
        },
      ],
      arms: [
        {
          arm: "original",
          configurationHash: hash,
          requestedModel: "codex-test",
          reasoningEffort: null,
          retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
          sources: [],
          evidencePacks: [
            evidencePack("development-1"),
            evidencePack("holdout-1"),
          ],
        },
      ],
      pairs,
    },
  };
}

function controlledExperiment(
  selectedRunId = runId,
): Pick<ControlledEvaluationRecord, "runId" | "metadata"> {
  return {
    runId: selectedRunId,
    metadata: ControlledEvaluationRequestSchema.parse({
      mode: "controlled_evaluation",
      format: "promptlab-controlled-evaluation-v1",
      datasetName: "Paired test dataset",
      datasetVersion: "v1",
      promptId: "00000000-0000-4000-8000-000000000003",
      baselinePromptVersionId: "00000000-0000-4000-8000-000000000004",
      baselinePromptHash: hash,
      candidatePromptVersionId: "00000000-0000-4000-8000-000000000005",
      candidatePromptHash: "b".repeat(64),
      cases: [
        { id: "development-1", split: "development", input: "dev01" },
        { id: "holdout-1", split: "holdout", input: "hold1" },
      ],
      arms: [
        {
          arm: "original",
          provider: "codex_app_server",
          requestedModel: "codex-test",
          reasoningEffort: null,
          retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
          sources: [],
        },
      ],
    }),
  };
}

describe("controlled evaluation UI evidence", () => {
  it("parses valid development and holdout cases and defaults evaluator labels safely", () => {
    const parsed = parseControlledCaseDraft(
      JSON.stringify([
        { id: "dev-1", split: "development", input: "Pertanyaan dev" },
        { id: "holdout-1", split: "holdout", input: "Pertanyaan holdout" },
      ]),
    );

    expect(parsed.error).toBeNull();
    expect(parsed.cases).toHaveLength(2);
    expect(parsed.cases?.[1]?.label).toBeNull();
  });

  it("rejects duplicate IDs and a dataset missing one split", () => {
    const duplicate = parseControlledCaseDraft(
      JSON.stringify([
        { id: "same", split: "development", input: "A" },
        { id: "same", split: "holdout", input: "B" },
      ]),
    );
    const missingHoldout = parseControlledCaseDraft(
      JSON.stringify([
        { id: "dev-1", split: "development", input: "A" },
        { id: "dev-2", split: "development", input: "B" },
      ]),
    );

    expect(duplicate.cases).toBeNull();
    expect(duplicate.error).toContain("unik");
    expect(missingHoldout.cases).toBeNull();
    expect(missingHoldout.error).toContain("holdout");
  });

  it("accepts only a schema-valid completion for the selected run", () => {
    const report = controlledReport();
    const experiment = controlledExperiment();

    expect(parseControlledEvaluationReport(report, experiment)).toEqual(report);
    expect(
      parseControlledEvaluationReport(
        { ...report, expectedRequestCount: report.pairs.length },
        experiment,
      ),
    ).toBeNull();
    expect(
      parseControlledEvaluationReport(report, {
        ...experiment,
        runId: attemptId,
      }),
    ).toBeNull();
    expect(
      parseControlledEvaluationReport({ ...report, pairs: [] }, experiment),
    ).toBeNull();
  });

  it("shows missing, subjective, and failed pairs without claiming general quality", () => {
    const subjective = assessControlledPair(
      pair("development-1", "subjective"),
    );
    const failed = assessControlledPair(
      pair("development-1", "candidate_failed"),
    );
    const missing = assessControlledPair(undefined);
    const missingHash = pair("development-1", "subjective");
    missingHash.candidate.answerHash = null;

    expect(subjective.kind).toBe("subjective");
    expect(subjective.label).toBe("Perlu tinjauan manusia");
    expect(failed.kind).toBe("failed");
    expect(failed.label).toBe("Validator kandidat gagal");
    expect(missing.kind).toBe("missing");
    expect(assessControlledPair(missingHash).kind).toBe("inconclusive");
  });

  it("enables acceptance only for successful runs that the server marks eligible", () => {
    expect(
      canAcceptControlledEvaluation({
        status: "succeeded",
        evidenceEligible: true,
      }),
    ).toBe(true);
    expect(
      canAcceptControlledEvaluation({
        status: "succeeded",
        evidenceEligible: false,
      }),
    ).toBe(false);
    expect(
      canAcceptControlledEvaluation({
        status: "failed",
        evidenceEligible: true,
      }),
    ).toBe(false);
  });

  it("keeps both modes identifiable in the shared history list", () => {
    const controlled = {
      mode: "controlled_evaluation",
      metadata: {
        datasetName: "Paket validasi",
        datasetVersion: "v2",
        cases: [{}, {}],
        arms: [{ arm: "original" }, { arm: "rag" }],
      },
    } as unknown as ControlledEvaluationRecord;
    const pilot = {
      mode: "pilot",
      metadata: { datasetName: "Eksplorasi", datasetVersion: "v1", arm: "rag" },
    } as unknown as ExperimentPilotRecord;

    expect(experimentHistoryLabel(controlled)).toContain(
      "Batch 2 kasus · Original / RAG",
    );
    expect(experimentHistoryLabel(pilot)).toContain("Pilot · RAG");
  });
});
