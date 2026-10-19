import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Route } from "@playwright/test";

const projectId = "0d5a5412-7abe-4a48-b733-4e41508c9fc0";
const runId = "2d5a5412-7abe-4a48-b733-4e41508c9fc0";
const canceledRunId = "3d5a5412-7abe-4a48-b733-4e41508c9fc0";
const timestamp = "2026-10-17T05:00:00.000Z";

const project = {
  id: projectId,
  name: "OFFLINE FIXTURE · NOT LIVE TELEMETRY",
  objective: "Fixture lokal untuk tampilan aktivitas run.",
};

const run = {
  id: runId,
  promptVersionId: "fixture-version",
  promptText: "PRIVATE PROMPT FIXTURE — should not appear in the timeline.",
  promptName: "Fixture prompt",
  purpose: "target",
  provider: "codex_app_server",
  requestedModel: "gpt-6-codex",
  responseModel: "gpt-6-codex",
  status: "succeeded",
  errorCode: null,
  errorSummary: null,
  createdAt: timestamp,
};

const canceledRun = {
  ...run,
  id: canceledRunId,
  promptText: "PRIVATE CANCELED PROMPT FIXTURE.",
  status: "canceled",
};

const activityEvents = [
  {
    id: "event-1",
    sequence: 1,
    timestamp,
    eventType: "run.status",
    payload: { status: "queued" },
  },
  {
    id: "event-2",
    sequence: 2,
    timestamp,
    eventType: "run.status",
    payload: { status: "running" },
  },
  {
    id: "event-3",
    sequence: 3,
    timestamp,
    eventType: "agent.action",
    payload: {
      mode: "prompt_optimization",
      phase: "target_test",
      provider: "codex_app_server",
      model: "gpt-6-codex",
      reasoningEffort: "high",
      subject: "candidate",
      summary: "PRIVATE MODEL REASONING FIXTURE.",
      prompt: "PRIVATE PROMPT IN EVENT.",
    },
  },
  {
    id: "event-4",
    sequence: 4,
    timestamp,
    eventType: "usage.snapshot",
    payload: {
      provider: "codex_app_server",
      purpose: "target",
      responseModel: "gpt-6-codex",
      usage: {
        inputTokens: { status: "reported", value: 1_200 },
        outputTokens: { status: "estimated", value: 47 },
        cacheReadTokens: { status: "unknown", value: null },
        cacheWriteTokens: { status: "unknown", value: null },
        completeness: "partial",
      },
    },
  },
  {
    id: "event-5",
    sequence: 5,
    timestamp,
    eventType: "agent.action",
    payload: {
      mode: "prompt_optimization",
      phase: "decision",
      provider: "campus_gateway",
      model: "senopati-optimizer",
      turn: 1,
      selectedTools: ["search_knowledge", "get_graph_evidence"],
      summary: "PRIVATE SENOPATI REASONING FIXTURE.",
    },
  },
  {
    id: "event-6",
    sequence: 6,
    timestamp,
    eventType: "tool.started",
    payload: {
      toolName: "search_knowledge",
      retrievalStrategy: "graph",
      argumentsSummary: {
        sourceCount: 2,
        queryCharacters: 65,
        query: "PRIVATE SEARCH QUERY.",
        path: "/private/user/source.txt",
      },
      summary: "PRIVATE TOOL ARGUMENT SUMMARY.",
    },
  },
  {
    id: "event-7",
    sequence: 7,
    timestamp,
    eventType: "tool.completed",
    payload: {
      toolName: "search_knowledge",
      retrievalStrategy: "graph",
      resultSummary: { resultCount: 3, truncated: false },
      summary: "PRIVATE TOOL RESULT SUMMARY.",
    },
  },
  {
    id: "event-8",
    sequence: 8,
    timestamp,
    eventType: "tool.completed",
    payload: {
      toolName: "get_graph_evidence",
      resultSummary: { resultCount: 2 },
    },
  },
  {
    id: "event-9",
    sequence: 9,
    timestamp,
    eventType: "tool.started",
    payload: {
      tool: "campus_graph_extraction",
      attemptNumber: 1,
      provider: "campus_gateway",
      responseModel: "qwen3:14b",
      purpose: "graph_indexing",
    },
  },
  {
    id: "event-10",
    sequence: 10,
    timestamp,
    eventType: "tool.completed",
    payload: {
      tool: "campus_graph_extraction",
      status: "succeeded",
      provider: "campus_gateway",
      responseModel: "qwen3:14b",
      purpose: "graph_indexing",
    },
  },
  {
    id: "event-11",
    sequence: 11,
    timestamp,
    eventType: "run.completed",
    payload: {
      status: "succeeded",
      mode: "prompt_optimization",
      text: "PRIVATE PROMPT EVENT TEXT.",
      result: {
        status: "no_change_recommended",
        candidate: {
          outcome: "no_change_recommended",
          prompt: "PRIVATE COMPLETION PROMPT.",
        },
      },
      token: "sk-live-fixture-secret",
      path: "/home/person/private.txt",
    },
  },
];

const canceledEvents = [
  {
    id: "canceled-event-1",
    sequence: 1,
    timestamp,
    eventType: "run.status",
    payload: { status: "canceled", remoteOutcomeMayBeUnknown: true },
  },
];

function jsonResponse(route: Route, value: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
  });
}

test("shows actual run actions and tools with safe keyboard disclosures", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript((id) => {
    window.localStorage.setItem("promptlab.activeProjectId", id);
  }, projectId);

  await page.route("**/api/**", async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    if (requestPath === "/api/projects")
      return jsonResponse(route, { projects: [project] });
    if (requestPath === `/api/projects/${projectId}/runs`)
      return jsonResponse(route, { runs: [run, canceledRun] });
    if (requestPath === `/api/projects/${projectId}/runs/${runId}/events`) {
      const body = activityEvents
        .map(
          (event) =>
            `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body,
      });
    }
    if (
      requestPath === `/api/projects/${projectId}/runs/${canceledRunId}/events`
    ) {
      const body = canceledEvents
        .map(
          (event) =>
            `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body,
      });
    }
    if (requestPath === "/api/health")
      return jsonResponse(route, { status: "ok" });
    return route.fulfill({ status: 404, body: "Offline fixture only" });
  });

  await page.goto(`/runs?run=${runId}`);
  const projectPicker = page.getByLabel("Proyek", { exact: true });
  await expect(projectPicker).toHaveValue(projectId);
  await expect(projectPicker.locator("option:checked")).toHaveText(
    "OFFLINE FIXTURE · NOT LIVE TELEMETRY",
  );
  await expect(
    page.getByText("Memanggil Codex", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("gpt-6-codex", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Senopati memilih tool", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("search_knowledge", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("get_graph_evidence", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Mencari sumber pengetahuan · GraphRAG").first(),
  ).toBeVisible();
  await expect(page.getByText("Hasil memuat 3 item.")).toBeVisible();
  const activityList = page.getByRole("list", { name: "Urutan aktivitas run" });
  const searchActivities = activityList.locator("li").filter({
    has: page.getByText("Mencari sumber pengetahuan · GraphRAG", {
      exact: true,
    }),
  });
  await expect(searchActivities).toHaveCount(2);
  await expect(
    searchActivities.nth(0).getByText("Dimulai", { exact: true }),
  ).toBeVisible();
  await expect(
    searchActivities.nth(1).getByText("Selesai", { exact: true }),
  ).toBeVisible();

  const graphExtractionActivities = activityList.locator("li").filter({
    has: page.getByText("Mengekstrak graf sumber", { exact: true }),
  });
  await expect(graphExtractionActivities).toHaveCount(2);
  await expect(
    graphExtractionActivities.nth(0).getByText("Dimulai", { exact: true }),
  ).toBeVisible();
  await expect(
    graphExtractionActivities.nth(1).getByText("Selesai", { exact: true }),
  ).toBeVisible();
  await expect(
    graphExtractionActivities
      .nth(0)
      .getByText("Senopati · qwen3:14b", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Tidak ada perubahan prompt yang direkomendasikan", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Kandidat prompt tidak disajikan sebagai jawaban provider.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(page.locator('pre[aria-label="Output Run"]')).toHaveCount(0);

  await expect(
    page.getByText(
      /PRIVATE PROMPT|PRIVATE MODEL REASONING|PRIVATE SENOPATI REASONING|PRIVATE SEARCH QUERY|PRIVATE TOOL ARGUMENT|PRIVATE TOOL RESULT|sk-live-fixture-secret|\/private\/user\/source\.txt|\/home\/person\/private\.txt/,
    ),
  ).toHaveCount(0);

  const details = page
    .getByRole("list", { name: "Urutan aktivitas run" })
    .locator("li")
    .filter({ hasText: "Memanggil Codex" })
    .locator("details")
    .first();
  const disclosure = details.locator("summary");
  await expect(details).not.toHaveAttribute("open", "");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(details.getByText("Provider", { exact: true })).toBeVisible();

  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(
      screenshotDirectory,
      "run-activity-details-fixture-desktop.png",
    ),
    fullPage: true,
  });

  for (const width of [320, 360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(
      page.getByText("Memanggil Codex", { exact: true }),
    ).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow, `horizontal overflow at ${width}px`).toBe(
      false,
    );
  }

  await page.goto(`/runs?run=${canceledRunId}`);
  await expect(page.getByText("Dibatalkan", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Run dibatalkan. Periksa linimasa untuk kepastian hasil provider.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Run terhenti sebelum hasil provider dapat dipastikan.", {
      exact: true,
    }),
  ).toHaveCount(0);
});
