import { expect, test, type Route } from "@playwright/test";
import { expectActiveProjectId } from "./helpers/project-picker";

const projectId = "11111111-1111-4111-8111-111111111111";
const promptId = "22222222-2222-4222-8222-222222222222";
const currentVersionId = "33333333-3333-4333-8333-333333333333";
const historicalVersionId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const modelId = "gpt-5.6-codex";
const originalPrompt = "Answer the request clearly.";
const historicalPrompt = "Answer in one concise paragraph.";

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { status: "reported", value: inputTokens },
    outputTokens: { status: "reported", value: outputTokens },
    totalTokens: { status: "reported", value: inputTokens + outputTokens },
  };
}

test("Experiments runs a frozen paired pilot and records a user decision", async ({
  page,
}) => {
  const prompt = {
    id: promptId,
    name: "Prompt for pilot",
    currentVersionId,
    version: 2,
    text: originalPrompt,
  };
  const promptVersions = [
    {
      id: currentVersionId,
      version: 2,
      text: originalPrompt,
      createdAt: "2026-10-15T00:00:00.000Z",
    },
    {
      id: historicalVersionId,
      version: 1,
      text: historicalPrompt,
      createdAt: "2026-10-14T00:00:00.000Z",
    },
  ];
  let runRequest: Record<string, unknown> | null = null;
  let markerRequest: Record<string, unknown> | null = null;
  let decisionRequest: Record<string, unknown> | null = null;
  let experiment: Record<string, unknown> | null = null;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());

    if (url.pathname === "/api/projects" && method === "GET") {
      await respond(route, {
        projects: [
          {
            id: projectId,
            name: "Pilot QA project",
            objective: "Verify the bounded paired pilot UI.",
          },
        ],
      });
      return;
    }

    if (url.pathname === "/api/providers" && method === "GET") {
      await respond(route, {
        providers: [
          {
            provider: "codex_app_server",
            role: "target",
            status: "verified",
            requestedModel: modelId,
            responseModel: modelId,
            endpointLabel: "Codex CLI · mock",
            capabilities: {},
          },
          {
            provider: "campus_gateway",
            role: "optimizer",
            status: "verified",
            requestedModel: "senopati-test-model",
            responseModel: "senopati-test-model",
            endpointLabel: "Senopati · mock",
            capabilities: {},
          },
        ],
        codexModels: [
          {
            id: modelId,
            displayName: "GPT-5.6 Codex",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium"],
          },
        ],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/prompts` &&
      method === "GET"
    ) {
      await respond(route, { prompts: [prompt] });
      return;
    }

    if (
      url.pathname ===
        `/api/projects/${projectId}/prompts/${promptId}/versions` &&
      method === "GET"
    ) {
      await respond(route, { versions: promptVersions });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/experiments` &&
      method === "GET"
    ) {
      await respond(route, { experiments: experiment ? [experiment] : [] });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs` &&
      method === "POST"
    ) {
      runRequest = request.postDataJSON() as Record<string, unknown>;
      await respond(route, { run: { id: runId, status: "queued" } }, 201);
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/experiments` &&
      method === "POST"
    ) {
      markerRequest = request.postDataJSON() as Record<string, unknown>;
      const metadata = markerRequest.metadata as Record<string, unknown>;
      experiment = {
        experimentId: runId,
        runId,
        mode: "pilot",
        status: "queued",
        evidenceEligible: false,
        decisionVerified: false,
        errorSummary: null,
        metadata,
        createdAt: "2026-10-15T01:00:00.000Z",
        decision: null,
        decisionNote: null,
        decidedAt: null,
      };
      await respond(
        route,
        { experiment: { experimentId: runId, runId, metadata } },
        201,
      );
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs/${runId}/events` &&
      method === "GET"
    ) {
      const result = {
        status: "candidate_ready",
        baseline: {
          prompt: historicalPrompt,
          answers: [
            {
              caseId: "pilot-case-1",
              input: "Summarize this policy.",
              text: "The policy takes effect in June.",
              usage: usage(24, 9),
              latencyMs: 820,
              source: "user",
            },
          ],
          aggregateUsage: usage(24, 9),
          totalTargetLatencyMs: 820,
        },
        candidate: {
          id: "candidate-1",
          prompt: "Answer with the effective date first.",
          changeSummary: "States the requested detail first.",
          answers: [
            {
              caseId: "pilot-case-1",
              input: "Summarize this policy.",
              text: "The policy takes effect in June, according to the supplied text.",
              usage: usage(27, 12),
              latencyMs: 940,
              source: "user",
            },
          ],
          aggregateUsage: usage(27, 12),
          totalTargetLatencyMs: 940,
          invariantsPreserved: true,
        },
        optimizer: {
          model: "senopati-test-model",
          calls: 2,
          usage: usage(700, 180),
          elapsedMs: 1_100,
        },
        optimizationOverheadMs: 1_250,
      };
      const event = {
        id: "66666666-6666-4666-8666-666666666666",
        sequence: 4,
        timestamp: "2026-10-15T01:00:04.000Z",
        eventType: "run.completed",
        payload: { status: "succeeded", result },
      };
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        body: `id: 4\nevent: run.completed\ndata: ${JSON.stringify(event)}\n\n`,
      });
      return;
    }

    if (
      url.pathname ===
        `/api/projects/${projectId}/experiments/${runId}/decision` &&
      method === "POST"
    ) {
      decisionRequest = request.postDataJSON() as Record<string, unknown>;
      experiment = {
        ...experiment,
        decision: decisionRequest.decision,
        decisionNote: decisionRequest.note,
        decidedAt: "2026-10-15T01:01:00.000Z",
      };
      await respond(route, {
        experimentId: runId,
        decision: decisionRequest.decision,
        note: decisionRequest.note,
        decidedAt: "2026-10-15T01:01:00.000Z",
        sequence: 5,
      });
      return;
    }

    await respond(
      route,
      { error: `Unexpected mocked request: ${method} ${url.pathname}` },
      501,
    );
  });

  await page.goto("/experiments");
  await expect(
    page.getByRole("heading", { level: 1, name: "Pengujian" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Pilot eksploratif/ }).check();
  await expectActiveProjectId(page, projectId);
  await page.getByLabel("Prompt baseline").selectOption(promptId);
  const promptVersionPicker = page.getByLabel("Versi prompt");
  await expect(promptVersionPicker).toBeEnabled();
  await promptVersionPicker.selectOption(historicalVersionId);
  await page.getByLabel("Model Codex").selectOption(modelId);
  await page.getByLabel("Kedalaman berpikir").selectOption("low");
  await page.getByLabel("Nama pilot").fill("Kebijakan kampus");
  await page.getByLabel("Versi pilot").fill("2026-06");
  await page.getByLabel("Satu input uji").fill("Summarize this policy.");
  await page.getByRole("button", { name: "Run", exact: true }).click();

  await expect(page.getByText("Pilot satu kasus dibuat.")).toBeVisible();
  await expect(
    page.getByText("The policy takes effect in June."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The policy takes effect in June, according to the supplied text.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Tanpa sumber knowledge dan tanpa snapshot/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ekspor laporan JSON" }),
  ).toBeVisible();

  expect(runRequest).toMatchObject({
    promptVersionId: historicalVersionId,
    requestedModel: modelId,
    reasoningEffort: "low",
    retrieval: { strategy: "lexical", sourceIds: [] },
    optimization: {
      maxIterations: 1,
      testCases: [{ id: "pilot-case-1", input: "Summarize this policy." }],
    },
  });
  expect(markerRequest).toMatchObject({
    runId,
    metadata: {
      datasetName: "Kebijakan kampus",
      datasetVersion: "2026-06",
      promptVersionId: historicalVersionId,
      baselinePrompt: historicalPrompt,
      activeSnapshotId: null,
      sources: [],
      retrieval: { strategy: "lexical", sourceIds: [] },
    },
  });
  expect(prompt.currentVersionId).toBe(currentVersionId);
  expect(prompt.text).toBe(originalPrompt);

  await page
    .getByLabel("Catatan keputusan (opsional)")
    .fill("Pilih jawaban yang lebih jelas.");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Ekspor laporan JSON" }).click(),
  ]);
  expect(download.suggestedFilename()).toContain(
    "pilot-kebijakan-kampus-2026-06",
  );

  await page.getByRole("button", { name: "Belum meyakinkan" }).click();
  await expect(
    page.getByText("Keputusan tersimpan. Prompt aktif tidak berubah otomatis."),
  ).toBeVisible();
  expect(decisionRequest).toEqual({
    decision: "inconclusive",
    note: "Pilih jawaban yang lebih jelas.",
  });
  expect(experiment?.decision).toBe("inconclusive");
  expect(prompt.currentVersionId).toBe(currentVersionId);
});
