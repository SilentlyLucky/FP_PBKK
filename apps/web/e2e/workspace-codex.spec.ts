import { once } from "node:events";
import { createServer } from "node:http";

import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "project-codex-qa";
const promptId = "prompt-codex-qa";
const promptVersionId = "prompt-version-codex-qa";
const runId = "run-codex-qa";
const deviceUrl = "https://auth.openai.com/codex/device";
const deviceCode = "QA-CODE-42";
const selectedModel = "gpt-5.6-codex";
const alternateModel = "gpt-5.6";
const completedOutput = "Mocked Codex completed output for the QA prompt.";
const inlineCompletedOutput = "Replayed completion for the inline answer.";
const inlineProjectA = "project-inline-a";
const inlineProjectB = "project-inline-b";

const codexModels = [
  {
    id: alternateModel,
    displayName: "GPT-5.6",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: selectedModel,
    displayName: "GPT-5.6 Codex",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium"],
  },
];

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function codexProvider(
  status: "configured_unverified" | "verified",
  model = selectedModel,
) {
  return {
    provider: "codex_app_server",
    role: "target",
    status,
    requestedModel: status === "verified" ? model : null,
    responseModel: status === "verified" ? model : null,
    endpointLabel: "Codex CLI · app-server stdio",
    checkedAt: status === "verified" ? "2026-10-12T00:00:00.000Z" : null,
    reason:
      status === "verified"
        ? "Provider Codex terverifikasi lewat fixture QA."
        : "Login Codex tersedia untuk akun ini.",
    capabilities: {},
  };
}

async function mockCodexJourney(page: Page) {
  let loggedIn = false;
  let verified = false;
  let verifiedModel = selectedModel;
  let savedPrompt:
    | {
        id: string;
        name: string;
        currentVersionId: string;
        version: number;
        text: string;
        invariants: string[];
      }
    | undefined;
  let runCreated = false;
  let promptWrite: Record<string, unknown> | null = null;
  let runWrite: Record<string, unknown> | null = null;
  const verifyModels: string[] = [];
  const providerActions: string[] = [];

  let markLoginPollStarted!: () => void;
  const loginPollStarted = new Promise<void>((resolve) => {
    markLoginPollStarted = resolve;
  });
  let releaseLoginPoll!: () => void;
  const loginPollGate = new Promise<void>((resolve) => {
    releaseLoginPoll = resolve;
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());

    if (url.pathname === "/api/projects" && method === "GET") {
      await respond(route, {
        projects: [
          {
            id: projectId,
            name: "Codex QA project",
            objective: "Exercise the mocked Codex workspace flow.",
          },
        ],
      });
      return;
    }

    if (url.pathname === "/api/providers" && method === "GET") {
      await respond(route, {
        providers: [
          codexProvider(
            verified ? "verified" : "configured_unverified",
            verifiedModel,
          ),
        ],
        codexModels: loggedIn ? codexModels : [],
        projectPrerequisite: "satisfied",
      });
      return;
    }

    if (url.pathname === "/api/providers" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const action = String(body.action ?? "");
      providerActions.push(action);

      if (action === "codex-login-start") {
        await respond(route, {
          outcome: "login_started",
          login: {
            loginId: "codex-login-qa",
            verificationUrl: deviceUrl,
            userCode: deviceCode,
            status: "pending",
          },
        });
        return;
      }

      if (action === "codex-login-status") {
        markLoginPollStarted();
        await loginPollGate;
        loggedIn = true;
        await respond(route, {
          outcome: "login_succeeded",
          login: {
            loginId: "codex-login-qa",
            verificationUrl: deviceUrl,
            userCode: deviceCode,
            status: "succeeded",
          },
        });
        return;
      }

      if (action === "codex-verify") {
        const verifyModel = typeof body.model === "string" ? body.model : null;
        if (verifyModel) verifyModels.push(verifyModel);
        verifiedModel = verifyModel ?? selectedModel;
        verified = codexModels.some((model) => model.id === verifyModel);
        await respond(route, {
          outcome: verified ? "verified" : "verification_failed",
          message: "Codex target verified by the QA fixture.",
          providers: [
            codexProvider(
              verified ? "verified" : "configured_unverified",
              verifiedModel,
            ),
          ],
          codexModels,
          projectPrerequisite: "satisfied",
        });
        return;
      }

      await respond(
        route,
        { error: `Unexpected mocked provider action: ${action}` },
        501,
      );
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/prompts` &&
      method === "GET"
    ) {
      await respond(route, { prompts: savedPrompt ? [savedPrompt] : [] });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/prompts` &&
      method === "POST"
    ) {
      promptWrite = request.postDataJSON() as Record<string, unknown>;
      savedPrompt = {
        id: promptId,
        name: String(promptWrite.name),
        currentVersionId: promptVersionId,
        version: 1,
        text: String(promptWrite.text),
        invariants: Array.isArray(promptWrite.invariants)
          ? promptWrite.invariants.map(String)
          : [],
      };
      await respond(route, { prompt: savedPrompt }, 201);
      return;
    }

    if (
      url.pathname ===
        `/api/projects/${projectId}/prompts/${promptId}/versions` &&
      method === "GET"
    ) {
      await respond(route, {
        versions: [
          {
            id: promptVersionId,
            version: 1,
            parentVersionId: null,
            createdAt: "2026-10-12T00:00:00.000Z",
          },
        ],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/workspace` &&
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
      url.pathname === `/api/projects/${projectId}/workspace/roots` &&
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
      url.pathname === `/api/projects/${projectId}/knowledge` &&
      method === "GET"
    ) {
      await respond(route, { sources: [] });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs` &&
      method === "POST"
    ) {
      runWrite = request.postDataJSON() as Record<string, unknown>;
      runCreated = true;
      await respond(route, { run: { id: runId, status: "queued" } }, 201);
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs` &&
      method === "GET"
    ) {
      const requestedModel =
        typeof runWrite?.requestedModel === "string"
          ? runWrite.requestedModel
          : selectedModel;
      await respond(route, {
        runs: runCreated
          ? [
              {
                id: runId,
                purpose: "target",
                provider: "codex_app_server",
                requestedModel,
                responseModel: requestedModel,
                status: "succeeded",
                errorCode: null,
                errorSummary: null,
                createdAt: "2026-10-12T00:00:00.000Z",
              },
            ]
          : [],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs/${runId}/events` &&
      method === "GET"
    ) {
      const requestedModel =
        typeof runWrite?.requestedModel === "string"
          ? runWrite.requestedModel
          : selectedModel;
      const events = [
        {
          id: "codex-completed-qa",
          sequence: 1,
          timestamp: "2026-10-12T00:00:02.000Z",
          eventType: "run.completed",
          payload: {
            status: "succeeded",
            text: completedOutput,
            requestedModel,
            responseModel: requestedModel,
            responseId: null,
          },
        },
      ];
      const body = events
        .map(
          (event) =>
            `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
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

    await respond(
      route,
      { error: `Unexpected mocked API request: ${method} ${url.pathname}` },
      501,
    );
  });

  return {
    loginPollStarted,
    releaseLoginPoll,
    providerActions,
    get promptWrite() {
      return promptWrite;
    },
    get runWrite() {
      return runWrite;
    },
    get verifyModels() {
      return verifyModels;
    },
  };
}

async function mockInlineRunJourney(page: Page) {
  await page.addInitScript(() => {
    type RunEventDetail = {
      runId: string;
      eventType: string;
      sequence: number;
      payload: Record<string, unknown>;
    };
    type ReconnectDetail = { runId: string };

    class MockEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      readonly url: string;
      readyState = MockEventSource.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private readonly pathname: string;
      private readonly listeners = new Map<string, Set<EventListener>>();
      private lastEventId = "";

      constructor(url: string | URL) {
        this.url = String(url);
        this.pathname = new URL(this.url, window.location.href).pathname;
        document.documentElement.dataset.inlineEventSourcePath = this.pathname;

        window.addEventListener("promptlab:run-event", (rawEvent) => {
          const detail = (rawEvent as CustomEvent<RunEventDetail>).detail;
          if (
            this.readyState !== MockEventSource.OPEN ||
            !this.pathname.endsWith(`/runs/${detail.runId}/events`)
          ) {
            return;
          }
          this.lastEventId = String(detail.sequence);
          const message = new MessageEvent(detail.eventType, {
            data: JSON.stringify({
              id: `inline-event-${detail.sequence}`,
              sequence: detail.sequence,
              timestamp: "2026-10-12T00:00:02.000Z",
              eventType: detail.eventType,
              payload: detail.payload,
            }),
            lastEventId: this.lastEventId,
          });
          for (const listener of this.listeners.get(detail.eventType) ?? [])
            listener(message);
        });

        window.addEventListener("promptlab:reconnect", (rawEvent) => {
          const detail = (rawEvent as CustomEvent<ReconnectDetail>).detail;
          if (
            this.readyState === MockEventSource.CLOSED ||
            !this.pathname.endsWith(`/runs/${detail.runId}/events`)
          ) {
            return;
          }
          this.readyState = MockEventSource.CONNECTING;
          this.onerror?.(new Event("error"));
          document.documentElement.dataset.inlineLastEventId = this.lastEventId;
          this.readyState = MockEventSource.OPEN;
          this.onopen?.(new Event("open"));
        });

        queueMicrotask(() => {
          if (this.readyState === MockEventSource.CLOSED) return;
          this.readyState = MockEventSource.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      addEventListener(type: string, listener: EventListener) {
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      close() {
        this.readyState = MockEventSource.CLOSED;
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource,
    });
  });

  const projectRunCounts = new Map<string, number>();
  const createdRunIds: string[] = [];
  const promptWrites: Record<string, unknown>[] = [];
  const runWrites: Record<string, unknown>[] = [];
  let promptVersion = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());

    if (url.pathname === "/api/projects" && method === "GET") {
      await respond(route, {
        projects: [
          { id: inlineProjectA, name: "Inline project A", objective: null },
          { id: inlineProjectB, name: "Inline project B", objective: null },
        ],
      });
      return;
    }

    if (url.pathname === "/api/providers" && method === "GET") {
      await respond(route, {
        providers: [
          {
            provider: "campus_gateway",
            role: "optimizer",
            status: "verified",
            requestedModel: "senopati-inline-fixture",
            responseModel: "senopati-inline-fixture",
            endpointLabel: "Senopati · inline fixture",
            checkedAt: "2026-10-12T00:00:00.000Z",
            reason: "Verified optimizer fixture.",
            capabilities: {},
          },
          codexProvider("verified"),
        ],
        codexModels,
        projectPrerequisite: "satisfied",
      });
      return;
    }

    const projectPath = url.pathname.match(/^\/api\/projects\/([^/]+)\//);
    const activeProjectId = projectPath?.[1];

    if (
      activeProjectId &&
      url.pathname === `/api/projects/${activeProjectId}/workspace` &&
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
      activeProjectId &&
      url.pathname === `/api/projects/${activeProjectId}/workspace/roots` &&
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
      activeProjectId &&
      url.pathname === `/api/projects/${activeProjectId}/knowledge` &&
      method === "GET"
    ) {
      await respond(route, { sources: [] });
      return;
    }

    const workspacePromptMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/workspace\/prompts$/,
    );
    if (workspacePromptMatch && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      promptWrites.push(body);
      promptVersion += 1;
      await respond(
        route,
        {
          prompt: {
            id: `workspace-prompt-${workspacePromptMatch[1]}`,
            name: String(body.name),
            versionId: `workspace-prompt-version-${promptVersion}`,
            version: promptVersion,
            text: String(body.text),
            currentVersionId: null,
          },
        },
        201,
      );
      return;
    }

    const runsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
    if (runsMatch && method === "GET") {
      await respond(route, { runs: [] });
      return;
    }
    if (runsMatch && method === "POST") {
      const projectId = runsMatch[1]!;
      runWrites.push(request.postDataJSON() as Record<string, unknown>);
      const runNumber = (projectRunCounts.get(projectId) ?? 0) + 1;
      projectRunCounts.set(projectId, runNumber);
      const runId = `run-${projectId}-${runNumber}`;
      createdRunIds.push(runId);
      await respond(route, { run: { id: runId, status: "queued" } }, 201);
      return;
    }

    await respond(
      route,
      { error: `Unexpected mocked API request: ${method} ${url.pathname}` },
      501,
    );
  });

  return {
    get createdRunIds() {
      return [...createdRunIds];
    },
    get promptWrites() {
      return [...promptWrites];
    },
    get runWrites() {
      return [...runWrites];
    },
  };
}

async function emitInlineRunEvent(
  page: Page,
  runId: string,
  eventType: string,
  sequence: number,
  payload: Record<string, unknown>,
) {
  await page.evaluate(
    (detail) =>
      window.dispatchEvent(new CustomEvent("promptlab:run-event", { detail })),
    { runId, eventType, sequence, payload },
  );
}

async function reconnectInlineRunStream(page: Page, runId: string) {
  return page.evaluate((targetRunId) => {
    window.dispatchEvent(
      new CustomEvent("promptlab:reconnect", {
        detail: { runId: targetRunId },
      }),
    );
    return document.documentElement.dataset.inlineLastEventId ?? "";
  }, runId);
}

test("Codex login and verification cannot bypass mandatory Senopati optimization", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const mocks = await mockCodexJourney(page);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Pengaturan" })).toBeVisible();

  await page.getByRole("button", { name: "Login Codex" }).click();
  await expect(page.getByLabel("Kode login Codex")).toHaveText(deviceCode);
  const deviceLink = page.getByRole("link", {
    name: "Buka halaman login Codex",
  });
  await expect(deviceLink).toHaveAttribute("href", deviceUrl);
  await expect(deviceLink).toHaveAttribute("target", "_blank");

  await mocks.loginPollStarted;
  mocks.releaseLoginPoll();
  await expect(
    page.getByText("Login Codex berhasil. Pilih model lalu verifikasi target."),
  ).toBeVisible();

  const modelPicker = page.getByLabel("Model target Codex");
  await expect(modelPicker).toBeVisible();
  await modelPicker.selectOption(selectedModel);
  await expect(modelPicker).toHaveValue(selectedModel);
  await page.getByRole("button", { name: "Verifikasi Codex" }).click();
  await expect(
    page.getByText("Codex target verified by the QA fixture."),
  ).toBeVisible();
  await expect(
    page.getByText("Codex target siap", { exact: true }),
  ).toBeVisible();
  expect(mocks.providerActions).toEqual([
    "codex-login-start",
    "codex-login-status",
    "codex-verify",
  ]);
  expect(mocks.verifyModels).toEqual([selectedModel]);

  const navigation = page.getByRole("navigation", { name: "Navigasi utama" });
  await navigation.getByRole("link", { name: "Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await expect(
    page.getByText("Codex target siap", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Senopati tidak tersedia", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Senopati belum terverifikasi. Setiap pesan harus dioptimasi sebelum dapat dikirim ke Codex.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pesan" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Kirim", exact: true }),
  ).toBeDisabled();
  expect(mocks.promptWrite).toBeNull();
  expect(mocks.runWrite).toBeNull();
});

test("Workspace streams optimized answers without leaking state across runs or projects", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const mocks = await mockInlineRunJourney(page);

  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await expect(page.getByText("Senopati siap", { exact: true })).toBeVisible();
  const message = page.getByRole("textbox", { name: "Pesan" });
  const sendButton = page.getByRole("button", { name: "Kirim", exact: true });

  await message.fill("Return a concise answer for project A.");
  await sendButton.click();
  const resultPanel = page.getByRole("region", { name: "Jawaban Senopati" });
  await expect(resultPanel).toHaveCount(1);
  const firstRunId = mocks.createdRunIds[0]!;
  await expect(page.locator("html")).toHaveAttribute(
    "data-inline-event-source-path",
    `/api/projects/${inlineProjectA}/runs/${firstRunId}/events`,
  );
  await emitInlineRunEvent(page, firstRunId, "run.status", 1, {
    status: "queued",
  });
  await expect(
    resultPanel.getByText("Menunggu giliran…", { exact: true }),
  ).toBeVisible();
  expect(await reconnectInlineRunStream(page, firstRunId)).toBe("1");
  await emitInlineRunEvent(page, firstRunId, "run.status", 1, {
    status: "queued",
  });
  await expect(
    resultPanel.getByText("Menunggu giliran…", { exact: true }),
  ).toBeVisible();
  await emitInlineRunEvent(page, firstRunId, "run.status", 2, {
    status: "running",
  });

  await expect(
    resultPanel.getByText("Sedang menyiapkan jawaban…", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await reconnectInlineRunStream(page, firstRunId)).toBe("2");
  await emitInlineRunEvent(page, firstRunId, "run.completed", 3, {
    status: "succeeded",
    text: inlineCompletedOutput,
  });
  await expect(
    resultPanel.getByText(inlineCompletedOutput, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Percakapan baru" }).click();
  await expect(resultPanel).toHaveCount(0);
  await message.fill("Return a second answer that will fail.");
  await sendButton.click();
  await expect.poll(() => mocks.createdRunIds.length).toBe(2);
  await expect(resultPanel).toHaveCount(1);
  const secondResultPanel = resultPanel;
  await expect(
    secondResultPanel.getByText(inlineCompletedOutput, { exact: true }),
  ).toHaveCount(0);
  const secondRunId = mocks.createdRunIds[1]!;
  await expect(page.locator("html")).toHaveAttribute(
    "data-inline-event-source-path",
    `/api/projects/${inlineProjectA}/runs/${secondRunId}/events`,
  );
  await emitInlineRunEvent(page, secondRunId, "run.status", 1, {
    status: "failed",
    errorCode: "MOCK_FAILURE",
  });
  await expect(
    secondResultPanel.getByText(
      "Saya belum dapat menyelesaikan jawaban ini. Coba lagi setelah memeriksa koneksi provider.",
      { exact: true },
    ),
  ).toBeVisible();
  await secondResultPanel.getByText("Detail kegagalan").click();
  await expect(
    secondResultPanel.getByText("MOCK_FAILURE", { exact: true }),
  ).toBeVisible();

  await page.locator("#active-project").selectOption(inlineProjectB);
  await expect(
    page.getByRole("region", { name: "Jawaban Senopati" }),
  ).toHaveCount(0);
  await message.fill("Return an answer for project B.");
  await sendButton.click();
  await expect.poll(() => mocks.createdRunIds.length).toBe(3);
  const projectBResult = page.getByRole("region", {
    name: "Jawaban Senopati",
  });
  const projectBRunId = mocks.createdRunIds[2]!;
  await expect(page.locator("html")).toHaveAttribute(
    "data-inline-event-source-path",
    `/api/projects/${inlineProjectB}/runs/${projectBRunId}/events`,
  );
  await emitInlineRunEvent(page, projectBRunId, "run.status", 1, {
    status: "running",
  });
  await expect(
    projectBResult.getByText("Sedang menyiapkan jawaban…", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    projectBResult.getByText("Saya belum dapat menyelesaikan jawaban ini.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await expect(
    projectBResult.getByText("MOCK_FAILURE", { exact: true }),
  ).toHaveCount(0);
  await expect(
    projectBResult.getByText(inlineCompletedOutput, { exact: true }),
  ).toHaveCount(0);

  expect(mocks.runWrites).toHaveLength(3);
  expect(mocks.runWrites[0]).toMatchObject({
    projectId: inlineProjectA,
    provider: "campus_gateway",
    purpose: "optimizer",
    workspaceChat: {
      format: "promptlab-workspace-chat-v1",
      target: { requestedModel: selectedModel },
    },
  });
  expect(mocks.runWrites[1]).toMatchObject({
    projectId: inlineProjectA,
    provider: "campus_gateway",
    purpose: "optimizer",
  });
  expect(mocks.runWrites[2]).toMatchObject({
    projectId: inlineProjectB,
    provider: "campus_gateway",
    purpose: "optimizer",
  });
  expect(mocks.promptWrites).toHaveLength(3);
  expect(mocks.promptWrites[0]?.text).toContain(
    "Return a concise answer for project A.",
  );
  expect(mocks.promptWrites[1]?.text).toContain(
    "Return a second answer that will fail.",
  );
  expect(mocks.promptWrites[2]?.text).toContain(
    "Return an answer for project B.",
  );
});

test("EventSource reconnects with Last-Event-ID and receives the next run event", async ({
  page,
}) => {
  const cursors: string[] = [];
  const server = createServer((request, response) => {
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Last-Event-ID",
      "access-control-allow-methods": "GET, OPTIONS",
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (request.url !== "/events") {
      response.writeHead(404);
      response.end();
      return;
    }

    const cursorHeader = request.headers["last-event-id"];
    const cursor = Array.isArray(cursorHeader)
      ? (cursorHeader[0] ?? "")
      : (cursorHeader ?? "");
    cursors.push(cursor);
    response.writeHead(200, headers);
    const sequence = cursor === "1" ? 2 : 1;
    const eventType = sequence === 1 ? "run.status" : "run.completed";
    response.end(
      `id: ${sequence}\nevent: ${eventType}\ndata: ${JSON.stringify({ sequence })}\n\n`,
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The local SSE fixture did not bind to a TCP port.");

  try {
    await page.setContent(`
      <body>
        <script>
          const source = new EventSource("http://127.0.0.1:${address.port}/events");
          source.addEventListener("run.status", (event) => {
            document.body.dataset.lastStatusId = event.lastEventId;
          });
          source.addEventListener("run.completed", (event) => {
            document.body.dataset.completedId = event.lastEventId;
            source.close();
          });
        </script>
      </body>
    `);
    await page.waitForFunction(
      () => document.body.dataset.completedId === "2",
      undefined,
      { timeout: 10_000 },
    );
    expect(await page.locator("body").getAttribute("data-last-status-id")).toBe(
      "1",
    );
    expect(cursors).toEqual(["", "1"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
