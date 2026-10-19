import { createHash } from "node:crypto";

import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

const projectId = "project-codex-file-draft";
const filePath = "docs/notes.md";
const originalContent = "# Project guide\nCurrent local policy";
const draftedContent = "# Project guide\nRevised local policy";
const changedContent = "# Project guide\nUpdated during Codex";
const runId = "run-codex-file-draft";
const modelId = "gpt-5.6-codex";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

function provider() {
  return {
    provider: "codex_app_server",
    role: "target",
    status: "verified",
    requestedModel: modelId,
    responseModel: modelId,
    endpointLabel: "Codex CLI · app-server stdio",
    checkedAt: "2026-10-17T00:00:00.000Z",
    reason: "Verified fixture target",
    capabilities: {},
  };
}

function optimizerProvider() {
  return {
    provider: "campus_gateway",
    role: "optimizer",
    status: "verified",
    requestedModel: "senopati-qa",
    responseModel: "senopati-qa",
    endpointLabel: "Senopati · verified fixture",
    checkedAt: "2026-10-17T00:00:00.000Z",
    reason: "Verified fixture optimizer",
    capabilities: {},
  };
}

function patchRecord(
  patchId: string,
  before: string,
  after: string,
  beforeHash: string,
  afterHash: string,
  status: "proposed" | "approved" = "proposed",
) {
  return {
    patchId,
    path: filePath,
    status,
    beforeHash,
    afterHash,
    createdAt: "2026-10-17T00:00:00.000Z",
    expiresAt: "2026-10-17T00:15:00.000Z",
    approvedAt: status === "approved" ? "2026-10-17T00:01:00.000Z" : null,
    rolledBackAt: null,
    beforeContent: before,
    proposedContent: after,
    diff: "--- before\n+++ after\n-Current local policy\n+Revised local policy",
    diffRows: [
      { before: "# Project guide", proposed: "# Project guide" },
      {
        before: before.split("\n").at(-1) ?? "",
        proposed: after.split("\n").at(-1) ?? "",
      },
    ],
    diffTruncated: false,
  };
}

async function renderedContrast(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    function parseColor(value: string): [number, number, number, number] {
      const channels = value.match(/[\d.]+/gu)?.map(Number);
      if (!channels || channels.length < 3) {
        throw new Error("Could not read rendered color: " + value);
      }
      return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1];
    }

    function luminance(color: [number, number, number, number]) {
      const channels = color.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      );
    }

    const foreground = parseColor(getComputedStyle(element).color);
    let ancestor: Element | null = element;
    let background: [number, number, number, number] | null = null;
    while (ancestor) {
      const candidate = parseColor(getComputedStyle(ancestor).backgroundColor);
      if (candidate[3] > 0) {
        background = candidate;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (!background)
      throw new Error("Could not find an opaque text background");
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
  });
}

interface DraftFixture {
  unexpectedRequests: string[];
  promptBodies: Array<Record<string, unknown>>;
  runBodies: Array<Record<string, unknown>>;
  patchBodies: Array<Record<string, unknown>>;
  patchActions: string[];
  idempotencyLookups: string[];
  get currentContent(): string;
  changeCurrentContent(value: string): void;
}

async function installDraftFixtures(
  page: Page,
  options: { unknownFirstRunCreation?: boolean } = {},
): Promise<DraftFixture> {
  let currentContent = originalContent;
  const fixture: DraftFixture = {
    unexpectedRequests: [],
    promptBodies: [],
    runBodies: [],
    patchBodies: [],
    patchActions: [],
    idempotencyLookups: [],
    get currentContent() {
      return currentContent;
    },
    changeCurrentContent(value) {
      currentContent = value;
    },
  };

  await page.addInitScript((activeProjectId) => {
    window.localStorage.setItem("promptlab.activeProjectId", activeProjectId);
  }, projectId);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/projects" && method === "GET") {
      return json(route, {
        projects: [
          { id: projectId, name: "Codex draft fixture", objective: null },
        ],
      });
    }
    if (path === "/api/providers" && method === "GET") {
      return json(route, {
        providers: [provider(), optimizerProvider()],
        codexModels: [
          {
            id: modelId,
            displayName: "GPT Codex fixture",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ],
      });
    }

    const match = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (match && match[1] === projectId) {
      const suffix = match[2] ?? "";
      if (suffix === "knowledge" && method === "GET") {
        return json(route, { projectId, sources: [], builds: [] });
      }
      if (suffix === "runs" && method === "GET") {
        const idempotencyKey = url.searchParams.get("idempotencyKey");
        if (idempotencyKey) {
          fixture.idempotencyLookups.push(idempotencyKey);
          return json(route, { error: "RUN_NOT_FOUND" }, 404);
        }
        return json(route, { runs: [] });
      }
      if (suffix === "clarifications" && method === "GET") {
        return json(route, { projectId, clarifications: [] });
      }
      if (suffix === "prompts" && method === "GET") {
        return json(route, { prompts: [] });
      }
      if (suffix === "prompts" && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        fixture.promptBodies.push(body);
        return json(
          route,
          {
            prompt: {
              id: "prompt-codex-file-draft",
              name: body.name,
              currentVersionId: "prompt-version-codex-file-draft",
              version: 1,
              text: body.text,
              invariants: [],
            },
          },
          201,
        );
      }
      if (suffix === "runs" && method === "POST") {
        fixture.runBodies.push(
          request.postDataJSON() as Record<string, unknown>,
        );
        if (options.unknownFirstRunCreation && fixture.runBodies.length === 1) {
          return json(
            route,
            { error: "SERVICE_UNAVAILABLE", message: "Run status unknown" },
            503,
          );
        }
        return json(route, { run: { id: runId, status: "queued" } }, 201);
      }
      const eventsMatch = suffix.match(/^runs\/([^/]+)\/events$/);
      if (eventsMatch && method === "GET") {
        const event = {
          id: "draft-completion",
          sequence: 1,
          timestamp: "2026-10-17T00:00:01.000Z",
          eventType: "run.completed",
          payload: {
            status: "succeeded",
            text: draftedContent,
            requestedModel: modelId,
            responseModel: modelId,
          },
        };
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          },
          body:
            "id: 1\nevent: run.completed\ndata: " +
            JSON.stringify(event) +
            "\n\n",
        });
      }

      if (suffix === "workspace" && method === "GET") {
        return json(route, {
          projectConfigured: true,
          writeAvailable: true,
          grantDurationSeconds: 900,
          writeGrantDurationSeconds: 300,
          reason: null,
        });
      }
      if (suffix === "workspace/roots" && method === "GET") {
        return json(route, {
          roots: [],
          canChooseDirectory: true,
          runtimeAvailable: true,
          unavailableReason: null,
        });
      }
      if (suffix === "workspace/grants" && method === "POST") {
        return json(
          route,
          {
            grantId: "read-grant-codex-file-draft",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
          201,
        );
      }
      if (suffix === "workspace/grants/write" && method === "POST") {
        return json(
          route,
          {
            grantId: "write-grant-codex-file-draft",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
          201,
        );
      }

      const grantMatch = suffix.match(
        /^workspace\/grants\/([^/]+)(?:\/(.*))?$/,
      );
      if (grantMatch) {
        const grantPath = grantMatch[2] ?? "";
        if (!grantPath && method === "DELETE") {
          return json(route, { revoked: true });
        }
        if (grantPath === "list" && method === "GET") {
          const listedPath = url.searchParams.get("path") ?? "";
          return json(route, {
            path: listedPath,
            entries: listedPath
              ? [{ name: "notes.md", path: filePath, kind: "file" }]
              : [{ name: "docs", path: "docs", kind: "directory" }],
            truncated: false,
          });
        }
        if (grantPath === "read" && method === "GET") {
          return json(route, {
            path: url.searchParams.get("path") ?? "",
            bytes: new TextEncoder().encode(currentContent).byteLength,
            content: currentContent,
            contentHash: sha256(currentContent),
          });
        }
        if (grantPath === "patches" && method === "POST") {
          const body = request.postDataJSON() as Record<string, unknown>;
          fixture.patchBodies.push(body);
          if (body.expectedBeforeHash !== sha256(currentContent)) {
            return json(
              route,
              {
                error: "PATCH_CONFLICT",
                code: "PATCH_CONFLICT",
                message: "The selected file changed before proposal creation.",
              },
              409,
            );
          }
          const nextContent = String(body.content ?? "");
          return json(
            route,
            patchRecord(
              "patch-codex-file-draft",
              currentContent,
              nextContent,
              sha256(currentContent),
              sha256(nextContent),
            ),
            201,
          );
        }
        const patchAction = grantPath.match(
          /^patches\/([^/]+)\/(approve|reject|rollback)$/,
        );
        if (patchAction && method === "POST") {
          const action = patchAction[2]!;
          fixture.patchActions.push(action);
          if (action === "approve") {
            currentContent = draftedContent;
            return json(route, {
              patch: patchRecord(
                patchAction[1]!,
                originalContent,
                draftedContent,
                sha256(originalContent),
                sha256(draftedContent),
                "approved",
              ),
              repeated: false,
            });
          }
          return json(
            route,
            patchRecord(
              patchAction[1]!,
              currentContent,
              draftedContent,
              sha256(currentContent),
              sha256(draftedContent),
            ),
          );
        }
      }
    }

    fixture.unexpectedRequests.push(method + " " + path);
    return json(
      route,
      { error: "Unexpected Codex file draft fixture request" },
      501,
    );
  });

  return fixture;
}

async function openSelectedFile(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Tinjau file, usulkan, dan jalankan tes" })
    .click();
  await expect(
    page.getByLabel("Saya meminta akses baca sementara ke folder proyek ini."),
  ).toBeVisible();
  await page
    .getByLabel("Saya meminta akses baca sementara ke folder proyek ini.")
    .check();
  await page.getByRole("button", { name: "Izinkan baca" }).click();
  await page.getByRole("button", { name: "docs" }).click();
  await page.getByRole("button", { name: "notes.md" }).click();
  await expect(page.getByText("Current local policy")).toBeVisible();
  await page
    .getByLabel(
      "Saya ingin mengusulkan perubahan file dan mengizinkan penerapan setelah saya menyetujui diff.",
    )
    .check();
  await page.getByRole("button", { name: "Izinkan edit 5 menit" }).click();
  await page.getByRole("button", { name: "Edit teks sendiri" }).click();
}

async function requestDraft(page: Page) {
  await page.getByLabel("Tugas untuk Codex").fill("Perjelas kebijakan lokal.");
  await page
    .getByLabel(
      "Saya setuju mengirim teks tugas saja ke Senopati untuk optimasi.",
    )
    .check();
  await page
    .getByLabel("Saya setuju mengirim teks file terpilih ke Codex.")
    .check();
  await page
    .getByLabel(
      "Saya setuju tugas dan teks file disimpan dalam riwayat proyek.",
    )
    .check();
  await page.getByRole("button", { name: "Draf dengan Codex" }).click();
  await expect(page.getByLabel("Teks usulan")).toHaveValue(draftedContent);
}

test("drafts into the editor, then requires a separate diff and approval", async ({
  page,
}, testInfo) => {
  const fixture = await installDraftFixtures(page);
  await page.goto("/workspace");
  await openSelectedFile(page);
  await requestDraft(page);
  await page.getByText(/Snapshot file saat ini/u).press("Enter");
  await expect(page.getByText(originalContent)).toBeVisible();

  expect(fixture.promptBodies).toHaveLength(1);
  const savedPrompt = String(fixture.promptBodies[0]?.text ?? "");
  expect(savedPrompt).toContain("Perjelas kebijakan lokal.");
  expect(savedPrompt).toContain(JSON.stringify(originalContent));
  expect(savedPrompt).not.toContain(filePath);
  expect(savedPrompt).not.toContain("/home/");
  expect(fixture.runBodies).toHaveLength(1);
  expect(fixture.runBodies[0]).toMatchObject({
    projectId,
    promptVersionId: "prompt-version-codex-file-draft",
    provider: "codex_app_server",
    requestedModel: modelId,
    purpose: "target",
    intent: "workspace_file_draft",
    retrieval: { strategy: "lexical", sourceIds: [] },
    workspaceFileDraft: { taskOptimizationConsent: true },
  });
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.currentContent).toBe(originalContent);
  await page
    .getByRole("region", { name: "Pratinjau file lokal" })
    .screenshot({ path: testInfo.outputPath("codex-file-draft-editor.png") });

  await page
    .getByRole("button", { name: "Buat usulan untuk ditinjau" })
    .click();
  await expect(
    page.getByRole("region", { name: "Usulan perubahan file" }),
  ).toBeVisible();
  expect(fixture.patchBodies[0]).toMatchObject({
    path: filePath,
    content: draftedContent,
    source: "user_editor",
    expectedBeforeHash: sha256(originalContent),
  });
  expect(fixture.patchActions).toHaveLength(0);
  expect(fixture.currentContent).toBe(originalContent);

  await page.getByRole("button", { name: "Setujui dan terapkan" }).click();
  await expect(
    page.getByText("Perubahan pada docs/notes.md diterapkan."),
  ).toBeVisible();
  expect(fixture.patchActions).toEqual(["approve"]);
  expect(fixture.currentContent).toBe(draftedContent);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("keeps the same run key after an unknown response and blocks a fresh draft", async ({
  page,
}) => {
  const fixture = await installDraftFixtures(page, {
    unknownFirstRunCreation: true,
  });
  await page.goto("/workspace");
  await openSelectedFile(page);
  await page.getByLabel("Tugas untuk Codex").fill("Perjelas kebijakan lokal.");
  await page
    .getByLabel(
      "Saya setuju mengirim teks tugas saja ke Senopati untuk optimasi.",
    )
    .check();
  await page
    .getByLabel("Saya setuju mengirim teks file terpilih ke Codex.")
    .check();
  await page
    .getByLabel(
      "Saya setuju tugas dan teks file disimpan dalam riwayat proyek.",
    )
    .check();
  await page.getByRole("button", { name: "Draf dengan Codex" }).click();

  await expect(
    page.getByRole("button", { name: "Periksa status run yang sama" }),
  ).toBeVisible();
  await expect(page.getByLabel("Tugas untuk Codex")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Draf dengan Codex" }),
  ).toHaveCount(0);
  expect(fixture.runBodies).toHaveLength(1);
  const firstRequest = fixture.runBodies[0];
  expect(firstRequest?.idempotencyKey).toEqual(expect.any(String));

  await page
    .getByRole("button", { name: "Periksa status run yang sama" })
    .click();
  await expect(page.getByLabel("Teks usulan")).toHaveValue(draftedContent);
  expect(fixture.idempotencyLookups).toEqual([firstRequest?.idempotencyKey]);
  expect(fixture.runBodies).toHaveLength(2);
  expect(fixture.runBodies[1]).toEqual(firstRequest);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("keeps the draft usable by keyboard and at narrow and wide viewports", async ({
  page,
}) => {
  const fixture = await installDraftFixtures(page);
  await page.goto("/workspace");
  await openSelectedFile(page);

  const draftRegion = page.getByRole("region", {
    name: "Draf teks dengan Codex",
  });
  await expect(draftRegion).toBeVisible();
  await expect(
    draftRegion.getByText(
      "Senopati menerima teks tugas saja untuk optimasi; isi file tidak dikirim kepadanya.",
    ),
  ).toBeVisible();
  const contrastLocators = [
    draftRegion.getByRole("heading", { name: "Draf teks dengan Codex" }),
    draftRegion.getByText(
      "Codex menyiapkan teks untuk editor. Anda tetap meninjau diff.",
    ),
    draftRegion.getByText(/Senopati menerima teks tugas saja/u),
    draftRegion.locator("#codex-file-draft-task-help"),
    draftRegion.getByText(
      "Saya setuju mengirim teks tugas saja ke Senopati untuk optimasi.",
    ),
    draftRegion.getByText("Saya setuju mengirim teks file terpilih ke Codex."),
    draftRegion.getByText(
      "Saya setuju tugas dan teks file disimpan dalam riwayat proyek.",
    ),
  ];
  const contrastRatios: number[] = [];
  for (const locator of contrastLocators) {
    const ratio = await renderedContrast(locator);
    contrastRatios.push(ratio);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  console.info(
    "Rendered Codex draft text contrast ratios:",
    contrastRatios.map((ratio) => ratio.toFixed(2)).join(", "),
  );

  const task = page.getByLabel("Tugas untuk Codex");
  const draftButton = page.getByRole("button", { name: "Draf dengan Codex" });
  for (const width of [320, 360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      draft: document.querySelector<HTMLElement>(
        '[aria-labelledby="codex-file-draft-title"]',
      )?.scrollWidth,
      draftClient: document.querySelector<HTMLElement>(
        '[aria-labelledby="codex-file-draft-title"]',
      )?.clientWidth,
    }));
    expect(
      dimensions.document,
      `page overflow at ${width}px`,
    ).toBeLessThanOrEqual(dimensions.viewport);
    expect(
      dimensions.draft,
      `draft overflow at ${width}px`,
    ).toBeLessThanOrEqual(dimensions.draftClient ?? 0);
    await expect(task).toBeVisible();
  }

  await task.fill("Perjelas kebijakan lokal.");
  await expect(draftButton).toBeDisabled();
  await task.focus();
  await page.keyboard.press("Tab");
  const optimizerConsent = page.getByLabel(
    "Saya setuju mengirim teks tugas saja ke Senopati untuk optimasi.",
  );
  await expect(optimizerConsent).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const sharing = page.getByLabel(
    "Saya setuju mengirim teks file terpilih ke Codex.",
  );
  await expect(sharing).toBeFocused();
  expect(
    await sharing.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const retention = page.getByLabel(
    "Saya setuju tugas dan teks file disimpan dalam riwayat proyek.",
  );
  await expect(retention).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(draftButton).toBeFocused();
  await expect(draftButton).toBeEnabled();
  expect((await draftButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Teks usulan")).toHaveValue(draftedContent);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("rejects a stale snapshot before proposal and keeps the editor text", async ({
  page,
}) => {
  const fixture = await installDraftFixtures(page);
  await page.goto("/workspace");
  await openSelectedFile(page);
  await requestDraft(page);
  fixture.changeCurrentContent(changedContent);

  await page
    .getByRole("button", { name: "Buat usulan untuk ditinjau" })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "File berubah sebelum usulan dibuat. Snapshot terbaru dimuat",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Teks usulan")).toHaveValue(draftedContent);
  await expect(page.getByText(changedContent)).toBeVisible();
  expect(fixture.patchBodies).toHaveLength(1);
  expect(fixture.patchBodies[0]).toMatchObject({
    expectedBeforeHash: sha256(originalContent),
    content: draftedContent,
  });
  expect(fixture.patchActions).toHaveLength(0);
  expect(fixture.currentContent).toBe(changedContent);
  expect(fixture.unexpectedRequests).toEqual([]);
});
