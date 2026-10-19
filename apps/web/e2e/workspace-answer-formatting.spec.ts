import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const projectId = "7a058ee0-8ef5-4e15-9fc1-e0e3310c8f20";
const conversationId = "3a4f3461-6317-4cc8-a8aa-25ba25e27f14";
const turnId = "a2e497ce-ec79-42e4-a11b-75df3048c685";
const runId = "a736f92d-99bc-43fe-b15c-9fc61b0774b1";
const jsonRequestRunId = "5ec83baa-9958-44f6-a713-bac9e06b72c6";
const jsonFollowUpRunId = "91be6f0b-84b0-4fd7-9750-81ea9991379b";
const timestamp = "2026-10-17T09:00:00.000Z";

const project = {
  id: projectId,
  name: "OFFLINE FIXTURE · Workspace chat",
  objective: "Pemeriksaan tampilan jawaban, bukan data proyek live.",
};

const chatRun = {
  id: runId,
  promptVersionId: "fixture-version",
  promptText: "Fixture prompt",
  promptName: "Workspace answer fixture",
  purpose: "target",
  provider: "codex_app_server",
  requestedModel: "gpt-6-codex",
  responseModel: "gpt-6-codex",
  status: "succeeded",
  errorCode: null,
  errorSummary: null,
  createdAt: timestamp,
};

const conversation = {
  id: conversationId,
  title: "Format jawaban",
  updatedAt: timestamp,
  preference: "balanced",
  reasoningEffort: "high",
  sourceIds: [],
  promptId: null,
  promptVersionId: null,
  turns: [
    {
      id: "json-request-turn",
      userText: "Berikan jawaban dalam format JSON.",
      assistantText: null,
      runId: jsonRequestRunId,
      status: "succeeded",
      promptId: null,
      promptVersionId: null,
      promptText: null,
      provider: "codex_app_server",
      requestedModel: "gpt-6-codex",
      runCreateRequest: null,
      sourceIds: [],
      createdAt: timestamp,
    },
    {
      id: turnId,
      userText: "Tunjukkan rumus kombinasi, kode TypeScript, dan alurnya.",
      assistantText: null,
      runId,
      status: "succeeded",
      promptId: null,
      promptVersionId: null,
      promptText: null,
      provider: "codex_app_server",
      requestedModel: "gpt-6-codex",
      runCreateRequest: null,
      sourceIds: [],
      createdAt: timestamp,
    },
    {
      id: "json-follow-up-turn",
      userText: "Tambahkan status pada jawaban tadi.",
      assistantText: null,
      runId: jsonFollowUpRunId,
      status: "succeeded",
      promptId: null,
      promptVersionId: null,
      promptText: null,
      provider: "codex_app_server",
      requestedModel: "gpt-6-codex",
      runCreateRequest: null,
      sourceIds: [],
      createdAt: timestamp,
    },
  ],
};

const fence = String.fromCharCode(96).repeat(3);
const answer = [
  "Rumus kombinasi:",
  "",
  "$$\\binom{n}{k} = \\frac{n!}{k!(n-k)!}$$",
  "",
  "Panah: $\\leftarrow$ dan $\\rightarrow$.",
  "",
  "Implementasi TypeScript:",
  "",
  fence + "typescript",
  "function choose(n: number, k: number): number {",
  "  return factorial(n) / (factorial(k) * factorial(n - k));",
  "}",
  fence,
  "",
  fence + "mermaid",
  "flowchart TD",
  "A[Input] --> B{Nilai valid?}",
  "B -->|Ya| C[Hitung kombinasi]",
  "B -->|Tidak| D[Tampilkan kesalahan]",
  fence,
].join("\n");
const jsonRequestAnswer = '{"answer":"Jawaban pertama."}';
const jsonFollowUpAnswer = '{"answer":"Status: siap."}';

test("Workspace displays readable math, copyable code, and a safe diagram preview", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(
    ({ selectedProjectId, selectedConversation }) => {
      localStorage.setItem("promptlab.activeProjectId", selectedProjectId);
      localStorage.setItem(
        "promptlab.workspace.conversations.v1:" + selectedProjectId,
        JSON.stringify([selectedConversation]),
      );
      localStorage.setItem(
        "promptlab.workspace.active.v1:" + selectedProjectId,
        selectedConversation.id,
      );
    },
    { selectedProjectId: projectId, selectedConversation: conversation },
  );

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/projects") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ projects: [project] }),
      });
    }
    if (url.pathname === "/api/providers") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          providers: [
            {
              provider: "codex_app_server",
              status: "verified",
              role: "target",
              requestedModel: "gpt-6-codex",
              responseModel: "gpt-6-codex",
              endpointLabel: "Offline fixture",
              checkedAt: timestamp,
              reason: null,
              capabilities: {},
            },
          ],
          codexModels: [
            {
              id: "gpt-6-codex",
              displayName: "GPT-6 Codex",
              supportedReasoningEfforts: ["low", "medium", "high"],
              defaultReasoningEffort: "medium",
            },
          ],
        }),
      });
    }
    if (url.pathname === "/api/projects/" + projectId + "/knowledge") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sources: [] }),
      });
    }
    if (url.pathname === "/api/projects/" + projectId + "/runs") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [chatRun] }),
      });
    }
    if (
      url.pathname.startsWith("/api/projects/" + projectId + "/runs/") &&
      url.pathname.endsWith("/events")
    ) {
      const eventRunId = url.pathname.split("/").at(-2);
      const answerText = new Map([
        [runId, answer],
        [jsonRequestRunId, jsonRequestAnswer],
        [jsonFollowUpRunId, jsonFollowUpAnswer],
      ]).get(eventRunId ?? "");
      if (!answerText) return route.fulfill({ status: 404 });
      const event = {
        id: "answer-event-" + eventRunId,
        sequence: 1,
        timestamp,
        eventType: "run.completed",
        payload: { status: "succeeded", text: answerText },
      };
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body:
          "id: 1\nevent: run.completed\ndata: " +
          JSON.stringify(event) +
          "\n\n",
      });
    }
    if (url.pathname === "/api/health") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    }
    return route.fulfill({ status: 404, body: "Offline fixture only" });
  });

  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await expect(
    page.getByText("Tunjukkan rumus kombinasi, kode TypeScript, dan alurnya."),
  ).toBeVisible();
  await expect(page.getByRole("math").first()).toBeVisible();
  const formulaText = (await page.getByRole("math").allTextContents()).join("");
  expect(formulaText).not.toContain("\\binom");
  expect(formulaText).toContain("(");
  expect(formulaText).toContain(")");
  expect(formulaText).toContain("←");
  expect(formulaText).toContain("→");
  await expect(
    page.getByRole("img", { name: "Pratinjau diagram alur" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Salin typescript" }),
  ).toBeVisible();
  await expect(page.locator("#workspace-thinking")).toHaveValue("high");
  await expect(page.locator("#workspace-thinking-help")).toContainText(
    "Tingkat usaha berpikir mengatur seberapa banyak model",
  );
  await expect(page.locator("#workspace-thinking-help")).toContainText(
    "penalaran internal tetap tidak ditampilkan",
  );
  await expect(page.getByRole("button", { name: "Salin json" })).toHaveCount(2);
  await expect(
    page.locator("code").filter({ hasText: '"answer": "Status: siap."' }),
  ).toBeVisible();
  const diagramPreview = page.getByRole("img", {
    name: "Pratinjau diagram alur",
  });
  const diagramScroll = diagramPreview.locator("xpath=..");
  const desktopDiagramWidth = await diagramScroll.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    svgWidth: element.querySelector("svg")?.getBoundingClientRect().width ?? 0,
  }));
  expect(
    desktopDiagramWidth.scrollWidth,
    JSON.stringify(desktopDiagramWidth),
  ).toBeLessThanOrEqual(desktopDiagramWidth.clientWidth);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const copyButton = page.getByRole("button", { name: "Salin typescript" });
  await copyButton.click();
  await expect(copyButton).toContainText("Tersalin");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("function choose");

  const messageScroll = page.getByTestId("workspace-message-scroll");
  await messageScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-answer-text-code-fixture-1440.png",
    ),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });
  await messageScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await diagramPreview.scrollIntoViewIfNeeded();

  await page.screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-answer-formatting-fixture-1440.png",
    ),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });
  await diagramPreview.screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-mermaid-preview-fixture-1440.png",
    ),
  });

  await page.setViewportSize({ width: 390, height: 900 });
  await messageScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      diagramScroll.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  await diagramPreview.scrollIntoViewIfNeeded();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  await page.screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-answer-formatting-fixture-390.png",
    ),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });
  await diagramPreview.screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-mermaid-preview-fixture-390.png",
    ),
  });
});
