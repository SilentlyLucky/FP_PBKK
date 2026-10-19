import type {
  ProviderCompletion,
  UsageMetric,
  UsageSnapshot,
} from "@promptlab/contracts";
import { describe, expect, it } from "vitest";

import {
  campusCredentialFingerprint,
  campusCapabilitiesFromSnapshot,
  campusVerificationMatchesConfiguration,
  campusVerificationFailureMessage,
  createCampusFailureSnapshot,
  createCampusVerificationSnapshot,
} from "./campus-verification.js";

const checkedAt = "2026-10-12T00:00:00.000Z";
const apiKey = "test-only-campus-secret";
const reported: UsageMetric = {
  status: "reported",
  value: 4,
  observedAt: checkedAt,
  method: "test fixture",
};
const unknown: UsageMetric = {
  status: "unknown",
  value: null,
  reason: "not included in test response",
};

function completion(
  usage: UsageSnapshot = {
    inputTokens: reported,
    outputTokens: reported,
    cacheReadTokens: unknown,
    cacheWriteTokens: unknown,
    completeness: "partial",
    responseId: "private-response-id",
    mapperVersion: "test-v1",
  },
): ProviderCompletion {
  return {
    provider: "campus_gateway",
    requestedModel: "qwen3:14b",
    responseModel: "campus-qwen-alias",
    responseId: "private-response-id",
    text: "private response content must not enter the receipt",
    usage,
    observedAt: checkedAt,
  };
}

describe("campus verification receipt", () => {
  it("binds a successful response to the exact model, credential identity, timestamp, and provenance", () => {
    const receipt = createCampusVerificationSnapshot(completion(), {
      apiKey,
      checkedAt,
      verificationId: "receipt-test-1",
    });

    expect(receipt.verification).toMatchObject({
      provider: "campus_gateway",
      status: "verified",
      provenance: "settings_manual_action_v1",
      verificationId: "receipt-test-1",
      credentialFingerprint: campusCredentialFingerprint(apiKey),
      requestedModel: "qwen3:14b",
      responseModel: "campus-qwen-alias",
      checkedAt,
    });
    expect(
      campusVerificationMatchesConfiguration(receipt, {
        apiKey,
        requestedModel: "qwen3:14b",
      }),
    ).toBe(true);
    expect(
      campusVerificationMatchesConfiguration(receipt, {
        apiKey: "rotated-test-only-campus-secret",
        requestedModel: "qwen3:14b",
      }),
    ).toBe(false);
    expect(
      campusVerificationMatchesConfiguration(receipt, {
        apiKey,
        requestedModel: "different-model",
      }),
    ).toBe(false);
  });

  it("marks only fields observed in the one-shot response and keeps other capabilities unknown", () => {
    const receipt = createCampusVerificationSnapshot(completion(), {
      apiKey,
      checkedAt,
      verificationId: "receipt-test-2",
    });

    expect(receipt.capabilities.reportedUsage.status).toBe("supported");
    expect(receipt.capabilities.streamText.status).toBe("unknown");
    expect(receipt.capabilities.cacheReadReporting.status).toBe("unknown");
    expect(receipt.capabilities.cacheWriteReporting.status).toBe("unknown");
    expect(receipt.capabilities.toolCalls.status).toBe("unknown");
    expect(
      Object.values(receipt.capabilities).some(
        (capability) => capability.status === "unsupported",
      ),
    ).toBe(false);
    expect(campusCapabilitiesFromSnapshot(receipt)).toEqual(
      receipt.capabilities,
    );
  });

  it("does not put the credential, response text, or provider response id in the saved receipt", () => {
    const receipt = createCampusVerificationSnapshot(completion(), {
      apiKey,
      checkedAt,
      verificationId: "receipt-test-3",
    });
    const serialized = JSON.stringify(receipt);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("private response content");
    expect(serialized).not.toContain("private-response-id");
  });

  it("records a sanitized failure without turning it into a verified receipt", () => {
    const receipt = createCampusFailureSnapshot({
      apiKey,
      requestedModel: "qwen3:14b",
      checkedAt,
      verificationId: "receipt-failed-1",
      failureCode: "AUTH_REQUIRED",
    });

    expect(receipt.verification.status).toBe("failed");
    expect(receipt.verification.failureCode).toBe("AUTH_REQUIRED");
    expect(
      campusVerificationMatchesConfiguration(receipt, {
        apiKey,
        requestedModel: "qwen3:14b",
      }),
    ).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(apiKey);
    const message = campusVerificationFailureMessage("AUTH_REQUIRED");
    expect(message).toContain("credential tidak ditampilkan");
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain("authorization");
    expect(campusVerificationFailureMessage(null)).not.toContain(apiKey);
  });
});
