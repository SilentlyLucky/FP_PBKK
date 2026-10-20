import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: null as unknown,
  connectCodexAppServer: vi.fn(),
  readCodexAccount: vi.fn(),
  listCodexModels: vi.fn(),
  executeCodexTurn: vi.fn(),
  campusComplete: vi.fn(),
  campusStreamCapabilityProbe: vi.fn(),
  campusToolCall: vi.fn(),
  campusProviderConfig: vi.fn(),
  reserveInferenceCalls: vi.fn(),
  reserveInferenceCall: vi.fn(),
  recordInferenceOutcome: vi.fn(),
  providerRequest: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  databaseOrUnavailable: () => ({ db: mocks.database }),
}));

vi.mock("@/lib/codex-runtime", () => ({
  codexLoginStatus: vi.fn(() => null),
  codexReceiptMatchesRuntime: vi.fn(() => false),
  inspectCodexRuntime: vi.fn(),
  startCodexLogin: vi.fn(),
}));

vi.mock("@/lib/provider-settings-guards", () => ({
  isSelectedCodexModelVerified: vi.fn(() => false),
}));

vi.mock("@promptlab/providers/provider-smoke-ledger", () => ({
  isProviderVerificationCampaignConfigured: () =>
    Boolean(process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN?.trim()),
  recordInferenceOutcome: mocks.recordInferenceOutcome,
  reserveInferenceCalls: mocks.reserveInferenceCalls,
  reserveInferenceCall: mocks.reserveInferenceCall,
}));

vi.mock("@promptlab/providers/campus", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@promptlab/providers/campus")>();
  return {
    ...actual,
    CampusChatProvider: class {
      constructor(config: unknown) {
        mocks.campusProviderConfig(config);
      }

      complete(...args: unknown[]) {
        return mocks.campusComplete(...args);
      }

      streamCapabilityProbe(...args: unknown[]) {
        return mocks.campusStreamCapabilityProbe(...args);
      }

      probeToolCall(...args: unknown[]) {
        return mocks.campusToolCall(...args);
      }
    },
  };
});

vi.mock("@promptlab/providers/codex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@promptlab/providers/codex")>();
  return {
    ...actual,
    connectCodexAppServer: mocks.connectCodexAppServer,
    executeCodexTurn: mocks.executeCodexTurn,
    listCodexModels: mocks.listCodexModels,
    readCodexAccount: mocks.readCodexAccount,
  };
});

import { schema } from "@promptlab/db";
import { ProviderRequestError } from "@promptlab/providers/campus";
import { POST } from "./route.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const projectId = "6a20dbe3-d59b-4a58-a8c1-5269bdc29a8c";
const requestedModel = "codex-test-model";
const campaignId = "flow1-live-20261018-000000000000";

function createDatabase() {
  const makeSelect = () =>
    vi.fn(() => {
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where: vi.fn(async () =>
          table === schema.projects ? [{ id: projectId }] : [],
        ),
      };
      return query;
    });
  const transaction = {
    select: makeSelect(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return {
    select: makeSelect(),
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
}

function verificationRequest(): Request {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "codex-verify", model: requestedModel }),
  });
}

function campusVerificationRequest(): Request {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function campusCapabilityCampaignRequest(): Request {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "campus-capability-campaign" }),
  });
}

function successfulCampusStream(text: string) {
  return {
    text,
    responseModel: "mock-campus-model",
    textDeltaObserved: true,
    usage: { inputTokens: 8, outputTokens: 6 },
  };
}

type CampaignResponse = {
  campaign: {
    status: string;
    attemptedInferenceCalls: number;
    reason: string;
    capabilities: Record<
      string,
      { status: string; reason: string } | undefined
    >;
  };
};

function campaignCapability(
  campaign: CampaignResponse["campaign"],
  name: string,
) {
  const capability = campaign.capabilities[name];
  if (!capability) throw new Error(`Missing campaign capability: ${name}`);
  return capability;
}

describe("provider verification campaign gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", "");
    vi.stubEnv("PROMPTLAB_CAMPUS_API_KEY", "");
    vi.stubEnv("PROMPTLAB_CAMPUS_MODEL", "");
    mocks.database = createDatabase();
    mocks.recordInferenceOutcome.mockResolvedValue(undefined);
    mocks.connectCodexAppServer.mockResolvedValue({
      session: { close: mocks.closeSession },
      cliVersion: "0.160.1",
      codexHomeFingerprint: "a".repeat(64),
      isolationPolicyVersion: "codex-bwrap-bounded-native-v2",
    });
    mocks.readCodexAccount.mockResolvedValue({
      type: "chatgpt",
      planType: "plus",
      identityFingerprint: "b".repeat(64),
    });
    mocks.listCodexModels.mockResolvedValue([
      {
        id: requestedModel,
        displayName: "Mock Codex",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
        inputModalities: ["text"],
      },
    ]);
    mocks.executeCodexTurn.mockImplementation(
      async (input: { beforeGeneration?: () => Promise<void> }) => {
        await input.beforeGeneration?.();
        mocks.providerRequest();
        throw new Error("Mock provider turn should not continue in this test");
      },
    );
  });

  it.each([
    {
      error:
        "Inference call cap reached for codex_app_server at 2; no call was made",
      expectedStatus: 409,
      expectedOutcome: "budget_exhausted",
      expectedRecordedOutcome: "blocked_budget_exhausted",
    },
    {
      error: "Provider call ledger is locked; no inference call was made",
      expectedStatus: 503,
      expectedOutcome: "safety_ledger_unavailable",
      expectedRecordedOutcome: null,
    },
  ])(
    "blocks the provider turn when ledger reservation fails ($expectedOutcome)",
    async ({
      error,
      expectedStatus,
      expectedOutcome,
      expectedRecordedOutcome,
    }) => {
      vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", campaignId);
      mocks.reserveInferenceCall.mockRejectedValue(new Error(error));

      const response = await POST(verificationRequest());
      const body = (await response.json()) as {
        outcome: string;
        message: string;
      };

      expect(response.status).toBe(expectedStatus);
      expect(body.outcome).toBe(expectedOutcome);
      expect(body.message).toContain("Tidak ada inference");
      expect(mocks.reserveInferenceCall).toHaveBeenCalledOnce();
      expect(mocks.reserveInferenceCall).toHaveBeenCalledWith(
        "codex_app_server",
      );
      expect(mocks.providerRequest).not.toHaveBeenCalled();
      if (expectedRecordedOutcome) {
        expect(mocks.recordInferenceOutcome).toHaveBeenCalledWith(
          "codex_app_server",
          { outcome: expectedRecordedOutcome },
        );
      } else {
        expect(mocks.recordInferenceOutcome).not.toHaveBeenCalled();
      }
      expect(mocks.closeSession).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      error:
        "Inference call cap reached for campus_gateway at 2; no call was made",
      expectedStatus: 429,
      expectedOutcome: "budget_exhausted",
      expectedRecordedOutcome: "blocked_budget_exhausted",
    },
    {
      error: "Provider call ledger is locked; no inference call was made",
      expectedStatus: 503,
      expectedOutcome: "safety_ledger_unavailable",
      expectedRecordedOutcome: null,
    },
  ])(
    "blocks the Campus request when ledger reservation fails ($expectedOutcome)",
    async ({
      error,
      expectedStatus,
      expectedOutcome,
      expectedRecordedOutcome,
    }) => {
      vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", campaignId);
      vi.stubEnv("PROMPTLAB_CAMPUS_API_KEY", "mock-campus-key");
      vi.stubEnv("PROMPTLAB_CAMPUS_MODEL", "mock-campus-model");
      mocks.reserveInferenceCall.mockRejectedValue(new Error(error));

      const response = await POST(campusVerificationRequest());
      const body = (await response.json()) as {
        outcome: string;
        message: string;
      };

      expect(response.status).toBe(expectedStatus);
      expect(body.outcome).toBe(expectedOutcome);
      expect(body.message).toContain("Tidak ada request");
      expect(mocks.reserveInferenceCall).toHaveBeenCalledOnce();
      expect(mocks.reserveInferenceCall).toHaveBeenCalledWith("campus_gateway");
      expect(mocks.campusComplete).not.toHaveBeenCalled();
      if (expectedRecordedOutcome) {
        expect(mocks.recordInferenceOutcome).toHaveBeenCalledWith(
          "campus_gateway",
          { outcome: expectedRecordedOutcome },
        );
      } else {
        expect(mocks.recordInferenceOutcome).not.toHaveBeenCalled();
      }
      expect(mocks.connectCodexAppServer).not.toHaveBeenCalled();
    },
  );

  it("uses a bounded output budget and timeout for a manual Campus check", async () => {
    vi.stubEnv("PROMPTLAB_CAMPUS_API_KEY", "mock-campus-key");
    vi.stubEnv("PROMPTLAB_CAMPUS_MODEL", "mock-campus-model");
    mocks.campusComplete.mockRejectedValue(
      new Error("Mock provider failure after request dispatch"),
    );

    const response = await POST(campusVerificationRequest());
    const body = (await response.json()) as { outcome: string };

    expect(response.status).toBe(502);
    expect(body.outcome).toBe("failed");
    expect(mocks.campusProviderConfig).toHaveBeenCalledWith({
      apiKey: "mock-campus-key",
      timeoutMs: 15_000,
      disableThinking: true,
    });
    expect(mocks.campusComplete).toHaveBeenCalledOnce();
    expect(mocks.campusComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mock-campus-model",
        purpose: "optimizer",
        maxOutputTokens: 16,
        messages: [
          {
            role: "user",
            content: "Reply exactly: PromptLab provider smoke OK.",
          },
        ],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reserveInferenceCall).not.toHaveBeenCalled();
    expect(mocks.recordInferenceOutcome).not.toHaveBeenCalled();
  });

  it("reaches Codex for a manual check without a named campaign", async () => {
    const response = await POST(verificationRequest());
    const body = (await response.json()) as { outcome: string };

    expect(response.status).toBe(502);
    expect(body.outcome).toBe("verification_failed");
    expect(mocks.providerRequest).toHaveBeenCalledOnce();
    expect(mocks.reserveInferenceCall).not.toHaveBeenCalled();
    expect(mocks.recordInferenceOutcome).not.toHaveBeenCalled();
    expect(mocks.closeSession).toHaveBeenCalledOnce();
  });

  it("caps campaign probe time and skips dependent requests after a stream failure", async () => {
    vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", campaignId);
    vi.stubEnv("PROMPTLAB_CAMPUS_API_KEY", "mock-campus-key");
    vi.stubEnv("PROMPTLAB_CAMPUS_MODEL", "mock-campus-model");
    vi.stubEnv("PROMPTLAB_CAMPUS_OPTIMIZER_TIMEOUT_MS", "90000");
    mocks.reserveInferenceCalls.mockResolvedValue(4);
    mocks.campusStreamCapabilityProbe.mockRejectedValue(
      new ProviderRequestError(
        "PROVIDER_HTTP_ERROR",
        "Campus gateway returned HTTP 429",
      ),
    );

    const response = await POST(campusCapabilityCampaignRequest());
    const body = (await response.json()) as CampaignResponse;

    expect(response.status).toBe(200);
    expect(mocks.reserveInferenceCalls).toHaveBeenCalledOnce();
    expect(mocks.reserveInferenceCalls).toHaveBeenCalledWith(
      "campus_gateway",
      4,
    );
    expect(mocks.campusProviderConfig).toHaveBeenCalledWith({
      apiKey: "mock-campus-key",
      timeoutMs: 15_000,
      disableThinking: true,
    });
    expect(mocks.campusStreamCapabilityProbe).toHaveBeenCalledOnce();
    expect(mocks.campusToolCall).not.toHaveBeenCalled();
    expect(mocks.campusComplete).not.toHaveBeenCalled();
    expect(body.campaign.status).toBe("partial");
    expect(body.campaign.attemptedInferenceCalls).toBe(1);
    expect(body.campaign.reason).toContain("3 probe dilewati");
    expect(mocks.recordInferenceOutcome).toHaveBeenCalledWith(
      "campus_gateway",
      expect.objectContaining({ outcome: "failed" }),
    );
    expect(campaignCapability(body.campaign, "streamText").status).toBe(
      "failed",
    );
    expect(campaignCapability(body.campaign, "streamText").reason).toContain(
      "HTTP 429",
    );
    expect(campaignCapability(body.campaign, "structuredOutput").status).toBe(
      "blocked",
    );
    expect(campaignCapability(body.campaign, "reportedUsage").status).toBe(
      "blocked",
    );
    expect(campaignCapability(body.campaign, "cacheReadReporting").status).toBe(
      "blocked",
    );
    expect(campaignCapability(body.campaign, "toolCalls").status).toBe(
      "blocked",
    );
    expect(campaignCapability(body.campaign, "cancellation").status).toBe(
      "blocked",
    );
  });

  it("runs independent probes but skips cache repeats when the stream schema is invalid", async () => {
    vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", campaignId);
    vi.stubEnv("PROMPTLAB_CAMPUS_API_KEY", "mock-campus-key");
    vi.stubEnv("PROMPTLAB_CAMPUS_MODEL", "mock-campus-model");
    mocks.reserveInferenceCalls.mockResolvedValue(4);
    mocks.campusStreamCapabilityProbe.mockResolvedValue(
      successfulCampusStream("not a JSON object"),
    );
    mocks.campusToolCall.mockResolvedValue(true);
    mocks.campusComplete.mockRejectedValue(
      new ProviderRequestError("PROVIDER_ABORTED", "Request was canceled"),
    );

    const response = await POST(campusCapabilityCampaignRequest());
    const body = (await response.json()) as CampaignResponse;

    expect(response.status).toBe(200);
    expect(mocks.campusStreamCapabilityProbe).toHaveBeenCalledOnce();
    expect(mocks.campusToolCall).toHaveBeenCalledOnce();
    expect(mocks.campusComplete).toHaveBeenCalledOnce();
    expect(body.campaign.status).toBe("partial");
    expect(body.campaign.attemptedInferenceCalls).toBe(3);
    expect(campaignCapability(body.campaign, "cacheReadReporting").status).toBe(
      "blocked",
    );
    expect(
      campaignCapability(body.campaign, "cacheReadReporting").reason,
    ).toContain("dilewati");
    expect(campaignCapability(body.campaign, "toolCalls").status).toBe(
      "supported",
    );
    expect(campaignCapability(body.campaign, "cancellation").status).toBe(
      "supported",
    );
  });

  it("stops after the repeated stream times out and records the timeout category", async () => {
    vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", campaignId);
    vi.stubEnv("PROMPTLAB_CAMPUS_API_KEY", "mock-campus-key");
    vi.stubEnv("PROMPTLAB_CAMPUS_MODEL", "mock-campus-model");
    mocks.reserveInferenceCalls.mockResolvedValue(4);
    mocks.campusStreamCapabilityProbe
      .mockResolvedValueOnce(
        successfulCampusStream('{"answer":"PROMPTLAB CAPABILITY READY"}'),
      )
      .mockRejectedValueOnce(
        new ProviderRequestError(
          "PROVIDER_TIMEOUT",
          "Provider request timed out",
          false,
          {
            phase: "response_body",
            elapsedMs: 15_000,
            responseStatus: 200,
            responseHeadersMs: 180,
            firstChunkMs: 410,
            finishReasonSeen: true,
            doneMarkerSeen: false,
          },
        ),
      );

    const response = await POST(campusCapabilityCampaignRequest());
    const body = (await response.json()) as CampaignResponse;

    expect(response.status).toBe(200);
    expect(mocks.campusStreamCapabilityProbe).toHaveBeenCalledTimes(2);
    expect(mocks.campusToolCall).not.toHaveBeenCalled();
    expect(mocks.campusComplete).not.toHaveBeenCalled();
    expect(body.campaign.status).toBe("partial");
    expect(body.campaign.attemptedInferenceCalls).toBe(2);
    expect(campaignCapability(body.campaign, "structuredOutput").status).toBe(
      "supported",
    );
    expect(campaignCapability(body.campaign, "cacheReadReporting").status).toBe(
      "failed",
    );
    expect(
      campaignCapability(body.campaign, "cacheReadReporting").reason,
    ).toContain("PROVIDER_TIMEOUT");
    expect(
      campaignCapability(body.campaign, "cacheReadReporting").reason,
    ).toContain("finish_reason terlihat, DONE belum terlihat");
    expect(campaignCapability(body.campaign, "toolCalls").status).toBe(
      "blocked",
    );
    expect(campaignCapability(body.campaign, "cancellation").status).toBe(
      "blocked",
    );
  });
});
