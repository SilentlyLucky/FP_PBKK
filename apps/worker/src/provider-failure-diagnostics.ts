import { ProviderRequestError } from "@promptlab/providers";

const MAX_DIAGNOSTIC_DURATION_MS = 600_000;
const requestPhases = [
  "request_headers",
  "response_headers",
  "response_body",
] as const;

export interface SafeProviderFailureDiagnostics {
  phase?: (typeof requestPhases)[number];
  elapsedMs?: number;
  responseStatus?: number;
  transportCode?:
    | "ECONNRESET"
    | "ECONNREFUSED"
    | "ENOTFOUND"
    | "EAI_AGAIN"
    | "ETIMEDOUT"
    | "UND_ERR_CONNECT_TIMEOUT"
    | "UND_ERR_HEADERS_TIMEOUT"
    | "UND_ERR_SOCKET"
    | "OTHER";
}

const safeTransportCodes = new Set<
  NonNullable<SafeProviderFailureDiagnostics["transportCode"]>
>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "OTHER",
]);

/** Whitelists bounded transport metadata for durable run events. */
export function safeProviderFailureDiagnostics(
  error: unknown,
): SafeProviderFailureDiagnostics | null {
  if (!(error instanceof ProviderRequestError) || !error.diagnostics) {
    return null;
  }

  const diagnostics = error.diagnostics;
  const safe: SafeProviderFailureDiagnostics = {};

  if (
    requestPhases.includes(diagnostics.phase as (typeof requestPhases)[number])
  ) {
    safe.phase = diagnostics.phase;
  }
  if (isSafeDuration(diagnostics.elapsedMs)) {
    safe.elapsedMs = diagnostics.elapsedMs;
  }
  if (
    typeof diagnostics.responseStatus === "number" &&
    Number.isSafeInteger(diagnostics.responseStatus) &&
    diagnostics.responseStatus >= 100 &&
    diagnostics.responseStatus <= 599
  ) {
    safe.responseStatus = diagnostics.responseStatus;
  }
  if (
    typeof diagnostics.transportCode === "string" &&
    safeTransportCodes.has(
      diagnostics.transportCode as NonNullable<
        SafeProviderFailureDiagnostics["transportCode"]
      >,
    )
  ) {
    safe.transportCode = diagnostics.transportCode as NonNullable<
      SafeProviderFailureDiagnostics["transportCode"]
    >;
  }

  return Object.keys(safe).length ? safe : null;
}

function isSafeDuration(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DIAGNOSTIC_DURATION_MS
  );
}
