import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const projectId = "4fd7a8a8-1875-4a83-9c01-4d33b607779c";
const sourceId = "8c6cecca-6a08-4738-93ac-6102b62bcf8d";
const importedSourceId = "c9de9bd6-644b-4cd7-adfb-823872559a01";
const grantId = "r2-fixture-read-grant";
const grantExpiry = new Date(Date.now() + 900_000).toISOString();
const screenshots = resolve(process.cwd(), "test-results");

function sourceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: sourceId,
    displayName: "Onboarding guide.md",
    sourceKind: "text_upload",
    permission: "local_only",
    updatedAt: "2026-10-15T10:00:00.000Z",
    deleted: false,
    version: 1,
    versionId: "f73806c8-e4c8-44a9-90cb-4b48f913e819",
    checksum: "a".repeat(64),
    eligible: true,
    contentType: "text/markdown",
    wordCount: 8,
    extractStatus: "ready",
    chunkCount: 1,
    ...overrides,
  };
}

function knowledgeFixture(sources: Array<Record<string, unknown>>) {
  return {
    readiness: {
      documents: {
        total: sources.length,
        eligible: sources.filter((source) => source.eligible).length,
        chunkCount: sources.reduce(
          (total, source) => total + Number(source.chunkCount ?? 0),
          0,
        ),
      },
      snapshot: {
        id: null,
        status: "none",
        buildId: null,
        revision: null,
        activatedAt: null,
      },
      build: { id: null, state: "none" },
      retrieval: {
        status: sources.length ? "lexical_available" : "no_sources",
        backend: "postgres_lexical",
        graphAvailable: false,
        fallback: null,
      },
      indexer: {
        requestedModel: null,
        connectionStatus: "not_configured",
        ready: false,
        reason: "not_configured",
      },
    },
    sources,
    builds: [],
    snapshotId: null,
    assertions: [],
  };
}

async function installStrictApiFallback(page: import("@playwright/test").Page) {
  const unexpectedRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({
      status: 501,
      json: { error: "Unexpected source acceptance fixture request" },
    });
  });
  return unexpectedRequests;
}

async function installProjectFixture(page: import("@playwright/test").Page) {
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        projects: [
          { id: projectId, name: "R2 fixture project", objective: null },
        ],
      },
    });
  });
  await page.route("**/api/providers**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: { providers: [], codexModels: [], projectPrerequisite: "missing" },
    });
  });
}

test("Sumber searches, previews, removes, reads, selects, and imports through APIs", async ({
  page,
}) => {
  await mkdir(screenshots, { recursive: true });
  const unexpectedRequests = await installStrictApiFallback(page);
  await installProjectFixture(page);
  let sources = [
    sourceFixture({
      permission: "campus_indexer_allowed",
      semanticReadiness: {
        documentVersionId: "f73806c8-e4c8-44a9-90cb-4b48f913e819",
        chunkCount: 1,
        staleEmbeddingCount: 0,
        status: "ready",
        reason: null,
        retrievalProfileCompatibility: "not_verified",
        profiles: [
          {
            profileId: "r2-semantic-profile",
            profileChecksum: "c".repeat(64),
            provider: "ollama",
            requestedModel: "embeddinggemma:latest",
            observedModel: "embeddinggemma:latest",
            modelDigest: "d".repeat(64),
            dimensions: 768,
            chunkingVersion: "chunks-v1",
            preprocessingVersion: "identity-v1",
            queryTemplateVersion: "query-v1",
            documentTemplateVersion: "document-v1",
            chunkCount: 1,
            embeddedChunkCount: 1,
            status: "ready",
          },
        ],
      },
    }),
  ];
  let approved = false;
  let selectedPermission: string | null = null;
  let retrievalSourceIds: string[] = [];

  await page.route("**/api/projects/" + projectId + "/knowledge", (route) =>
    route.fulfill({ json: knowledgeFixture(sources) }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/knowledge/reference-pack",
    (route) =>
      route.fulfill({
        json: {
          metadata: { status: "researched_only_not_ingested" },
          sources: [],
          previews: [],
        },
      }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/graph/snapshots",
    (route) => route.fulfill({ json: { snapshots: [] } }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/knowledge/sources/" + sourceId,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: {
            source: {
              id: sourceId,
              displayName: "Onboarding guide.md",
              version: 1,
              checksum: "a".repeat(64),
              contentType: "text/markdown",
              sourceMetadata: {},
              chunks: [
                {
                  id: "chunk-fixture-1",
                  ordinal: 0,
                  heading: "First steps",
                  pageNumber: null,
                  content: "Preview loaded from the source detail API.",
                },
              ],
            },
          },
        });
      }
      sources = sources.filter((source) => source.id !== sourceId);
      return route.fulfill({ json: { sourceId, deleted: true } });
    },
  );
  await page.route("**/api/projects/" + projectId + "/workspace", (route) =>
    route.fulfill({
      json: {
        projectConfigured: true,
        databaseConfigured: true,
        reason: null,
        access: "read_only",
        grantDurationSeconds: 900,
      },
    }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/workspace/roots",
    (route) =>
      route.fulfill({
        json: {
          roots: [
            {
              rootId: "r2-fixture-root",
              displayName: "FP_PBKK",
              source: "environment",
              available: true,
            },
          ],
        },
      }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/workspace/grants",
    async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        expect(body).toEqual({
          approval: "read_only_project_root",
          rootId: "r2-fixture-root",
        });
        approved = true;
        return route.fulfill({
          status: 201,
          json: {
            grantId,
            expiresAt: grantExpiry,
            access: "read_only",
            scope: "project_root",
            rootId: "r2-fixture-root",
          },
        });
      }
      return route.fulfill({ status: 405 });
    },
  );
  await page.route(
    "**/api/projects/" + projectId + "/workspace/grants/**",
    async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (method === "DELETE") {
        return route.fulfill({ json: { revoked: true } });
      }
      if (url.pathname.endsWith("/list")) {
        const path = url.searchParams.get("path") ?? "";
        return route.fulfill({
          json: {
            path,
            entries: path
              ? [{ name: "notes.md", path: "docs/notes.md", kind: "file" }]
              : [{ name: "docs", path: "docs", kind: "directory" }],
            truncated: false,
          },
        });
      }
      if (url.pathname.endsWith("/read")) {
        return route.fulfill({
          json: {
            path: url.searchParams.get("path"),
            encoding: "utf-8",
            bytes: 73,
            content:
              "This local note explains the project policy and source provenance.",
          },
        });
      }
      if (url.pathname.endsWith("/search")) {
        return route.fulfill({
          json: {
            matches: [
              {
                path: "docs/notes.md",
                line: 1,
                snippet: "project policy and source provenance",
              },
            ],
            filesScanned: 2,
            filesSkipped: 0,
            bytesScanned: 120,
            truncated: false,
          },
        });
      }
      if (url.pathname.endsWith("/import")) {
        const body = route.request().postDataJSON() as {
          path: string;
          permission: string;
        };
        selectedPermission = body.permission;
        expect(body.path).toBe("docs/notes.md");
        sources = [
          sourceFixture({
            id: importedSourceId,
            displayName: "notes.md",
            sourceKind: "text_upload",
            permission: body.permission,
            checksum: "b".repeat(64),
            sourceMetadata: {
              origin: "local_workspace",
              relativePath: "docs/notes.md",
            },
          }),
        ];
        return route.fulfill({
          status: 201,
          json: {
            sourceId: importedSourceId,
            version: 1,
            checksum: "b".repeat(64),
            chunkCount: 1,
            updated: false,
            permission: body.permission,
          },
        });
      }
      unexpectedRequests.push(`${method} ${url.pathname}`);
      return route.fulfill({
        status: 501,
        json: { error: "Unexpected grant request" },
      });
    },
  );
  await page.route(
    "**/api/projects/" + projectId + "/graph/retrieval",
    async (route) => {
      const body = route.request().postDataJSON() as { sourceIds?: string[] };
      retrievalSourceIds = body.sourceIds ?? [];
      return route.fulfill({
        json: {
          retrieval: {
            requestedStrategy: "graph",
            strategyUsed: "lexical",
            snapshotId: null,
            traceId: "r2-fixture-trace",
            seeds: [],
            paths: [],
            evidence: [],
            estimatedContextTokens: 0,
            fallbackReason: "graph_snapshot_unavailable",
            clipping: {},
            elapsedMs: 1,
          },
        },
      });
    },
  );

  await page.goto("/sources");
  await expect(page.locator("#active-project")).toHaveValue(projectId);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sumber" }),
  ).toBeVisible();
  const evaluatorWikiLink = page.getByRole("link", {
    name: "Unduh wiki verified memory evaluator, termasuk kasus dan kriteria holdout",
  });
  await expect(evaluatorWikiLink).toHaveAttribute(
    "href",
    `/api/projects/${projectId}/memory?format=markdown&audience=evaluator`,
  );
  await expect(
    page.getByText(
      "Ekspor Markdown read-only untuk evaluator; mencakup kasus dan kriteria holdout. Tidak dipakai oleh retrieval runtime.",
    ),
  ).toBeVisible();
  const sourceCard = page.locator("#knowledge-source-" + sourceId);
  await expect(sourceCard).toBeVisible();
  await expect(
    sourceCard.getByText("Lengkap pada profil tersimpan"),
  ).toBeVisible();
  await sourceCard.getByText("Detail indeks semantik").click();
  await expect(
    sourceCard.getByText(
      /embeddinggemma:latest → embeddinggemma:latest · 1\/1 chunk · lengkap/,
    ),
  ).toBeVisible();
  await expect(
    sourceCard.getByText(/Coverage ini menggambarkan indeks tersimpan/),
  ).toBeVisible();
  await expect(
    sourceCard.getByText(
      /kecocokan dengan profil query saat retrieval belum diverifikasi\./,
    ),
  ).toBeVisible();
  const addSourceLink = page.getByRole("button", {
    name: "Tambah sumber",
    exact: true,
  });
  const saveSourceAction = page.getByRole("button", {
    name: "Simpan sumber",
    exact: true,
  });
  const [addSourceBackground, saveSourceBackground] = await Promise.all([
    addSourceLink.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
    saveSourceAction.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
  ]);
  expect(addSourceBackground).not.toBe(saveSourceBackground);

  await page.locator("#knowledge-source-search").fill("missing");
  await expect(
    page.getByText("Tidak ada sumber yang cocok dengan pencarian."),
  ).toBeVisible();
  await page.locator("#knowledge-source-search").fill("onboarding");
  await sourceCard.getByRole("button", { name: "Pratinjau" }).click();
  await expect(
    page.getByText("Preview loaded from the source detail API."),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await sourceCard.getByRole("button", { name: "Hapus" }).click();
  await expect(page.locator("#knowledge-source-" + sourceId)).toHaveCount(0);
  await page.locator("#knowledge-source-search").fill("");

  await expect(
    page.getByRole("heading", { name: "Folder di komputer ini" }),
  ).toBeVisible();
  const connectFolder = page.getByRole("button", {
    name: "Hubungkan dan izinkan baca untuk FP_PBKK",
  });
  await connectFolder.click();
  await expect(connectFolder).toHaveText("Terhubung");
  expect(approved).toBe(true);

  await page.getByRole("button", { name: "docs" }).click();
  await expect(page.getByRole("button", { name: "notes.md" })).toBeVisible();
  await page.getByLabel("Cari teks di folder lokal").fill("project policy");
  await page.getByRole("button", { name: "Cari" }).click();
  await page.getByRole("button", { name: /docs\/notes\.md · baris 1/ }).click();
  await expect(
    page.getByText(
      "This local note explains the project policy and source provenance.",
    ),
  ).toBeVisible();
  await page.getByLabel("Hanya lokal").check();
  await page.getByRole("button", { name: "Impor file terpilih" }).click();
  await expect(
    page.getByText("Sumber lokal diimpor sebagai v1."),
  ).toBeVisible();
  await expect(
    page.locator("#knowledge-source-" + importedSourceId),
  ).toBeVisible();
  expect(selectedPermission).toBe("local_only");

  await page.screenshot({
    path: resolve(screenshots, "r2-sources-default-fixture.png"),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });

  await page
    .locator("details")
    .filter({ hasText: "Diagnostik lanjutan" })
    .locator("summary")
    .click();
  await page.locator(".retrieval-source-selection input").check();
  await page.locator("#knowledge-query").fill("What is the project policy?");
  await page.getByRole("button", { name: "Jalankan preview" }).click();
  await expect(page.getByText("r2-fixture-trace")).toBeVisible();
  expect(retrievalSourceIds).toEqual([importedSourceId]);

  await page.screenshot({
    path: resolve(screenshots, "r2-sources-advanced-fixture.png"),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });
  expect(unexpectedRequests).toEqual([]);
});

test("Sumber and Pengaturan explain disconnected local folders and database", async ({
  page,
}) => {
  await mkdir(screenshots, { recursive: true });
  const unexpectedRequests = await installStrictApiFallback(page);
  await installProjectFixture(page);
  await page.route("**/api/projects/" + projectId + "/workspace", (route) =>
    route.fulfill({
      json: {
        projectConfigured: false,
        databaseConfigured: false,
        reason: "not_configured",
        access: null,
        grantDurationSeconds: null,
      },
    }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/workspace/roots",
    (route) => route.fulfill({ json: { roots: [] } }),
  );
  await page.route("**/api/projects/" + projectId + "/knowledge", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: "DATABASE_UNAVAILABLE",
        message: "Database lokal belum dikonfigurasi.",
      },
    }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/knowledge/reference-pack",
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: "DATABASE_UNAVAILABLE",
          message: "Database belum tersedia.",
        },
      }),
  );
  await page.route(
    "**/api/projects/" + projectId + "/graph/snapshots",
    (route) => route.fulfill({ status: 503, json: { snapshots: [] } }),
  );

  await page.goto("/sources");
  await expect(page.locator("#active-project")).toHaveValue(projectId);
  await expect(
    page.getByRole("heading", { name: "Folder di komputer ini" }),
  ).toBeVisible();
  await expect(page.getByText(/Belum ada folder yang terhubung/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Hubungkan dan izinkan baca/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Simpan sumber" }),
  ).toBeDisabled();
  await expect(page.getByText("Database belum tersedia.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Muat ulang referensi" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tambahkan referensi umum" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: resolve(screenshots, "r2-sources-disconnected.png"),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Folder di komputer ini" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Folder yang tersedia ada di komputer yang menjalankan PromptLab/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/PromptLab tidak mengubah file atau menjalankan perintah/),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(screenshots, "r2-settings-disconnected.png"),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });
  expect(unexpectedRequests).toEqual([]);
});
