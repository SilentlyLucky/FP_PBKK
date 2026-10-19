import type { ProviderConnectionState } from "@promptlab/contracts";

export const CAPABILITY_CAMPAIGN_INFERENCE_CALLS = {
  campus_gateway: 4,
  codex_app_server: 3,
} as const;

export type CapabilityName = keyof ProviderConnectionState["capabilities"];
export type CapabilityEvidence = ProviderConnectionState["capabilities"][string];
export type CapabilityCampaignProvider =
  | "campus_gateway"
  | "codex_app_server";

export type CapabilityCampaign = {
  schemaVersion: 1;
  provider: CapabilityCampaignProvider;
  status: "completed" | "partial" | "blocked";
  requestedModel: string;
  checkedAt: string;
  plannedInferenceCalls: number;
  attemptedInferenceCalls: number;
  reason: string;
  capabilities: ProviderConnectionState["capabilities"];
};

type CapabilityOverrides = Partial<
  Record<CapabilityName, CapabilityEvidence>
>;

function evidence(
  status: CapabilityEvidence["status"],
  provider: CapabilityCampaignProvider,
  name: CapabilityName,
  checkedAt: string,
  reason: string,
): CapabilityEvidence {
  return {
    status,
    checkedAt,
    adapterVersion:
      provider === "campus_gateway"
        ? "campus-openai-compatible-v1"
        : "codex-app-server-v1",
    evidenceRef: `campaign:${provider}:${name}`,
    reason,
  };
}

export function makeCapabilityCampaign(input: {
  provider: CapabilityCampaignProvider;
  requestedModel: string;
  checkedAt: string;
  attemptedInferenceCalls: number;
  status: CapabilityCampaign["status"];
  reason: string;
  blockedReason?: string;
  overrides?: CapabilityOverrides;
}): CapabilityCampaign {
  const { provider, requestedModel, checkedAt } = input;
  const capabilityNames = Object.keys(
    input.provider === "campus_gateway"
      ? {
          streamText: true,
          reportedUsage: true,
          cacheReadReporting: true,
          cacheWriteReporting: true,
          cancellation: true,
          remoteCancellation: true,
          structuredOutput: true,
          toolCalls: true,
          quotaReporting: true,
        }
      : {
          streamText: true,
          reportedUsage: true,
          cacheReadReporting: true,
          cacheWriteReporting: true,
          cancellation: true,
          remoteCancellation: true,
          structuredOutput: true,
          toolCalls: true,
          quotaReporting: true,
        },
  ) as CapabilityName[];

  const blockedReason =
    input.blockedReason ??
    "Probe ini tidak dijalankan setelah prasyarat kampanye gagal.";
  const capabilities = Object.fromEntries(
    capabilityNames.map((name) => [
      name,
      evidence("blocked", provider, name, checkedAt, blockedReason),
    ]),
  ) as ProviderConnectionState["capabilities"];

  if (provider === "campus_gateway") {
    capabilities.remoteCancellation = evidence(
      "not_exposed",
      provider,
      "remoteCancellation",
      checkedAt,
      "Endpoint chat completions yang dikonfigurasi tidak menyediakan API untuk menghentikan request yang sudah diterima gateway.",
    );
    capabilities.quotaReporting = evidence(
      "not_exposed",
      provider,
      "quotaReporting",
      checkedAt,
      "Adapter Gateway Kampus hanya memakai chat completions; tidak ada endpoint kuota yang dikonfigurasi atau dibaca.",
    );
  } else {
    capabilities.toolCalls = evidence(
      "policy_restricted",
      provider,
      "toolCalls",
      checkedAt,
      "PromptLab menolak native tool dan approval pada target Codex. Probe ini tidak menilai dukungan tool calls Codex di luar kebijakan PromptLab.",
    );
    capabilities.quotaReporting = evidence(
      "not_exposed",
      provider,
      "quotaReporting",
      checkedAt,
      "Adapter app-server PromptLab tidak membaca kuota atau rate limit; informasi plan akun bukan laporan kuota.",
    );
  }

  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    if (value) capabilities[name as CapabilityName] = value;
  }

  return {
    schemaVersion: 1,
    provider,
    status: input.status,
    requestedModel,
    checkedAt,
    plannedInferenceCalls: CAPABILITY_CAMPAIGN_INFERENCE_CALLS[provider],
    attemptedInferenceCalls: input.attemptedInferenceCalls,
    reason: input.reason,
    capabilities,
  };
}

export function campaignCapabilityEvidence(input: {
  provider: CapabilityCampaignProvider;
  name: CapabilityName;
  status: CapabilityEvidence["status"];
  checkedAt: string;
  reason: string;
}): CapabilityEvidence {
  return evidence(
    input.status,
    input.provider,
    input.name,
    input.checkedAt,
    input.reason,
  );
}

export function campaignHasNoUnknownCapabilities(
  campaign: CapabilityCampaign,
): boolean {
  return Object.values(campaign.capabilities).every(
    (capability) => capability.status !== "unknown",
  );
}
