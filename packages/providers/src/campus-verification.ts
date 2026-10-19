import { createHash, randomUUID } from "node:crypto";

import {
  CapabilityEvidenceSchema,
  type ProviderConnectionState,
  type ProviderCompletion,
} from "@promptlab/contracts";
import { z } from "zod";

import type { CapabilityCampaign } from "./capability-campaign.js";
import { CAMPUS_CHAT_COMPLETIONS_ENDPOINT } from "@promptlab/providers/campus";

export const CAMPUS_VERIFICATION_PROVENANCE =
  "settings_manual_action_v1" as const;
export type CampusVerificationFailureCode =
  | "AUTH_REQUIRED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ABORTED"
  | "PROVIDER_ERROR";

const capabilityNames = [
  "streamText",
  "reportedUsage",
  "cacheReadReporting",
  "cacheWriteReporting",
  "cancellation",
  "remoteCancellation",
  "structuredOutput",
  "toolCalls",
  "quotaReporting",
] as const;

type CapabilityName = (typeof capabilityNames)[number];
type CapabilityEvidence = ProviderConnectionState["capabilities"][string];
export type CampusCapabilitySnapshot = {
  schemaVersion: 1;
  verification: {
    provider: "campus_gateway";
    status: "verified" | "failed";
    provenance: typeof CAMPUS_VERIFICATION_PROVENANCE;
    verificationId: string;
    credentialFingerprint: string;
    endpoint: typeof CAMPUS_CHAT_COMPLETIONS_ENDPOINT;
    requestedModel: string;
    responseModel: string | null;
    checkedAt: string;
    failureCode?: CampusVerificationFailureCode;
  };
  capabilities: Record<CapabilityName, CapabilityEvidence>;
  observed: string[];
  capabilityCampaign?: CapabilityCampaign & {
    credentialFingerprint: string;
  };
};

const CapabilityMapSchema = z.record(z.string(), CapabilityEvidenceSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidence(
  status: CapabilityEvidence["status"],
  checkedAt: string,
  verificationId: string,
  reason: string,
): CapabilityEvidence {
  return {
    status,
    checkedAt,
    adapterVersion: "campus-openai-compatible-v1",
    evidenceRef: status === "unknown" ? null : verificationId,
    reason,
  };
}

function emptyCapabilities(
  checkedAt: string,
  verificationId: string,
): Record<CapabilityName, CapabilityEvidence> {
  return Object.fromEntries(
    capabilityNames.map((name) => [
      name,
      evidence(
        "unknown",
        checkedAt,
        verificationId,
        "Belum diamati oleh request verifikasi non-streaming.",
      ),
    ]),
  ) as Record<CapabilityName, CapabilityEvidence>;
}

export function campusCredentialFingerprint(apiKey: string): string {
  if (!apiKey.trim()) throw new Error("Campus credential is required");
  return `sha256:${createHash("sha256").update(apiKey).digest("hex")}`;
}

export function createCampusVerificationSnapshot(
  completion: ProviderCompletion,
  options: { apiKey: string; checkedAt?: string; verificationId?: string },
): CampusCapabilitySnapshot {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const verificationId = options.verificationId ?? randomUUID();
  const capabilities = emptyCapabilities(checkedAt, verificationId);
  const inputReported = completion.usage.inputTokens.status === "reported";
  const outputReported = completion.usage.outputTokens.status === "reported";

  if (inputReported && outputReported) {
    capabilities.reportedUsage = evidence(
      "supported",
      checkedAt,
      verificationId,
      "Response memuat prompt_tokens dan completion_tokens.",
    );
  }
  if (completion.usage.cacheReadTokens.status === "reported") {
    capabilities.cacheReadReporting = evidence(
      "supported",
      checkedAt,
      verificationId,
      "Response memuat cached_tokens.",
    );
  }
  if (completion.usage.cacheWriteTokens.status === "reported") {
    capabilities.cacheWriteReporting = evidence(
      "supported",
      checkedAt,
      verificationId,
      "Response memuat cache_write_tokens.",
    );
  }

  const observed = ["non-stream chat completion returned a valid response"];
  if (inputReported && outputReported)
    observed.push("prompt and completion token usage were reported");
  if (completion.usage.cacheReadTokens.status === "reported")
    observed.push("cached token usage was reported");
  if (completion.usage.cacheWriteTokens.status === "reported")
    observed.push("cache write token usage was reported");

  return {
    schemaVersion: 1,
    verification: {
      provider: "campus_gateway",
      status: "verified",
      provenance: CAMPUS_VERIFICATION_PROVENANCE,
      verificationId,
      credentialFingerprint: campusCredentialFingerprint(options.apiKey),
      endpoint: CAMPUS_CHAT_COMPLETIONS_ENDPOINT,
      requestedModel: completion.requestedModel,
      responseModel: completion.responseModel,
      checkedAt,
    },
    capabilities,
    observed,
  };
}

export function createCampusFailureSnapshot(options: {
  apiKey: string;
  requestedModel: string;
  checkedAt?: string;
  verificationId?: string;
  failureCode: CampusVerificationFailureCode;
}): CampusCapabilitySnapshot {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const verificationId = options.verificationId ?? randomUUID();

  return {
    schemaVersion: 1,
    verification: {
      provider: "campus_gateway",
      status: "failed",
      provenance: CAMPUS_VERIFICATION_PROVENANCE,
      verificationId,
      credentialFingerprint: campusCredentialFingerprint(options.apiKey),
      endpoint: CAMPUS_CHAT_COMPLETIONS_ENDPOINT,
      requestedModel: options.requestedModel,
      responseModel: null,
      checkedAt,
      failureCode: options.failureCode,
    },
    capabilities: emptyCapabilities(checkedAt, verificationId),
    observed: [],
  };
}

export function campusVerificationMatchesConfiguration(
  snapshot: unknown,
  options: { apiKey: string; requestedModel: string },
): boolean {
  if (!isRecord(snapshot) || !isRecord(snapshot.verification)) return false;
  const verification = snapshot.verification;

  return (
    snapshot.schemaVersion === 1 &&
    verification.provider === "campus_gateway" &&
    verification.status === "verified" &&
    verification.provenance === CAMPUS_VERIFICATION_PROVENANCE &&
    verification.endpoint === CAMPUS_CHAT_COMPLETIONS_ENDPOINT &&
    verification.requestedModel === options.requestedModel &&
    verification.credentialFingerprint ===
      campusCredentialFingerprint(options.apiKey)
  );
}

export function campusCredentialFingerprintFromSnapshot(
  snapshot: unknown,
): string | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.verification)) return null;
  const verification = snapshot.verification;
  return verification.provider === "campus_gateway" &&
    verification.status === "verified" &&
    typeof verification.credentialFingerprint === "string"
    ? verification.credentialFingerprint
    : null;
}

export function campusCapabilitiesFromSnapshot(
  snapshot: unknown,
): ProviderConnectionState["capabilities"] | null {
  if (!isRecord(snapshot)) return null;
  const campaignCapabilities = isRecord(snapshot.capabilityCampaign)
    ? snapshot.capabilityCampaign.capabilities
    : undefined;
  const parsed = CapabilityMapSchema.safeParse(
    campaignCapabilities ?? snapshot.capabilities,
  );
  if (!parsed.success) return null;
  if (capabilityNames.some((name) => !(name in parsed.data))) return null;
  return parsed.data;
}

export function campusCapabilityCampaignMatchesConfiguration(
  snapshot: unknown,
  options: { apiKey: string; requestedModel: string },
): boolean {
  if (!isRecord(snapshot) || !isRecord(snapshot.capabilityCampaign))
    return false;
  const campaign = snapshot.capabilityCampaign;
  return (
    campaign.schemaVersion === 1 &&
    campaign.provider === "campus_gateway" &&
    campaign.requestedModel === options.requestedModel &&
    campaign.credentialFingerprint === campusCredentialFingerprint(options.apiKey)
  );
}

export function campusVerificationFailureMessage(
  failureCode: CampusVerificationFailureCode | null,
): string {
  switch (failureCode) {
    case "AUTH_REQUIRED":
      return "Gateway kampus menolak credential. Periksa konfigurasi server; credential tidak ditampilkan dan tidak ada retry.";
    case "PROVIDER_TIMEOUT":
      return "Gateway kampus melewati batas waktu. Periksa jaringan lalu coba verifikasi manual lagi.";
    case "PROVIDER_RESPONSE_INVALID":
      return "Gateway merespons dengan format yang tidak dikenali. Tidak ada retry yang dikirim.";
    case "PROVIDER_ABORTED":
      return "Request verifikasi dibatalkan sebelum selesai.";
    case "PROVIDER_HTTP_ERROR":
      return "Gateway kampus tidak menerima request dengan sukses. Periksa akses gateway; tidak ada retry.";
    default:
      return "Verifikasi koneksi gagal. Detail gateway tidak ditampilkan dan tidak ada retry.";
  }
}

export function unknownCampusCapabilities(
  reason: string,
): ProviderConnectionState["capabilities"] {
  return Object.fromEntries(
    capabilityNames.map((name) => [
      name,
      {
        status: "unknown",
        checkedAt: null,
        adapterVersion: null,
        evidenceRef: null,
        reason,
      },
    ]),
  ) as ProviderConnectionState["capabilities"];
}
