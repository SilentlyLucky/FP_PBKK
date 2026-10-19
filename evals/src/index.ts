import { createHash } from "node:crypto";

export const REQUIRED_CORPUS_COUNTS = {
  development: 20,
  holdout: 40,
} as const;

export const EXPERIMENT_ARMS = ["A", "R", "G"] as const;
export type ExperimentArm = (typeof EXPERIMENT_ARMS)[number];
export type EvaluationSplit = "development" | "holdout";

export interface OptimizerVisibleCase {
  input: string;
  sourceIds: string[];
}

/**
 * Project a stored case onto the only fields an optimizer/tool may receive.
 * Deliberately selects properties instead of deleting known label fields so
 * future private annotations cannot accidentally cross this boundary.
 */
export function toOptimizerVisibleCase(input: {
  caseId: string;
  input: string;
  split: EvaluationSplit;
  sourceIds?: readonly string[];
  [privateField: string]: unknown;
}): OptimizerVisibleCase {
  return {
    input: input.input,
    sourceIds: [...(input.sourceIds ?? [])],
  };
}

export interface ExperimentCaseReference {
  caseId: string;
  inputHash: string;
  split: EvaluationSplit;
  sourceIds: string[];
}

export interface ExperimentScheduleInput {
  projectId: string;
  datasetId: string;
  datasetVersionId: string;
  datasetVersionHash: string;
  split: EvaluationSplit;
  cases: readonly ExperimentCaseReference[];
  arms?: readonly ExperimentArm[];
  repeats: number;
  promptVersionId: string;
  promptHash: string;
  target: {
    provider: string;
    requestedModel: string;
    reasoningEffort: string | null;
    policyHash: string;
  };
  retrieval: {
    sourceIds: readonly string[];
    sourceManifestHash: string | null;
    graphSnapshotId: string | null;
  };
  holdoutEvaluationRequested?: boolean;
}

export interface ExperimentScheduleCell {
  cellId: string;
  pairId: string;
  caseId: string;
  inputHash: string;
  split: EvaluationSplit;
  arm: ExperimentArm;
  repeat: number;
}

export interface FrozenExperimentManifest {
  schemaVersion: "promptlab-experiment-manifest-v1";
  projectId: string;
  datasetId: string;
  datasetVersionId: string;
  datasetVersionHash: string;
  split: EvaluationSplit;
  promptVersionId: string;
  promptHash: string;
  target: ExperimentScheduleInput["target"];
  retrieval: {
    sourceIds: string[];
    sourceManifestHash: string | null;
    graphSnapshotId: string | null;
  };
  arms: ExperimentArm[];
  repeats: number;
  cells: ExperimentScheduleCell[];
  manifestHash: string;
}

export class ExperimentScheduleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExperimentScheduleError";
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Freeze a complete paired A/R/G plan without including case labels. */
export function freezeExperimentSchedule(
  input: ExperimentScheduleInput,
): FrozenExperimentManifest {
  if (!input.projectId || !input.datasetId || !input.datasetVersionId)
    throw new ExperimentScheduleError(
      "IDENTITY_REQUIRED",
      "Project and dataset version are required.",
    );
  if (!/^[a-f0-9]{64}$/u.test(input.datasetVersionHash))
    throw new ExperimentScheduleError(
      "DATASET_HASH_INVALID",
      "Dataset version hash must be a SHA-256 digest.",
    );
  if (!/^[a-f0-9]{64}$/u.test(input.promptHash))
    throw new ExperimentScheduleError(
      "PROMPT_HASH_INVALID",
      "Prompt hash must be a SHA-256 digest.",
    );
  if (!input.cases.length)
    throw new ExperimentScheduleError(
      "CASES_REQUIRED",
      "At least one case is required to freeze a schedule.",
    );
  if (
    !Number.isInteger(input.repeats) ||
    input.repeats < 1 ||
    input.repeats > 10
  )
    throw new ExperimentScheduleError(
      "REPEATS_INVALID",
      "Repeats must be between 1 and 10.",
    );
  if (input.split === "holdout" && input.holdoutEvaluationRequested !== true)
    throw new ExperimentScheduleError(
      "HOLDOUT_CONFIRMATION_REQUIRED",
      "Holdout evaluation must be explicitly requested.",
    );

  const cases = [...input.cases].sort((left, right) =>
    left.caseId.localeCompare(right.caseId),
  );
  if (cases.some((item) => item.split !== input.split))
    throw new ExperimentScheduleError(
      "SPLIT_MISMATCH",
      "Every selected case must belong to the requested split.",
    );
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length)
    throw new ExperimentScheduleError(
      "DUPLICATE_CASE",
      "A case may appear only once in a frozen manifest.",
    );
  if (cases.some((item) => !/^[a-f0-9]{64}$/u.test(item.inputHash)))
    throw new ExperimentScheduleError(
      "CASE_HASH_INVALID",
      "Every case input must have a SHA-256 digest.",
    );

  const arms = [...new Set(input.arms ?? EXPERIMENT_ARMS)].sort(
    (left, right) =>
      EXPERIMENT_ARMS.indexOf(left) - EXPERIMENT_ARMS.indexOf(right),
  );
  if (
    arms.length !== EXPERIMENT_ARMS.length ||
    EXPERIMENT_ARMS.some((arm) => !arms.includes(arm))
  )
    throw new ExperimentScheduleError(
      "ARMS_INCOMPLETE",
      "A frozen academic schedule requires A, R, and G arms.",
    );

  const sourceIds = [...new Set(input.retrieval.sourceIds)].sort();
  const cells: ExperimentScheduleCell[] = [];
  for (const item of cases) {
    for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
      const pairId = sha256(
        canonicalJson({
          datasetVersionHash: input.datasetVersionHash,
          caseId: item.caseId,
          inputHash: item.inputHash,
          repeat,
        }),
      );
      for (const arm of arms) {
        cells.push({
          cellId: sha256(`${pairId}:${arm}`),
          pairId,
          caseId: item.caseId,
          inputHash: item.inputHash,
          split: item.split,
          arm,
          repeat,
        });
      }
    }
  }

  const frozen = {
    schemaVersion: "promptlab-experiment-manifest-v1" as const,
    projectId: input.projectId,
    datasetId: input.datasetId,
    datasetVersionId: input.datasetVersionId,
    datasetVersionHash: input.datasetVersionHash,
    split: input.split,
    promptVersionId: input.promptVersionId,
    promptHash: input.promptHash,
    target: { ...input.target },
    retrieval: {
      sourceIds,
      sourceManifestHash: input.retrieval.sourceManifestHash,
      graphSnapshotId: input.retrieval.graphSnapshotId,
    },
    arms,
    repeats: input.repeats,
    cells,
  };
  return { ...frozen, manifestHash: sha256(canonicalJson(frozen)) };
}

export type EvaluationObservationStatus =
  "succeeded" | "failed" | "unavailable" | "unknown";

export interface EvaluationObservation {
  caseId: string;
  arm: ExperimentArm;
  repeat: number;
  status: EvaluationObservationStatus;
  score: number | null;
  criticalConstraintsPassed: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  durationMs: number | null;
  responseId: string | null;
  unavailableReason?: string | null;
}

export interface ArmReport {
  arm: ExperimentArm;
  plannedCells: number;
  observedCells: number;
  succeededCells: number;
  failedCells: number;
  unavailableCells: number;
  unknownCells: number;
  meanScore: number | null;
  criticalFailureCount: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    unknownCells: number;
  };
}

export interface PairedArmComparison {
  baseline: "A";
  candidate: "R" | "G";
  pairedCases: number;
  meanScoreDelta: number | null;
  confidence95: { lower: number; upper: number } | null;
  outcome:
    "candidate_better" | "non_inferior" | "inconclusive" | "candidate_rejected";
}

export interface PairedExperimentReport {
  schemaVersion: "promptlab-experiment-report-v1";
  manifestHash: string;
  split: EvaluationSplit;
  evidenceClass: "offline_report";
  corpusGate: {
    developmentCases: number;
    holdoutCases: number;
    developmentReady: boolean;
    holdoutReady: boolean;
  };
  arms: ArmReport[];
  comparisons: PairedArmComparison[];
  reportHash: string;
}

const T_95 = [
  0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
  2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function pairedMeanAndConfidence(
  values: readonly number[],
): { mean: number; lower: number; upper: number } | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  const critical = T_95[Math.min(values.length - 1, T_95.length - 1)] ?? 1.96;
  const margin = critical * Math.sqrt(variance / values.length);
  return { mean, lower: mean - margin, upper: mean + margin };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** Build a reproducible report; labels and reference answers are not accepted here. */
export function buildPairedRepeatedReport(input: {
  manifest: FrozenExperimentManifest;
  observations: readonly EvaluationObservation[];
  datasetCounts: { development: number; holdout: number };
  nonInferiorityMargin?: number;
}): PairedExperimentReport {
  const plannedByKey = new Map(
    input.manifest.cells.map((cell) => [
      `${cell.caseId}:${cell.arm}:${cell.repeat}`,
      cell,
    ]),
  );
  const seen = new Set<string>();
  for (const observation of input.observations) {
    const key = `${observation.caseId}:${observation.arm}:${observation.repeat}`;
    if (!plannedByKey.has(key))
      throw new Error("Observation is outside the frozen manifest.");
    if (seen.has(key))
      throw new Error("Duplicate observation for a frozen experiment cell.");
    if (
      observation.score !== null &&
      (!Number.isFinite(observation.score) ||
        observation.score < 0 ||
        observation.score > 100)
    )
      throw new Error("Scores must be null or between 0 and 100.");
    if (observation.repeat < 1 || !Number.isInteger(observation.repeat))
      throw new Error("Repeat index is invalid.");
    seen.add(key);
  }

  const observations = [...input.observations].sort(
    (left, right) =>
      left.caseId.localeCompare(right.caseId) ||
      EXPERIMENT_ARMS.indexOf(left.arm) - EXPERIMENT_ARMS.indexOf(right.arm) ||
      left.repeat - right.repeat,
  );
  const armReports = EXPERIMENT_ARMS.map((arm): ArmReport => {
    const planned = input.manifest.cells.filter((cell) => cell.arm === arm);
    const current = observations.filter((item) => item.arm === arm);
    const succeeded = current.filter((item) => item.status === "succeeded");
    const scores = succeeded
      .map((item) => item.score)
      .filter((value): value is number => value !== null);
    return {
      arm,
      plannedCells: planned.length,
      observedCells: current.length,
      succeededCells: current.filter((item) => item.status === "succeeded")
        .length,
      failedCells: current.filter((item) => item.status === "failed").length,
      unavailableCells: current.filter((item) => item.status === "unavailable")
        .length,
      unknownCells:
        planned.length -
        current.length +
        current.filter((item) => item.status === "unknown").length,
      meanScore: scores.length
        ? scores.reduce((sum, value) => sum + value, 0) / scores.length
        : null,
      criticalFailureCount: current.filter(
        (item) => item.criticalConstraintsPassed === false,
      ).length,
      usage: {
        inputTokens: sumKnown(current.map((item) => item.inputTokens)),
        outputTokens: sumKnown(current.map((item) => item.outputTokens)),
        cacheReadTokens: sumKnown(current.map((item) => item.cacheReadTokens)),
        unknownCells: current.filter(
          (item) =>
            item.inputTokens === null ||
            item.outputTokens === null ||
            item.cacheReadTokens === null,
        ).length,
      },
    };
  });

  const byArmCase = new Map<ExperimentArm, Map<string, number[]>>();
  for (const arm of EXPERIMENT_ARMS) byArmCase.set(arm, new Map());
  for (const item of observations) {
    if (item.status !== "succeeded" || item.score === null) continue;
    const byCase = byArmCase.get(item.arm)!;
    const scores = byCase.get(item.caseId) ?? [];
    scores.push(item.score);
    byCase.set(item.caseId, scores);
  }

  const margin = input.nonInferiorityMargin ?? 3;
  const comparisons = (["R", "G"] as const).map(
    (candidate): PairedArmComparison => {
      const baselineByCase = byArmCase.get("A")!;
      const candidateByCase = byArmCase.get(candidate)!;
      const deltas: number[] = [];
      for (const [caseId, baselineScores] of baselineByCase) {
        const candidateScores = candidateByCase.get(caseId);
        if (!candidateScores?.length) continue;
        const baselineMean =
          baselineScores.reduce((sum, value) => sum + value, 0) /
          baselineScores.length;
        const candidateMean =
          candidateScores.reduce((sum, value) => sum + value, 0) /
          candidateScores.length;
        deltas.push(candidateMean - baselineMean);
      }
      const confidence = pairedMeanAndConfidence(deltas);
      const candidateReport = armReports.find(
        (report) => report.arm === candidate,
      )!;
      const requiredPairedCases =
        input.manifest.split === "development"
          ? REQUIRED_CORPUS_COUNTS.development
          : REQUIRED_CORPUS_COUNTS.holdout;
      const splitCorpusReady =
        input.manifest.split === "development"
          ? input.datasetCounts.development >=
            REQUIRED_CORPUS_COUNTS.development
          : input.datasetCounts.holdout >= REQUIRED_CORPUS_COUNTS.holdout;
      const sampleReady =
        splitCorpusReady && deltas.length >= requiredPairedCases;
      const outcome: PairedArmComparison["outcome"] =
        candidateReport.criticalFailureCount > 0
          ? "candidate_rejected"
          : !confidence || !sampleReady
            ? "inconclusive"
            : confidence.lower > 0
              ? "candidate_better"
              : confidence.lower > -margin
                ? "non_inferior"
                : "inconclusive";
      return {
        baseline: "A",
        candidate,
        pairedCases: deltas.length,
        meanScoreDelta: confidence?.mean ?? deltas[0] ?? null,
        confidence95: confidence
          ? { lower: confidence.lower, upper: confidence.upper }
          : null,
        outcome,
      };
    },
  );

  const reportBody = {
    schemaVersion: "promptlab-experiment-report-v1" as const,
    manifestHash: input.manifest.manifestHash,
    split: input.manifest.split,
    evidenceClass: "offline_report" as const,
    corpusGate: {
      developmentCases: input.datasetCounts.development,
      holdoutCases: input.datasetCounts.holdout,
      developmentReady:
        input.datasetCounts.development >= REQUIRED_CORPUS_COUNTS.development,
      holdoutReady:
        input.datasetCounts.holdout >= REQUIRED_CORPUS_COUNTS.holdout,
    },
    arms: armReports,
    comparisons,
  };
  return { ...reportBody, reportHash: sha256(canonicalJson(reportBody)) };
}

/** JSON export intentionally carries aggregate evidence only, never case labels. */
export function exportPairedReport(report: PairedExperimentReport): string {
  return canonicalJson(report);
}
