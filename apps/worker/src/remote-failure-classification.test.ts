import { describe, expect, it } from "vitest";

import { classifyRemoteOutcomeUnknown } from "./remote-failure-classification.js";

describe("remote failure outcome classification", () => {
  it("treats a trusted pre-turn Codex interruption as known", () => {
    expect(
      classifyRemoteOutcomeUnknown({
        code: "codex_turn_interrupted",
        remoteRequestActive: true,
        trustedCodexOutcomeMayBeUnknown: false,
      }),
    ).toBe(false);
  });

  it("keeps started or missing-flag interruptions unknown", () => {
    expect(
      classifyRemoteOutcomeUnknown({
        code: "codex_turn_interrupted",
        remoteRequestActive: true,
        trustedCodexOutcomeMayBeUnknown: true,
      }),
    ).toBe(true);
    expect(
      classifyRemoteOutcomeUnknown({
        code: "codex_turn_interrupted",
        remoteRequestActive: true,
      }),
    ).toBe(true);
  });

  it("keeps other uncertain remote failures conservative", () => {
    expect(
      classifyRemoteOutcomeUnknown({
        code: "PROVIDER_TIMEOUT",
        remoteRequestActive: true,
        trustedCodexOutcomeMayBeUnknown: false,
      }),
    ).toBe(true);
    expect(
      classifyRemoteOutcomeUnknown({
        code: "PROVIDER_ABORTED",
        remoteRequestActive: true,
      }),
    ).toBe(true);
    expect(
      classifyRemoteOutcomeUnknown({
        code: "PROVIDER_TRANSPORT_ERROR",
        remoteRequestActive: true,
      }),
    ).toBe(true);
    expect(
      classifyRemoteOutcomeUnknown({
        code: "PROVIDER_HTTP_ERROR",
        providerHttpStatus: 504,
        remoteRequestActive: true,
      }),
    ).toBe(true);
    expect(
      classifyRemoteOutcomeUnknown({
        code: "PROVIDER_HTTP_ERROR",
        providerHttpStatus: 429,
        remoteRequestActive: true,
      }),
    ).toBe(false);
  });

  it("does not classify a local failure as an unknown remote outcome", () => {
    expect(
      classifyRemoteOutcomeUnknown({
        code: "codex_turn_interrupted",
        remoteRequestActive: false,
        trustedCodexOutcomeMayBeUnknown: true,
      }),
    ).toBe(false);
  });
});
