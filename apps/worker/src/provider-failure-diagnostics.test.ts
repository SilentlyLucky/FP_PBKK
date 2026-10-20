import { describe, expect, it } from "vitest";

import { ProviderRequestError } from "@promptlab/providers";

import { safeProviderFailureDiagnostics } from "./provider-failure-diagnostics.ts";

describe("safe provider failure diagnostics", () => {
  it("persists bounded transport metadata without provider content or secrets", () => {
    const diagnostics = Object.assign(
      {
        phase: "response_headers" as const,
        elapsedMs: 56_102,
        responseHeadersMs: 56_100,
        responseStatus: 504,
        transportCode: "ECONNRESET" as const,
      },
      {
        responseBody: "private provider response",
        apiKey: "private test credential",
        outputEmpty: true,
      },
    );
    const error = new ProviderRequestError(
      "PROVIDER_HTTP_ERROR",
      "Campus gateway returned HTTP 504",
      false,
      diagnostics,
    );

    const safe = safeProviderFailureDiagnostics(error);

    expect(safe).toEqual({
      phase: "response_headers",
      elapsedMs: 56_102,
      responseStatus: 504,
      transportCode: "ECONNRESET",
    });
    expect(JSON.stringify(safe)).not.toContain("private provider response");
    expect(JSON.stringify(safe)).not.toContain("private test credential");
  });

  it("ignores errors without safe provider diagnostics", () => {
    expect(safeProviderFailureDiagnostics(new Error("network failure"))).toBe(
      null,
    );
    expect(
      safeProviderFailureDiagnostics(
        new ProviderRequestError("PROVIDER_HTTP_ERROR", "gateway failure"),
      ),
    ).toBeNull();
  });
});
