import {
  aggregateUsageProvenance,
  CampusChatProvider,
  ProviderRequestError,
} from "@promptlab/providers";

import { recordInferenceOutcome, reserveInferenceCall } from "./ledger.mjs";

const apiKey = process.env.PROMPTLAB_CAMPUS_API_KEY?.trim();
const model = process.env.PROMPTLAB_CAMPUS_MODEL?.trim();

if (!apiKey || !model) {
  await recordInferenceOutcome("campus_gateway", {
    outcome: "blocked_missing_credentials_or_model",
  });
  process.stdout.write(
    "Campus inference blocked: PROMPTLAB_CAMPUS_API_KEY and PROMPTLAB_CAMPUS_MODEL are required. No request was sent.\n",
  );
  process.exitCode = 2;
} else {
  await reserveInferenceCall("campus_gateway");
  const startedAt = performance.now();
  try {
    const provider = new CampusChatProvider({
      apiKey,
      disableThinking: true,
    });
    const result = await provider.complete({
      model,
      purpose: "optimizer",
      maxOutputTokens: 64,
      messages: [
        {
          role: "user",
          content: "Reply exactly: halo.",
        },
      ],
    });
    await recordInferenceOutcome("campus_gateway", {
      outcome: "succeeded",
      requestedModel: model,
      responseModel: result.responseModel,
      usage: aggregateUsageProvenance(result.usage),
      capabilitiesObserved: [
        "non-stream chat completion returned a valid response",
      ],
    });
    process.stdout.write(
      `${JSON.stringify({
        provider: result.provider,
        requestedModel: result.requestedModel,
        responseModel: result.responseModel,
        responseId: result.responseId,
        elapsedMs: Math.round(performance.now() - startedAt),
        usage: result.usage,
        capabilitiesObserved: ["non-stream chat completion"],
      })}\n`,
    );
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "PROVIDER_ERROR";
    const diagnostics =
      error instanceof ProviderRequestError && error.diagnostics
        ? {
            phase: error.diagnostics.phase,
            elapsedMs: error.diagnostics.elapsedMs,
            responseStatus: error.diagnostics.responseStatus,
            transportCode: error.diagnostics.transportCode,
          }
        : undefined;
    await recordInferenceOutcome("campus_gateway", {
      outcome: "failed",
      requestedModel: model,
      capabilitiesObserved: [`single request failed (${code})`],
    });
    process.stderr.write(
      `${JSON.stringify({
        provider: "campus_gateway",
        requestedModel: model,
        code,
        diagnostics,
        elapsedMs: Math.round(performance.now() - startedAt),
        retried: false,
      })}\n`,
    );
    process.exitCode = 1;
  }
}
