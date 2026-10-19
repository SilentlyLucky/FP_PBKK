import type { ProviderConnectionState } from "@promptlab/contracts";

export type ProjectPrerequisite = "satisfied" | "missing" | "unknown";

export function isSelectedCodexModelVerified(
  provider:
    | Pick<
        ProviderConnectionState,
        "provider" | "role" | "status" | "requestedModel"
      >
    | undefined,
  selectedModelId: string,
): boolean {
  return Boolean(
    provider?.provider === "codex_app_server" &&
    provider.role === "target" &&
    provider.status === "verified" &&
    selectedModelId &&
    provider.requestedModel === selectedModelId,
  );
}

export function canVerifyCodex(input: {
  projectPrerequisite: ProjectPrerequisite;
  loginPending: boolean;
  selectedModelId: string;
  availableModelIds: string[];
  providerAvailable: boolean;
}): boolean {
  return (
    input.projectPrerequisite === "satisfied" &&
    !input.loginPending &&
    input.providerAvailable &&
    input.selectedModelId.length > 0 &&
    input.availableModelIds.includes(input.selectedModelId)
  );
}

export function codexLoginPollFailure(
  status: number,
  outcome?: string,
): "expired" | "retry" | "failed" | null {
  if (outcome === "login_expired" || status === 401 || status === 404)
    return "expired";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  if (status < 200 || status >= 300) return "failed";
  return null;
}
