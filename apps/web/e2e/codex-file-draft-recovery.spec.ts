import { createHash } from "node:crypto";

import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "project-codex-file-draft-recovery";
const filePath = "docs/notes.md";
const originalContent = "# Project guide\nCurrent local policy";
const taskText = "Perjelas kebijakan lokal.";
const runId = "run-codex-file-draft-recovery";
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

interface RecoveryFixture {
  promptBodies: Array<Record<string, unknown>>;
  runBodies: Array<Record<string, unknown>>;
  runLookups: number;
  unexpectedRequests: string[];
}

async function installRecoveryFixtures(
  page: Page,
  eventMode: "running" | "interrupted_unknown" = "running",
): Promise<RecoveryFixture> {
  const fixture: RecoveryFixture = {
    promptBodies: [],
    runBodies: [],
    runLookups: 0,
    unexpectedRequests: [],
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
          { id: projectId, name: "Codex recovery fixture", objective: null },
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
        if (url.searchParams.has("idempotencyKey")) {
          fixture.runLookups += 1;
          return json(route, { error: "RUN_NOT_FOUND" }, 404);
        }
        return json(route, { runs: [] });
      }
      if (suffix === "runs" && method === "POST") {
        fixture.runBodies.push(
          request.postDataJSON() as Record<string, unknown>,
        );
        return json(route, { run: { id: runId, status: "queued" } }, 201);
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
              id: "prompt-codex-file-draft-recovery",
              name: body.name,
              currentVersionId: "prompt-version-codex-file-draft-recovery",
              version: 1,
              text: body.text,
              invariants: [],
            },
          },
          201,
        );
      }

      const eventsMatch = suffix.match(/^runs\/([^/]+)\/events$/);
      if (eventsMatch && method === "GET") {
        const eventType =
          eventMode === "interrupted_unknown" ? "run.failed" : "run.status";
        const status =
          eventMode === "interrupted_unknown"
            ? "interrupted_unknown"
            : "running";
        const event = {
          id: "draft-recovery-status",
          sequence: 1,
          timestamp: "2026-10-17T00:00:01.000Z",
          eventType,
          payload: {
            status,
            ...(eventMode === "interrupted_unknown"
              ? { errorCode: "PROCESS_INTERRUPTED" }
              : {}),
          },
        };
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          },
          body:
            "id: 1\nevent: " +
            eventType +
            "\ndata: " +
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
            grantId: "read-grant-codex-file-draft-recovery",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
          201,
        );
      }
      if (suffix === "workspace/grants/write" && method === "POST") {
        return json(
          route,
          {
            grantId: "write-grant-codex-file-draft-recovery",
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
            bytes: new TextEncoder().encode(originalContent).byteLength,
            content: originalContent,
            contentHash: sha256(originalContent),
          });
        }
      }
    }

    fixture.unexpectedRequests.push(method + " " + path);
    return json(
      route,
      { error: "Unexpected Codex recovery fixture request" },
      501,
    );
  });

  return fixture;
}

async function seedStalePendingRun(page: Page) {
  await page.addInitScript((activeProjectId) => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const pending = {
      version: 1,
      context: {
        projectId: activeProjectId,
        path: "docs/notes.md",
        snapshotHash: "b".repeat(64),
        readGrantId: "read-grant-codex-file-draft-recovery",
        readGrantExpiresAt: expiresAt,
        writeGrantId: "write-grant-codex-file-draft-recovery",
        writeGrantExpiresAt: expiresAt,
      },
      request: {
        projectId: activeProjectId,
        promptVersionId: "prompt-version-from-pending-run",
        provider: "codex_app_server",
        requestedModel: "gpt-5.6-codex",
        purpose: "target",
        intent: "workspace_file_draft",
        idempotencyKey: "draft-run-recovery-key-0001",
        retrieval: { strategy: "lexical", sourceIds: [] },
        workspaceFileDraft: {
          format: "promptlab-workspace-file-draft-run-v1",
          path: "docs/notes.md",
          snapshotHash: "b".repeat(64),
          readGrantId: "read-grant-codex-file-draft-recovery",
          writeGrantId: "write-grant-codex-file-draft-recovery",
          taskOptimizationConsent: true,
        },
      },
    };
    window.sessionStorage.setItem(
      "promptlab.codex-file-draft.pending.v1:" + activeProjectId,
      JSON.stringify(pending),
    );
  }, projectId);
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

async function submitDraft(page: Page) {
  await page.getByLabel("Tugas untuk Codex").fill(taskText);
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
}

test("does not repost a stale pending request after RUN_NOT_FOUND", async ({
  page,
}) => {
  const fixture = await installRecoveryFixtures(page);
  await seedStalePendingRun(page);
  await page.goto("/workspace");
  await openSelectedFile(page);

  await page
    .getByRole("button", { name: "Periksa status run yang sama" })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Snapshot file berubah saat Codex menjawab." }),
  ).toContainText("Snapshot file berubah");

  expect(fixture.runLookups).toBe(1);
  expect(fixture.runBodies).toHaveLength(0);
  expect(fixture.promptBodies).toHaveLength(0);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("keeps an accepted active run locked across a page remount", async ({
  page,
}) => {
  const fixture = await installRecoveryFixtures(page);
  await page.goto("/workspace");
  await openSelectedFile(page);
  await submitDraft(page);
  await expect(page.getByLabel("Tugas untuk Codex")).toBeDisabled();
  await expect.poll(() => fixture.runBodies.length).toBe(1);

  await expect
    .poll(async () =>
      page.evaluate(
        (activeProjectId) =>
          window.sessionStorage.getItem(
            "promptlab.codex-file-draft.active.v1:" + activeProjectId,
          ),
        projectId,
      ),
    )
    .toContain(runId);
  const storedActive = await page.evaluate((activeProjectId) => {
    return window.sessionStorage.getItem(
      "promptlab.codex-file-draft.active.v1:" + activeProjectId,
    );
  }, projectId);
  expect(storedActive).toContain("prompt-version-codex-file-draft-recovery");
  expect(storedActive).not.toContain(taskText);
  expect(storedActive).not.toContain(originalContent);

  await page.reload();
  await openSelectedFile(page);
  await expect(page.getByLabel("Tugas untuk Codex")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Minta pembatalan" }),
  ).toBeVisible();
  expect(fixture.runBodies).toHaveLength(1);
  expect(fixture.promptBodies).toHaveLength(1);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("keeps input locked after interrupted_unknown without creating another key", async ({
  page,
}) => {
  const fixture = await installRecoveryFixtures(page, "interrupted_unknown");
  await page.goto("/workspace");
  await openSelectedFile(page);
  await submitDraft(page);

  await expect(
    page.getByRole("alert").filter({ hasText: "Hasil run belum diketahui" }),
  ).toContainText("Hasil run belum diketahui");
  await expect(page.getByLabel("Tugas untuk Codex")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Draf dengan Codex" }),
  ).toHaveCount(0);

  const storedActive = await page.evaluate((activeProjectId) => {
    return window.sessionStorage.getItem(
      "promptlab.codex-file-draft.active.v1:" + activeProjectId,
    );
  }, projectId);
  expect(storedActive).toContain("interrupted_unknown");
  expect(fixture.runBodies).toHaveLength(1);
  expect(fixture.unexpectedRequests).toEqual([]);
});
