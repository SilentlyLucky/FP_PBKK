import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { expectActiveProjectId } from "./helpers/project-picker";

const projectId = "4fd7a8a8-1875-4a83-9c01-4d33b607779c";
const sourceId = "8c6cecca-6a08-4738-93ac-6102b62bcf8d";
const importedSourceId = "c9de9bd6-644b-4cd7-adfb-823872559a01";
const pastedSourceId = "9a3c67bb-472d-48c7-bf3b-dca8318336fd";
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

function contrastRatio(foreground: string, background: string) {
  const parseLinearRgb = (color: string) => {
    const channels = color.match(/-?\d*\.?\d+/g)?.map(Number);
    if (!channels || (channels.length !== 3 && channels.length !== 4)) {
      throw new Error("Expected a rendered CSS color, received " + color);
    }
    const alpha = channels[3] ?? 1;
    const toLinear = (normalized: number) => {
      const bounded = Math.min(1, Math.max(0, normalized));
      return bounded <= 0.04045
        ? bounded / 12.92
        : ((bounded + 0.055) / 1.055) ** 2.4;
    };

    if (color.startsWith("oklab(")) {
      const [lightness = 0, a = 0, b = 0] = channels;
      const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return {
        alpha,
        linear: [
          4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
        ].map((channel) => Math.min(1, Math.max(0, channel))),
      };
    }

    const [red = 0, green = 0, blue = 0] = channels;
    return {
      alpha,
      linear: [red, green, blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      }),
    };
  };

  const parsedBackground = parseLinearRgb(background);
  const backgroundLinear = parsedBackground.linear.map(
    (channel) =>
      channel * parsedBackground.alpha + (1 - parsedBackground.alpha),
  );
  const parsedForeground = parseLinearRgb(foreground);
  const foregroundLinear = parsedForeground.linear.map(
    (channel, index) =>
      channel * parsedForeground.alpha +
      (backgroundLinear[index] ?? 1) * (1 - parsedForeground.alpha),
  );
  const luminance = (channels: number[]) => {
    const [red = 0, green = 0, blue = 0] = channels;
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const foregroundLuminance = luminance(foregroundLinear);
  const backgroundLuminance = luminance(backgroundLinear);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
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
        const body = route.request().postDataJSON() as { path: string };
        expect(body.path).toBe("docs/notes.md");
        sources = [
          sourceFixture({
            id: importedSourceId,
            displayName: "notes.md",
            sourceKind: "text_upload",
            permission: "campus_indexer_allowed",
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
            permission: "campus_indexer_allowed",
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
  await page.route(
    "**/api/projects/" + projectId + "/knowledge/sources",
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sources = [
        ...sources,
        sourceFixture({
          id: pastedSourceId,
          displayName: "Meeting notes.log",
          sourceKind: "text_upload",
          permission: "local_only",
          contentType: "text/plain",
        }),
      ];
      return route.fulfill({
        status: 201,
        json: {
          source: { id: pastedSourceId, version: 1 },
          message: "Sumber tersimpan.",
        },
      });
    },
  );

  await page.goto("/sources");
  await expectActiveProjectId(page, projectId);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sumber" }),
  ).toBeVisible();
  const sourceCard = page.locator("#knowledge-source-" + sourceId);
  await expect(sourceCard).toBeVisible();

  const sourceViewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ];
  for (const [viewportIndex, viewport] of sourceViewports.entries()) {
    await page.setViewportSize(viewport);
    const size = String(viewport.width) + "x" + String(viewport.height);
    const pageLayout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      sourceWidth:
        document
          .querySelector(".knowledge-source-card")
          ?.getBoundingClientRect().width ?? 0,
    }));
    expect(pageLayout.documentWidth).toBeLessThanOrEqual(
      pageLayout.viewportWidth,
    );
    expect(pageLayout.sourceWidth).toBeGreaterThan(240);
    await page.screenshot({
      path: resolve(screenshots, "r2-sources-" + size + "-default.png"),
      fullPage: false,
      style: "nextjs-portal { display: none !important; }",
    });

    const addSource = page.getByRole("button", {
      name: "Tambah sumber",
      exact: true,
    });
    await addSource.click();
    const sourceDialog = page.getByRole("dialog", { name: "Tambah sumber" });
    await expect(sourceDialog).toBeVisible();
    await expect(
      sourceDialog.getByRole("button", { name: "Unggah file" }),
    ).toBeVisible();
    await expect(
      sourceDialog.getByRole("button", { name: "Tempel teks" }),
    ).toBeVisible();
    await expect(
      sourceDialog.getByText("Pilih file", { exact: true }),
    ).toBeVisible();
    await expect(
      sourceDialog.getByText("Belum ada file dipilih", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("File sumber")).toBeFocused();
    const dialogBounds = await sourceDialog.evaluate((dialog) => {
      const bounds = dialog.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width };
    });
    expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
    expect(dialogBounds.right).toBeLessThanOrEqual(viewport.width);
    expect(dialogBounds.width).toBeGreaterThanOrEqual(
      Math.min(320, viewport.width - 16),
    );
    await page.screenshot({
      path: resolve(screenshots, "r2-sources-" + size + "-add-dialog.png"),
      fullPage: false,
      style: "nextjs-portal { display: none !important; }",
    });
    if (viewportIndex === 0) {
      await page.getByLabel("File sumber").setInputFiles({
        name: "catatan.log",
        mimeType: "text/plain",
        buffer: Buffer.from("Isi catatan untuk sumber."),
      });
      await expect(
        sourceDialog.getByText("catatan.log", { exact: true }),
      ).toBeVisible();
      await page.getByLabel("File sumber").focus();
      await page.keyboard.press("Tab");
      await expect(
        sourceDialog.getByText("Opsi tambahan", { exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        sourceDialog.getByRole("button", { name: "Simpan sumber" }),
      ).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(sourceDialog).toBeHidden();
    await expect(addSource).toBeFocused();
    if (viewportIndex < sourceViewports.length - 1) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await addSource.evaluate((button) => button.blur());
      await expect(addSource).not.toBeFocused();
      await page.mouse.move(0, 0);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderedColors = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    const sourceCard = document.querySelector(".knowledge-source-card");
    const sourceMetadata = document.querySelector(
      ".knowledge-source-card .knowledge-source-title .helper",
    );
    const addSource = document.querySelector(
      '[aria-label="Ringkasan sumber"] button[aria-expanded]',
    ) as HTMLButtonElement | null;
    const sourceSummary = document.querySelector(
      '[aria-label="Ringkasan sumber"]',
    );
    if (
      !heading ||
      !sourceCard ||
      !sourceMetadata ||
      !addSource ||
      !sourceSummary
    ) {
      throw new Error("Sumber contrast elements are missing.");
    }
    return {
      headingText: getComputedStyle(heading).color,
      pageBackground: getComputedStyle(document.body).backgroundColor,
      metadataText: getComputedStyle(sourceMetadata).color,
      cardBackground: getComputedStyle(sourceCard).backgroundColor,
      actionText: getComputedStyle(addSource).color,
      actionBackground: getComputedStyle(addSource).backgroundColor,
      focusColor: getComputedStyle(addSource).outlineColor,
      focusWidth: getComputedStyle(addSource).outlineWidth,
      focusVisible: addSource.matches(":focus-visible"),
      focusBackground: getComputedStyle(document.body).backgroundColor,
    };
  });
  const contrastResults = {
    heading: contrastRatio(
      renderedColors.headingText,
      renderedColors.pageBackground,
    ),
    metadata: contrastRatio(
      renderedColors.metadataText,
      renderedColors.cardBackground,
    ),
    action: contrastRatio(
      renderedColors.actionText,
      renderedColors.actionBackground,
    ),
    focus: contrastRatio(
      renderedColors.focusColor,
      renderedColors.focusBackground,
    ),
  };
  console.log(
    "Rendered WCAG contrast ratios: " + JSON.stringify(contrastResults),
  );
  expect(contrastResults.heading).toBeGreaterThanOrEqual(3);
  expect(contrastResults.metadata).toBeGreaterThanOrEqual(4.5);
  expect(contrastResults.action).toBeGreaterThanOrEqual(4.5);
  expect(renderedColors.focusVisible).toBe(true);
  expect(Number.parseFloat(renderedColors.focusWidth)).toBeGreaterThanOrEqual(
    2,
  );
  expect(contrastResults.focus).toBeGreaterThanOrEqual(3);

  await page.locator("#knowledge-advanced-tools > summary").click();
  const evaluatorWikiLink = page.getByRole("link", {
    name: "Unduh wiki verified memory evaluator, termasuk kasus dan kriteria holdout",
  });
  await expect(evaluatorWikiLink).toHaveAttribute(
    "href",
    `/api/projects/${projectId}/memory?format=markdown&audience=evaluator`,
  );
  await expect(
    page.getByText("Ekspor Markdown untuk evaluator, bukan retrieval runtime."),
  ).toBeVisible();
  const indexDisclosure = sourceCard
    .locator("details")
    .filter({ hasText: "Detail indeks" });
  await expect(
    indexDisclosure.getByText("Lengkap pada profil tersimpan"),
  ).toBeHidden();
  await indexDisclosure.locator("summary").click();
  await expect(
    indexDisclosure.getByText("Lengkap pada profil tersimpan"),
  ).toBeVisible();
  await expect(
    indexDisclosure.getByText(
      /embeddinggemma:latest → embeddinggemma:latest · 1\/1 chunk · lengkap/,
    ),
  ).toBeVisible();
  await expect(
    indexDisclosure.getByText(/Coverage ini menggambarkan indeks tersimpan/),
  ).toBeVisible();
  await expect(
    indexDisclosure.getByText(
      /kecocokan dengan profil query saat retrieval belum diverifikasi\./,
    ),
  ).toBeVisible();
  const addSourceLink = page.getByRole("button", {
    name: "Tambah sumber",
    exact: true,
  });
  const saveSourceAction = page.locator(
    "#knowledge-add-source button[type='submit']",
  );
  const [addSourceBackground, saveSourceBackground] = await Promise.all([
    addSourceLink.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
    saveSourceAction.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
  ]);
  // Warna aksen terang (--primary) pada tema Warm Slate.
  expect(addSourceBackground).toBe("rgb(180, 83, 47)");
  expect(saveSourceBackground).toBe(addSourceBackground);

  await page.locator("#knowledge-source-search").fill("missing");
  await expect(
    page.getByText("Tidak ada sumber yang cocok dengan pencarian."),
  ).toBeVisible();
  await page.locator("#knowledge-source-search").fill("onboarding");
  await sourceCard.getByRole("button", { name: "Pratinjau" }).click();
  await expect(
    page.getByText("Preview loaded from the source detail API."),
  ).toBeVisible();

  const sourceActionMenu = sourceCard.locator("details").first();
  await sourceActionMenu.locator("summary").click();
  await sourceActionMenu
    .getByRole("button", { name: "Ganti dengan versi baru" })
    .click();
  const replaceDialog = page.getByRole("dialog", {
    name: "Ganti versi sumber",
  });
  await expect(replaceDialog).toBeVisible();
  await replaceDialog
    .getByRole("button", { name: "Simpan versi baru" })
    .click();
  await expect(
    replaceDialog
      .getByRole("alert")
      .getByText("Pilih file sumber terlebih dahulu."),
  ).toBeVisible();
  await replaceDialog.getByRole("button", { name: "Batal" }).click();
  await expect(replaceDialog).toBeHidden();

  page.once("dialog", (dialog) => dialog.accept());
  await sourceCard.locator("details").first().locator("summary").click();
  await sourceCard.getByRole("button", { name: "Hapus" }).click();
  await expect(page.locator("#knowledge-source-" + sourceId)).toHaveCount(0);
  await page.locator("#knowledge-source-search").fill("");

  await page
    .locator("#knowledge-advanced-tools details")
    .filter({ hasText: "Impor file dari folder kerja lokal" })
    .locator("summary")
    .click();
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
  await page.getByRole("button", { name: "Impor file terpilih" }).click();
  await expect(
    page.getByText("Sumber lokal diimpor sebagai v1."),
  ).toBeVisible();
  await expect(
    page.locator("#knowledge-source-" + importedSourceId),
  ).toBeVisible();

  await page.screenshot({
    path: resolve(screenshots, "r2-sources-default-fixture.png"),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });

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

  await page
    .getByRole("button", { name: "Tambah sumber", exact: true })
    .click();
  const sourceDialog = page.getByRole("dialog", { name: "Tambah sumber" });
  await expect(sourceDialog).toBeVisible();
  await sourceDialog.getByRole("button", { name: "Tempel teks" }).click();
  await sourceDialog.getByLabel("Nama sumber").fill("Meeting notes.log");
  await sourceDialog
    .getByLabel("Teks sumber")
    .fill("Catatan ini tersimpan sebagai sumber.");
  await sourceDialog.getByRole("button", { name: "Simpan sumber" }).click();
  await expect(sourceDialog).toBeHidden();
  await expect(page.getByText("Sumber tersimpan.")).toBeVisible();
  await expect(
    page.locator("#knowledge-source-" + pastedSourceId),
  ).toBeVisible();
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
  await expectActiveProjectId(page, projectId);
  await page.locator("#knowledge-advanced-tools > summary").click();
  await page
    .locator("#knowledge-advanced-tools details")
    .filter({ hasText: "Impor file dari folder kerja lokal" })
    .locator("summary")
    .click();
  await expect(
    page.getByRole("heading", { name: "Folder di komputer ini" }),
  ).toBeVisible();
  await expect(page.getByText(/Belum ada folder yang terhubung/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Hubungkan dan izinkan baca/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Tambah sumber" }).click();
  await expect(
    page.getByRole("button", { name: "Simpan sumber" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page
    .locator("#knowledge-advanced-tools details")
    .filter({ hasText: "Referensi umum · sumber publik dan preview" })
    .locator("summary")
    .click();
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
    page.getByText(/Hubungkan folder untuk memberi akses baca selama/),
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
