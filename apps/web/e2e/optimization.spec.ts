import { expect, test, type Route } from "@playwright/test";

const projectId = "optimization-v3-qa";
const promptId = "optimization-v3-prompt";
const promptVersionId = "optimization-v3-version";
const runId = "optimization-v3-run";
const userMessage = "Jelaskan hasilnya secara singkat dan beri satu alasan.";
const answer = "Hasilnya sesuai karena setiap langkah mengikuti instruksi.";
const codexModel = "gpt-6-codex-fixture";
const optimizerModel = "senopati-fixture-model";

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function eventLine(sequence: number, eventType: string, payload: unknown) {
  const event = {
    id: `optimization-v3-${sequence}`,
    sequence,
    timestamp: "2026-10-18T00:00:00.000Z",
    eventType,
    payload,
  };
  return `id: ${sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

test("Workspace optimizes every message before Codex runs", async ({
  page,
}) => {
  const promptWrites: Record<string, unknown>[] = [];
  const runWrites: Record<string, unknown>[] = [];
  const unexpectedRequests: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === "/api/projects" && method === "GET") {
      await respond(route, {
        projects: [
          {
            id: projectId,
            name: "Optimization QA project",
            objective: "Verify mandatory workspace prompt optimization.",
          },
        ],
      });
      return;
    }

    if (pathname === "/api/providers" && method === "GET") {
      await respond(route, {
        providers: [
          {
            provider: "campus_gateway",
            role: "optimizer",
            status: "verified",
            requestedModel: optimizerModel,
            responseModel: optimizerModel,
            endpointLabel: "Senopati · QA fixture",
            checkedAt: "2026-10-18T00:00:00.000Z",
            reason: "Verified optimizer fixture.",
            capabilities: {},
          },
          {
            provider: "codex_app_server",
            role: "target",
            status: "verified",
            requestedModel: codexModel,
            responseModel: codexModel,
            endpointLabel: "Codex · QA fixture",
            checkedAt: "2026-10-18T00:00:00.000Z",
            reason: "Verified target fixture.",
            capabilities: {},
          },
        ],
        codexModels: [
          {
            id: codexModel,
            displayName: "GPT-6 Codex fixture",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ],
        projectPrerequisite: "satisfied",
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace` &&
      method === "GET"
    ) {
      await respond(route, {
        projectConfigured: false,
        databaseConfigured: true,
        reason: null,
        grantDurationSeconds: 900,
        writeAvailable: false,
        writeGrantDurationSeconds: null,
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/roots` &&
      method === "GET"
    ) {
      await respond(route, {
        roots: [],
        canChooseDirectory: false,
        runtimeAvailable: false,
        unavailableReason: "Local folder access is not needed for this test.",
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/knowledge` &&
      method === "GET"
    ) {
      await respond(route, { sources: [] });
      return;
    }

    if (pathname === `/api/projects/${projectId}/runs` && method === "GET") {
      await respond(route, {
        runs: runWrites.length
          ? [{ id: runId, status: "succeeded", purpose: "optimizer" }]
          : [],
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/prompts` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      promptWrites.push(body);
      await respond(
        route,
        {
          prompt: {
            id: promptId,
            name: String(body.name),
            versionId: promptVersionId,
            version: 1,
            text: String(body.text),
            currentVersionId: null,
          },
        },
        201,
      );
      return;
    }

    if (pathname === `/api/projects/${projectId}/runs` && method === "POST") {
      runWrites.push(request.postDataJSON() as Record<string, unknown>);
      await respond(route, { run: { id: runId, status: "running" } }, 201);
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/runs/${runId}/events` &&
      method === "GET"
    ) {
      const body =
        eventLine(1, "agent.action", {
          mode: "workspace_chat",
          phase: "senopati_decision",
          summary: "Senopati mengoptimasi prompt sebelum Codex berjalan.",
          provider: "campus_gateway",
          purpose: "optimizer",
        }) +
        eventLine(2, "run.completed", {
          status: "succeeded",
          text: answer,
          requestedModel: codexModel,
          responseModel: codexModel,
          responseId: "optimization-v3-response",
          workspaceChat: {
            outcome: "no_change_recommended",
            optimizationEvidenceStatus: "no_change_unscored",
            qualityVerified: false,
            fixtureEvaluationCount: 0,
            recommendation: null,
            clarification: null,
            retrievalStrategy: "lexical",
            graphSnapshotId: null,
            graphEvidenceStatus: "not_requested",
            graphEvidence: [],
            graphTraceIds: [],
            targetContextHash: null,
            decisionTurns: 1,
            toolCalls: 0,
            senopatiCalls: 1,
            codexTargetCalls: 1,
          },
        });
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
        body,
      });
      return;
    }

    unexpectedRequests.push(`${method} ${pathname}`);
    await respond(
      route,
      { error: "UNEXPECTED_FIXTURE_REQUEST", message: "Unexpected request." },
      501,
    );
  });

  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await expect(
    page.getByText(
      "Setiap pesan dioptimasi Senopati lalu otomatis dijalankan Codex. Versi prompt tersimpan tidak diaktifkan otomatis.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Senopati siap", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Minta rekomendasi prompt/i }),
  ).toHaveCount(0);

  const message = page.getByRole("textbox", { name: "Pesan" });
  await message.fill(userMessage);
  expect(runWrites).toEqual([]);
  await message.press("Enter");

  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Senopati menilai prompt sudah memadai; prompt asli otomatis dikirim ke Codex. Prompt ini belum dinilai pada contoh uji.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Aktivitas tersimpan", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Senopati mengoptimasi prompt sebelum Codex berjalan.", {
      exact: true,
    }),
  ).toBeHidden();
  expect(promptWrites).toHaveLength(1);
  expect(promptWrites[0]?.text).toContain(
    `Permintaan pengguna saat ini:\n${userMessage}`,
  );
  expect(runWrites).toHaveLength(1);
  expect(runWrites[0]).toMatchObject({
    projectId,
    promptVersionId,
    provider: "campus_gateway",
    requestedModel: optimizerModel,
    purpose: "optimizer",
    intent: "workspace_chat",
    retrieval: { strategy: "lexical", sourceIds: [] },
    workspaceChat: {
      format: "promptlab-workspace-chat-v1",
      target: {
        requestedModel: codexModel,
        reasoningEffort: "medium",
      },
    },
  });
  expect(unexpectedRequests).toEqual([]);
});
