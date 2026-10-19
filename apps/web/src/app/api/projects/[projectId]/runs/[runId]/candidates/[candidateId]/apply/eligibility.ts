import {
  PromptOptimizationRequestSchema,
  PromptOptimizationVerificationSchema,
} from "@promptlab/contracts";
import { isOptimizationCandidateEvidenceEligible } from "@promptlab/agent/evidence-manifest";

import { isLegacyUnverifiedOptimizationCandidate } from "@/lib/optimization-result";

type JsonRecord = Record<string, unknown>;

export type CandidateApplyBlockReason =
  | "legacy_candidate"
  | "run_not_ready"
  | "result_missing"
  | "candidate_not_ready"
  | "candidate_scope_mismatch"
  | "candidate_text_mismatch"
  | "draft_scope_mismatch"
  | "frozen_cases_unavailable"
  | "case_results_incomplete"
  | "verification_not_passed"
  | "invariant_not_preserved"
  | "stale_baseline";

export type CandidateApplyEligibility =
  | { eligible: true; alreadyApplied: boolean }
  | { eligible: false; reason: CandidateApplyBlockReason };

export interface CandidateApplyEligibilityInput {
  requested: {
    projectId: string;
    runId: string;
    promptId: string;
    candidateId: string;
    draftVersionId: string;
  };
  run: {
    id: string;
    projectId: string;
    status: string;
    purpose: string;
    promptVersionId: string | null;
    configSnapshot: Record<string, unknown>;
  };
  completionAttemptId: string | null;
  prompt: {
    id: string;
    projectId: string;
    currentVersionId: string | null;
    deletedAt: Date | null;
  };
  baselineVersion: {
    id: string;
    projectId: string;
    promptId: string;
    text: string;
    invariants: unknown;
  } | null;
  draftVersion: {
    id: string;
    projectId: string;
    promptId: string;
    version: number;
    parentVersionId: string | null;
    text: string;
    invariants: unknown;
    createdBy: string;
  } | null;
  completionPayload: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as JsonRecord;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function invariantList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

interface FrozenTestCase {
  id: string;
  input: string;
  source: "user" | "generated";
  verification: JsonRecord | null;
}

function frozenTestCases(configSnapshot: Record<string, unknown>): {
  cases: FrozenTestCase[];
  configuredCases: Array<{ id: string; input: string; verification?: unknown }>;
} | null {
  const optimization = PromptOptimizationRequestSchema.safeParse(
    configSnapshot.optimization,
  );
  const snapshot = asRecord(configSnapshot.optimizationExecutionSnapshot);
  if (
    !optimization.success ||
    snapshot?.preflightComplete !== true ||
    !Array.isArray(snapshot.testCases) ||
    snapshot.testCases.length === 0
  ) {
    return null;
  }

  const cases: FrozenTestCase[] = [];
  const seen = new Set<string>();
  for (const rawCase of snapshot.testCases) {
    const testCase = asRecord(rawCase);
    const verification = testCase?.verification;
    const parsedVerification =
      verification === undefined
        ? null
        : PromptOptimizationVerificationSchema.safeParse(verification);
    if (
      !testCase ||
      !nonEmptyString(testCase.id) ||
      !nonEmptyString(testCase.input) ||
      (testCase.source !== "user" && testCase.source !== "generated") ||
      seen.has(testCase.id) ||
      (verification !== undefined && !parsedVerification?.success)
    ) {
      return null;
    }
    seen.add(testCase.id);
    cases.push({
      id: testCase.id,
      input: testCase.input,
      source: testCase.source,
      verification:
        parsedVerification && parsedVerification.success
          ? (parsedVerification.data as unknown as JsonRecord)
          : null,
    });
  }

  const configuredCases = optimization.data.testCases;
  if (
    !configuredCases.every((configured) => {
      const frozen = cases.find((testCase) => testCase.id === configured.id);
      return (
        frozen?.source === "user" &&
        frozen.input === configured.input &&
        sameJson(frozen.verification, configured.verification ?? null)
      );
    })
  ) {
    return null;
  }

  return { cases, configuredCases };
}

function verificationPassed(
  verification: JsonRecord,
  evidence: unknown,
): boolean {
  const result = asRecord(evidence);
  if (
    !result ||
    result.kind !== verification.kind ||
    result.status !== "passed"
  ) {
    return false;
  }

  if (verification.kind === "divisibility") {
    const expected = asRecord(verification.expected);
    const actualExpected = asRecord(result.expected);
    const reference = asRecord(result.reference);
    const actual = asRecord(result.actual);
    return Boolean(
      expected &&
      actualExpected &&
      reference &&
      actual &&
      sameJson(actualExpected, expected) &&
      sameJson(reference, expected) &&
      sameJson(actual, expected),
    );
  }

  if (verification.kind === "python_tests") {
    const execution = asRecord(result.execution);
    const tests = verification.tests;
    const fixtures = result.fixtures;
    if (
      execution?.status !== "passed" ||
      !Array.isArray(tests) ||
      !Array.isArray(fixtures) ||
      fixtures.length !== tests.length
    ) {
      return false;
    }
    return tests.every((rawFixture, index) => {
      const expectedFixture = asRecord(rawFixture);
      const fixture = asRecord(fixtures[index]);
      return Boolean(
        expectedFixture &&
        fixture &&
        fixture.id === expectedFixture.id &&
        fixture.expectedOutput === expectedFixture.expectedOutput &&
        fixture.referenceOutput === expectedFixture.expectedOutput &&
        fixture.expectedMatchesReference === true &&
        fixture.actualOutput === expectedFixture.expectedOutput &&
        fixture.status === "passed",
      );
    });
  }

  return false;
}

function caseResultsMatchFrozenCases(
  candidateCaseResults: unknown,
  cases: readonly FrozenTestCase[],
): "complete" | "incomplete" | "verification_failed" {
  if (
    !Array.isArray(candidateCaseResults) ||
    candidateCaseResults.length !== cases.length
  ) {
    return "incomplete";
  }

  for (const [index, expected] of cases.entries()) {
    const actual = asRecord(candidateCaseResults[index]);
    if (
      !actual ||
      actual.id !== expected.id ||
      actual.input !== expected.input ||
      actual.source !== expected.source ||
      typeof actual.answer !== "string"
    ) {
      return "incomplete";
    }
    if (expected.verification) {
      if (
        !sameJson(actual.verification, expected.verification) ||
        !verificationPassed(expected.verification, actual.verificationEvidence)
      ) {
        return "verification_failed";
      }
    } else if (
      (actual.verification !== undefined && actual.verification !== null) ||
      (actual.verificationEvidence !== undefined &&
        actual.verificationEvidence !== null)
    ) {
      return "verification_failed";
    }
  }
  return "complete";
}

export function validateOptimizationCandidateApply(
  input: CandidateApplyEligibilityInput,
): CandidateApplyEligibility {
  const { requested, run, prompt, baselineVersion, draftVersion } = input;
  if (
    run.projectId !== requested.projectId ||
    run.id !== requested.runId ||
    prompt.projectId !== requested.projectId ||
    prompt.id !== requested.promptId ||
    prompt.deletedAt !== null ||
    !baselineVersion ||
    !draftVersion ||
    !run.promptVersionId ||
    baselineVersion.id !== run.promptVersionId ||
    baselineVersion.projectId !== requested.projectId ||
    baselineVersion.promptId !== requested.promptId ||
    draftVersion.id !== requested.draftVersionId ||
    draftVersion.projectId !== requested.projectId ||
    draftVersion.promptId !== requested.promptId
  ) {
    return { eligible: false, reason: "draft_scope_mismatch" };
  }

  const baseInvariants = invariantList(baselineVersion.invariants);
  const savedInvariants = invariantList(draftVersion.invariants);
  if (
    !baseInvariants ||
    !savedInvariants ||
    !sameJson(baseInvariants, savedInvariants) ||
    draftVersion.parentVersionId !== baselineVersion.id ||
    draftVersion.createdBy !== "prompt_optimization"
  ) {
    return { eligible: false, reason: "draft_scope_mismatch" };
  }

  if (
    prompt.currentVersionId !== baselineVersion.id &&
    prompt.currentVersionId !== draftVersion.id
  ) {
    return { eligible: false, reason: "stale_baseline" };
  }

  if (
    run.status !== "succeeded" ||
    run.purpose !== "target" ||
    !Object.hasOwn(run.configSnapshot, "optimization")
  ) {
    return { eligible: false, reason: "run_not_ready" };
  }

  const completion = asRecord(input.completionPayload);
  const result = asRecord(completion?.result);
  const baseline = asRecord(result?.baseline);
  if (
    completion?.status !== "succeeded" ||
    completion.mode !== "prompt_optimization" ||
    !result ||
    result.status !== "candidate_ready" ||
    baseline?.prompt !== baselineVersion.text
  ) {
    return { eligible: false, reason: "result_missing" };
  }

  const candidates = Array.isArray(result.candidates)
    ? result.candidates.map(asRecord).filter((candidate) => candidate !== null)
    : result.candidate
      ? [asRecord(result.candidate)]
      : [];
  const matchingCandidates = candidates.filter(
    (candidate) => candidate?.id === requested.candidateId,
  );
  if (matchingCandidates.length !== 1) {
    return { eligible: false, reason: "candidate_scope_mismatch" };
  }
  const candidate = matchingCandidates[0];
  if (!candidate)
    return { eligible: false, reason: "candidate_scope_mismatch" };

  const candidateDraftVersionId = candidate.draftVersionId;
  if (
    isLegacyUnverifiedOptimizationCandidate({
      runId: requested.runId,
      candidate: {
        id: requested.candidateId,
        draftVersionId:
          typeof candidateDraftVersionId === "string"
            ? candidateDraftVersionId
            : null,
      },
    })
  ) {
    return { eligible: false, reason: "legacy_candidate" };
  }

  if (
    candidateDraftVersionId !== requested.draftVersionId ||
    candidate.draftVersionId !== draftVersion.id
  ) {
    return { eligible: false, reason: "draft_scope_mismatch" };
  }
  if (
    typeof candidate.prompt !== "string" ||
    candidate.prompt !== draftVersion.text
  ) {
    return { eligible: false, reason: "candidate_text_mismatch" };
  }
  if (
    result.status !== "candidate_ready" ||
    candidate.outcome !== "candidate_ready" ||
    candidate.testingStatus !== "ready" ||
    candidate.evidenceBoundToPrompt !== true
  ) {
    return { eligible: false, reason: "candidate_not_ready" };
  }

  const invariantsPreserved =
    candidate.invariantsPreserved === true &&
    candidate.invariantStatus === "preserved";
  const noInvariantsConfigured =
    baseInvariants.length === 0 &&
    candidate.invariantStatus === "not_configured" &&
    (candidate.invariantsPreserved === null ||
      candidate.invariantsPreserved === undefined);
  if (!invariantsPreserved && !noInvariantsConfigured) {
    return { eligible: false, reason: "invariant_not_preserved" };
  }

  const frozen = frozenTestCases(run.configSnapshot);
  if (!frozen) {
    return { eligible: false, reason: "frozen_cases_unavailable" };
  }
  const caseCheck = caseResultsMatchFrozenCases(
    candidate.caseResults,
    frozen.cases,
  );
  if (caseCheck === "incomplete") {
    return { eligible: false, reason: "case_results_incomplete" };
  }
  if (caseCheck === "verification_failed") {
    return { eligible: false, reason: "verification_not_passed" };
  }

  if (
    !isOptimizationCandidateEvidenceEligible({
      runId: requested.runId,
      runStatus: run.status,
      runConfigSnapshot: run.configSnapshot,
      completionAttemptId: input.completionAttemptId,
      completionPayload: input.completionPayload,
      candidateId: requested.candidateId,
    })
  ) {
    return { eligible: false, reason: "candidate_not_ready" };
  }

  return {
    eligible: true,
    alreadyApplied: prompt.currentVersionId === draftVersion.id,
  };
}

export function candidateApplyBlockMessage(
  reason: CandidateApplyBlockReason,
): string {
  const messages: Record<CandidateApplyBlockReason, string> = {
    legacy_candidate:
      "Hasil optimasi lama ini belum membuktikan bahwa draft tersimpan sama dengan prompt yang diuji, sehingga tidak dapat diterapkan.",
    run_not_ready:
      "Run optimasi belum selesai dengan status berhasil. Tunggu sampai Run selesai sebelum menerapkan hasil.",
    result_missing:
      "Hasil optimasi yang tersimpan belum membuktikan kandidat siap digunakan. Jalankan ulang optimasi sebelum menerapkan hasil.",
    candidate_not_ready:
      "Kandidat belum siap digunakan atau bukti pengujiannya tidak terikat pada teks prompt yang diuji.",
    candidate_scope_mismatch:
      "Kandidat tidak cocok dengan Run optimasi yang dipilih. Muat ulang hasil optimasi sebelum menerapkannya.",
    candidate_text_mismatch:
      "Teks draft tersimpan berbeda dari teks kandidat yang diuji. Jalankan ulang optimasi sebelum menerapkan hasil.",
    draft_scope_mismatch:
      "Draft tidak berasal dari prompt dan versi dasar Run optimasi ini.",
    frozen_cases_unavailable:
      "Daftar contoh uji yang dibekukan tidak tersedia. Jalankan ulang optimasi sebelum menerapkan hasil.",
    case_results_incomplete:
      "Belum semua contoh uji yang dibekukan memiliki hasil kandidat. Jalankan ulang optimasi sebelum menerapkannya.",
    verification_not_passed:
      "Pemeriksaan pada contoh uji gagal, memakai fixture tidak valid, atau tidak tersedia. Kandidat ini tidak dapat diterapkan.",
    invariant_not_preserved:
      "Bukti belum menunjukkan bahwa aturan penting pada prompt tetap dipertahankan.",
    stale_baseline:
      "Versi prompt aktif sudah berubah sejak Run ini dibuat. Jalankan optimasi ulang pada versi aktif sebelum menerapkan hasil.",
  };
  return messages[reason];
}
