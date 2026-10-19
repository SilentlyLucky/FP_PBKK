import {
  ControlledEvaluationManifestSchema,
  ControlledEvaluationReportSchema,
  ControlledEvaluationRequestSchema,
  type ControlledEvaluationArm,
  type ControlledEvaluationCase,
  type ControlledEvaluationPair,
  type ControlledEvaluationReport,
  type ControlledEvaluationRequest,
  type EvaluationEvidencePack,
  type UsageSnapshot,
} from "@promptlab/contracts";

import {
  buildTargetEvaluationRequest,
  canonicalJson,
  sha256Json,
  sha256Text,
} from "./evidence-manifest.js";
import {
  isOptimizationVerificationEvidenceConsistent,
  verifyOptimizationCase,
} from "./prompt-optimization-verification.js";

export type ControlledEvaluationSubject = "baseline" | "candidate";

export type ControlledEvaluationInvocation =
  | {
      status: "succeeded";
      text: string;
      responseId: string | null;
      responseModel: string;
      usage: UsageSnapshot;
      latencyMs: number;
    }
  | { status: "failed"; errorCode: string };

export interface ControlledEvaluationTargetCall {
  arm: ControlledEvaluationArm["arm"];
  caseId: string;
  split: ControlledEvaluationCase["split"];
  subject: ControlledEvaluationSubject;
  promptHash: string;
  requestHash: string;
  contextHash: string;
  pairConfigHash: string;
  text: string;
  signal: AbortSignal;
}

export interface ControlledEvaluationTrace {
  arm: ControlledEvaluationArm["arm"];
  caseId: string;
  split: ControlledEvaluationCase["split"];
  subject: ControlledEvaluationSubject;
  promptHash: string;
  requestHash: string;
  contextHash: string;
  pairConfigHash: string;
  phase: "target_request_started" | "target_response_recorded";
  status?: "succeeded" | "failed";
}

export class ControlledEvaluationInterruptedError extends Error {
  readonly code = "CONTROLLED_EVALUATION_INTERRUPTED";

  constructor(readonly remoteOutcomeUncertain: boolean) {
    super("Controlled evaluation was interrupted.");
    this.name = "ControlledEvaluationInterruptedError";
  }
}

export class ControlledEvaluationFatalError extends Error {
  readonly controlledEvaluationFatal = true;

  constructor(readonly code: string) {
    super("Controlled evaluation could not persist its execution record.");
    this.name = "ControlledEvaluationFatalError";
  }
}

export interface RunControlledEvaluationInput {
  runId: string;
  attemptId: string;
  request: ControlledEvaluationRequest;
  baselinePrompt: string;
  candidatePrompt: string;
  signal: AbortSignal;
  resolveEvidence: (
    arm: ControlledEvaluationArm,
    cases: readonly Pick<ControlledEvaluationCase, "id" | "input">[],
    signal: AbortSignal,
  ) => Promise<readonly EvaluationEvidencePack[]>;
  invoke: (
    call: ControlledEvaluationTargetCall,
  ) => Promise<ControlledEvaluationInvocation>;
  onTrace?: (trace: ControlledEvaluationTrace) => unknown;
  onEvidenceResolved?: () => unknown;
}

/** Runs a sequential, bounded paired suite over pre-frozen retrieval contexts. */
export async function runControlledEvaluation(
  input: RunControlledEvaluationInput,
): Promise<ControlledEvaluationReport> {
  const request = ControlledEvaluationRequestSchema.parse(input.request);
  if (!isControlledEvaluationConfigurationValid(request)) {
    throw new Error("CONTROLLED_EVALUATION_CONFIGURATION_INVALID");
  }
  if (
    sha256Text(input.baselinePrompt) !== request.baselinePromptHash ||
    sha256Text(input.candidatePrompt) !== request.candidatePromptHash ||
    input.baselinePrompt === input.candidatePrompt
  ) {
    throw new Error("CONTROLLED_EVALUATION_PROMPT_SNAPSHOT_MISMATCH");
  }
  throwIfAborted(input.signal, false);

  const cases = request.cases.map(({ id, input: caseInput }) => ({
    id,
    input: caseInput,
  }));
  const evidenceByArm = new Map<string, Map<string, EvaluationEvidencePack>>();
  const armManifests: ControlledEvaluationReport["manifest"]["arms"] = [];

  // Resolve every arm and every case before the first provider call. This keeps
  // holdout handling and source snapshots out of an adaptive agent loop.
  for (const arm of request.arms) {
    throwIfAborted(input.signal, false);
    const packs = await input.resolveEvidence(arm, cases, input.signal);
    const packByCase = new Map(packs.map((pack) => [pack.caseId, pack]));
    if (
      packs.length !== request.cases.length ||
      packByCase.size !== packs.length ||
      request.cases.some((testCase) => !packByCase.has(testCase.id))
    ) {
      throw new Error("CONTROLLED_EVALUATION_EVIDENCE_INCOMPLETE");
    }
    for (const testCase of request.cases) {
      const pack = packByCase.get(testCase.id)!;
      assertEvidencePackMatchesArm(arm, pack);
    }
    evidenceByArm.set(arm.arm, packByCase);
    armManifests.push({
      arm: arm.arm,
      configurationHash: sha256Json(arm),
      requestedModel: arm.requestedModel,
      reasoningEffort: arm.reasoningEffort,
      retrieval: arm.retrieval,
      sources: arm.sources,
      evidencePacks: [...packs],
    });
  }
  await input.onEvidenceResolved?.();

  const configurationHash = sha256Json(request);
  const pairs: ControlledEvaluationPair[] = [];
  for (const arm of request.arms) {
    const packByCase = evidenceByArm.get(arm.arm)!;
    for (const testCase of request.cases) {
      throwIfAborted(input.signal, false);
      const pack = packByCase.get(testCase.id)!;
      const inputHash = sha256Text(testCase.input);
      const contextHash = sha256Text(pack.contextText);
      const pairConfigHash = sha256Json({
        armConfigurationHash: sha256Json(arm),
        caseId: testCase.id,
        split: testCase.split,
        inputHash,
        contextHash,
      });
      const baseline = await invokeSubject({
        input,
        arm,
        testCase,
        prompt: input.baselinePrompt,
        subject: "baseline",
        pack,
        inputHash,
        contextHash,
        pairConfigHash,
      });
      const candidate = await invokeSubject({
        input,
        arm,
        testCase,
        prompt: input.candidatePrompt,
        subject: "candidate",
        pack,
        inputHash,
        contextHash,
        pairConfigHash,
      });
      const judgment = deriveJudgment({
        testCase,
        baseline: baseline.verificationEvidence,
        candidate: candidate.verificationEvidence,
      });
      pairs.push({
        arm: arm.arm,
        caseId: testCase.id,
        split: testCase.split,
        inputHash,
        contextHash,
        pairConfigHash,
        baseline,
        candidate,
        judgment,
      });
    }
  }

  const caseManifest = request.cases.map((testCase) => ({
    caseId: testCase.id,
    split: testCase.split,
    inputHash: sha256Text(testCase.input),
    inputCharacters: testCase.input.length,
    labelHash: testCase.label ? sha256Text(testCase.label) : null,
    verificationHash: testCase.verification
      ? sha256Json(testCase.verification)
      : null,
  }));
  const unsignedManifest = {
    format: "promptlab-controlled-evaluation-manifest-v1" as const,
    runId: input.runId,
    attemptId: input.attemptId,
    configurationHash,
    baselinePromptHash: request.baselinePromptHash,
    candidatePromptHash: request.candidatePromptHash,
    cases: caseManifest,
    arms: armManifests,
    pairs,
  };
  const manifest = ControlledEvaluationManifestSchema.parse({
    ...unsignedManifest,
    manifestHash: sha256Json(unsignedManifest),
  });
  const report = ControlledEvaluationReportSchema.parse({
    mode: "controlled_evaluation",
    status: pairs.every(
      (pair) =>
        pair.baseline.status === "succeeded" &&
        pair.candidate.status === "succeeded",
    )
      ? "complete"
      : "partial",
    runId: input.runId,
    attemptId: input.attemptId,
    configurationHash,
    baselinePromptHash: request.baselinePromptHash,
    candidatePromptHash: request.candidatePromptHash,
    expectedRequestCount: request.arms.length * request.cases.length * 2,
    optimizerLineage: { status: "not_used", calls: 0, overheadMs: null },
    pairs,
    manifest,
  });
  if (
    !isControlledEvaluationReportIntact({
      request,
      report,
      runId: input.runId,
      attemptId: input.attemptId,
      baselinePrompt: input.baselinePrompt,
      candidatePrompt: input.candidatePrompt,
    })
  ) {
    throw new Error("CONTROLLED_EVALUATION_MANIFEST_INVALID");
  }
  return deepFreeze(report);
}

export function isControlledEvaluationConfigurationValid(
  request: ControlledEvaluationRequest,
): boolean {
  const parsed = ControlledEvaluationRequestSchema.safeParse(request);
  if (!parsed.success) return false;
  const armsById = new Map(parsed.data.arms.map((arm) => [arm.arm, arm]));
  const original = armsById.get("original");
  const rag = armsById.get("rag");
  const graphrag = armsById.get("graphrag");
  if (
    parsed.data.arms.length !== 3 ||
    !original ||
    !rag ||
    !graphrag ||
    parsed.data.arms.some(
      (arm) =>
        arm.requestedModel !== original.requestedModel ||
        arm.reasoningEffort !== original.reasoningEffort,
    )
  ) {
    return false;
  }

  const sourceIdentity = (
    arm: ControlledEvaluationArm,
  ): Array<{
    documentId: string;
    documentVersionId: string;
    documentVersion: number;
    checksum: string;
  }> =>
    arm.sources
      .map(({ documentId, documentVersionId, documentVersion, checksum }) => ({
        documentId,
        documentVersionId,
        documentVersion,
        checksum,
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId));

  if (
    canonicalJson(sourceIdentity(rag)) !==
    canonicalJson(sourceIdentity(graphrag))
  ) {
    return false;
  }

  return parsed.data.arms.every((arm) => {
    const sourceIds = arm.sources.map((source) => source.documentId).sort();
    const selectedSourceIds = [...arm.retrieval.sourceIds].sort();
    if (
      new Set(sourceIds).size !== sourceIds.length ||
      canonicalJson(sourceIds) !== canonicalJson(selectedSourceIds)
    ) {
      return false;
    }
    if (arm.arm === "original") {
      return (
        sourceIds.length === 0 &&
        arm.retrieval.strategy === "lexical" &&
        (arm.retrieval.snapshotId ?? null) === null
      );
    }
    if (arm.arm === "rag") {
      return (
        sourceIds.length > 0 &&
        arm.retrieval.strategy === "lexical" &&
        (arm.retrieval.snapshotId ?? null) === null
      );
    }
    return (
      sourceIds.length > 0 &&
      arm.retrieval.strategy === "graph" &&
      Boolean(arm.retrieval.snapshotId)
    );
  });
}

export function isControlledEvaluationReportIntact(input: {
  request: ControlledEvaluationRequest;
  report: unknown;
  runId: string;
  attemptId: string;
  baselinePrompt: string;
  candidatePrompt: string;
}): input is typeof input & { report: ControlledEvaluationReport } {
  const parsedRequest = ControlledEvaluationRequestSchema.safeParse(
    input.request,
  );
  const parsedReport = ControlledEvaluationReportSchema.safeParse(input.report);
  if (!parsedRequest.success || !parsedReport.success) return false;
  const request = parsedRequest.data;
  const report = parsedReport.data;
  const { manifestHash, ...unsignedManifest } = report.manifest;
  if (
    !isControlledEvaluationConfigurationValid(request) ||
    report.runId !== input.runId ||
    report.attemptId !== input.attemptId ||
    report.manifest.runId !== input.runId ||
    report.manifest.attemptId !== input.attemptId ||
    report.configurationHash !== sha256Json(request) ||
    report.manifest.configurationHash !== report.configurationHash ||
    report.baselinePromptHash !== sha256Text(input.baselinePrompt) ||
    report.candidatePromptHash !== sha256Text(input.candidatePrompt) ||
    report.baselinePromptHash !== request.baselinePromptHash ||
    report.candidatePromptHash !== request.candidatePromptHash ||
    report.manifest.baselinePromptHash !== report.baselinePromptHash ||
    report.manifest.candidatePromptHash !== report.candidatePromptHash ||
    sha256Json(unsignedManifest) !== manifestHash ||
    report.manifest.pairs.length !==
      request.arms.length * request.cases.length ||
    report.pairs.length !== report.manifest.pairs.length ||
    report.expectedRequestCount !==
      request.arms.length * request.cases.length * 2 ||
    canonicalJson(report.pairs) !== canonicalJson(report.manifest.pairs) ||
    report.optimizerLineage.status !== "not_used" ||
    report.optimizerLineage.calls !== 0 ||
    report.optimizerLineage.overheadMs !== null
  ) {
    return false;
  }

  if (!manifestCasesMatch(request, report)) return false;
  if (!manifestArmsMatch(request, report)) return false;

  const caseById = new Map(
    request.cases.map((testCase) => [testCase.id, testCase]),
  );
  const armById = new Map(request.arms.map((arm) => [arm.arm, arm]));
  const seen = new Set<string>();
  for (const pair of report.pairs) {
    const key = `${pair.arm}:${pair.caseId}`;
    const arm = armById.get(pair.arm);
    const testCase = caseById.get(pair.caseId);
    const pack = report.manifest.arms
      .find((entry) => entry.arm === pair.arm)
      ?.evidencePacks.find((entry) => entry.caseId === pair.caseId);
    if (!arm || !testCase || !pack || seen.has(key)) return false;
    seen.add(key);
    const inputHash = sha256Text(testCase.input);
    const contextHash = sha256Text(pack.contextText);
    const pairConfigHash = sha256Json({
      armConfigurationHash: sha256Json(arm),
      caseId: testCase.id,
      split: testCase.split,
      inputHash,
      contextHash,
    });
    if (
      pair.split !== testCase.split ||
      pair.inputHash !== inputHash ||
      pair.contextHash !== contextHash ||
      pair.pairConfigHash !== pairConfigHash ||
      !responseMatches({
        response: pair.baseline,
        prompt: input.baselinePrompt,
        caseInput: testCase.input,
        pack,
        verification: testCase.verification,
        contextHash,
      }) ||
      !responseMatches({
        response: pair.candidate,
        prompt: input.candidatePrompt,
        caseInput: testCase.input,
        pack,
        verification: testCase.verification,
        contextHash,
      }) ||
      (pair.baseline.requestHash !== pair.candidate.requestHash &&
        pair.baseline.promptHash === pair.candidate.promptHash) ||
      pair.baseline.contextHash !== pair.candidate.contextHash ||
      pair.baseline.promptHash !== request.baselinePromptHash ||
      pair.candidate.promptHash !== request.candidatePromptHash ||
      pair.judgment !==
        deriveJudgment({
          testCase,
          baseline: pair.baseline.verificationEvidence,
          candidate: pair.candidate.verificationEvidence,
        })
    ) {
      return false;
    }
  }
  return seen.size === request.arms.length * request.cases.length;
}

async function invokeSubject(input: {
  input: RunControlledEvaluationInput;
  arm: ControlledEvaluationArm;
  testCase: ControlledEvaluationCase;
  prompt: string;
  subject: ControlledEvaluationSubject;
  pack: EvaluationEvidencePack;
  inputHash: string;
  contextHash: string;
  pairConfigHash: string;
}): Promise<ControlledEvaluationPair["baseline"]> {
  const promptHash = sha256Text(input.prompt);
  const text = buildTargetEvaluationRequest({
    prompt: input.prompt,
    caseInput: input.testCase.input,
    evidencePack: input.pack,
  });
  const requestHash = sha256Text(text);
  const call: ControlledEvaluationTargetCall = {
    arm: input.arm.arm,
    caseId: input.testCase.id,
    split: input.testCase.split,
    subject: input.subject,
    promptHash,
    requestHash,
    contextHash: input.contextHash,
    pairConfigHash: input.pairConfigHash,
    text,
    signal: input.input.signal,
  };
  throwIfAborted(input.input.signal, false);
  await input.input.onTrace?.(traceFromCall(call, "target_request_started"));
  let invocation: ControlledEvaluationInvocation;
  try {
    invocation = await input.input.invoke(call);
  } catch (error) {
    if (input.input.signal.aborted || isAbortError(error)) {
      throw new ControlledEvaluationInterruptedError(true);
    }
    if (isFatalError(error) || isRemoteOutcomeUncertain(error)) throw error;
    invocation = { status: "failed", errorCode: getSafeErrorCode(error) };
  }
  throwIfAborted(input.input.signal, false);

  const textAnswer = invocation.status === "succeeded" ? invocation.text : null;
  const verification = await verifyOptimizationCase(
    textAnswer,
    input.testCase.verification,
  );
  const verificationEvidence = verification
    ? (verification as unknown as Record<string, unknown>)
    : null;
  const answer = {
    status: invocation.status,
    promptHash,
    requestHash,
    contextHash: input.contextHash,
    answerHash: textAnswer === null ? null : sha256Text(textAnswer),
    responseId:
      invocation.status === "succeeded" ? invocation.responseId : null,
    responseModel:
      invocation.status === "succeeded" ? invocation.responseModel : null,
    provider: "codex_app_server" as const,
    text: textAnswer,
    usage: invocation.status === "succeeded" ? invocation.usage : null,
    latencyMs: invocation.status === "succeeded" ? invocation.latencyMs : null,
    errorCode:
      invocation.status === "failed"
        ? invocation.errorCode.slice(0, 120)
        : null,
    verificationEvidence,
  };
  await input.input.onTrace?.({
    ...traceFromCall(call, "target_response_recorded"),
    status: invocation.status,
  });
  return answer;
}

function traceFromCall(
  call: ControlledEvaluationTargetCall,
  phase: ControlledEvaluationTrace["phase"],
): ControlledEvaluationTrace {
  return {
    arm: call.arm,
    caseId: call.caseId,
    split: call.split,
    subject: call.subject,
    promptHash: call.promptHash,
    requestHash: call.requestHash,
    contextHash: call.contextHash,
    pairConfigHash: call.pairConfigHash,
    phase,
  };
}

function assertEvidencePackMatchesArm(
  arm: ControlledEvaluationArm,
  pack: EvaluationEvidencePack,
): void {
  const selectedSnapshotId = arm.retrieval.snapshotId ?? null;
  const sourceManifest = pack.sourceManifest.map((source) => ({
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    documentVersion: source.documentVersion,
    checksum: source.checksum,
  }));
  const expectedManifest = arm.sources
    .map((source) => ({
      documentId: source.documentId,
      documentVersionId: source.documentVersionId,
      documentVersion: source.documentVersion,
      checksum: source.checksum,
    }))
    .sort((left, right) =>
      left.documentVersionId.localeCompare(right.documentVersionId),
    );
  if (
    pack.contextHash !== sha256Text(pack.contextText) ||
    canonicalJson([...pack.selectedSourceIds].sort()) !==
      canonicalJson([...arm.retrieval.sourceIds].sort()) ||
    canonicalJson(sourceManifest) !== canonicalJson(expectedManifest)
  ) {
    throw new Error("CONTROLLED_EVALUATION_SOURCE_SNAPSHOT_MISMATCH");
  }
  if (arm.arm === "original") {
    if (
      pack.requestedStrategy !== "none" ||
      pack.strategyUsed !== "none" ||
      pack.selectedSnapshotId !== null ||
      pack.usedSnapshotId !== null ||
      pack.fallbackReason !== null ||
      pack.contextText !== ""
    ) {
      throw new Error("CONTROLLED_EVALUATION_ORIGINAL_ARM_MISMATCH");
    }
    return;
  }
  if (arm.arm === "rag") {
    if (
      pack.requestedStrategy !== "lexical" ||
      pack.strategyUsed !== "lexical" ||
      pack.selectedSnapshotId !== null ||
      pack.usedSnapshotId !== null ||
      pack.fallbackReason !== null
    ) {
      throw new Error("CONTROLLED_EVALUATION_RAG_ARM_MISMATCH");
    }
    return;
  }
  if (
    pack.requestedStrategy !== "graph" ||
    pack.strategyUsed !== "graph" ||
    pack.selectedSnapshotId !== selectedSnapshotId ||
    pack.usedSnapshotId !== selectedSnapshotId ||
    pack.fallbackReason !== null
  ) {
    throw new Error("CONTROLLED_EVALUATION_GRAPHRAG_FALLBACK_REJECTED");
  }
}

function manifestCasesMatch(
  request: ControlledEvaluationRequest,
  report: ControlledEvaluationReport,
): boolean {
  const expected = request.cases.map((testCase) => ({
    caseId: testCase.id,
    split: testCase.split,
    inputHash: sha256Text(testCase.input),
    inputCharacters: testCase.input.length,
    labelHash: testCase.label ? sha256Text(testCase.label) : null,
    verificationHash: testCase.verification
      ? sha256Json(testCase.verification)
      : null,
  }));
  return canonicalJson(report.manifest.cases) === canonicalJson(expected);
}

function manifestArmsMatch(
  request: ControlledEvaluationRequest,
  report: ControlledEvaluationReport,
): boolean {
  const expected = request.arms.map((arm) => {
    const result = report.manifest.arms.find((entry) => entry.arm === arm.arm);
    return result
      ? {
          arm: arm.arm,
          configurationHash: sha256Json(arm),
          requestedModel: arm.requestedModel,
          reasoningEffort: arm.reasoningEffort,
          retrieval: arm.retrieval,
          sources: arm.sources,
          evidencePacks: result.evidencePacks,
        }
      : null;
  });
  if (expected.some((item) => item === null)) return false;
  if (canonicalJson(report.manifest.arms) !== canonicalJson(expected))
    return false;
  return report.manifest.arms.every((entry) => {
    const arm = request.arms.find((candidate) => candidate.arm === entry.arm);
    if (!arm) return false;
    const packs = new Map(
      entry.evidencePacks.map((pack) => [pack.caseId, pack]),
    );
    return (
      packs.size === request.cases.length &&
      request.cases.every((testCase) => {
        const pack = packs.get(testCase.id);
        if (!pack) return false;
        try {
          assertEvidencePackMatchesArm(arm, pack);
          return true;
        } catch {
          return false;
        }
      })
    );
  });
}

function responseMatches(input: {
  response: ControlledEvaluationPair["baseline"];
  prompt: string;
  caseInput: string;
  pack: EvaluationEvidencePack;
  verification: ControlledEvaluationCase["verification"];
  contextHash: string;
}): boolean {
  const expectedRequest = buildTargetEvaluationRequest({
    prompt: input.prompt,
    caseInput: input.caseInput,
    evidencePack: input.pack,
  });
  const response = input.response;
  if (
    response.promptHash !== sha256Text(input.prompt) ||
    response.requestHash !== sha256Text(expectedRequest) ||
    response.contextHash !== input.contextHash
  ) {
    return false;
  }
  if (response.status === "failed") {
    return (
      response.text === null &&
      response.answerHash === null &&
      response.responseId === null &&
      response.responseModel === null &&
      response.usage === null &&
      response.latencyMs === null &&
      typeof response.errorCode === "string" &&
      (!input.verification ||
        (response.verificationEvidence?.status === "unavailable" &&
          response.verificationEvidence.kind === input.verification.kind))
    );
  }
  if (
    response.text === null ||
    response.answerHash !== sha256Text(response.text) ||
    response.errorCode !== null ||
    response.responseModel === null ||
    response.usage === null ||
    response.latencyMs === null
  ) {
    return false;
  }
  if (!input.verification) return response.verificationEvidence === null;
  return isOptimizationVerificationEvidenceConsistent({
    answer: response.text,
    verification: input.verification,
    evidence: response.verificationEvidence,
    requirePass: false,
  });
}

function deriveJudgment(input: {
  testCase: ControlledEvaluationCase;
  baseline: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
}): ControlledEvaluationPair["judgment"] {
  if (!input.testCase.verification) {
    return input.baseline === null && input.candidate === null
      ? "subjective"
      : input.baseline && input.candidate
        ? "subjective"
        : "inconclusive";
  }
  if (
    !input.baseline ||
    !input.candidate ||
    input.baseline.status === "unavailable" ||
    input.baseline.status === "invalid_fixture" ||
    input.candidate.status === "unavailable" ||
    input.candidate.status === "invalid_fixture"
  ) {
    return "inconclusive";
  }
  const baselinePassed = input.baseline.status === "passed";
  const candidatePassed = input.candidate.status === "passed";
  if (baselinePassed && candidatePassed) return "both_passed";
  if (!candidatePassed && !baselinePassed) return "both_failed";
  return candidatePassed ? "baseline_failed" : "candidate_failed";
}

function throwIfAborted(signal: AbortSignal, remoteStarted: boolean): void {
  if (signal.aborted) {
    throw new ControlledEvaluationInterruptedError(remoteStarted);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isFatalError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "controlledEvaluationFatal" in error &&
    error.controlledEvaluationFatal === true
  );
}

function isRemoteOutcomeUncertain(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeMayBeUnknown" in error &&
    error.outcomeMayBeUnknown === true
  );
}

function getSafeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 120);
  }
  return "CONTROLLED_TARGET_REQUEST_FAILED";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
