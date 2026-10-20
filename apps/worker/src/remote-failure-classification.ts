const uncertainRemoteFailureCodes = new Set([
  "PROVIDER_TRANSPORT_ERROR",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ABORTED",
  "codex_turn_timeout",
  "codex_turn_interrupted",
  "RUN_STATUS_WATCH_FAILED",
]);

export function classifyRemoteOutcomeUnknown(input: {
  code: string;
  remoteRequestActive: boolean;
  providerHttpStatus?: number | null | undefined;
  trustedCodexOutcomeMayBeUnknown?: boolean | null | undefined;
}): boolean {
  if (!input.remoteRequestActive) return false;

  if (
    input.code === "codex_turn_interrupted" &&
    input.trustedCodexOutcomeMayBeUnknown === false
  ) {
    return false;
  }

  if (
    input.code === "PROVIDER_HTTP_ERROR" &&
    input.providerHttpStatus !== undefined &&
    input.providerHttpStatus !== null &&
    input.providerHttpStatus >= 500
  ) {
    return true;
  }

  return uncertainRemoteFailureCodes.has(input.code);
}
