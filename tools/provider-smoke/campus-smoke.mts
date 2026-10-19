import {
  aggregateUsageProvenance,
  CampusChatProvider,
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
  try {
    const provider = new CampusChatProvider({ apiKey });
    const result = await provider.complete({
      model,
      purpose: "optimizer",
      maxOutputTokens: 16,
      messages: [
        {
          role: "user",
          content: "Reply exactly: PromptLab provider smoke OK.",
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
        usage: result.usage,
        capabilitiesObserved: ["non-stream chat completion"],
      })}\n`,
    );
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "PROVIDER_ERROR";
    await recordInferenceOutcome("campus_gateway", {
      outcome: "failed",
      requestedModel: model,
      capabilitiesObserved: [`single request failed (${code})`],
    });
    process.stderr.write(
      `Campus inference failed (${code}); no retry was made.\n`,
    );
    process.exitCode = 1;
  }
}
