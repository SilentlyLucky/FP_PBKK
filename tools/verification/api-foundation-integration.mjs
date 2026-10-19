import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.PROMPTLAB_TEST_BASE ?? "http://127.0.0.1:3000";

const providerResponse = await fetch(new URL("/api/providers", baseUrl));
assert.equal(providerResponse.status, 200);
const providerState = await providerResponse.json();
assert.equal("inferenceCallsMade" in providerState, false);
assert.equal(
  providerState.providers.find(
    (provider) => provider.provider === "campus_gateway",
  ).role,
  "optimizer",
);
assert.equal(
  providerState.providers.find(
    (provider) => provider.provider === "codex_app_server",
  ).role,
  "target",
);
assert.equal(
  providerState.providers.every((provider) => provider.checkedAt === null),
  true,
);
const healthResponse = await fetch(new URL("/api/health", baseUrl));
const health = await healthResponse.json();
assert.equal("inferenceCallsMade" in health, false);

async function jsonRequest(path, method, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

const projectResult = await jsonRequest("/api/projects", "POST", {
  name: `integration-${randomUUID()}`,
  objective: "Verify project and immutable prompt version APIs locally.",
});
assert.equal(projectResult.response.status, 201);
const projectId = projectResult.payload.project.id;

const promptResult = await jsonRequest(
  `/api/projects/${projectId}/prompts`,
  "POST",
  {
    name: "Integration prompt",
    text: "Keep the answer grounded in cited evidence.",
    invariants: ["Label unknowns."],
  },
);
assert.equal(promptResult.response.status, 201);
const prompt = promptResult.payload.prompt;

const versionResult = await jsonRequest(
  `/api/projects/${projectId}/prompts/${prompt.id}/versions`,
  "POST",
  {
    text: "Keep the answer grounded in cited evidence and label unknowns.",
    invariants: ["Label unknowns."],
    parentVersionId: prompt.currentVersionId,
  },
);
assert.equal(versionResult.response.status, 201);
assert.equal(versionResult.payload.prompt.version, 2);

const rollbackResult = await jsonRequest(
  `/api/projects/${projectId}/prompts/${prompt.id}/rollback`,
  "POST",
  { versionId: prompt.currentVersionId },
);
assert.equal(rollbackResult.response.status, 201);
assert.equal(rollbackResult.payload.prompt.version, 3);
assert.equal(rollbackResult.payload.prompt.text, prompt.text);

const runResult = await jsonRequest(`/api/projects/${projectId}/runs`, "POST", {
  projectId,
  promptVersionId: prompt.currentVersionId,
  purpose: "optimizer",
  provider: "campus_gateway",
  requestedModel: "not-configured-test-model",
  idempotencyKey: randomUUID(),
});
assert.equal(runResult.response.status, 201);
assert.equal(runResult.payload.run.status, "paused_auth_required");

const disallowedCampusTarget = await jsonRequest(
  `/api/projects/${projectId}/runs`,
  "POST",
  {
    projectId,
    promptVersionId: prompt.currentVersionId,
    purpose: "target",
    provider: "campus_gateway",
    requestedModel: "campus-target-is-not-allowed",
    idempotencyKey: randomUUID(),
  },
);
assert.equal(disallowedCampusTarget.response.status, 409);
assert.equal(
  disallowedCampusTarget.payload.error,
  "PROVIDER_PURPOSE_NOT_ALLOWED",
);

const fixtureRun = await jsonRequest(
  `/api/projects/${projectId}/runs`,
  "POST",
  {
    projectId,
    promptVersionId: prompt.currentVersionId,
    purpose: "optimizer",
    provider: "fixture",
    requestedModel: "fixture-only",
    idempotencyKey: randomUUID(),
  },
);
assert.equal(fixtureRun.response.status, 409);
assert.equal(fixtureRun.payload.error, "FIXTURE_PROVIDER_DISABLED");

const codexTargetRun = await jsonRequest(
  `/api/projects/${projectId}/runs`,
  "POST",
  {
    projectId,
    promptVersionId: prompt.currentVersionId,
    purpose: "target",
    provider: "codex_app_server",
    requestedModel: "codex-target-unverified",
    idempotencyKey: randomUUID(),
  },
);
assert.equal(codexTargetRun.response.status, 201);
assert.equal(codexTargetRun.payload.run.status, "paused_auth_required");

const controller = new AbortController();
const eventsResponse = await fetch(
  new URL(
    `/api/projects/${projectId}/runs/${runResult.payload.run.id}/events?after=0`,
    baseUrl,
  ),
  { signal: controller.signal },
);
assert.equal(eventsResponse.status, 200);
const reader = eventsResponse.body.getReader();
const firstEvent = await reader.read();
controller.abort();
await reader.cancel().catch(() => undefined);
const eventText = new TextDecoder().decode(firstEvent.value);
assert.match(eventText, /event: run\.status/);
assert.match(eventText, /paused_auth_required/);

const usageResponse = await fetch(
  new URL(`/api/projects/${projectId}/usage`, baseUrl),
);
assert.equal(usageResponse.status, 200);
const usage = await usageResponse.json();
assert.equal(Array.isArray(usage.records), true);
assert.equal(usage.records.length, 0);

process.stdout.write(
  JSON.stringify({
    projectCreated: true,
    providerRolesAndUnknownTimestamps: true,
    healthHasNoSyntheticInferenceCount: true,
    promptVersionCreated: true,
    rollbackCreatedVersion: true,
    unauthenticatedRunPaused: true,
    campusTargetPurposeRejected: true,
    fixtureProductionRunRejected: true,
    codexTargetRemainsPaused: true,
    sseReplayObserved: true,
    usageEmptyWithoutInference: true,
  }) + "\n",
);
