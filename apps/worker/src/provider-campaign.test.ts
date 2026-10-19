import { afterEach, describe, expect, it, vi } from "vitest";

const { reserveInferenceCall } = vi.hoisted(() => ({
  reserveInferenceCall:
    vi.fn<
      (provider: "campus_gateway" | "codex_app_server") => Promise<number>
    >(),
}));

vi.mock("@promptlab/providers/provider-smoke-ledger", () => ({
  isProviderVerificationCampaignConfigured: () =>
    Boolean(process.env.PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN?.trim()),
  reserveInferenceCall,
}));

import { withProviderInferenceReservation } from "./provider-campaign.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("provider verification campaign reservations", () => {
  it("does not change provider calls when no campaign is configured", async () => {
    vi.stubEnv("PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN", "");
    const invoke = vi.fn(async () => "response");

    await expect(
      withProviderInferenceReservation("campus_gateway", invoke),
    ).resolves.toBe("response");

    expect(reserveInferenceCall).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("reserves the provider call before invoking provider work", async () => {
    vi.stubEnv(
      "PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN",
      "flow1-live-20261018-000000000000",
    );
    const order: string[] = [];
    reserveInferenceCall.mockImplementation(async () => {
      order.push("reserved");
      return 1;
    });
    const invoke = vi.fn(async () => {
      order.push("provider");
      return "response";
    });

    await expect(
      withProviderInferenceReservation("codex_app_server", invoke),
    ).resolves.toBe("response");

    expect(reserveInferenceCall).toHaveBeenCalledExactlyOnceWith(
      "codex_app_server",
    );
    expect(order).toEqual(["reserved", "provider"]);
  });

  it("does not start provider work when a campaign reservation is refused", async () => {
    vi.stubEnv(
      "PROMPTLAB_PROVIDER_VERIFICATION_CAMPAIGN",
      "flow1-live-20261018-000000000000",
    );
    reserveInferenceCall.mockRejectedValue(
      new Error("Inference call cap reached; no call was made"),
    );
    const invoke = vi.fn(async () => "response");

    await expect(
      withProviderInferenceReservation("campus_gateway", invoke),
    ).rejects.toThrow("Inference call cap reached");

    expect(invoke).not.toHaveBeenCalled();
  });
});
