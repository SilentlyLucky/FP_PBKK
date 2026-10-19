import { expect, test, type Page } from "@playwright/test";

const codexProvider = {
  provider: "codex_app_server",
  role: "target",
  status: "configured_unverified",
  requestedModel: null,
  responseModel: null,
  endpointLabel: "Codex CLI · app-server stdio",
  checkedAt: null,
  reason: "Login Codex tersedia untuk akun ini.",
  capabilities: {},
};

const codexModel = { id: "gpt-5.6", displayName: "GPT-5.6" };

async function installStrictApiFallback(page: Page) {
  const unexpectedRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname.endsWith("/workspace/roots")
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          roots: [],
          canChooseDirectory: true,
          runtimeAvailable: false,
          unavailableReason: "not_configured",
        }),
      });
      return;
    }
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unexpected settings fixture request" }),
    });
  });
  return unexpectedRequests;
}

async function mockProjects(page: Page, active: boolean) {
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        projects: active
          ? [{ id: "project-1", name: "Test project", objective: null }]
          : [],
      }),
    });
  });
}

async function mockWorkspaceStatus(page: Page, projectId: string) {
  await page.route(`**/api/projects/${projectId}/workspace`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        projectConfigured: false,
        databaseConfigured: false,
        writeAvailable: false,
        reason: "not_configured",
        grantDurationSeconds: null,
        writeGrantDurationSeconds: null,
      }),
    });
  });
}

async function mockProviderGet(
  page: Page,
  projectPrerequisite: "satisfied" | "missing",
  codexModels: Array<{ id: string; displayName: string }>,
  verified = false,
) {
  await page.route("**/api/providers**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          verified
            ? {
                ...codexProvider,
                status: "verified",
                requestedModel: codexModel.id,
              }
            : codexProvider,
        ],
        codexModels,
        projectPrerequisite,
      }),
    });
  });
}

test("provider verification needs a project and links to project creation", async ({
  page,
}) => {
  const unexpectedRequests = await installStrictApiFallback(page);
  await mockProjects(page, false);
  await mockProviderGet(page, "missing", [codexModel]);
  await page.goto("/settings");

  const verify = page.getByRole("button", { name: "Verifikasi Codex" });
  await expect(verify).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Buat proyek di Overview" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Buat proyek di Overview" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Buat proyek" })).toBeEnabled();
  expect(unexpectedRequests).toEqual([]);
});

test("does not offer another verification for the already verified model", async ({
  page,
}) => {
  const unexpectedRequests = await installStrictApiFallback(page);
  await mockProjects(page, true);
  await mockProviderGet(page, "satisfied", [codexModel], true);
  await mockWorkspaceStatus(page, "project-1");
  await page.goto("/settings");

  await expect(
    page.getByText("Codex terverifikasi", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Model terpilih sudah terverifikasi dan dapat digunakan tanpa verifikasi baru.",
    ),
  ).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test("a lost Codex login session unlocks Login without inference", async ({
  page,
}) => {
  const unexpectedRequests = await installStrictApiFallback(page);
  await mockProjects(page, true);
  await mockWorkspaceStatus(page, "project-1");
  const actions: string[] = [];
  let releaseStatusPoll: (() => void) | undefined;
  let onStatusPollStarted: (() => void) | undefined;
  const statusPollStarted = new Promise<void>((resolve) => {
    onStatusPollStarted = resolve;
  });
  const statusPollBlocked = new Promise<void>((resolve) => {
    releaseStatusPoll = resolve;
  });

  await page.route("**/api/providers**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          providers: [codexProvider],
          codexModels: [codexModel],
          projectPrerequisite: "satisfied",
        }),
      });
      return;
    }

    const body = request.postDataJSON() as { action: string };
    actions.push(body.action);
    if (body.action === "codex-login-start") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "login_started",
          login: {
            loginId: "login-1",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "TEST-CODE",
            status: "pending",
          },
        }),
      });
      return;
    }
    if (body.action === "codex-login-status") {
      onStatusPollStarted?.();
      await statusPollBlocked;
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "login_expired",
          message: "Sesi login sudah berakhir.",
        }),
      });
      return;
    }
    await route.fulfill({ status: 500, body: "Unexpected mocked action" });
  });

  await page.goto("/settings");
  const login = page.getByRole("button", { name: "Login Codex" });
  await login.click();
  await expect(page.getByText("TEST-CODE", { exact: true })).toBeVisible();
  await expect(login).toBeDisabled();
  await statusPollStarted;

  releaseStatusPoll?.();
  await expect(
    page.getByRole("alert").filter({ hasText: "Sesi login Codex berakhir" }),
  ).toBeVisible();
  await expect(login).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Verifikasi Codex" }),
  ).toBeDisabled();
  expect(actions).toEqual(["codex-login-start", "codex-login-status"]);
  expect(unexpectedRequests).toEqual([]);
});

test("transient login polling errors stop after three harmless polls", async ({
  page,
}) => {
  const unexpectedRequests = await installStrictApiFallback(page);
  await mockProjects(page, true);
  await mockWorkspaceStatus(page, "project-1");
  let statusPolls = 0;
  let inferenceCalls = 0;

  await page.route("**/api/providers**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          providers: [codexProvider],
          codexModels: [codexModel],
          projectPrerequisite: "satisfied",
        }),
      });
      return;
    }

    const body = request.postDataJSON() as { action: string };
    if (body.action === "codex-login-start") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "login_started",
          login: {
            loginId: "login-2",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "TEST-ERROR",
            status: "pending",
          },
        }),
      });
      return;
    }
    if (body.action === "codex-login-status") {
      statusPolls += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (body.action === "codex-verify") inferenceCalls += 1;
    await route.fulfill({ status: 500, body: "Unexpected mocked action" });
  });

  await page.goto("/settings");
  const login = page.getByRole("button", { name: "Login Codex" });
  await login.click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Status login Codex tidak dapat diperiksa",
    }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(login).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Verifikasi Codex" }),
  ).toBeDisabled();
  expect(statusPolls).toBe(3);
  expect(inferenceCalls).toBe(0);
  expect(unexpectedRequests).toEqual([]);
});
