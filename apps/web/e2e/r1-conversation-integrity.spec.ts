import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "project-offline-fixture";
const project = {
  id: projectId,
  name: "Proyek Fixture Offline",
  objective: "Menguji alur lokal tanpa layanan eksternal.",
};

interface OfflineWorkspaceState {
  mode: "ready" | "empty" | "disconnected";
  knowledgeFailureOnRequest: number | null;
  sourceRows: Array<Record<string, unknown>>;
  dropFirstRunResponse: boolean;
  projectScopedCodexVerified: boolean;
}

interface OfflineWorkspaceFixtures {
  state: OfflineWorkspaceState;
  knowledgeRequests: number;
  providerProjectIds: Array<string | null>;
  promptRequests: Array<Record<string, unknown>>;
  runRequests: Array<Record<string, unknown>>;
  unexpectedApiRequests: string[];
}

function jsonResponse(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
  });
}

/** All API traffic in these tests is intercepted with offline fixtures. */
async function installOfflineWorkspaceFixtures(
  page: Page,
  options: Partial<OfflineWorkspaceState> = {},
): Promise<OfflineWorkspaceFixtures> {
  const fixtures: OfflineWorkspaceFixtures = {
    state: {
      mode: "ready",
      knowledgeFailureOnRequest: null,
      sourceRows: [],
      dropFirstRunResponse: false,
      projectScopedCodexVerified: false,
      ...options,
    },
    knowledgeRequests: 0,
    providerProjectIds: [],
    promptRequests: [],
    runRequests: [],
    unexpectedApiRequests: [],
  };
  const runStatuses = new Map<string, string>();
  const runEventSequences = new Map<string, number>();
  const runByIdempotencyKey = new Map<string, Record<string, unknown>>();
  const storedConversations: Array<Record<string, unknown>> = [];
  let droppedRunResponse = false;
  let promptVersion = 0;

  await page.addInitScript(
    (activeProjectId) => {
      if (activeProjectId) {
        window.localStorage.setItem(
          "promptlab.activeProjectId",
          activeProjectId,
        );
      } else {
        window.localStorage.removeItem("promptlab.activeProjectId");
      }
    },
    fixtures.state.mode === "empty" ? null : projectId,
  );

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (path === "/api/projects" && method === "GET") {
      return jsonResponse(route, {
        projects: fixtures.state.mode === "empty" ? [] : [project],
      });
    }
    if (path === "/api/providers" && method === "GET") {
      const requestedProjectId = url.searchParams.get("projectId");
      fixtures.providerProjectIds.push(requestedProjectId);
      const codexTarget =
        requestedProjectId && fixtures.state.projectScopedCodexVerified
          ? [
              {
                provider: "codex_app_server",
                role: "target",
                status: "verified",
                requestedModel: "gpt-6-luna",
                responseModel: "gpt-6-luna",
              },
            ]
          : [];
      const senopatiOptimizer =
        requestedProjectId && fixtures.state.projectScopedCodexVerified
          ? [
              {
                provider: "campus_gateway",
                role: "optimizer",
                status: "verified",
                requestedModel: "offline-fixture-model",
              },
            ]
          : [];
      return jsonResponse(route, {
        providers:
          fixtures.state.mode === "disconnected"
            ? []
            : senopatiOptimizer.concat(codexTarget),
        codexModels: codexTarget.length
          ? [{ id: "gpt-6-luna", displayName: "GPT-6-Luna" }]
          : [],
      });
    }

    const projectPath = `/api/projects/${projectId}`;
    const conversationCollectionPath = `${projectPath}/workspace/conversations`;
    if (path === conversationCollectionPath && method === "GET") {
      return jsonResponse(route, { conversations: storedConversations });
    }
    if (path === conversationCollectionPath && method === "PUT") {
      const body = request.postDataJSON() as {
        conversations?: Array<Record<string, unknown>>;
      };
      storedConversations.splice(
        0,
        storedConversations.length,
        ...(body.conversations ?? []),
      );
      return jsonResponse(route, { saved: storedConversations.length });
    }
    const conversationMatch = path.match(
      new RegExp(`^${conversationCollectionPath}/([^/]+)$`),
    );
    if (conversationMatch && method === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const index = storedConversations.findIndex(
        (conversation) => conversation.id === conversationMatch[1],
      );
      if (index < 0) storedConversations.unshift(body);
      else storedConversations[index] = body;
      return jsonResponse(route, { saved: true });
    }
    if (conversationMatch && method === "DELETE") {
      const index = storedConversations.findIndex(
        (conversation) => conversation.id === conversationMatch[1],
      );
      if (index >= 0) storedConversations.splice(index, 1);
      return jsonResponse(route, { deleted: true });
    }
    if (path === `${projectPath}/knowledge` && method === "GET") {
      fixtures.knowledgeRequests += 1;
      if (
        fixtures.state.knowledgeFailureOnRequest === fixtures.knowledgeRequests
      ) {
        return jsonResponse(
          route,
          {
            error: "OFFLINE_CONSENT_REFRESH_FAILED",
            message: "Fixture izin berbagi sedang tidak tersedia.",
          },
          503,
        );
      }
      return jsonResponse(route, {
        projectId,
        readiness: {},
        sources: fixtures.state.sourceRows,
        builds: [],
        assertions: [],
      });
    }
    if (path === `${projectPath}/workspace` && method === "GET") {
      return jsonResponse(route, {
        projectConfigured: true,
        databaseConfigured: true,
        writeAvailable: false,
        reason: null,
        grantDurationSeconds: 900,
        writeGrantDurationSeconds: null,
      });
    }

    if (path === `${projectPath}/workspace/prompts` && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      fixtures.promptRequests.push(body);
      promptVersion += 1;
      return jsonResponse(
        route,
        {
          prompt: {
            id:
              typeof body.promptId === "string"
                ? body.promptId
                : "offline-prompt",
            name:
              typeof body.name === "string" ? body.name : "Percakapan fixture",
            versionId: `offline-prompt-version-${promptVersion}`,
            version: promptVersion,
            text: typeof body.text === "string" ? body.text : "",
            currentVersionId: null,
          },
        },
        201,
      );
    }

    if (path === `${projectPath}/runs` && method === "GET") {
      const idempotencyKey = url.searchParams.get("idempotencyKey");
      if (idempotencyKey) {
        const run = runByIdempotencyKey.get(idempotencyKey);
        return run
          ? jsonResponse(route, { run })
          : jsonResponse(route, { error: "RUN_NOT_FOUND" }, 404);
      }
      return jsonResponse(route, { runs: [] });
    }
    if (path === `${projectPath}/runs` && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      fixtures.runRequests.push(body);
      const idempotencyKey = String(body.idempotencyKey ?? "");
      let run = runByIdempotencyKey.get(idempotencyKey);
      if (!run) {
        const runId = `offline-run-${fixtures.runRequests.length}`;
        runStatuses.set(runId, "queued");
        run = {
          id: runId,
          status: "queued",
          provider: body.provider,
          requestedModel: body.requestedModel,
          purpose: body.purpose,
          createdAt: new Date(0).toISOString(),
        };
        runByIdempotencyKey.set(idempotencyKey, run);
      }
      if (fixtures.state.dropFirstRunResponse && !droppedRunResponse) {
        droppedRunResponse = true;
        return route.abort();
      }
      return jsonResponse(
        route,
        { run },
        fixtures.runRequests.length > 1 ? 200 : 201,
      );
    }

    const cancelMatch = path.match(
      new RegExp(`^${projectPath}/runs/([^/]+)/cancel$`),
    );
    if (cancelMatch && method === "POST") {
      const runId = cancelMatch[1]!;
      runStatuses.set(runId, "canceled");
      return jsonResponse(route, { runId, status: "canceled", canceled: true });
    }

    const eventsMatch = path.match(
      new RegExp(`^${projectPath}/runs/([^/]+)/events$`),
    );
    if (eventsMatch && method === "GET") {
      const runId = eventsMatch[1]!;
      const status = runStatuses.get(runId) ?? "queued";
      const sequence = (runEventSequences.get(runId) ?? 0) + 1;
      runEventSequences.set(runId, sequence);
      const event = {
        sequence,
        eventType: "run.status",
        payload: { status },
      };
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "no-cache" },
        body: `id: ${sequence}\nevent: run.status\ndata: ${JSON.stringify(event)}\n\n`,
      });
    }

    if (
      path === `${projectPath}/prompts` &&
      (method === "POST" || method === "GET")
    ) {
      if (method === "GET") return jsonResponse(route, { prompts: [] });
      const body = request.postDataJSON() as Record<string, unknown>;
      fixtures.promptRequests.push(body);
      promptVersion += 1;
      return jsonResponse(
        route,
        {
          prompt: {
            id: "offline-prompt",
            name:
              typeof body.name === "string" ? body.name : "Percakapan fixture",
            currentVersionId: `offline-prompt-version-${promptVersion}`,
          },
        },
        201,
      );
    }
    const versionMatch = path.match(
      new RegExp(`^${projectPath}/prompts/([^/]+)/versions$`),
    );
    if (versionMatch && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      fixtures.promptRequests.push(body);
      promptVersion += 1;
      return jsonResponse(
        route,
        {
          prompt: {
            id: versionMatch[1],
            name: "Percakapan fixture",
            currentVersionId: `offline-prompt-version-${promptVersion}`,
          },
        },
        201,
      );
    }

    fixtures.unexpectedApiRequests.push(`${method} ${path}`);
    return jsonResponse(
      route,
      { error: "UNEXPECTED_OFFLINE_FIXTURE_REQUEST" },
      404,
    );
  });

  return fixtures;
}

test("loads provider status for the selected project", async ({ page }) => {
  const fixtures = await installOfflineWorkspaceFixtures(page, {
    projectScopedCodexVerified: true,
  });
  await page.goto("/workspace");

  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await expect.poll(() => fixtures.providerProjectIds).toContain(projectId);
  await expect(
    page.getByRole("link", { name: "Status target Codex" }),
  ).toContainText("Codex target siap");
  expect(fixtures.unexpectedApiRequests).toEqual([]);
});

test("serializes follow-ups, offers cancellation, and keeps one new conversation action", async ({
  page,
}) => {
  const fixtures = await installOfflineWorkspaceFixtures(page, {
    projectScopedCodexVerified: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/workspace");

  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Percakapan baru", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("complementary", {
      name: "Riwayat percakapan",
    }),
  ).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Pesan" });
  const sendButton = page.getByRole("button", { name: "Kirim pesan" });
  await composer.fill("Pertanyaan pertama fixture.");
  await sendButton.click();
  await expect(
    page.getByText(
      /follow-up ditahan agar konteks percakapan tetap berurutan/i,
    ),
  ).toBeVisible();
  await expect(sendButton).toBeDisabled();
  await composer.fill("Pertanyaan lanjutan fixture.");
  await expect.poll(() => fixtures.runRequests.length).toBe(1);

  await page.getByRole("button", { name: "Batalkan run" }).click();
  await expect(
    page.getByText(
      /follow-up ditahan agar konteks percakapan tetap berurutan/i,
    ),
  ).toHaveCount(0);
  await expect(page.getByText("Dibatalkan", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Pertanyaan lanjutan fixture.");
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect.poll(() => fixtures.runRequests.length).toBe(2);
  expect(fixtures.promptRequests).toHaveLength(2);
  expect(fixtures.runRequests[0]?.retrieval).toEqual({
    strategy: "auto",
    sourceIds: [],
  });
  expect(fixtures.runRequests[1]?.retrieval).toEqual({
    strategy: "auto",
    sourceIds: [],
  });

  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  for (const width of [320, 360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const panel = document.querySelector(
        '[data-testid="workspace-chat-panel"]',
      );
      const messages = document.querySelector(
        '[data-testid="workspace-message-scroll"]',
      );
      const composerForm = document.querySelector("#workspace-composer");
      if (
        !(panel instanceof HTMLElement) ||
        !(messages instanceof HTMLElement)
      ) {
        return null;
      }
      const panelBounds = panel.getBoundingClientRect();
      const composerBounds = composerForm?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        messagesHeight: messages.getBoundingClientRect().height,
        composerFitsPanel: Boolean(
          composerBounds && composerBounds.bottom <= panelBounds.bottom + 1,
        ),
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.documentWidth).toBeLessThanOrEqual(layout!.viewportWidth);
    expect(layout!.messagesHeight).toBeGreaterThanOrEqual(180);
    expect(layout!.composerFitsPanel).toBe(true);
    await page.screenshot({
      path: resolve(
        screenshotDirectory,
        `r1-conversation-integrity-${width}.png`,
      ),
      fullPage: true,
      style: "nextjs-portal { display: none !important; }",
    });
  }

  await page.setViewportSize({ width: 320, height: 900 });
  const historyToggle = page.getByRole("button", { name: "Riwayat" });
  await expect(historyToggle).toHaveAttribute(
    "aria-controls",
    "workspace-history",
  );
  await expect(historyToggle).toHaveAttribute("aria-expanded", "false");
  await historyToggle.click();
  await expect(historyToggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "Percakapan baru", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("complementary", {
      name: "Riwayat percakapan",
    }),
  ).toBeVisible();
  expect(fixtures.unexpectedApiRequests).toEqual([]);
});

test("keeps an uncertain run creation blocked until the same idempotent run is found", async ({
  page,
}) => {
  const fixtures = await installOfflineWorkspaceFixtures(page, {
    projectScopedCodexVerified: true,
    dropFirstRunResponse: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/workspace");

  const composer = page.getByRole("textbox", { name: "Pesan" });
  await composer.fill("Permintaan dengan respons run yang terputus.");
  await page.getByRole("button", { name: "Kirim pesan" }).click();
  await expect.poll(() => fixtures.runRequests.length).toBe(1);
  const reconcile = page.getByRole("button", {
    name: "Periksa atau temukan run",
  });
  await expect(reconcile).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Kirim pesan" }),
  ).toBeDisabled();

  const persisted = await page.evaluate((activeProjectId) => {
    const key = `promptlab.workspace.conversations.v1:${activeProjectId}`;
    return JSON.parse(window.localStorage.getItem(key) ?? "[]") as Array<{
      turns: Array<Record<string, unknown>>;
    }>;
  }, projectId);
  const pendingTurn = persisted[0]?.turns[0];
  expect(pendingTurn?.status).toBe("run_creation_unconfirmed");
  const savedRequest = pendingTurn?.runCreateRequest as
    Record<string, unknown> | undefined;
  expect(savedRequest?.idempotencyKey).toBe(
    fixtures.runRequests[0]?.idempotencyKey,
  );

  await reconcile.click();
  await expect(reconcile).toHaveCount(0);
  await expect(
    page.getByText(
      /follow-up ditahan agar konteks percakapan tetap berurutan/i,
    ),
  ).toBeVisible();
  expect(fixtures.runRequests).toHaveLength(1);
  expect(fixtures.unexpectedApiRequests).toEqual([]);
});

test("blocks source egress after a failed consent refresh and allows an explicit no-source recovery", async ({
  page,
}) => {
  const fixtures = await installOfflineWorkspaceFixtures(page, {
    projectScopedCodexVerified: true,
    knowledgeFailureOnRequest: 2,
    sourceRows: [
      {
        id: "source-offline-fixture",
        displayName: "Kebijakan offline",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
        deleted: false,
        eligible: true,
        version: 1,
        versionId: "source-version-1",
        extractStatus: "ready",
        chunkCount: 1,
      },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/workspace");

  await page.getByRole("button", { name: "Sumber" }).click();
  await page.getByRole("checkbox", { name: /Kebijakan offline/ }).check();
  await expect(
    page.getByText(/sumber pilihan akan dipakai setelah izin diverifikasi/i),
  ).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Pesan" });
  await composer.fill("Pertanyaan dengan sumber fixture.");
  await page.getByRole("button", { name: "Kirim pesan" }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Izin sumber terbaru tidak dapat diverifikasi",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Kebijakan offline", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hapus pilihan bermasalah" }),
  ).toBeVisible();
  expect(fixtures.promptRequests).toHaveLength(0);
  expect(fixtures.runRequests).toHaveLength(0);
  await expect(composer).toHaveValue("Pertanyaan dengan sumber fixture.");

  await page.getByRole("button", { name: "Hapus pilihan bermasalah" }).click();
  await page.getByRole("button", { name: "Kirim pesan" }).click();
  await expect.poll(() => fixtures.runRequests.length).toBe(1);
  expect(fixtures.knowledgeRequests).toBe(2);
  expect(fixtures.runRequests[0]?.retrieval).toEqual({
    strategy: "auto",
    sourceIds: [],
  });
  expect(fixtures.unexpectedApiRequests).toEqual([]);
});

test("shows honest empty-project and disconnected-provider states", async ({
  page,
}) => {
  const fixtures = await installOfflineWorkspaceFixtures(page, {
    mode: "empty",
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { level: 3, name: "Pilih proyek untuk mulai" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pesan" })).toBeDisabled();
  await page.getByRole("button", { name: "Riwayat" }).click();
  await expect(
    page.getByRole("button", { name: "Percakapan baru", exact: true }),
  ).toBeDisabled();

  fixtures.state.mode = "disconnected";
  await page.reload();
  await expect(page.locator("#active-project")).toHaveValue(projectId);
  await expect(
    page
      .getByRole("status")
      .getByText("Hubungkan Senopati dan Codex untuk mulai."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Kirim pesan" }),
  ).toBeDisabled();
  await expect(page.getByRole("link", { name: "Atur Senopati" })).toBeVisible();
  expect(fixtures.unexpectedApiRequests).toEqual([]);
});

test("keeps the active conversation header inside narrow viewports", async ({
  page,
}) => {
  const fixtures = await installOfflineWorkspaceFixtures(page);
  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.goto("/workspace");
  const header = page
    .getByTestId("workspace-chat-panel")
    .locator("header")
    .first();
  await expect(
    header.getByRole("heading", { name: "Percakapan baru" }),
  ).toBeVisible();

  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="workspace-chat-panel"]',
      );
      const header = panel?.querySelector<HTMLElement>("header");
      const title = header?.querySelector<HTMLElement>("h2");
      const status = header?.children.item(1);
      if (!panel || !header || !title || !status) {
        throw new Error("The active conversation header is incomplete.");
      }
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          top: Math.round(bounds.top),
          bottom: Math.round(bounds.bottom),
          width: Math.round(bounds.width),
        };
      };
      return {
        viewportWidth,
        documentWidth: document.documentElement.scrollWidth,
        panel: rect(panel),
        header: rect(header),
        title: rect(title),
        status: rect(status),
        compactHeader: viewportWidth <= 640,
      };
    });

    expect(
      dimensions.documentWidth,
      `Workspace at ${width}px should not overflow: ${JSON.stringify(dimensions)}`,
    ).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(
      dimensions.header.right,
      `conversation header at ${width}px should fit the viewport: ${JSON.stringify(dimensions)}`,
    ).toBeLessThanOrEqual(dimensions.viewportWidth);
    if (dimensions.compactHeader) {
      expect(
        dimensions.title.bottom,
        `conversation title at ${width}px should stay above its actions: ${JSON.stringify(dimensions)}`,
      ).toBeLessThanOrEqual(dimensions.status.top);
    } else {
      expect(
        dimensions.title.right,
        `conversation title at ${width}px should stay before its status: ${JSON.stringify(dimensions)}`,
      ).toBeLessThanOrEqual(dimensions.status.left);
    }
  }

  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "r1-conversation-integrity-390.png"),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });
  await expect(header.locator(".chatHeaderStatus")).toBeHidden();
  await expect(header.getByRole("button", { name: "Konteks" })).toBeVisible();
  expect(fixtures.unexpectedApiRequests).toEqual([]);
});
