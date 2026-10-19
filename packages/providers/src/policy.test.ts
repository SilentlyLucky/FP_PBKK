import { describe, expect, it } from "vitest";

import {
  providerConnectionMatchesPolicy,
  providerPurposePolicy,
} from "./policy.js";

describe("provider purpose policy", () => {
  it.each([
    ["campus_gateway", "optimizer", true, "optimizer", true],
    ["campus_gateway", "graph_indexing", true, "optimizer", true],
    ["campus_gateway", "auxiliary", true, "auxiliary", true],
    ["campus_gateway", "graph_query_model", true, "auxiliary", true],
    ["campus_gateway", "target", false, null, false],
    ["campus_gateway", "evaluator", false, null, false],
    ["codex_app_server", "target", true, "target", true],
    ["codex_app_server", "optimizer", false, null, false],
    ["codex_app_server", "graph_query_model", false, null, false],
    ["claude_cli", "target", false, null, false],
    ["fixture", "optimizer", false, null, false],
  ] as const)(
    "%s / %s policy",
    (provider, purpose, supported, role, executable) => {
      expect(providerPurposePolicy(provider, purpose)).toMatchObject({
        supported,
        role,
        executable,
      });
    },
  );

  it("keeps Codex limited to the verified target role", () => {
    expect(providerPurposePolicy("codex_app_server", "target")).toMatchObject({
      supported: true,
      role: "target",
      executable: true,
      reason: null,
    });
    expect(providerPurposePolicy("campus_gateway", "target")).toMatchObject({
      supported: false,
      role: null,
      executable: false,
    });
    expect(providerPurposePolicy("fixture", "target").reason).toBe(
      "fixture_provider_disabled",
    );
  });

  it("requires provider, role, verified status, and model to match", () => {
    const policy = providerPurposePolicy("campus_gateway", "optimizer");
    const connection = {
      provider: "campus_gateway",
      role: "optimizer",
      connectionStatus: "verified",
      requestedModel: "qwen-test",
      credentialFingerprint: "sha256:test-credential",
    };

    expect(
      providerConnectionMatchesPolicy(
        "campus_gateway",
        "qwen-test",
        policy,
        connection,
      ),
    ).toBe(true);
    expect(
      providerConnectionMatchesPolicy(
        "campus_gateway",
        "qwen-test",
        policy,
        connection,
        "sha256:test-credential",
      ),
    ).toBe(true);
    expect(
      providerConnectionMatchesPolicy(
        "campus_gateway",
        "qwen-test",
        policy,
        connection,
        "sha256:rotated-credential",
      ),
    ).toBe(false);
    expect(
      providerConnectionMatchesPolicy("campus_gateway", "qwen-test", policy, {
        ...connection,
        provider: "codex_app_server",
      }),
    ).toBe(false);
    expect(
      providerConnectionMatchesPolicy("campus_gateway", "qwen-test", policy, {
        ...connection,
        role: "target",
      }),
    ).toBe(false);
    expect(
      providerConnectionMatchesPolicy("campus_gateway", "qwen-test", policy, {
        ...connection,
        connectionStatus: "configured_unverified",
      }),
    ).toBe(false);
    expect(
      providerConnectionMatchesPolicy("campus_gateway", "qwen-test", policy, {
        ...connection,
        requestedModel: "other-model",
      }),
    ).toBe(false);
    expect(
      providerConnectionMatchesPolicy(
        "codex_app_server",
        "codex-target",
        providerPurposePolicy("codex_app_server", "target"),
        {
          ...connection,
          provider: "codex_app_server",
          role: "target",
          requestedModel: "codex-target",
        },
      ),
    ).toBe(true);
  });
});
