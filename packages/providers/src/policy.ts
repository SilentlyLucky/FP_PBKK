import type { ProviderId, RunPurpose } from "@promptlab/contracts";

export type ProviderRole = "optimizer" | "target" | "evaluator" | "auxiliary";

export interface ProviderPurposePolicy {
  supported: boolean;
  role: ProviderRole | null;
  executable: boolean;
  reason: "fixture_provider_disabled" | "provider_unverified" | null;
}

export interface ProviderConnectionEvidence {
  provider: string;
  role: string;
  connectionStatus: string;
  requestedModel: string | null;
  credentialFingerprint?: string | null;
}

const denied = (
  reason: ProviderPurposePolicy["reason"],
): ProviderPurposePolicy => ({
  supported: false,
  role: null,
  executable: false,
  reason,
});

/** Shared run-route and worker policy. Provider roles stay distinct from purposes. */
export function providerPurposePolicy(
  provider: ProviderId,
  purpose: RunPurpose,
): ProviderPurposePolicy {
  if (provider === "fixture") return denied("fixture_provider_disabled");

  if (provider === "campus_gateway") {
    if (purpose === "optimizer" || purpose === "graph_indexing") {
      return {
        supported: true,
        role: "optimizer",
        executable: true,
        reason: null,
      };
    }
    if (purpose === "auxiliary" || purpose === "graph_query_model") {
      return {
        supported: true,
        role: "auxiliary",
        executable: true,
        reason: null,
      };
    }
    return denied(null);
  }

  if (provider === "codex_app_server" && purpose === "target") {
    return {
      supported: true,
      role: "target",
      executable: true,
      reason: null,
    };
  }

  return denied(null);
}

/** A persisted connection authorizes execution only when every identity matches. */
export function providerConnectionMatchesPolicy(
  provider: ProviderId,
  requestedModel: string,
  policy: ProviderPurposePolicy,
  connection: ProviderConnectionEvidence | null | undefined,
  expectedCredentialFingerprint?: string | null,
): boolean {
  return Boolean(
    policy.supported &&
    policy.executable &&
    policy.role &&
    connection &&
    connection.provider === provider &&
    connection.role === policy.role &&
    connection.connectionStatus === "verified" &&
    connection.requestedModel === requestedModel &&
    (provider !== "campus_gateway" ||
      expectedCredentialFingerprint === undefined ||
      (expectedCredentialFingerprint !== null &&
        connection.credentialFingerprint === expectedCredentialFingerprint)),
  );
}
