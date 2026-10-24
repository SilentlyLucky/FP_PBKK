import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  chooseMenuOption,
  expectMenuValue,
  menuTrigger,
} from "./helpers/menu";

const projectId = "f3b16568-80c7-45f7-9f14-1bfda4fc23c8";
const sourceId = "f77f9efb-8890-4f03-b365-165932946c1f";
const sourceVersionId = "01a80fb2-8748-44d4-9ba4-9509e11bd813";
const secondSourceId = "27b15266-2c88-4f48-8374-4c248a0c2d30";
const secondSourceVersionId = "52bcdb96-c1ed-4c01-a8db-e3617c2b3775";
const promptId = "9cf60647-c8d1-4b8c-85b0-713c8772dc21";
const firstRootId = "0dc10c15-5c88-4d5e-8477-17cb41c568e9";
const secondRootId = "2f8e94c2-12bb-411c-a421-8a5e8fce3d14";

type FixtureOutcome =
  | { kind: "failed"; errorCode?: string }
  | {
      kind: "completed";
      text: string;
      outcome?: string;
      optimizationEvidenceStatus?: string;
      recommendation?: {
        text: string;
        changeSummary: string;
        riskSummary: string;
      };
      retrievalStrategy?: string;
      effectiveRetrievalStrategy?: string;
      retrievalEvidenceStatus?: string;
      retrievalTraceIds?: string[];
      retrievalEvidence?: Array<{
        evidenceId: string;
        kind?: "graph" | "chunk";
        quote: string;
        documentId: string;
        documentName: string;
        sourcePermission: string;
        documentVersionId: string;
        documentVersion: number;
        sourceChecksum: string;
        chunkId?: string;
        pageNumber?: number | null;
        traceId: string;
      }>;
      graphSnapshotId?: string;
      targetContextHash?: string;
      graphEvidence?: Array<{
        evidenceId: string;
        quote: string;
        documentId: string;
        documentName: string;
        sourcePermission: string;
        documentVersionId: string;
        documentVersion: number;
        sourceChecksum: string;
        traceId: string;
      }>;
    };

interface WorkspaceFixtureOptions {
  senopatiAvailable?: boolean;
  codexTargetAvailable?: boolean;
  directoryPickerAvailable?: boolean;
  secondFolderAvailable?: boolean;
  failGrantNumbers?: number[];
  staleSearchOnGrantNumber?: number;
  graphEvidenceJourney?: boolean;
  outcomes?: FixtureOutcome[];
}

interface WorkspaceFixtureLog {
  promptWrites: Array<Record<string, unknown>>;
  runWrites: Array<Record<string, unknown>>;
  registrationWrites: Array<Record<string, unknown>>;
  grantWrites: Array<Record<string, unknown>>;
  importWrites: Array<Record<string, unknown>>;
  deletedGrantIds: string[];
  revokedRootIds: string[];
  versionWrites: Array<Record<string, unknown>>;
  unexpectedRequests: string[];
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function eventLine(
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const event = {
    id: `workspace-chat-${sequence}`,
    sequence,
    timestamp: "2026-10-17T08:00:00.000Z",
    eventType,
    payload,
  };
  return `id: ${sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function installWorkspaceFixtures(
  page: Page,
  options: WorkspaceFixtureOptions = {},
): Promise<WorkspaceFixtureLog> {
  const senopatiAvailable = options.senopatiAvailable ?? true;
  const codexTargetAvailable = options.codexTargetAvailable ?? true;
  const directoryPickerAvailable = options.directoryPickerAvailable ?? true;
  const secondFolderAvailable = options.secondFolderAvailable ?? false;
  const graphEvidenceJourney = options.graphEvidenceJourney ?? false;
  const outcomes = options.outcomes ?? [
    {
      kind: "completed" as const,
      text: "Halo! Ada yang bisa saya bantu?",
      outcome: "answered",
    },
  ];
  const roots: Array<Record<string, unknown>> = [];
  let activeGrantId: string | null = null;
  let activeGrantRootId: string | null = null;
  let grantNumber = 0;
  let sourceImported = graphEvidenceJourney;
  let runNumber = 0;
  let promptNumber = 0;
  const storedConversations: Array<Record<string, unknown>> = [];
  const log: WorkspaceFixtureLog = {
    promptWrites: [],
    runWrites: [],
    registrationWrites: [],
    grantWrites: [],
    importWrites: [],
    deletedGrantIds: [],
    revokedRootIds: [],
    versionWrites: [],
    unexpectedRequests: [],
  };

  const source = {
    id: sourceId,
    displayName: "README.md",
    sourceKind: "local_file",
    permission: "campus_indexer_allowed",
    deleted: false,
    eligible: true,
    version: 1,
    versionId: sourceVersionId,
    extractStatus: "completed",
    chunkCount: 1,
    semanticReadiness: { status: "ready" },
  };
  const secondSource = {
    ...source,
    id: secondSourceId,
    displayName: "ARCHITECTURE.md",
    version: 3,
    versionId: secondSourceVersionId,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === "/api/projects" && method === "GET") {
      await json(route, {
        projects: [
          {
            id: projectId,
            name: "Workspace QA project",
            objective: "Exercise offline Workspace chat and folder fixtures.",
          },
        ],
      });
      return;
    }

    if (pathname === "/api/providers" && method === "GET") {
      await json(route, {
        providers: [
          {
            provider: "campus_gateway",
            role: "optimizer",
            status: senopatiAvailable ? "verified" : "configured_unverified",
            requestedModel: "senopati-fixture-model",
            responseModel: senopatiAvailable ? "senopati-fixture-model" : null,
            endpointLabel: "Campus Gateway · fixture",
            checkedAt: null,
            reason: senopatiAvailable
              ? "Koneksi fixture terverifikasi."
              : "Koneksi fixture belum terverifikasi.",
            capabilities: {},
          },
          {
            provider: "codex_app_server",
            role: "target",
            status: codexTargetAvailable ? "verified" : "configured_unverified",
            requestedModel: "gpt-6-codex-fixture",
            responseModel: codexTargetAvailable ? "gpt-6-codex-fixture" : null,
            endpointLabel: "Codex · fixture",
            checkedAt: null,
            reason: codexTargetAvailable
              ? "Target fixture terverifikasi."
              : "Target fixture belum terverifikasi.",
            capabilities: {},
          },
        ],
        codexModels: [
          {
            id: "gpt-6-codex-fixture",
            displayName: "GPT-6 Codex fixture",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ],
        projectPrerequisite: "satisfied",
      });
      return;
    }

    const conversationsPath = `/api/projects/${projectId}/workspace/conversations`;
    if (pathname === conversationsPath && method === "GET") {
      await json(route, { conversations: storedConversations });
      return;
    }
    if (pathname === conversationsPath && method === "PUT") {
      const body = request.postDataJSON() as {
        conversations?: Array<Record<string, unknown>>;
      };
      storedConversations.splice(
        0,
        storedConversations.length,
        ...(body.conversations ?? []),
      );
      await json(route, { saved: storedConversations.length });
      return;
    }
    const conversationMatch = pathname.match(
      new RegExp(
        `^/api/projects/${projectId}/workspace/conversations/([^/]+)$`,
      ),
    );
    if (conversationMatch && method === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const index = storedConversations.findIndex(
        (conversation) => conversation.id === conversationMatch[1],
      );
      if (index < 0) storedConversations.unshift(body);
      else storedConversations[index] = body;
      await json(route, { saved: true });
      return;
    }
    if (conversationMatch && method === "DELETE") {
      const index = storedConversations.findIndex(
        (conversation) => conversation.id === conversationMatch[1],
      );
      if (index >= 0) storedConversations.splice(index, 1);
      await json(route, { deleted: true });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/knowledge` &&
      method === "GET"
    ) {
      await json(route, {
        sources: sourceImported
          ? [source, ...(graphEvidenceJourney ? [secondSource] : [])]
          : [],
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace` &&
      method === "GET"
    ) {
      await json(route, {
        projectConfigured: roots.some((root) => root.available === true),
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
      if (!directoryPickerAvailable) {
        await json(
          route,
          {
            error: "ORIGIN_NOT_ALLOWED",
            message:
              "Pemilih folder hanya tersedia dari aplikasi lokal loopback dengan koneksi same-origin.",
          },
          403,
        );
        return;
      }
      await json(route, {
        roots: roots.map((root) => ({ ...root })),
        canChooseDirectory: true,
        runtimeAvailable: true,
        unavailableReason: null,
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/roots/picker` &&
      method === "GET"
    ) {
      if (!directoryPickerAvailable) {
        await json(route, { error: "ORIGIN_NOT_ALLOWED" }, 403);
      } else if (url.searchParams.get("token") === "folder-token") {
        await json(route, {
          currentName: "FP_PBKK",
          breadcrumbs: ["FP_PBKK"],
          currentToken: "selection-token",
          parentToken: "home-token",
          directories: [{ name: "docs", token: "docs-token" }],
          truncated: false,
        });
      } else if (
        secondFolderAvailable &&
        url.searchParams.get("token") === "second-folder-token"
      ) {
        await json(route, {
          currentName: "Dokumen",
          breadcrumbs: ["Dokumen"],
          currentToken: "second-selection-token",
          parentToken: "home-token",
          directories: [],
          truncated: false,
        });
      } else {
        await json(route, {
          currentName: "Folder pengguna",
          breadcrumbs: [],
          currentToken: null,
          parentToken: null,
          directories: [
            { name: "FP_PBKK", token: "folder-token" },
            ...(secondFolderAvailable
              ? [{ name: "Dokumen", token: "second-folder-token" }]
              : []),
          ],
          truncated: false,
        });
      }
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/roots` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      log.registrationWrites.push(body);
      const root =
        body.selectionToken === "selection-token"
          ? {
              rootId: firstRootId,
              displayName: "FP_PBKK",
              source: "registered",
              available: true,
              createdAt: "2026-10-17T08:00:00.000Z",
            }
          : body.selectionToken === "second-selection-token" &&
              secondFolderAvailable
            ? {
                rootId: secondRootId,
                displayName: "Dokumen",
                source: "registered",
                available: true,
                createdAt: "2026-10-17T08:01:00.000Z",
              }
            : null;
      if (!root) {
        await json(
          route,
          {
            error: "REQUEST_INVALID",
            message: "Folder tidak dapat didaftarkan.",
          },
          400,
        );
        return;
      }
      roots.push(root);
      activeGrantId = null;
      activeGrantRootId = null;
      await json(route, { root }, 201);
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/roots` &&
      method === "DELETE"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const rootId = String(body.rootId ?? "");
      log.revokedRootIds.push(rootId);
      const index = roots.findIndex((root) => root.rootId === rootId);
      if (index >= 0) roots.splice(index, 1);
      activeGrantId = null;
      activeGrantRootId = null;
      await json(route, { revoked: index >= 0 });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/grants` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      log.grantWrites.push(body);
      grantNumber += 1;
      if (options.failGrantNumbers?.includes(grantNumber)) {
        await json(
          route,
          {
            error: "WORKSPACE_NOT_CONFIGURED",
            message: "Izin baca sementara belum tersedia.",
          },
          503,
        );
        return;
      }
      activeGrantId = `e12f49b8-2f08-44bc-90ee-f9956ac288${String(grantNumber).padStart(2, "0")}`;
      activeGrantRootId = String(body.rootId ?? "");
      await json(
        route,
        {
          grantId: activeGrantId,
          rootId: body.rootId,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          access: "read_only",
        },
        201,
      );
      return;
    }

    const grantMatch = new RegExp(
      `^/api/projects/${projectId}/workspace/grants/([^/]+)(?:/(list|read|search|import))?$`,
    ).exec(pathname);
    if (grantMatch) {
      const requestedGrantId = grantMatch[1]!;
      const operation = grantMatch[2] ?? null;
      const grantIsActive = activeGrantId === requestedGrantId;
      const isSecondFolder = activeGrantRootId === secondRootId;
      const fileName = isSecondFolder ? "MULAI.md" : "README.md";
      const fileContent = isSecondFolder
        ? "Petunjuk folder Dokumen"
        : "Panduan proyek FP_PBKK";

      if (method === "DELETE" && operation === null) {
        if (grantIsActive) {
          activeGrantId = null;
          activeGrantRootId = null;
        }
        log.deletedGrantIds.push(requestedGrantId);
        await json(route, { revoked: grantIsActive });
        return;
      }
      if (method === "GET" && operation === "list") {
        if (!grantIsActive) {
          await json(route, { error: "GRANT_NOT_FOUND" }, 404);
        } else {
          await json(route, {
            path: url.searchParams.get("path") ?? "",
            entries: [{ name: fileName, path: fileName, kind: "file" }],
            truncated: false,
          });
        }
        return;
      }
      if (method === "GET" && operation === "read") {
        if (!grantIsActive) {
          await json(route, { error: "GRANT_NOT_FOUND" }, 404);
        } else {
          await json(route, {
            path: url.searchParams.get("path") ?? fileName,
            encoding: "utf-8",
            bytes: fileContent.length,
            content: fileContent,
          });
        }
        return;
      }
      if (method === "GET" && operation === "search") {
        if (options.staleSearchOnGrantNumber === grantNumber && grantIsActive) {
          activeGrantId = null;
          activeGrantRootId = null;
          await json(route, { error: "GRANT_NOT_FOUND" }, 404);
        } else if (!grantIsActive) {
          await json(route, { error: "GRANT_NOT_FOUND" }, 404);
        } else {
          await json(route, {
            matches: [
              {
                path: fileName,
                line: 1,
                snippet: fileContent,
              },
            ],
            truncated: false,
            filesSkipped: 0,
          });
        }
        return;
      }
      if (method === "POST" && operation === "import") {
        const body = request.postDataJSON() as Record<string, unknown>;
        log.importWrites.push(body);
        if (!grantIsActive || body.path !== fileName) {
          await json(route, { error: "GRANT_NOT_FOUND" }, 404);
          return;
        }
        sourceImported = true;
        await json(
          route,
          {
            sourceId,
            version: 1,
            checksum: "a".repeat(64),
            chunkCount: 1,
            updated: false,
            permission: "campus_indexer_allowed",
          },
          201,
        );
        return;
      }
    }

    if (
      pathname === `/api/projects/${projectId}/workspace/prompts` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      log.promptWrites.push(body);
      promptNumber += 1;
      await json(
        route,
        {
          prompt: {
            id: promptId,
            name: String(body.name),
            versionId: `bff606bd-80b7-4aa1-8cf7-3a143341e1${String(promptNumber).padStart(2, "0")}`,
            version: promptNumber,
            text: String(body.text),
            currentVersionId: null,
          },
        },
        201,
      );
      return;
    }

    if (pathname === `/api/projects/${projectId}/runs` && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      log.runWrites.push(body);
      runNumber += 1;
      await json(
        route,
        { run: { id: `workspace-chat-run-${runNumber}`, status: "running" } },
        201,
      );
      return;
    }

    const runEventsMatch = new RegExp(
      `^/api/projects/${projectId}/runs/workspace-chat-run-(\\d+)/events$`,
    ).exec(pathname);
    if (runEventsMatch && method === "GET") {
      const index = Number(runEventsMatch[1]) - 1;
      const outcome = outcomes[index] ?? outcomes.at(-1)!;
      const action = eventLine(1, "agent.action", {
        mode: "workspace_chat",
        phase: "senopati_decision",
        summary: "Senopati mengoptimasi prompt sebelum Codex berjalan.",
        provider: "campus_gateway",
        purpose: "optimizer",
      });
      const terminalEvent =
        outcome.kind === "failed"
          ? eventLine(2, "run.failed", {
              status: "failed",
              errorCode: outcome.errorCode ?? "CAMPUS_PROVIDER_UNAVAILABLE",
            })
          : eventLine(outcome.graphEvidence?.length ? 4 : 2, "run.completed", {
              status: "succeeded",
              text: outcome.text,
              requestedModel: "senopati-fixture-model",
              responseModel: "senopati-fixture-model",
              responseId: `senopati-fixture-response-${index + 1}`,
              workspaceChat: {
                outcome: outcome.outcome ?? "answered",
                optimizationEvidenceStatus:
                  outcome.optimizationEvidenceStatus ??
                  (outcome.recommendation
                    ? "rewrite_unscored"
                    : "no_change_unscored"),
                qualityVerified: false,
                fixtureEvaluationCount: 0,
                recommendation: outcome.recommendation ?? null,
                clarification: null,
                retrievalStrategy: outcome.retrievalStrategy ?? "lexical",
                effectiveRetrievalStrategy:
                  outcome.effectiveRetrievalStrategy ?? null,
                retrievalEvidenceStatus:
                  outcome.retrievalEvidenceStatus ??
                  (outcome.graphEvidence?.length
                    ? "evidence_included"
                    : outcome.retrievalStrategy === "graph"
                      ? "no_evidence_found"
                      : "not_requested"),
                retrievalEvidence:
                  outcome.retrievalEvidence ?? outcome.graphEvidence ?? [],
                retrievalTraceIds:
                  outcome.retrievalTraceIds ??
                  (outcome.graphEvidence?.length
                    ? [
                        ...new Set(
                          outcome.graphEvidence.map((item) => item.traceId),
                        ),
                      ]
                    : []),
                graphSnapshotId: outcome.graphSnapshotId ?? null,
                graphEvidenceStatus: outcome.graphEvidence?.length
                  ? "evidence_included"
                  : outcome.retrievalStrategy === "graph"
                    ? "no_evidence_found"
                    : "not_requested",
                graphEvidence: outcome.graphEvidence ?? [],
                graphTraceIds: outcome.graphEvidence?.length
                  ? [
                      ...new Set(
                        outcome.graphEvidence.map((item) => item.traceId),
                      ),
                    ]
                  : [],
                targetContextHash: outcome.targetContextHash ?? null,
                decisionTurns: outcome.graphEvidence?.length ? 3 : 1,
                toolCalls: outcome.graphEvidence?.length ? 2 : 0,
                senopatiCalls: outcome.graphEvidence?.length ? 2 : 1,
                codexTargetCalls: outcome.graphEvidence?.length ? 1 : 0,
              },
            });
      const graphToolTrace =
        outcome.kind === "completed" && outcome.graphEvidence?.length
          ? eventLine(2, "tool.started", {
              mode: "workspace_chat",
              turn: 1,
              toolName: "search_graph_entities",
              argumentsSummary: { queryCharacters: 11, limit: 2 },
              summary: "Mencari entitas di GraphRAG",
            }) +
            eventLine(3, "tool.completed", {
              mode: "workspace_chat",
              turn: 1,
              toolName: "search_graph_entities",
              resultSummary: {
                available: true,
                resultCount: 1,
                pathCount: 1,
                evidenceCount: outcome.graphEvidence.length,
                sourceVersionCount: new Set(
                  outcome.graphEvidence.map((item) => item.documentVersionId),
                ).size,
                snapshotId: outcome.graphSnapshotId,
                traceId: outcome.graphEvidence[0]?.traceId,
              },
              summary: "GraphRAG menghasilkan bukti versi sumber",
            })
          : "";
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: action + graphToolTrace + terminalEvent,
      });
      return;
    }

    if (
      pathname === `/api/projects/${projectId}/prompts/${promptId}/versions` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      log.versionWrites.push(body);
      await json(
        route,
        {
          prompt: {
            id: promptId,
            currentVersionId: "bdc35c13-1187-4439-ae20-807261bc22cb",
            version: 2,
          },
        },
        201,
      );
      return;
    }

    log.unexpectedRequests.push(`${method} ${pathname}`);
    await json(
      route,
      {
        error: "UNEXPECTED_FIXTURE_REQUEST",
        message: "Unexpected fixture request.",
      },
      501,
    );
  });

  return log;
}

async function openWorkspaceContext(page: Page) {
  const toggle = page
    .getByTestId("workspace-chat-panel")
    .getByRole("button", { name: "Konteks", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(
    page.getByRole("complementary", { name: "Konteks percakapan" }),
  ).toBeVisible();
}

async function openWorkspaceFolderAccess(page: Page) {
  await openWorkspaceContext(page);
  await page
    .getByRole("complementary", { name: "Konteks percakapan" })
    .locator("summary")
    .filter({ hasText: "Baca file workspace" })
    .click();
}

async function closeWorkspaceContext(page: Page) {
  const toggle = page
    .getByTestId("workspace-chat-panel")
    .getByRole("button", { name: "Konteks", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) === "true") {
    await page
      .getByRole("complementary", { name: "Konteks percakapan" })
      .getByRole("button", { name: "Tutup panel konteks" })
      .click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

test("Workspace runs the mandatory optimization flow and restores project conversation history", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/workspace");

  await expect(page.getByText("Senopati siap", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Minta rekomendasi prompt/i }),
  ).toHaveCount(0);
  const message = page.getByRole("textbox", { name: "Pesan" });
  await message.fill("Halo");
  await message.press("Shift+Enter");
  await expect(message).toHaveValue("Halo\n");
  expect(fixture.runWrites).toEqual([]);
  await message.press("Enter");
  const answer = page.getByText("Halo! Ada yang bisa saya bantu?", {
    exact: true,
  });
  await expect(answer).toBeVisible();
  await expect(
    page.getByText("Aktivitas tersimpan", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Senopati mengoptimasi prompt sebelum Codex berjalan.", {
      exact: true,
    }),
  ).toBeHidden();
  await expect(
    page.getByRole("region", {
      name: "Prompt hasil susunan Senopati yang dikirim ke Codex",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Riwayat percakapan dan pengaturan tersimpan di browser ini. Riwayat ini tidak disinkronkan ke server.",
    ),
  ).toHaveCount(0);
  expect(fixture.runWrites).toHaveLength(1);
  expect(fixture.runWrites[0]).toMatchObject({
    provider: "campus_gateway",
    purpose: "optimizer",
    intent: "workspace_chat",
    workspaceChat: {
      format: "promptlab-workspace-chat-v1",
      target: {
        requestedModel: "gpt-6-codex-fixture",
        reasoningEffort: "medium",
      },
    },
    retrieval: { strategy: "auto", sourceIds: [] },
  });
  expect(fixture.promptWrites).toHaveLength(1);
  expect(fixture.promptWrites[0]?.text).toContain(
    "Permintaan pengguna saat ini:\nHalo",
  );

  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-chat-senopati-answer-1440.png",
    ),
    fullPage: true,
    style: "nextjs-portal { display: none !important; }",
  });

  await page.reload();
  await expect(
    page.getByText("Halo! Ada yang bisa saya bantu?", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Halo/ })).toBeVisible();
  expect(fixture.runWrites).toHaveLength(1);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("Workspace Auto effort keeps the target fixed and persists Auto and manual selections", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await installWorkspaceFixtures(page, {
    outcomes: [
      { kind: "completed", text: "Jawaban dengan effort Auto." },
      { kind: "completed", text: "Jawaban dengan effort manual." },
    ],
  });
  await page.goto("/workspace");
  await openWorkspaceContext(page);

  await chooseMenuOption(page, "Reasoning effort Codex", "Otomatis");
  await expectMenuValue(page, "Reasoning effort Codex", "Otomatis");
  const message = page.getByRole("textbox", { name: "Pesan" });
  await message.fill("Jawab singkat dengan Auto.");
  await message.press("Enter");
  await expect(
    page.getByText("Jawaban dengan effort Auto.", { exact: true }),
  ).toBeVisible();
  expect(fixture.runWrites[0]).toMatchObject({
    workspaceChat: {
      target: {
        requestedModel: "gpt-6-codex-fixture",
        reasoningEffort: null,
        reasoningEffortMode: "auto",
      },
    },
  });

  await page.reload();
  await openWorkspaceContext(page);
  await expectMenuValue(page, "Reasoning effort Codex", "Otomatis");
  await chooseMenuOption(page, "Reasoning effort Codex", "Mendalam");
  await expectMenuValue(page, "Reasoning effort Codex", "Mendalam");
  const followUp = page.getByRole("textbox", { name: "Pesan" });
  await followUp.fill("Jawab singkat dengan effort tinggi.");
  await followUp.press("Enter");
  await expect(
    page.getByText("Jawaban dengan effort manual.", { exact: true }),
  ).toBeVisible();
  expect(fixture.runWrites).toHaveLength(2);
  expect(fixture.runWrites[1]).toMatchObject({
    workspaceChat: {
      target: {
        requestedModel: "gpt-6-codex-fixture",
        reasoningEffort: "high",
        reasoningEffortMode: "selected",
      },
    },
  });

  await page.reload();
  await openWorkspaceContext(page);
  await expectMenuValue(page, "Reasoning effort Codex", "Mendalam");
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("Workspace selects and persists Hybrid without a graph snapshot", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    graphEvidenceJourney: true,
    outcomes: [{ kind: "completed", text: "Jawaban dengan pencarian Hybrid." }],
  });
  await page.goto("/workspace");
  await openWorkspaceContext(page);
  await page.locator(`#workspace-source-${sourceId}`).check();
  await page.getByLabel("Strategi").selectOption("hybrid");
  await closeWorkspaceContext(page);

  await page
    .getByRole("textbox", { name: "Pesan" })
    .fill("Cari jawaban dengan pencarian Hybrid.");
  await page.getByRole("button", { name: "Kirim pesan", exact: true }).click();
  await expect(
    page.getByText("Jawaban dengan pencarian Hybrid.", { exact: true }),
  ).toBeVisible();

  expect(fixture.runWrites[0]).toMatchObject({
    retrieval: { strategy: "hybrid", sourceIds: [sourceId] },
  });
  expect(
    (fixture.runWrites[0]?.retrieval as Record<string, unknown>).snapshotId,
  ).toBeUndefined();

  await page.reload();
  await openWorkspaceContext(page);
  await expect(page.getByLabel("Strategi")).toHaveValue("hybrid");
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("Workspace preserves a saved manual effort when the live catalog drops it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await installWorkspaceFixtures(page);
  await page.addInitScript((storedProjectId) => {
    const conversationId = "conversation-with-stale-effort";
    localStorage.setItem(
      `promptlab.workspace.conversations.v1:${storedProjectId}`,
      JSON.stringify([
        {
          id: conversationId,
          title: "Percakapan lama",
          updatedAt: "2026-10-17T08:00:00.000Z",
          preference: "balanced",
          reasoningEffort: "max",
          reasoningEffortMode: "selected",
          sourceIds: [],
          promptId: null,
          promptVersionId: null,
          turns: [],
        },
      ]),
    );
    localStorage.setItem(
      `promptlab.workspace.active.v1:${storedProjectId}`,
      conversationId,
    );
  }, projectId);
  await page.goto("/workspace");
  await openWorkspaceContext(page);

  await expectMenuValue(
    page,
    "Reasoning effort Codex",
    "Maksimal · tidak didukung model saat ini",
  );
  await menuTrigger(page, "Reasoning effort Codex").click();
  await expect(
    page.getByRole("menuitemradio", {
      name: "Maksimal · tidak didukung model saat ini",
      exact: true,
    }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  const message = page.getByRole("textbox", { name: "Pesan" });
  await message.fill("Gunakan pilihan yang tersimpan.");
  await message.press("Enter");
  await expect(
    page.getByText("Halo! Ada yang bisa saya bantu?", { exact: true }),
  ).toBeVisible();
  expect(fixture.runWrites[0]).toMatchObject({
    workspaceChat: {
      target: {
        requestedModel: "gpt-6-codex-fixture",
        reasoningEffort: "max",
        reasoningEffortMode: "selected",
      },
    },
  });
  await page.reload();
  await openWorkspaceContext(page);
  await expectMenuValue(
    page,
    "Reasoning effort Codex",
    "Maksimal · tidak didukung model saat ini",
  );
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("Workspace shows the two source-versioned GraphRAG quotes carried to Codex", async ({
  page,
}) => {
  const graphSnapshotId = "c62772a2-1057-4e67-9686-0c1236b26577";
  const graphTraceId = "6b3d1ddd-c39b-4815-9ea4-53329110a2ab";
  const firstChecksum = "a".repeat(64);
  const secondChecksum = "b".repeat(64);
  const quoteA = "Sistem memuat konfigurasi dari berkas alpha.";
  const quoteB = "Berkas beta menjelaskan hubungan modul terkait.";
  const fixture = await installWorkspaceFixtures(page, {
    graphEvidenceJourney: true,
    outcomes: [
      {
        kind: "completed",
        text: "Ringkasan menggunakan dua sumber proyek.",
        outcome: "optimized_prompt_executed",
        retrievalStrategy: "graph",
        effectiveRetrievalStrategy: "graph",
        graphSnapshotId,
        targetContextHash: "c".repeat(64),
        recommendation: {
          text: "Ringkas hubungan modul dengan dua kutipan sumber terpilih.",
          changeSummary: "Mengikat jawaban pada evidence yang diambil.",
          riskSummary: "Kelengkapan bergantung pada snapshot aktif.",
        },
        graphEvidence: [
          {
            evidenceId: "9bfa1a02-cf11-4c3f-b06f-e738adac1f32",
            quote: quoteA,
            documentId: sourceId,
            documentName: "README.md",
            sourcePermission: "campus_indexer_allowed",
            documentVersionId: sourceVersionId,
            documentVersion: 1,
            sourceChecksum: firstChecksum,
            traceId: graphTraceId,
          },
          {
            evidenceId: "e48d47e6-931c-41e7-a852-1c0d9e515cc2",
            quote: quoteB,
            documentId: secondSourceId,
            documentName: "ARCHITECTURE.md",
            sourcePermission: "campus_indexer_allowed",
            documentVersionId: secondSourceVersionId,
            documentVersion: 3,
            sourceChecksum: secondChecksum,
            traceId: graphTraceId,
          },
        ],
      },
    ],
  });

  await page.goto("/workspace");
  await openWorkspaceContext(page);
  await page.locator(`#workspace-source-${sourceId}`).check();
  await page.locator(`#workspace-source-${secondSourceId}`).check();
  await page.getByLabel("Strategi").selectOption("graph");
  await closeWorkspaceContext(page);
  await page
    .getByRole("textbox", { name: "Pesan" })
    .fill("Ringkas hubungan modul dari sumber terpilih.");
  await page.getByRole("button", { name: "Kirim pesan", exact: true }).click();

  // Blok "Dioptimasi Senopati" tertutup secara bawaan.
  await page
    .locator("summary")
    .filter({ hasText: "Dioptimasi Senopati" })
    .click();
  const evidencePanel = page.getByRole("region", {
    name: "Bukti GraphRAG yang disertakan ke Codex",
  });
  await expect(evidencePanel).toBeVisible();
  await expect(evidencePanel).toContainText(graphSnapshotId);
  await expect(evidencePanel).toContainText("2 kutipan sumber digunakan");
  await expect(evidencePanel).toContainText(quoteA);
  await expect(evidencePanel).toContainText(quoteB);
  await expect(evidencePanel).toContainText(sourceVersionId);
  await expect(evidencePanel).toContainText(secondSourceVersionId);
  await expect(evidencePanel).toContainText(firstChecksum);
  await expect(evidencePanel).toContainText(secondChecksum);

  expect(fixture.runWrites[0]).toMatchObject({
    retrieval: {
      strategy: "graph",
      sourceIds: [sourceId, secondSourceId],
    },
  });
  const activitySummary = page
    .locator("summary")
    .filter({ hasText: "Aktivitas tersimpan" });
  await expect(activitySummary).toBeVisible();
  await activitySummary.press("Enter");
  await expect(
    page.getByText(
      "GraphRAG menemukan 1 jalur dan 2 kutipan berbasis versi sumber.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("an unverified Senopati connection refuses normal chat even with verified Codex", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    senopatiAvailable: false,
  });
  await page.goto("/workspace");

  await expect(
    page.getByText("Senopati tidak tersedia", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pesan" })).toBeDisabled();
  await expect(
    page.getByText("Senopati perlu diverifikasi untuk mengoptimasi prompt."),
  ).toBeVisible();
  expect(fixture.promptWrites).toEqual([]);
  expect(fixture.runWrites).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("provider failure, empty output, no-op, and an executed candidate stay distinct", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    outcomes: [
      { kind: "failed", errorCode: "CAMPUS_PROVIDER_UNAVAILABLE" },
      { kind: "completed", text: "", outcome: "answered" },
      {
        kind: "completed",
        text: "Halo kembali.",
        outcome: "no_change_recommended",
        optimizationEvidenceStatus: "no_change_unscored",
      },
      {
        kind: "completed",
        text: "Jawaban dari Codex dengan prompt hasil optimasi.",
        outcome: "optimized_prompt_executed",
        optimizationEvidenceStatus: "rewrite_unscored",
        recommendation: {
          text: "Jawab sapaan dengan singkat dan ramah.",
          changeSummary: "Menambahkan pola jawaban untuk sapaan.",
          riskSummary: "Belum diuji pada contoh percakapan yang beragam.",
        },
      },
    ],
  });
  await page.goto("/workspace");

  async function send(message: string) {
    await page.getByRole("textbox", { name: "Pesan" }).fill(message);
    await page
      .getByRole("button", { name: "Kirim pesan", exact: true })
      .click();
  }

  await send("Pertama");
  await expect(
    page.getByText("Saya belum dapat menyelesaikan jawaban ini."),
  ).toBeVisible();
  await expect(page.getByText("Gagal", { exact: true })).toBeVisible();

  await send("Kedua");
  await expect(
    page.getByText("Run selesai, tetapi belum ada teks jawaban."),
  ).toBeVisible();
  await expect(page.getByText("Gagal", { exact: true })).toHaveCount(1);

  await send("Ketiga");
  await expect(page.getByText("Halo kembali.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Senopati menilai prompt sudah memadai; prompt asli otomatis dikirim ke Codex.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Prompt hasil susunan Senopati yang dikirim ke Codex",
    }),
  ).toHaveCount(0);

  await send("Keempat");
  await expect(
    page.getByText("Jawaban dari Codex dengan prompt hasil optimasi.", {
      exact: true,
    }),
  ).toBeVisible();
  // Blok "Dioptimasi Senopati" tertutup secara bawaan.
  await page
    .locator("summary")
    .filter({ hasText: "Dioptimasi Senopati" })
    .last()
    .click();
  await expect(
    page.getByRole("region", {
      name: "Prompt hasil susunan Senopati yang dikirim ke Codex",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Prompt hasil susunan Senopati · dikirim ke Codex", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Prompt ini disusun ulang oleh Senopati dan dikirim ke Codex apa adanya. Belum ada penilaian pada contoh uji.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tambahkan ke pesan" }),
  ).toHaveCount(0);
  expect(fixture.versionWrites).toEqual([]);
  expect(fixture.promptWrites).toHaveLength(4);
  expect(fixture.runWrites).toHaveLength(4);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("Workspace refuses to send when Codex target is unavailable", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    codexTargetAvailable: false,
  });
  await page.goto("/workspace");

  await expect(
    page.getByText("Codex perlu terverifikasi untuk menjawab pesan."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pesan" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Kirim pesan", exact: true }),
  ).toBeDisabled();
  expect(fixture.promptWrites).toEqual([]);
  expect(fixture.runWrites).toEqual([]);
});

test("composer folder flow connects with read-only consent, imports one file, selects context, and disconnects", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page);
  const nestedFormWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /<form>.*(?:descendant|nested)/iu.test(message.text())
    ) {
      nestedFormWarnings.push(message.text());
    }
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace");
  await openWorkspaceFolderAccess(page);

  await page
    .getByRole("button", { name: "Hubungkan folder", exact: true })
    .click();
  await expect(
    page.getByText("Pilih folder di komputer yang menjalankan PromptLab", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "FP_PBKK", exact: true }).click();
  await page.getByRole("button", { name: "Pilih folder “FP_PBKK”" }).click();
  await page
    .getByRole("button", {
      name: "Hubungkan dan izinkan baca untuk FP_PBKK",
    })
    .click();
  await expect(
    page.getByRole("search", { name: "Cari di folder lokal" }),
  ).toBeVisible();
  await expect(page.locator("#workspace-composer form")).toHaveCount(0);
  expect(nestedFormWarnings).toEqual([]);
  const localSearch = page.getByRole("textbox", {
    name: "Cari teks di folder lokal",
  });
  await localSearch.fill("Panduan");
  await localSearch.press("Enter");
  await expect(
    page.getByRole("button", { name: /README\.md · baris 1/ }),
  ).toBeVisible();
  expect(fixture.runWrites).toEqual([]);
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(
    page.locator("pre").getByText("Panduan proyek FP_PBKK", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Impor file terpilih" }).click();
  await expect(
    page.getByText("Sumber lokal diimpor sebagai v1.", { exact: true }),
  ).toBeVisible();

  const selectedSource = page.getByRole("checkbox", { name: /README\.md/ });
  await expect(selectedSource).toBeChecked();
  await expect(
    page.getByText(
      "Sumber pilihan akan dipakai setelah izin diverifikasi untuk run.",
    ),
  ).toBeVisible();
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const viewportDimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(
      viewportDimensions.documentWidth,
      `Workspace has no horizontal overflow at ${width}px`,
    ).toBeLessThanOrEqual(viewportDimensions.viewportWidth);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .getByTestId("workspace-chat-panel")
      .getByRole("button", { name: "Konteks", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");

  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.locator("#workspace-composer").screenshot({
    path: resolve(
      screenshotDirectory,
      "workspace-folder-source-context-390.png",
    ),
    style: "nextjs-portal { display: none !important; }",
  });

  await page
    .getByRole("textbox", { name: "Pesan" })
    .fill("Ringkas file yang saya pilih.");
  await page.getByRole("button", { name: "Kirim pesan", exact: true }).click();
  await expect(
    page.getByText("Halo! Ada yang bisa saya bantu?", { exact: true }),
  ).toBeVisible();
  expect(fixture.registrationWrites).toEqual([
    { selectionToken: "selection-token" },
  ]);
  expect(fixture.grantWrites).toEqual([
    {
      approval: "read_only_project_root",
      rootId: "0dc10c15-5c88-4d5e-8477-17cb41c568e9",
    },
  ]);
  expect(fixture.importWrites).toEqual([
    { path: "README.md" },
  ]);
  expect(fixture.runWrites[0]).toMatchObject({
    retrieval: { strategy: "auto", sourceIds: [sourceId] },
  });
  expect(JSON.stringify(fixture.registrationWrites)).not.toContain("/home/");

  await openWorkspaceContext(page);
  await page.getByRole("button", { name: "Cabut", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Belum ada folder yang terhubung." }),
  ).toContainText("Belum ada folder yang terhubung.");
  expect(fixture.deletedGrantIds).toEqual([
    "e12f49b8-2f08-44bc-90ee-f9956ac28801",
  ]);
  expect(fixture.revokedRootIds).toEqual([
    "0dc10c15-5c88-4d5e-8477-17cb41c568e9",
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("registering another folder clears the old grant and allows a fresh connection", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    secondFolderAvailable: true,
    staleSearchOnGrantNumber: 2,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace");
  await openWorkspaceFolderAccess(page);
  await page.getByRole("button", { name: "Hubungkan folder" }).click();

  await page.getByRole("button", { name: "FP_PBKK", exact: true }).click();
  await page.getByRole("button", { name: "Pilih folder “FP_PBKK”" }).click();
  await page
    .getByRole("button", {
      name: "Hubungkan dan izinkan baca untuk FP_PBKK",
    })
    .click();
  const localSearch = page.getByRole("textbox", {
    name: "Cari teks di folder lokal",
  });
  await expect(localSearch).toBeVisible();
  await localSearch.fill("Panduan");
  await page.getByRole("button", { name: "Cari", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /README\.md · baris 1/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(
    page.locator("pre").getByText("Panduan proyek FP_PBKK", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Hubungkan folder" }).click();
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
  await page.getByRole("button", { name: "Pilih folder “Dokumen”" }).click();
  await page
    .getByRole("button", {
      name: "Hubungkan dan izinkan baca untuk Dokumen",
    })
    .click();
  await expect(localSearch).toBeVisible();
  await expect(localSearch).toHaveValue("");
  await expect(
    page.getByText("Pilih file teks untuk membaca isinya.", { exact: true }),
  ).toBeVisible();
  expect(fixture.registrationWrites).toEqual([
    { selectionToken: "selection-token" },
    { selectionToken: "second-selection-token" },
  ]);
  expect(fixture.grantWrites).toEqual([
    { approval: "read_only_project_root", rootId: firstRootId },
    { approval: "read_only_project_root", rootId: secondRootId },
  ]);

  await localSearch.fill("Kadaluarsa");
  await page.getByRole("button", { name: "Cari", exact: true }).click();
  await expect(
    page.getByText(
      "Izin baca sudah tidak berlaku. Hubungkan kembali folder untuk memilih file.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("search", { name: "Cari di folder lokal" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Petunjuk folder Dokumen", { exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", {
      name: "Hubungkan dan izinkan baca untuk Dokumen",
    })
    .click();
  await expect(localSearch).toBeVisible();
  expect(fixture.grantWrites).toHaveLength(3);
  expect(fixture.grantWrites[2]).toEqual({
    approval: "read_only_project_root",
    rootId: secondRootId,
  });

  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.locator("#workspace-composer").screenshot({
    path: resolve(screenshotDirectory, "workspace-folder-reconnect-390.png"),
    style: "nextjs-portal { display: none !important; }",
  });

  await localSearch.fill("Pulih");
  await page.getByRole("button", { name: "Cari", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /MULAI\.md · baris 1/ }),
  ).toBeVisible();
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("a folder remains connected when read access fails and can be retried", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    failGrantNumbers: [1],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace");
  await openWorkspaceFolderAccess(page);
  await page.getByRole("button", { name: "Hubungkan folder" }).click();
  await page.getByRole("button", { name: "FP_PBKK", exact: true }).click();
  await page.getByRole("button", { name: "Pilih folder “FP_PBKK”" }).click();
  await page
    .getByRole("button", {
      name: "Hubungkan dan izinkan baca untuk FP_PBKK",
    })
    .click();

  await expect(
    page.getByText("FP_PBKK sudah didaftarkan. Akses baca belum aktif.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Izin baca sementara belum tersedia." }),
  ).toContainText("Izin baca sementara belum tersedia.");
  expect(fixture.registrationWrites).toEqual([
    { selectionToken: "selection-token" },
  ]);
  expect(fixture.grantWrites).toEqual([
    { approval: "read_only_project_root", rootId: firstRootId },
  ]);

  const retry = page.getByRole("button", {
    name: "Hubungkan dan izinkan baca untuk FP_PBKK",
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(
    page.getByRole("search", { name: "Cari di folder lokal" }),
  ).toBeVisible();
  expect(fixture.grantWrites).toEqual([
    { approval: "read_only_project_root", rootId: firstRootId },
    { approval: "read_only_project_root", rootId: firstRootId },
  ]);
  expect(fixture.registrationWrites).toHaveLength(1);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("remote or untrusted deployments show folder chooser as unavailable", async ({
  page,
}) => {
  const fixture = await installWorkspaceFixtures(page, {
    directoryPickerAvailable: false,
  });
  await page.goto("/settings");

  await expect(
    page.getByText(
      /Pemilih folder hanya tersedia dari aplikasi lokal loopback dengan koneksi same-origin/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hubungkan folder", exact: true }),
  ).toBeDisabled();
  expect(fixture.registrationWrites).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
});
