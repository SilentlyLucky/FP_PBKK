import { createHash } from "node:crypto";

export type OfflineGateStatus = "passed" | "failed" | "unverifiable";

export interface OfflineAcceptanceGate {
  status: OfflineGateStatus;
  detail: string;
}

export interface OfflineAcceptanceInput {
  savedResult: unknown;
  expectedCampaignId: string;
  expectedAnswer: Record<string, unknown>;
  originalUploadText: string | null;
  persistedSourceText: string | null;
  campaignSnapshot: unknown;
  optimizerObservations: unknown[] | null;
  optimizerObserverFileMode: string | null;
  legacyRetainedInspectionMode?: boolean;
}

export interface OfflineAcceptanceVerdict {
  passed: boolean;
  gates: Record<string, OfflineAcceptanceGate>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
}

function gate(
  condition: boolean | null,
  passDetail: string,
  failDetail: string,
  unknownDetail: string,
): OfflineAcceptanceGate {
  if (condition === true) return { status: "passed", detail: passDetail };
  if (condition === false) return { status: "failed", detail: failDetail };
  return { status: "unverifiable", detail: unknownDetail };
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Serialize text fields through the platform FormData multipart encoder and
 * return the exact value bytes sent for one field. No request is sent.
 */
export async function renderMultipartTextField(
  fields: readonly (readonly [string, string])[],
  fieldName: string,
): Promise<string> {
  const form = new FormData();
  for (const [name, value] of fields) form.set(name, value);

  const request = new Request("http://offline.invalid", {
    method: "POST",
    body: form,
  });
  const contentType = request.headers.get("content-type");
  const boundary = contentType?.match(/boundary=([^;]+)/u)?.[1];
  if (!boundary) throw new Error("FormData multipart boundary is missing");

  const multipart = Buffer.from(await request.arrayBuffer()).toString("utf8");
  const field = multipart
    .split(`--${boundary}`)
    .find((part) => part.includes(`name="${fieldName}"`));
  if (!field) throw new Error(`FormData field ${fieldName} is missing`);

  const separator = field.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("FormData field header is malformed");
  return field.slice(separator + 4).replace(/\r\n$/u, "");
}

function parseExactAnswer(
  text: unknown,
  expected: Record<string, unknown>,
): { validJson: boolean; exactMatch: boolean } {
  if (typeof text !== "string") return { validJson: false, exactMatch: false };
  let candidate = text.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fence) candidate = fence[1]!.trim();

  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    return { validJson: false, exactMatch: false };
  }
  if (!isRecord(value)) return { validJson: true, exactMatch: false };

  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return {
    validJson: true,
    exactMatch:
      actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]) &&
      expectedKeys.every((key) => value[key] === expected[key]),
  };
}

function exactSingleStringArray(
  value: unknown,
  expected: string,
): boolean | null {
  if (!Array.isArray(value)) return null;
  return value.length === 1 && value[0] === expected;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function exactCount(
  record: JsonRecord | null,
  key: string,
  expected: number,
): boolean | null {
  const value = record?.[key];
  return Number.isInteger(value) ? value === expected : null;
}

export function validateSavedLiveAcceptance(
  input: OfflineAcceptanceInput,
): OfflineAcceptanceVerdict {
  const result = isRecord(input.savedResult) ? input.savedResult : null;
  const source = recordAt(result, "source");
  const evidence = result?.evidenceIdentities;
  const evidenceItem =
    Array.isArray(evidence) && evidence.length === 1
      ? isRecord(evidence[0])
        ? evidence[0]
        : null
      : null;
  const sourceAudit = recordAt(result, "sourceManifestAudit");
  const target = recordAt(result, "target");
  const privateTargetInputProof = recordAt(result, "privateTargetInputProof");
  const targetInputAudit = recordAt(result, "evaluatorLeakageAudit");
  const generationRequests = recordAt(result, "generationRequests");
  const optimizerObservation = recordAt(result, "privateOptimizerObservation");
  const reservationsBefore = recordAt(result, "campaignReservationsBefore");
  const reservationsAfter = recordAt(result, "campaignReservationsAfter");
  const campaignLimits = recordAt(result, "campaignLimits");
  const ledger = isRecord(input.campaignSnapshot)
    ? input.campaignSnapshot
    : null;
  const ledgerProviders = recordAt(ledger, "providers");
  const ledgerCampus = recordAt(ledgerProviders, "campus_gateway");
  const ledgerTarget = recordAt(ledgerProviders, "codex_app_server");
  const ledgerLimits = recordAt(ledger, "maxInferenceCallsByProvider");
  const sourceId =
    typeof source?.sourceId === "string" ? source.sourceId : null;
  const versionId =
    typeof source?.versionId === "string" ? source.versionId : null;
  const chunkIds = source?.chunkIds;
  const chunkId =
    Array.isArray(chunkIds) &&
    chunkIds.length === 1 &&
    typeof chunkIds[0] === "string"
      ? chunkIds[0]
      : null;
  const sourceChecksum =
    typeof source?.checksum === "string" ? source.checksum : null;
  const rawTargetInputText =
    typeof privateTargetInputProof?.targetInputText === "string"
      ? privateTargetInputProof.targetInputText
      : null;
  const rawEvidenceQuoteText =
    typeof privateTargetInputProof?.evidenceQuoteText === "string"
      ? privateTargetInputProof.evidenceQuoteText
      : null;
  const persistedSourceHash =
    input.persistedSourceText === null
      ? null
      : sha256Utf8(input.persistedSourceText);
  const originalSourceHash =
    input.originalUploadText === null
      ? null
      : sha256Utf8(input.originalUploadText);
  const answer = parseExactAnswer(target?.responseText, input.expectedAnswer);
  const responseText =
    typeof target?.responseText === "string" ? target.responseText : null;
  const responseHashMatches =
    responseText !== null &&
    typeof target?.responseHash === "string" &&
    target.responseHash === sha256Utf8(responseText);

  const sourceIdentityMatches =
    sourceId !== null &&
    versionId !== null &&
    chunkId !== null &&
    evidenceItem !== null &&
    evidenceItem.evidenceId === chunkId &&
    evidenceItem.kind === "chunk" &&
    evidenceItem.sourceId === sourceId &&
    evidenceItem.versionId === versionId &&
    evidenceItem.chunkId === chunkId;
  const identityKnown =
    sourceId !== null &&
    versionId !== null &&
    chunkId !== null &&
    evidenceItem !== null &&
    typeof evidenceItem.evidenceId === "string" &&
    typeof evidenceItem.sourceId === "string" &&
    typeof evidenceItem.versionId === "string" &&
    typeof evidenceItem.chunkId === "string";
  const traceKnown =
    evidenceItem !== null &&
    typeof evidenceItem.traceId === "string" &&
    Array.isArray(target?.retrievalTraceIds);
  const traceMatches =
    traceKnown &&
    evidenceItem !== null &&
    Array.isArray(target?.retrievalTraceIds) &&
    (target.retrievalTraceIds as unknown[]).includes(evidenceItem.traceId) &&
    evidenceItem.traceIdMatchesWorkspaceRetrievalTrace === true;
  const manifestKnown = source !== null && sourceAudit !== null;
  const manifestMatches =
    manifestKnown &&
    sourceId !== null &&
    versionId !== null &&
    chunkId !== null &&
    source?.sourceKind === "text_paste" &&
    source?.permission === "campus_indexer_allowed" &&
    source?.versionNumber === 1 &&
    source?.chunkCount === 1 &&
    sourceAudit?.createdSourceMatchesReadback === true &&
    sourceAudit?.sourceRecordCount === 1 &&
    sourceAudit?.sourceIdMatches === true &&
    sourceAudit?.activeVersionMatches === true &&
    sourceAudit?.permissionMatches === true &&
    sourceAudit?.eligibilityMatches === true &&
    sourceAudit?.deletionStatusMatches === true &&
    sourceAudit?.chunkCountMatches === true &&
    sourceAudit?.checksumMatchesReadback === true &&
    sourceAudit?.frozenRunManifestExact === true &&
    sourceAudit?.targetInputManifestExact === true &&
    exactSingleStringArray(sourceAudit?.selectedSourceIds, sourceId) === true &&
    exactSingleStringArray(sourceAudit?.frozenManifestSourceIds, sourceId) ===
      true;
  const inputAuditKnown = targetInputAudit !== null && target !== null;
  const targetInputAuditMatches =
    inputAuditKnown &&
    targetInputAudit?.targetInputInspected === true &&
    targetInputAudit?.targetInputHash === target?.targetInputHash &&
    Number.isInteger(targetInputAudit?.targetInputCharacters) &&
    targetInputAudit?.targetInputCharacters === target?.targetInputCharacters &&
    targetInputAudit?.selectedSourceAnswerValuePresentInTargetInput === true &&
    targetInputAudit?.selectedSourceValueIsLegitimateEvidence === true &&
    targetInputAudit?.privateGoldObjectPresent === false &&
    targetInputAudit?.evaluatorOnlyMarkerPresent === false;
  const callsKnown =
    generationRequests !== null &&
    Number.isInteger(generationRequests.campusOptimizerDecisions) &&
    Number.isInteger(generationRequests.campusSuccessfulUsageSnapshots) &&
    Number.isInteger(generationRequests.codexTargetCalls) &&
    Number.isInteger(generationRequests.codexSuccessfulUsageSnapshots) &&
    Number.isInteger(generationRequests.baselineTargetGenerations) &&
    Array.isArray(generationRequests.targetResponseIds);
  const targetResponseIds = generationRequests?.targetResponseIds;
  const callsMatch =
    callsKnown &&
    Number(generationRequests?.campusOptimizerDecisions) >= 1 &&
    Number(generationRequests?.campusOptimizerDecisions) <= 5 &&
    generationRequests?.campusSuccessfulUsageSnapshots ===
      generationRequests?.campusOptimizerDecisions &&
    generationRequests?.codexTargetCalls === 1 &&
    generationRequests?.codexSuccessfulUsageSnapshots === 1 &&
    generationRequests?.baselineTargetGenerations === 0 &&
    Array.isArray(targetResponseIds) &&
    targetResponseIds.length === 1 &&
    typeof targetResponseIds[0] === "string";
  const optimizerContextChecks = optimizerObservation?.contextLeakageChecks;
  const optimizerRecords = input.optimizerObservations;
  const optimizerResponseCount = Array.isArray(optimizerRecords)
    ? optimizerRecords.filter(
        (item) => isRecord(item) && item.responseReceived === true,
      ).length
    : null;
  const optimizerObserverKnown =
    optimizerObservation !== null &&
    Number.isInteger(optimizerObservation.capturedRequests) &&
    Number.isInteger(optimizerObservation.capturedResponses) &&
    Array.isArray(optimizerContextChecks) &&
    Array.isArray(optimizerRecords) &&
    typeof input.optimizerObserverFileMode === "string" &&
    generationRequests !== null &&
    Number.isInteger(generationRequests.campusObservedHttpRequests) &&
    Number.isInteger(generationRequests.campusCapturedHttpResponses);
  const optimizerObserverMatches =
    optimizerObserverKnown &&
    optimizerObservation?.fileMode === "600" &&
    Number(optimizerObservation?.capturedRequests) >= 1 &&
    Number(optimizerObservation?.capturedRequests) <= 5 &&
    optimizerObservation?.capturedResponses ===
      generationRequests?.campusSuccessfulUsageSnapshots &&
    input.optimizerObserverFileMode === "600" &&
    optimizerRecords.length === optimizerObservation?.capturedRequests &&
    optimizerResponseCount === optimizerObservation?.capturedResponses &&
    generationRequests?.campusObservedHttpRequests ===
      optimizerObservation?.capturedRequests &&
    generationRequests?.campusCapturedHttpResponses ===
      optimizerObservation?.capturedResponses &&
    ledgerCampus !== null &&
    optimizerRecords.length === ledgerCampus.reservedCalls &&
    optimizerResponseCount ===
      generationRequests?.campusSuccessfulUsageSnapshots &&
    Array.isArray(optimizerContextChecks) &&
    optimizerContextChecks.length > 0 &&
    optimizerContextChecks.every(
      (item) =>
        isRecord(item) &&
        item.privateGoldObjectPresent === false &&
        item.evaluatorOnlyMarkerPresent === false,
    );
  const optimizerLeakageAuditMatches =
    targetInputAudit?.optimizerContextInspected === true &&
    targetInputAudit?.optimizerPrivateGoldObjectPresent === false &&
    targetInputAudit?.optimizerEvaluatorOnlyMarkerPresent === false;
  const runCompleted = result?.runStatus === "succeeded";
  const retrievalModeMatches =
    target?.requestedRetrievalStrategy === "lexical" &&
    target?.effectiveRetrievalStrategy === "lexical" &&
    target?.retrievalEvidenceStatus === "evidence_included";
  const exactAnswerAssertionsMatch =
    target?.answerFormatValidJson === answer.validJson &&
    target?.exactStructuredAnswerPassed === answer.exactMatch;
  const expectedManifestSource = {
    documentId: sourceId,
    documentVersionId: versionId,
    documentVersion: source?.versionNumber,
    checksum: sourceChecksum,
    sourcePermission: source?.permission,
  };
  const expectedFrozenManifest = {
    format: "promptlab-workspace-source-manifest-v1",
    sources: [expectedManifestSource],
  };
  const savedManifestObjectsKnown =
    privateTargetInputProof !== null &&
    privateTargetInputProof.frozenRunManifest !== undefined &&
    Array.isArray(privateTargetInputProof.targetInputSourceManifest) &&
    Array.isArray(privateTargetInputProof.targetInputSourceIds);
  const savedManifestObjectsMatch =
    savedManifestObjectsKnown &&
    canonicalJson(privateTargetInputProof?.frozenRunManifest) ===
      canonicalJson(expectedFrozenManifest) &&
    canonicalJson(privateTargetInputProof?.targetInputSourceManifest) ===
      canonicalJson([expectedManifestSource]) &&
    canonicalJson(privateTargetInputProof?.targetInputSourceIds) ===
      canonicalJson(sourceId === null ? [] : [sourceId]);
  const rawTargetInputHashMatches =
    rawTargetInputText !== null &&
    typeof targetInputAudit?.targetInputHash === "string" &&
    typeof target?.targetInputHash === "string" &&
    targetInputAudit.targetInputHash === sha256Utf8(rawTargetInputText) &&
    target.targetInputHash === sha256Utf8(rawTargetInputText) &&
    rawTargetInputText.length === targetInputAudit.targetInputCharacters &&
    rawTargetInputText.length === target.targetInputCharacters;
  const campaignKnown =
    result !== null &&
    reservationsBefore !== null &&
    reservationsAfter !== null &&
    campaignLimits !== null &&
    ledger !== null &&
    ledgerProviders !== null &&
    ledgerCampus !== null &&
    ledgerTarget !== null &&
    ledgerLimits !== null;
  const campusReservedCalls = ledgerCampus?.reservedCalls;
  const campaignMatches =
    campaignKnown &&
    result?.campaignId === input.expectedCampaignId &&
    ledger?.campaignId === input.expectedCampaignId &&
    campaignLimits?.campus_gateway === 5 &&
    campaignLimits?.codex_app_server === 1 &&
    exactCount(reservationsBefore, "campus_gateway", 0) === true &&
    exactCount(reservationsBefore, "codex_app_server", 0) === true &&
    Number.isInteger(campusReservedCalls) &&
    Number(campusReservedCalls) >= 1 &&
    Number(campusReservedCalls) <= 5 &&
    exactCount(
      reservationsAfter,
      "campus_gateway",
      Number(campusReservedCalls),
    ) === true &&
    exactCount(reservationsAfter, "codex_app_server", 1) === true &&
    exactCount(ledgerCampus, "reservedCalls", Number(campusReservedCalls)) ===
      true &&
    exactCount(ledgerTarget, "reservedCalls", 1) === true &&
    ledgerLimits?.campus_gateway === 5 &&
    ledgerLimits?.codex_app_server === 1 &&
    isRecord(reservationsAfter?.limits) &&
    reservationsAfter.limits.campus_gateway === 5 &&
    reservationsAfter.limits.codex_app_server === 1 &&
    reservationsAfter.withinConfiguredLimits === true &&
    reservationsAfter.countsMatchWorkerEvents === true;

  const gates: Record<string, OfflineAcceptanceGate> = {
    exact_answer: gate(
      responseText !== null &&
        typeof target?.answerFormatValidJson === "boolean" &&
        typeof target?.exactStructuredAnswerPassed === "boolean" &&
        typeof target?.responseHash === "string"
        ? answer.exactMatch && exactAnswerAssertionsMatch && responseHashMatches
        : null,
      "Saved target text parses to the exact expected JSON object using the harness parseExactAnswer rules, and its retained response hash matches the text bytes.",
      "Saved target text, response hash, or retained exact-answer assertions are invalid or disagree.",
      "The saved target response text, response hash, or exact-answer assertions are missing.",
    ),
    upload_fixture_binding: gate(
      source?.sourceTextSha256 && originalSourceHash
        ? source.sourceTextSha256 === originalSourceHash
        : null,
      "The offline fixture's original LF text hashes to the pre-upload source hash recorded by the original harness.",
      "The offline source fixture does not match the original harness's recorded pre-upload hash.",
      "The original upload text or its recorded hash is missing.",
    ),
    persisted_source_checksum: gate(
      sourceChecksum && persistedSourceHash
        ? sourceChecksum === persistedSourceHash
        : null,
      "Exact platform FormData text bytes hash to the source checksum returned by the create and readback endpoints.",
      "Reconstructed persisted source bytes do not match the recorded source checksum.",
      "The persisted source bytes or API checksum is missing.",
    ),
    source_manifest: gate(
      manifestKnown
        ? manifestMatches &&
            (savedManifestObjectsKnown
              ? savedManifestObjectsMatch
              : input.legacyRetainedInspectionMode === true)
        : null,
      "Retained source create/readback assertions and frozen run and target-input manifest assertions match the selected source. The offline audit checks saved assertions and retained manifest objects; it does not re-fetch endpoints or independently reconstruct absent API objects.",
      "One or more saved source endpoint or manifest fields disagree.",
      "A required saved source endpoint or manifest field is missing.",
    ),
    evidence_identity: gate(
      evidence === undefined ||
        !Array.isArray(evidence) ||
        evidence.length === 0
        ? null
        : identityKnown && sourceIdentityMatches,
      "The sole evidence item names the selected source, version, chunk, and matching chunk evidence ID.",
      "Evidence source, version, chunk, or evidence ID does not match the selected source manifest.",
      "The saved evidence identity is missing or incomplete.",
    ),
    evidence_trace: gate(
      traceKnown ? traceMatches : null,
      "The evidence trace ID is present in the saved Workspace retrieval trace list and the original trace audit passed.",
      "The evidence trace does not match the saved Workspace retrieval trace list.",
      "The evidence trace or saved retrieval trace list is missing.",
    ),
    evidence_quote: gate(
      evidenceItem &&
        typeof evidenceItem.quoteSha256 === "string" &&
        persistedSourceHash
        ? rawEvidenceQuoteText !== null
          ? evidenceItem.quoteSha256 === persistedSourceHash &&
            rawEvidenceQuoteText === input.persistedSourceText &&
            sha256Utf8(rawEvidenceQuoteText) === evidenceItem.quoteSha256 &&
            source?.chunkCount === 1 &&
            chunkId !== null
          : input.legacyRetainedInspectionMode === true
            ? null
            : null
        : null,
      "The retained raw evidence quote equals the complete stored one-chunk source bytes, and both text and evidence hashes match. This synthetic source has exactly one persisted chunk.",
      "The evidence quote text or hash differs from the stored normalized one-chunk source, or the one-chunk invariant failed.",
      input.legacyRetainedInspectionMode === true
        ? "Legacy retained-inspection mode: the seventh result retained only a quote hash; raw quote text is unavailable for an independent byte comparison."
        : "The raw evidence quote, normalized source bytes, or chunk identity is missing.",
    ),
    target_input_evidence_audit: gate(
      inputAuditKnown && rawTargetInputText !== null
        ? targetInputAuditMatches && rawTargetInputHashMatches
        : null,
      "The retained raw target-input text independently hashes to the Workspace target-input hash and length, alongside the selected-source and evaluator-isolation assertions.",
      "The retained target-input audit is incomplete or reports a mismatch.",
      input.legacyRetainedInspectionMode === true
        ? "Legacy retained-inspection mode: the seventh result has saved hash/length and assertions, but no raw target-input text to independently re-hash."
        : "Required raw target-input text or inspection fields are missing.",
    ),
    completed_run: gate(
      typeof result?.runStatus === "string" ? runCompleted : null,
      "The saved Workspace run status is succeeded.",
      "The saved Workspace run did not succeed.",
      "The saved Workspace run status is missing.",
    ),
    lexical_retrieval: gate(
      target === null ? null : retrievalModeMatches,
      "The saved run used the explicitly selected lexical strategy and reported evidence included.",
      "The saved retrieval strategy or evidence status differs from the strict gate.",
      "The saved retrieval strategy or evidence status is missing.",
    ),
    bounded_generation_calls: gate(
      generationRequests === null ? null : callsKnown && callsMatch,
      "Saved run events record one to five Campus optimizer completions with matching usage snapshots, one Codex target call and usage snapshot, one response ID, and no baseline generation.",
      "Saved run event counts differ from the required one-optimizer/one-target case.",
      "One or more required saved generation counts are missing.",
    ),
    optimizer_observer_and_isolation: gate(
      optimizerObservation === null || targetInputAudit === null
        ? null
        : optimizerObserverKnown &&
            optimizerObserverMatches &&
            optimizerLeakageAuditMatches,
      "The private mode-0600 observer captured the Campus optimizer requests and responses; counts match the run events and ledger, and retained context checks show no evaluator leakage.",
      "The optimizer observer counts, private mode, or evaluator-isolation audit disagree.",
      "Required private optimizer observation or isolation fields are missing.",
    ),
    campaign_ledger: gate(
      campaignKnown ? campaignMatches : null,
      "The strict read-only persisted campaign ledger snapshot and saved cleanup snapshot confirm one to five Campus optimizer reservations and exactly one Codex target reservation under 5/1 limits, matching run events.",
      "Campaign identity, limits, event counts, or provider reservations disagree.",
      "The campaign ledger snapshot or saved reservation fields are missing.",
    ),
  };

  return {
    passed: Object.values(gates).every((item) => item.status === "passed"),
    gates,
  };
}
