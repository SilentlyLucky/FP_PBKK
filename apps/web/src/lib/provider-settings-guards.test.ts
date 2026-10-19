import { describe, expect, it } from "vitest";

import {
  canVerifyCodex,
  codexLoginPollFailure,
  isSelectedCodexModelVerified,
} from "./provider-settings-guards";

const readyAccount = {
  projectPrerequisite: "satisfied" as const,
  loginPending: false,
  selectedModelId: "gpt-5.6",
  availableModelIds: ["gpt-5.6"],
  providerAvailable: true,
};

describe("Codex verification guard", () => {
  it.each([
    ["missing project", { projectPrerequisite: "missing" as const }],
    ["unknown project state", { projectPrerequisite: "unknown" as const }],
    ["pending login", { loginPending: true }],
    ["unavailable provider", { providerAvailable: false }],
    ["no signed-in account or model", { availableModelIds: [] }],
    ["no selected model", { selectedModelId: "" }],
    ["stale selected model", { availableModelIds: ["other-model"] }],
  ])("blocks verification when there is %s", (_label, override) => {
    expect(canVerifyCodex({ ...readyAccount, ...override })).toBe(false);
  });

  it("allows explicit re-verification with a current account and model", () => {
    expect(canVerifyCodex(readyAccount)).toBe(true);
  });
});

describe("Codex login poll failure handling", () => {
  it.each([401, 404])("ends a lost session on HTTP %i", (status) => {
    expect(codexLoginPollFailure(status)).toBe("expired");
  });

  it("ends a lost session when the API reports login_expired", () => {
    expect(codexLoginPollFailure(200, "login_expired")).toBe("expired");
  });

  it.each([408, 429, 500, 503])(
    "retries a harmless poll after HTTP %i",
    (status) => {
      expect(codexLoginPollFailure(status)).toBe("retry");
    },
  );

  it("does not retry other client errors", () => {
    expect(codexLoginPollFailure(400)).toBe("failed");
  });
});

describe("selected Codex verification reuse", () => {
  const verifiedTarget = {
    provider: "codex_app_server" as const,
    role: "target" as const,
    status: "verified" as const,
    requestedModel: "gpt-5.6",
  };

  it("reuses a verified receipt only for the same target model", () => {
    expect(isSelectedCodexModelVerified(verifiedTarget, "gpt-5.6")).toBe(true);
    expect(isSelectedCodexModelVerified(verifiedTarget, "gpt-6-luna")).toBe(
      false,
    );
    expect(isSelectedCodexModelVerified(undefined, "gpt-5.6")).toBe(false);
  });
});
