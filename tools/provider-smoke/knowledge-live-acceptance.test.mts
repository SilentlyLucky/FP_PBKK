import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  renderMultipartTextField,
  sha256Utf8,
  validateSavedLiveAcceptance,
  type OfflineAcceptanceInput,
} from "./knowledge-live-acceptance.mjs";
import { readExistingProviderCampaignLedgerReadOnly } from "./provider-campaign-ledger-readonly.mjs";

const SOURCE_TEXT =
  "# Refund policy\n\nFor ordinary non-Enterprise purchases of physical products bought outside a sale, refund requests are accepted up to 7 calendar days after purchase. Digital products are excluded.\n";
const CAMPAIGN_ID = "knowledge-live-20261019-00000007";
const EXPECTED_ANSWER = { eligible: true, refundWindowDays: 7 };
const TARGET_INPUT_TEXT =
  "Selected source excerpt: refund requests are accepted up to 7 calendar days after purchase.";

function makeCampaignLedger(campaignId = CAMPAIGN_ID) {
  const entry = {
    reservedCalls: 1,
    lastOutcome: "succeeded",
    requestedModel: "gpt-6-luna",
    responseModel: "gpt-6-luna",
    usage: "reported",
    capabilitiesObserved: [],
  };
  return {
    campaignId,
    maxInferenceCallsByProvider: {
      campus_gateway: 5,
      codex_app_server: 1,
    },
    providers: {
      campus_gateway: { ...entry, requestedModel: "qwen3:14b" },
      codex_app_server: entry,
    },
  };
}

async function snapshotDirectory(directory: string) {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      bytes: (await readFile(join(directory, name))).toString("hex"),
      mode: ((await stat(join(directory, name))).mode & 0o777).toString(8),
    })),
  );
}

async function expectReadOnlyRefusalWithoutChanges(
  directory: string,
  ledgerPath: string,
) {
  const before = await snapshotDirectory(directory);
  await expect(
    readExistingProviderCampaignLedgerReadOnly(ledgerPath, CAMPAIGN_ID),
  ).rejects.toThrow();
  expect(await snapshotDirectory(directory)).toEqual(before);
}

function setCampusReservationCount(
  input: OfflineAcceptanceInput,
  count: number,
) {
  const result = input.savedResult as Record<string, any>;
  const generationRequests = result.generationRequests;
  generationRequests.campusOptimizerDecisions = count;
  generationRequests.campusSuccessfulUsageSnapshots = count;
  generationRequests.campusObservedHttpRequests = count;
  generationRequests.campusCapturedHttpResponses = count;
  generationRequests.campusReservedInferenceCalls = count;
  result.privateOptimizerObservation.capturedRequests = count;
  result.privateOptimizerObservation.capturedResponses = count;
  result.privateOptimizerObservation.contextLeakageChecks = Array.from(
    { length: count },
    () => ({
      privateGoldObjectPresent: false,
      evaluatorOnlyMarkerPresent: false,
    }),
  );
  result.campaignReservationsAfter.campus_gateway = count;
  result.campaignReservationsAfter.withinConfiguredLimits = count <= 5;
  const campaignSnapshot = input.campaignSnapshot as Record<string, any>;
  campaignSnapshot.providers.campus_gateway.reservedCalls = count;
  input.optimizerObservations = Array.from({ length: count }, () => ({
    responseReceived: true,
  }));
}

async function makeAcceptedFixture(): Promise<OfflineAcceptanceInput> {
  const persistedSourceText = await renderMultipartTextField(
    [
      ["displayName", "refund-policy.md"],
      ["content", SOURCE_TEXT],
      ["sourceKind", "paste"],
      ["permission", "campus_indexer_allowed"],
    ],
    "content",
  );
  const sourceId = "source-1";
  const versionId = "version-1";
  const chunkId = "chunk-1";
  const traceId = "trace-1";
  const responseText = JSON.stringify(EXPECTED_ANSWER);

  return {
    expectedCampaignId: CAMPAIGN_ID,
    expectedAnswer: EXPECTED_ANSWER,
    originalUploadText: SOURCE_TEXT,
    persistedSourceText,
    optimizerObservations: [{ responseReceived: true }],
    optimizerObserverFileMode: "600",
    campaignSnapshot: {
      campaignId: CAMPAIGN_ID,
      maxInferenceCallsByProvider: {
        campus_gateway: 5,
        codex_app_server: 1,
      },
      providers: {
        campus_gateway: { reservedCalls: 1 },
        codex_app_server: { reservedCalls: 1 },
      },
    },
    savedResult: {
      campaignId: CAMPAIGN_ID,
      runStatus: "succeeded",
      campaignLimits: { campus_gateway: 5, codex_app_server: 1 },
      source: {
        sourceId,
        versionId,
        versionNumber: 1,
        sourceKind: "text_paste",
        permission: "campus_indexer_allowed",
        checksum: sha256Utf8(persistedSourceText),
        chunkCount: 1,
        chunkIds: [chunkId],
        sourceTextSha256: sha256Utf8(SOURCE_TEXT),
      },
      sourceManifestAudit: {
        createdSourceMatchesReadback: true,
        sourceRecordCount: 1,
        sourceIdMatches: true,
        activeVersionMatches: true,
        permissionMatches: true,
        eligibilityMatches: true,
        deletionStatusMatches: true,
        chunkCountMatches: true,
        checksumMatchesReadback: true,
        selectedSourceIds: [sourceId],
        frozenRunManifestExact: true,
        frozenManifestSourceIds: [sourceId],
        targetInputManifestExact: true,
      },
      evidenceIdentities: [
        {
          evidenceId: chunkId,
          kind: "chunk",
          sourceId,
          versionId,
          chunkId,
          traceId,
          quoteSha256: sha256Utf8(persistedSourceText),
          traceIdMatchesWorkspaceRetrievalTrace: true,
        },
      ],
      evaluatorLeakageAudit: {
        targetInputInspected: true,
        targetInputHash: sha256Utf8(TARGET_INPUT_TEXT),
        targetInputCharacters: TARGET_INPUT_TEXT.length,
        selectedSourceAnswerValuePresentInTargetInput: true,
        selectedSourceValueIsLegitimateEvidence: true,
        privateGoldObjectPresent: false,
        evaluatorOnlyMarkerPresent: false,
        optimizerContextInspected: true,
        optimizerPrivateGoldObjectPresent: false,
        optimizerEvaluatorOnlyMarkerPresent: false,
      },
      target: {
        responseText,
        responseHash: sha256Utf8(responseText),
        answerFormatValidJson: true,
        exactStructuredAnswerPassed: true,
        requestedRetrievalStrategy: "lexical",
        effectiveRetrievalStrategy: "lexical",
        targetInputHash: sha256Utf8(TARGET_INPUT_TEXT),
        targetInputCharacters: TARGET_INPUT_TEXT.length,
        retrievalEvidenceStatus: "evidence_included",
        retrievalTraceIds: [traceId],
      },
      privateTargetInputProof: {
        targetInputText: TARGET_INPUT_TEXT,
        evidenceQuoteText: persistedSourceText,
        frozenRunManifest: {
          format: "promptlab-workspace-source-manifest-v1",
          sources: [
            {
              documentId: sourceId,
              documentVersionId: versionId,
              documentVersion: 1,
              checksum: sha256Utf8(persistedSourceText),
              sourcePermission: "campus_indexer_allowed",
            },
          ],
        },
        targetInputSourceManifest: [
          {
            documentId: sourceId,
            documentVersionId: versionId,
            documentVersion: 1,
            checksum: sha256Utf8(persistedSourceText),
            sourcePermission: "campus_indexer_allowed",
          },
        ],
        targetInputSourceIds: [sourceId],
      },
      generationRequests: {
        campusOptimizerDecisions: 1,
        campusSuccessfulUsageSnapshots: 1,
        campusObservedHttpRequests: 1,
        campusCapturedHttpResponses: 1,
        codexTargetCalls: 1,
        codexSuccessfulUsageSnapshots: 1,
        baselineTargetGenerations: 0,
        targetResponseIds: ["response-1"],
      },
      privateOptimizerObservation: {
        capturedRequests: 1,
        capturedResponses: 1,
        fileMode: "600",
        contextLeakageChecks: [
          {
            privateGoldObjectPresent: false,
            evaluatorOnlyMarkerPresent: false,
          },
        ],
      },
      campaignReservationsBefore: {
        campus_gateway: 0,
        codex_app_server: 0,
      },
      campaignReservationsAfter: {
        campus_gateway: 1,
        codex_app_server: 1,
        limits: { campus_gateway: 5, codex_app_server: 1 },
        withinConfiguredLimits: true,
        countsMatchWorkerEvents: true,
        observerMatchesCampusReservations: true,
      },
    },
  };
}

describe("saved live knowledge acceptance", () => {
  it("reproduces the original LF upload through FormData and verifies its normalized one-chunk quote", async () => {
    const input = await makeAcceptedFixture();
    const result = input.savedResult as {
      source: { checksum: string; sourceTextSha256: string };
      evidenceIdentities: Array<{ quoteSha256: string }>;
    };

    expect(SOURCE_TEXT).toHaveLength(197);
    expect(sha256Utf8(SOURCE_TEXT)).toBe(
      "adbc9930f17b99b16eaee29d010a1255ad47eb6c9ec31ec83d6fc487ffd8873f",
    );
    expect(input.persistedSourceText).toBe(SOURCE_TEXT.replace(/\n/gu, "\r\n"));
    expect(input.persistedSourceText).toHaveLength(200);
    expect(result.source.sourceTextSha256).toBe(
      "adbc9930f17b99b16eaee29d010a1255ad47eb6c9ec31ec83d6fc487ffd8873f",
    );
    expect(result.source.checksum).toBe(
      "f77903f1c7ef66b00878681acccf05e67a0c9c6e44ed9a2e895396203a6f5929",
    );
    expect(result.evidenceIdentities[0]?.quoteSha256).toBe(
      result.source.checksum,
    );

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(true);
    expect(
      Object.values(verdict.gates).every((item) => item.status === "passed"),
    ).toBe(true);
  });

  it("rejects a changed evidence quote hash", async () => {
    const input = await makeAcceptedFixture();
    const savedResult = input.savedResult as {
      evidenceIdentities: Array<{ quoteSha256: string }>;
    };
    savedResult.evidenceIdentities[0]!.quoteSha256 = "0".repeat(64);

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.evidence_quote?.status).toBe("failed");
  });

  it("rejects changed raw quote text even when the saved hash is unchanged", async () => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as {
        privateTargetInputProof: { evidenceQuoteText: string };
      }
    ).privateTargetInputProof.evidenceQuoteText += " changed";

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.evidence_quote?.status).toBe("failed");
  });

  it("rejects a correct JSON answer whose retained response hash is wrong", async () => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as { target: { responseHash: string } }
    ).target.responseHash = "0".repeat(64);

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.exact_answer?.status).toBe("failed");
  });

  it("rejects changed raw target-input text when the retained hash is unchanged", async () => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as {
        privateTargetInputProof: { targetInputText: string };
      }
    ).privateTargetInputProof.targetInputText += " changed";

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.target_input_evidence_audit?.status).toBe("failed");
  });

  it("keeps missing raw target input explicitly unverifiable in legacy mode", async () => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as {
        privateTargetInputProof: { targetInputText: string | null };
      }
    ).privateTargetInputProof.targetInputText = null;
    input.legacyRetainedInspectionMode = true;

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.target_input_evidence_audit?.status).toBe(
      "unverifiable",
    );
  });

  it("rejects a changed source checksum even when the saved quote hash is unchanged", async () => {
    const input = await makeAcceptedFixture();
    const savedResult = input.savedResult as {
      source: { checksum: string };
    };
    savedResult.source.checksum = "0".repeat(64);

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.persisted_source_checksum?.status).toBe("failed");
  });

  it.each([
    [
      "source",
      (result: Record<string, any>) => {
        result.evidenceIdentities[0].sourceId = "other-source";
      },
      "evidence_identity",
    ],
    [
      "version",
      (result: Record<string, any>) => {
        result.evidenceIdentities[0].versionId = "other-version";
      },
      "evidence_identity",
    ],
    [
      "chunk",
      (result: Record<string, any>) => {
        result.evidenceIdentities[0].chunkId = "other-chunk";
      },
      "evidence_identity",
    ],
    [
      "trace",
      (result: Record<string, any>) => {
        result.evidenceIdentities[0].traceId = "other-trace";
      },
      "evidence_trace",
    ],
  ])(
    "rejects an evidence identity with a wrong %s",
    async (_label, mutate, gateName) => {
      const input = await makeAcceptedFixture();
      mutate(input.savedResult as Record<string, any>);

      const verdict = validateSavedLiveAcceptance(input);
      expect(verdict.passed).toBe(false);
      expect(verdict.gates[gateName]?.status).toBe("failed");
    },
  );

  it("rejects a target answer that differs from the exact expected JSON object", async () => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as { target: { responseText: string } }
    ).target.responseText = '{"eligible":true,"refundWindowDays":6}';

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.exact_answer?.status).toBe("failed");
  });

  it.each([0, 2])("rejects %s Codex target calls", async (calls) => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as { generationRequests: { codexTargetCalls: number } }
    ).generationRequests.codexTargetCalls = calls;

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.bounded_generation_calls?.status).toBe("failed");
  });

  it("accepts multiple completed optimizer calls within the 5-call cap", async () => {
    const input = await makeAcceptedFixture();
    setCampusReservationCount(input, 2);

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(true);
  });

  it("reports missing evidence as a retrieval failure, not a call-count failure", async () => {
    const input = await makeAcceptedFixture();
    (
      input.savedResult as {
        target: { retrievalEvidenceStatus: string };
      }
    ).target.retrievalEvidenceStatus = "no_evidence_found";

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.bounded_generation_calls?.status).toBe("passed");
    expect(verdict.gates.lexical_retrieval?.status).toBe("failed");
  });

  it.each([0, 6])("rejects %s Campus optimizer reservations", async (calls) => {
    const input = await makeAcceptedFixture();
    setCampusReservationCount(input, calls);

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.bounded_generation_calls?.status).toBe("failed");
    expect(verdict.gates.campaign_ledger?.status).toBe("failed");
  });

  it("rejects a missing Campus optimizer completion", async () => {
    const input = await makeAcceptedFixture();
    delete (
      input.savedResult as { generationRequests: Record<string, unknown> }
    ).generationRequests.campusOptimizerDecisions;

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.bounded_generation_calls?.status).toBe("failed");
  });

  it("does not pass when required source or trace fields are unverifiable", async () => {
    const input = await makeAcceptedFixture();
    delete (input.savedResult as { sourceManifestAudit?: unknown })
      .sourceManifestAudit;
    (
      input.savedResult as {
        evidenceIdentities: Array<Record<string, unknown>>;
      }
    ).evidenceIdentities[0]!.traceId = undefined;

    const verdict = validateSavedLiveAcceptance(input);
    expect(verdict.passed).toBe(false);
    expect(verdict.gates.source_manifest?.status).toBe("unverifiable");
    expect(verdict.gates.evidence_trace?.status).toBe("unverifiable");
  });
});

describe("read-only provider campaign ledger snapshot", () => {
  async function withLedgerDirectory(
    action: (directory: string, ledgerPath: string) => Promise<void>,
  ) {
    const directory = await mkdtemp(
      join(tmpdir(), "promptlab-ledger-readonly-"),
    );
    const ledgerPath = join(directory, `${CAMPAIGN_ID}.json`);
    try {
      await action(directory, ledgerPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("reads an existing valid ledger and marker without modification", async () => {
    await withLedgerDirectory(async (directory, ledgerPath) => {
      await writeFile(ledgerPath, `${JSON.stringify(makeCampaignLedger())}\n`, {
        mode: 0o600,
      });
      await writeFile(`${ledgerPath}.initialized`, `${CAMPAIGN_ID}\n`, {
        mode: 0o600,
      });
      const before = await snapshotDirectory(directory);

      const snapshot = await readExistingProviderCampaignLedgerReadOnly(
        ledgerPath,
        CAMPAIGN_ID,
      );

      expect(snapshot.campaignId).toBe(CAMPAIGN_ID);
      expect(snapshot.providers.campus_gateway.reservedCalls).toBe(1);
      expect(await snapshotDirectory(directory)).toEqual(before);
    });
  });

  it("refuses a missing ledger without creating it", async () => {
    await withLedgerDirectory(async (directory, ledgerPath) => {
      await writeFile(`${ledgerPath}.initialized`, `${CAMPAIGN_ID}\n`, {
        mode: 0o600,
      });
      await expectReadOnlyRefusalWithoutChanges(directory, ledgerPath);
    });
  });

  it("refuses a missing marker without creating it", async () => {
    await withLedgerDirectory(async (directory, ledgerPath) => {
      await writeFile(ledgerPath, `${JSON.stringify(makeCampaignLedger())}\n`, {
        mode: 0o600,
      });
      await expectReadOnlyRefusalWithoutChanges(directory, ledgerPath);
    });
  });

  it("refuses corrupt ledger JSON without modifying files", async () => {
    await withLedgerDirectory(async (directory, ledgerPath) => {
      await writeFile(ledgerPath, "{corrupt", { mode: 0o600 });
      await writeFile(`${ledgerPath}.initialized`, `${CAMPAIGN_ID}\n`, {
        mode: 0o600,
      });
      await expectReadOnlyRefusalWithoutChanges(directory, ledgerPath);
    });
  });

  it("refuses a corrupt marker without modifying files", async () => {
    await withLedgerDirectory(async (directory, ledgerPath) => {
      await writeFile(ledgerPath, `${JSON.stringify(makeCampaignLedger())}\n`, {
        mode: 0o600,
      });
      await writeFile(`${ledgerPath}.initialized`, "wrong-campaign\n", {
        mode: 0o600,
      });
      await expectReadOnlyRefusalWithoutChanges(directory, ledgerPath);
    });
  });
});
