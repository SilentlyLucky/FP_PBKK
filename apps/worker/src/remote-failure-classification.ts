const uncertainRemoteFailureCodes = new Set([
  "PROVIDER_TIMEOUT",
  "PROVIDER_ABORTED",
  "codex_turn_timeout",
  "codex_turn_interrupted",
  "RUN_STATUS_WATCH_FAILED",
]);

export function classifyRemoteOutcomeUnknown(input: {
  code: string;
  remoteRequestActive: boolean;
  trustedCodexOutcomeMayBeUnknown?: boolean | null | undefined;
}): boolean {
  if (!input.remoteRequestActive) return false;

  if (
    input.code === "codex_turn_interrupted" &&
    input.trustedCodexOutcomeMayBeUnknown === false
  ) {
    return false;
  }

  return uncertainRemoteFailureCodes.has(input.code);
}
