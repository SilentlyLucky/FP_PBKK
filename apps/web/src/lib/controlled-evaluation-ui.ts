import {
  ControlledEvaluationCaseSchema,
  ControlledEvaluationReportSchema,
  type ControlledEvaluationCase,
  type ControlledEvaluationPair,
  type ControlledEvaluationReport,
} from "@promptlab/contracts";
import type {
  ControlledEvaluationRecord,
  ExperimentRecord,
} from "@/lib/experiment-pilot";

export interface ControlledCaseDraftResult {
  cases: ControlledEvaluationCase[] | null;
  error: string | null;
}

export function parseControlledCaseDraft(
  value: string,
): ControlledCaseDraftResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    return { cases: null, error: "Kasus harus berupa JSON array yang valid." };
  }

  const parsed = ControlledEvaluationCaseSchema.array()
    .min(2)
    .max(20)
    .safeParse(candidate);
  if (!parsed.success) {
    return {
      cases: null,
      error:
        "Masukkan 2–20 kasus dengan id, split development/holdout, dan input.",
    };
  }

  const ids = parsed.data.map((testCase) => testCase.id);
  if (new Set(ids).size !== ids.length) {
    return { cases: null, error: "Setiap kasus harus memiliki id yang unik." };
  }
  if (
    !parsed.data.some((testCase) => testCase.split === "development") ||
    !parsed.data.some((testCase) => testCase.split === "holdout")
  ) {
    return {
      cases: null,
      error: "Sertakan sedikitnya satu kasus development dan satu holdout.",
    };
  }
  return { cases: parsed.data, error: null };
}

export function parseControlledEvaluationReport(
  value: unknown,
  experiment: Pick<ControlledEvaluationRecord, "runId" | "metadata">,
): ControlledEvaluationReport | null {
  const parsed = ControlledEvaluationReportSchema.safeParse(value);
  if (!parsed.success) return null;
  const report = parsed.data;
  const metadata = experiment.metadata;
  if (
    report.runId !== experiment.runId ||
    report.manifest.runId !== experiment.runId ||
    report.manifest.attemptId !== report.attemptId ||
    report.configurationHash !== report.manifest.configurationHash ||
    report.baselinePromptHash !== metadata.baselinePromptHash ||
    report.candidatePromptHash !== metadata.candidatePromptHash ||
    report.manifest.baselinePromptHash !== metadata.baselinePromptHash ||
    report.manifest.candidatePromptHash !== metadata.candidatePromptHash ||
    report.expectedRequestCount !==
      metadata.cases.length * metadata.arms.length * 2 ||
    report.manifest.cases.length !== metadata.cases.length ||
    report.manifest.arms.length !== metadata.arms.length ||
    report.pairs.length !== metadata.cases.length * metadata.arms.length ||
    new Set(report.manifest.cases.map((item) => item.caseId)).size !==
      metadata.cases.length ||
    new Set(report.manifest.arms.map((item) => item.arm)).size !==
      metadata.arms.length
  ) {
    return null;
  }

  const expectedCases = new Map(
    metadata.cases.map((item) => [item.id, item.split]),
  );
  if (
    report.manifest.cases.some(
      (item) => expectedCases.get(item.caseId) !== item.split,
    )
  ) {
    return null;
  }

  const expectedArms = new Map(metadata.arms.map((item) => [item.arm, item]));
  const manifestArmsMatch = report.manifest.arms.every((item) => {
    const expected = expectedArms.get(item.arm);
    return (
      expected !== undefined &&
      item.requestedModel === expected.requestedModel &&
      item.reasoningEffort === expected.reasoningEffort &&
      item.retrieval.strategy === expected.retrieval.strategy &&
      item.retrieval.snapshotId === (expected.retrieval.snapshotId ?? null) &&
      sameStringSet(item.retrieval.sourceIds, expected.retrieval.sourceIds) &&
      item.sources.length === expected.sources.length &&
      item.sources.every((source) =>
        expected.sources.some(
          (candidate) =>
            candidate.documentId === source.documentId &&
            candidate.documentVersionId === source.documentVersionId &&
            candidate.documentVersion === source.documentVersion &&
            candidate.checksum === source.checksum,
        ),
      )
    );
  });
  if (!manifestArmsMatch) return null;

  const seenPairs = new Set<string>();
  for (const pair of report.pairs) {
    const pairKey = pair.arm + ":" + pair.caseId;
    if (
      seenPairs.has(pairKey) ||
      expectedCases.get(pair.caseId) !== pair.split ||
      !expectedArms.has(pair.arm)
    ) {
      return null;
    }
    seenPairs.add(pairKey);
  }
  const manifestPairKeys = new Set(
    report.manifest.pairs.map((pair) => pair.arm + ":" + pair.caseId),
  );
  if (
    manifestPairKeys.size !== report.manifest.pairs.length ||
    manifestPairKeys.size !== seenPairs.size ||
    [...seenPairs].some((pairKey) => !manifestPairKeys.has(pairKey))
  ) {
    return null;
  }
  return report;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

export type ControlledPairAssessment = {
  kind: "missing" | "inconclusive" | "subjective" | "verified" | "failed";
  label: string;
  detail: string;
};

export function assessControlledPair(
  pair: ControlledEvaluationPair | undefined,
): ControlledPairAssessment {
  if (!pair) {
    return {
      kind: "missing",
      label: "Bukti pasangan tidak tersedia",
      detail:
        "Laporan tidak memuat pasangan baseline dan kandidat untuk kasus serta metode ini.",
    };
  }

  if (
    pair.baseline.status !== "succeeded" ||
    pair.candidate.status !== "succeeded" ||
    pair.baseline.text === null ||
    pair.candidate.text === null ||
    pair.baseline.answerHash === null ||
    pair.candidate.answerHash === null
  ) {
    return {
      kind: "inconclusive",
      label: "Hasil belum lengkap",
      detail:
        "Sedikitnya satu jawaban gagal atau tidak tersedia; pasangan ini belum dapat dibandingkan.",
    };
  }

  switch (pair.judgment) {
    case "both_passed":
      return {
        kind: "verified",
        label: "Validator kedua versi lolos",
        detail:
          "Pemeriksaan deterministik lolos untuk baseline dan kandidat. Ini tidak menyatakan mutu umum.",
      };
    case "candidate_failed":
      return {
        kind: "failed",
        label: "Validator kandidat gagal",
        detail: "Bukti deterministik pada kandidat tidak lolos.",
      };
    case "baseline_failed":
      return {
        kind: "failed",
        label: "Validator baseline gagal",
        detail: "Bukti deterministik pada baseline tidak lolos.",
      };
    case "both_failed":
      return {
        kind: "failed",
        label: "Validator kedua versi gagal",
        detail:
          "Bukti deterministik tidak lolos pada baseline maupun kandidat.",
      };
    case "subjective":
      return {
        kind: "subjective",
        label: "Perlu tinjauan manusia",
        detail: "Tidak ada validator deterministik untuk menilai kasus ini.",
      };
    case "inconclusive":
      return {
        kind: "inconclusive",
        label: "Belum konklusif",
        detail:
          "Worker tidak dapat menetapkan hasil deterministik untuk pasangan ini.",
      };
  }
}

export function canAcceptControlledEvaluation(
  experiment: Pick<ControlledEvaluationRecord, "status" | "evidenceEligible">,
): boolean {
  return experiment.status === "succeeded" && experiment.evidenceEligible;
}

export function experimentHistoryLabel(experiment: ExperimentRecord): string {
  const base =
    experiment.metadata.datasetName +
    " · v" +
    experiment.metadata.datasetVersion;
  if (experiment.mode === "pilot") {
    const labels = {
      original: "Original",
      rag: "RAG",
      graphrag: "GraphRAG",
    };
    return base + " · Pilot · " + labels[experiment.metadata.arm];
  }
  const armLabels = {
    original: "Original",
    rag: "RAG",
    graphrag: "GraphRAG",
  };
  return (
    base +
    " · Batch " +
    experiment.metadata.cases.length +
    " kasus · " +
    experiment.metadata.arms.map((arm) => armLabels[arm.arm]).join(" / ")
  );
}
