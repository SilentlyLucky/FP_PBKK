import { createHash } from "node:crypto";

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  expectActiveProjectId,
  selectProjectById,
} from "./helpers/project-picker";

const projectA = "project-local-review-a";
const projectB = "project-local-review-b";
const originalContent = "# Project guide\nCurrent local policy";
const proposedContent = "# Project guide\nRevised local policy";
const conflictContent = "# Project guide\nUpdated while review was open";

function hashContent(content: string): string {
  return createHash("sha256")
    .update(new TextEncoder().encode(content))
    .digest("hex");
}

type FixtureOptions = {
  readExpiryMs?: number;
  conflictOnApprove?: boolean;
};

type FixtureState = {
  unexpectedRequests: string[];
  grants: Array<{ projectId: string; grantId: string; access: string }>;
  revokedGrants: string[];
  patchActions: Array<{
    action: string;
    grantId: string;
    patchId: string;
    body: Record<string, unknown>;
  }>;
  evaluationActions: Array<{
    grantId: string;
    patchId: string;
    body: Record<string, unknown>;
  }>;
  patchCreateBodies: Array<Record<string, unknown>>;
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

function patchRecord(
  patchId: string,
  beforeContent: string,
  nextContent: string,
  status: "proposed" | "approved" | "rejected" | "rolled_back" = "proposed",
) {
  return {
    patchId,
    path: "docs/notes.md",
    status,
    beforeHash: hashContent(beforeContent),
    afterHash: hashContent(nextContent),
    createdAt: "2026-10-16T10:00:00.000Z",
    expiresAt: "2026-10-16T10:15:00.000Z",
    approvedAt: status === "approved" ? "2026-10-16T10:01:00.000Z" : null,
    rolledBackAt: status === "rolled_back" ? "2026-10-16T10:02:00.000Z" : null,
    beforeContent,
    proposedContent: nextContent,
    diff: "--- before\n+++ after\n-Current local policy\n+Revised local policy",
    diffRows: [
      { before: "# Project guide", proposed: "# Project guide" },
      { before: "Current local policy", proposed: "Revised local policy" },
    ],
    diffTruncated: false,
  };
}

async function installLocalReviewFixtures(
  page: Page,
  options: FixtureOptions = {},
): Promise<FixtureState> {
  const fixture: FixtureState = {
    unexpectedRequests: [],
    grants: [],
    revokedGrants: [],
    patchActions: [],
    evaluationActions: [],
    patchCreateBodies: [],
  };
  let grantCounter = 0;
  let patchCounter = 0;
  let latestContent = originalContent;
  const conversationsByProject = new Map<
    string,
    Array<Record<string, unknown>>
  >();

  await page.addInitScript((activeProjectId) => {
    window.localStorage.setItem("promptlab.activeProjectId", activeProjectId);
  }, projectA);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/projects" && method === "GET") {
      return json(route, {
        projects: [
          { id: projectA, name: "Local review A", objective: null },
          { id: projectB, name: "Local review B", objective: null },
        ],
      });
    }
    if (path === "/api/providers" && method === "GET") {
      return json(route, { providers: [], codexModels: [] });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const projectId = projectMatch[1]!;
      const suffix = projectMatch[2] ?? "";

      if (suffix === "workspace/conversations" && method === "GET") {
        return json(route, {
          conversations: conversationsByProject.get(projectId) ?? [],
        });
      }
      if (suffix === "workspace/conversations" && method === "PUT") {
        const body = request.postDataJSON() as {
          conversations?: Array<Record<string, unknown>>;
        };
        conversationsByProject.set(projectId, body.conversations ?? []);
        return json(route, {
          saved: conversationsByProject.get(projectId)?.length ?? 0,
        });
      }
      const conversationMatch = suffix.match(
        /^workspace\/conversations\/([^/]+)$/,
      );
      if (conversationMatch && method === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const conversations = conversationsByProject.get(projectId) ?? [];
        const index = conversations.findIndex(
          (conversation) => conversation.id === conversationMatch[1],
        );
        if (index < 0) conversations.unshift(body);
        else conversations[index] = body;
        conversationsByProject.set(projectId, conversations);
        return json(route, { saved: true });
      }
      if (conversationMatch && method === "DELETE") {
        const conversations = conversationsByProject.get(projectId) ?? [];
        const index = conversations.findIndex(
          (conversation) => conversation.id === conversationMatch[1],
        );
        if (index >= 0) conversations.splice(index, 1);
        conversationsByProject.set(projectId, conversations);
        return json(route, { deleted: true });
      }

      if (suffix === "knowledge" && method === "GET") {
        return json(route, {
          projectId,
          readiness: {},
          sources: [],
          builds: [],
          assertions: [],
        });
      }
      if (suffix === "runs" && method === "GET") {
        return json(route, { runs: [] });
      }
      if (suffix === "clarifications" && method === "GET") {
        return json(route, { projectId, clarifications: [] });
      }
      if (suffix === "prompts" && method === "GET") {
        return json(route, { prompts: [] });
      }
      if (suffix === "workspace" && method === "GET") {
        return json(route, {
          projectConfigured: true,
          writeAvailable: true,
          grantDurationSeconds: 900,
          writeGrantDurationSeconds: 300,
          isolatedEvaluation: {
            executionAvailable: true,
            reasonCode: null,
            tests: [
              {
                id: "review-check",
                label: "Review check",
                available: true,
              },
            ],
          },
          reason: null,
        });
      }
      if (suffix === "workspace/roots" && method === "GET") {
        return json(route, {
          roots: [
            {
              rootId: `environment:${projectId}`,
              displayName: "Folder proyek lokal",
              source: "environment",
              available: true,
              createdAt: null,
            },
          ],
          canChooseDirectory: true,
          runtimeAvailable: true,
          unavailableReason: null,
        });
      }

      const workspacePrefix = "workspace/grants";
      if (suffix === workspacePrefix && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        expect(body).toEqual({ approval: "read_only_project_root" });
        const grantId = `read-grant-${projectId}-${++grantCounter}`;
        fixture.grants.push({ projectId, grantId, access: "read" });
        return json(
          route,
          {
            grantId,
            expiresAt: new Date(
              Date.now() + (options.readExpiryMs ?? 300_000),
            ).toISOString(),
          },
          201,
        );
      }
      if (suffix === `${workspacePrefix}/write` && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        expect(body).toEqual({ approval: "workspace_write_project_root" });
        const grantId = `write-grant-${projectId}-${++grantCounter}`;
        fixture.grants.push({ projectId, grantId, access: "write" });
        return json(
          route,
          {
            grantId,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
          201,
        );
      }

      const grantMatch = suffix.match(
        /^workspace\/grants\/([^/]+)(?:\/(.*))?$/,
      );
      if (grantMatch) {
        const grantId = grantMatch[1]!;
        const grantPath = grantMatch[2] ?? "";
        if (!grantPath && method === "DELETE") {
          fixture.revokedGrants.push(grantId);
          return json(route, { revoked: true });
        }
        if (grantPath === "list" && method === "GET") {
          const listedPath = url.searchParams.get("path") ?? "";
          return json(route, {
            path: listedPath,
            entries: listedPath
              ? [{ name: "notes.md", path: "docs/notes.md", kind: "file" }]
              : [{ name: "docs", path: "docs", kind: "directory" }],
            truncated: false,
          });
        }
        if (grantPath === "read" && method === "GET") {
          const pathValue = url.searchParams.get("path") ?? "";
          return json(route, {
            path: pathValue,
            bytes: new TextEncoder().encode(latestContent).byteLength,
            content: latestContent,
            contentHash: hashContent(latestContent),
          });
        }

        const patchCollectionMatch = grantPath.match(/^patches$/);
        if (patchCollectionMatch && method === "POST") {
          const body = request.postDataJSON() as Record<string, unknown>;
          fixture.patchCreateBodies.push(body);
          const nextContent = String(body.content ?? "");
          const proposal = patchRecord(
            `patch-${++patchCounter}`,
            latestContent,
            nextContent,
          );
          return json(route, proposal, 201);
        }

        const evaluationMatch = grantPath.match(
          /^patches\/([^/]+)\/evaluate$/,
        );
        if (evaluationMatch && method === "POST") {
          const body = request.postDataJSON() as Record<string, unknown>;
          const patchId = evaluationMatch[1]!;
          fixture.evaluationActions.push({ grantId, patchId, body });
          return json(route, {
            status: "completed",
            reasonCode: null,
            assessment: "candidate_improved",
            commandId: "review-check",
            commandLabel: "Review check",
            startingSnapshotHash: "1".repeat(64),
            baselineSnapshotHash: "1".repeat(64),
            candidateSnapshotHash: "2".repeat(64),
            filesPerSnapshot: 4,
            bytesPerSnapshot: 128,
            entriesExcludedByPolicy: 1,
            baseline: {
              status: "completed",
              exitCode: 1,
              signal: null,
              stdout: "baseline test failed\n",
              stderr: "",
              durationMs: 21,
              reasonCode: null,
            },
            candidate: {
              status: "completed",
              exitCode: 0,
              signal: null,
              stdout: "candidate test passed\n",
              stderr: "",
              durationMs: 23,
              reasonCode: null,
            },
          });
        }

        const patchActionMatch = grantPath.match(
          /^patches\/([^/]+)\/(approve|reject|rollback)$/,
        );
        if (patchActionMatch && method === "POST") {
          const patchId = patchActionMatch[1]!;
          const action = patchActionMatch[2]!;
          const body = request.postDataJSON() as Record<string, unknown>;
          fixture.patchActions.push({ action, grantId, patchId, body });
          if (action === "approve" && options.conflictOnApprove) {
            latestContent = conflictContent;
            return json(
              route,
              {
                error: "PATCH_CONFLICT",
                code: "PATCH_CONFLICT",
                message: "File berubah pada fixture selama review.",
              },
              409,
            );
          }
          if (action === "reject") {
            return json(
              route,
              patchRecord(patchId, latestContent, proposedContent, "rejected"),
            );
          }
          if (action === "approve") {
            latestContent = proposedContent;
            return json(route, {
              patch: patchRecord(
                patchId,
                originalContent,
                proposedContent,
                "approved",
              ),
              repeated: false,
            });
          }
          latestContent = originalContent;
          return json(route, {
            patch: patchRecord(
              patchId,
              originalContent,
              proposedContent,
              "rolled_back",
            ),
            repeated: false,
          });
        }
      }
    }

    fixture.unexpectedRequests.push(`${method} ${path}`);
    return json(
      route,
      { error: "Unexpected local file review fixture request" },
      501,
    );
  });

  return fixture;
}

async function grantReadAndOpenFile(page: Page) {
  await page
    .getByLabel("Saya meminta akses baca sementara ke folder proyek ini.")
    .check();
  await page.getByRole("button", { name: "Izinkan baca" }).click();
  await page.getByRole("button", { name: "docs" }).click();
  await page.getByRole("button", { name: "notes.md" }).click();
  await expect(page.getByText("Current local policy")).toBeVisible();
}

async function openLocalReview(page: Page) {
  const contextToggle = page
    .getByTestId("workspace-chat-panel")
    .getByRole("button", { name: "Konteks", exact: true });
  if ((await contextToggle.getAttribute("aria-expanded")) !== "true") {
    await contextToggle.click();
  }
  const contextPanel = page.getByRole("complementary", {
    name: "Konteks percakapan",
  });
  await expect(contextPanel).toBeVisible();
  await contextPanel
    .locator("summary")
    .filter({ hasText: "Tinjau usulan file" })
    .click();
  await expect(page.getByRole("heading", { name: "Tinjau file" })).toBeVisible();
}

async function grantWrite(page: Page) {
  await page
    .getByLabel(
      "Saya ingin mengusulkan perubahan file dan mengizinkan penerapan setelah saya menyetujui diff.",
    )
    .check();
  await page.getByRole("button", { name: "Izinkan edit 5 menit" }).click();
  await expect(
    page.getByRole("button", { name: "Hentikan izin tulis" }),
  ).toBeVisible();
}

async function createProposal(page: Page, fixture: FixtureState) {
  await page.getByRole("button", { name: "Edit teks sendiri" }).click();
  await page.getByLabel("Teks usulan").fill(proposedContent);
  await page
    .getByRole("button", { name: "Buat usulan untuk ditinjau" })
    .click();
  await expect(
    page.getByRole("region", { name: "Usulan perubahan file" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Perbandingan isi sebelum dan sesudah" }),
  ).toContainText("Current local policy");
  await expect(
    page.getByRole("table", { name: "Perbandingan isi sebelum dan sesudah" }),
  ).toContainText("Revised local policy");
  expect(
    fixture.patchCreateBodies[fixture.patchCreateBodies.length - 1],
  ).toEqual({
    path: "docs/notes.md",
    content: proposedContent,
    source: "user_editor",
    expectedBeforeHash: hashContent(originalContent),
  });
}

test("grants local file access, rejects a proposal, approves a diff, and rolls it back", async ({
  page,
}) => {
  const fixture = await installLocalReviewFixtures(page);
  await page.goto("/workspace");
  await openLocalReview(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await expect(page.getByText("Folder diizinkan")).toBeVisible();

  await grantReadAndOpenFile(page);
  await grantWrite(page);

  await createProposal(page, fixture);
  await page.getByRole("button", { name: "Tolak usulan" }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Usulan ditolak. File asli belum diubah.",
    }),
  ).toBeVisible();
  await expect(page.getByText(originalContent)).toBeVisible();

  await createProposal(page, fixture);
  await page.getByRole("button", { name: "Setujui dan terapkan" }).click();
  await expect(
    page.getByText("Perubahan pada docs/notes.md diterapkan."),
  ).toBeVisible();
  await expect(page.getByText("Diterapkan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pulihkan versi sebelumnya" }).click();
  await expect(
    page.getByText("Versi sebelumnya untuk docs/notes.md dipulihkan."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tutup tinjauan" }).click();
  await expect(page.getByText("Current local policy")).toBeVisible();

  expect(fixture.patchActions.map(({ action }) => action)).toEqual([
    "reject",
    "approve",
    "rollback",
  ]);
  expect(fixture.patchActions.map(({ body }) => body)).toEqual([
    { decision: "reject_patch" },
    { approval: "apply_exact_patch" },
    { approval: "restore_exact_before_bytes" },
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
}, { timeout: 60_000 });

test("rejects a conflicted local proposal and reloads the changed file", async ({
  page,
}) => {
  const fixture = await installLocalReviewFixtures(page, {
    conflictOnApprove: true,
  });
  await page.goto("/workspace");
  await openLocalReview(page);
  await expect(page.getByText("Folder diizinkan")).toBeVisible();
  await grantReadAndOpenFile(page);
  await grantWrite(page);
  await createProposal(page, fixture);

  await page.getByRole("button", { name: "Setujui dan terapkan" }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "File berubah setelah usulan dibuat. Usulan lama tidak diterapkan",
    }),
  ).toBeVisible();
  await expect(page.getByText(conflictContent)).toBeVisible();
  expect(fixture.patchActions.map(({ action }) => action)).toEqual([
    "approve",
    "reject",
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("evaluates a proposed patch using the server test ID and shows both results", async ({
  page,
}) => {
  const fixture = await installLocalReviewFixtures(page);
  await page.goto("/workspace");
  await openLocalReview(page);
  await grantReadAndOpenFile(page);
  await grantWrite(page);
  await createProposal(page, fixture);

  await page.getByRole("button", { name: "Jalankan evaluasi" }).click();
  await expect(
    page.getByRole("heading", { name: "Kandidat lolos; baseline gagal" }),
  ).toBeVisible();
  await expect(page.getByText("baseline test failed")).toBeHidden();
  await page.getByText("Lihat output tes").last().click();
  await expect(page.getByText("candidate test passed")).toBeVisible();
  await page.getByText("Lihat output tes").first().click();
  await expect(page.getByText("baseline test failed")).toBeVisible();
  expect(fixture.evaluationActions).toEqual([
    {
      grantId: fixture.grants.find((grant) => grant.access === "write")
        ?.grantId,
      patchId: "patch-1",
      body: { testId: "review-check" },
    },
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("expires read grants and clears permissions and file content on project switch", async ({
  page,
}) => {
  const fixture = await installLocalReviewFixtures(page, {
    readExpiryMs: 1_200,
  });
  await page.goto("/workspace");
  await openLocalReview(page);
  await expect(page.getByText("Folder diizinkan")).toBeVisible();
  await grantReadAndOpenFile(page);
  await expect(
    page.getByLabel("Saya meminta akses baca sementara ke folder proyek ini."),
  ).toBeVisible({ timeout: 10_000 });
  expect(fixture.revokedGrants).toContain(fixture.grants[0]?.grantId);
  await expect(page.getByText("Current local policy")).toHaveCount(0);

  // Obtain a fresh, longer grant pair and prove a project change clears it.
  await page
    .getByLabel("Saya meminta akses baca sementara ke folder proyek ini.")
    .check();
  await page.getByRole("button", { name: "Izinkan baca" }).click();
  await grantWrite(page);
  const activeGrants = fixture.grants.slice(-2);
  await selectProjectById(page, projectB);
  await expectActiveProjectId(page, projectB);
  await expect(page.getByText("Folder diizinkan")).toBeVisible();
  await expect(
    page.getByLabel("Saya meminta akses baca sementara ke folder proyek ini."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hentikan izin baca" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Hentikan izin tulis" }),
  ).toHaveCount(0);
  await expect
    .poll(() => fixture.revokedGrants)
    .toEqual(
      expect.arrayContaining(activeGrants.map(({ grantId }) => grantId)),
    );
  expect(fixture.unexpectedRequests).toEqual([]);
});
