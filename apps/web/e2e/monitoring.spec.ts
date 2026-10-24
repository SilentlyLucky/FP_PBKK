import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";
import { expectActiveProjectId } from "./helpers/project-picker";

const projectId = "0d5a5412-7abe-4a48-b733-4e41508c9fc0";
const projectName = "OFFLINE FIXTURE · NOT LIVE TELEMETRY";
const runId = "2d5a5412-7abe-4a48-b733-4e41508c9fc0";
const fixtureTimestamp = "2026-10-17T05:00:00.000Z";

type FixtureMode = "populated" | "empty" | "unavailable";
type EventMode = "activity" | "empty" | "recovery";

interface ApiCall {
  method: string;
  path: string;
  search: string;
}

interface MonitoringFixtureState {
  summaryMode: FixtureMode;
  requestMode: FixtureMode;
  eventMode: EventMode;
  apiCalls: ApiCall[];
  eventCalls: string[];
  unexpectedRequests: string[];
}

interface RequestMetricFixture {
  status: "reported" | "estimated" | "unknown";
  value: number | null;
}

interface RequestFixture {
  attemptId: string;
  runId: string;
  attemptNumber: number;
  provider: string;
  purpose: string;
  requestedModel: string;
  responseModel: string | null;
  status: string;
  remoteOutcomeKnown: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  errorCode: string | null;
  usage: {
    inputTokens: RequestMetricFixture;
    outputTokens: RequestMetricFixture;
    cacheReadTokens: RequestMetricFixture;
    cacheWriteTokens: RequestMetricFixture;
    completeness: "complete" | "partial" | "unknown" | null;
  } | null;
}

const unavailableMetric = (): RequestMetricFixture => ({
  status: "unknown",
  value: null,
});

const reportedMetric = (value: number): RequestMetricFixture => ({
  status: "reported",
  value,
});

const estimatedMetric = (value: number): RequestMetricFixture => ({
  status: "estimated",
  value,
});

const requestFixtures: RequestFixture[] = Array.from(
  { length: 21 },
  (_unused, index) => {
    const attemptNumber = index + 1;
    const status =
      index === 20 ? "canceled" : index < 3 ? "failed" : "succeeded";

    return {
      attemptId: `00000000-0000-4000-8000-${String(attemptNumber).padStart(12, "0")}`,
      runId,
      attemptNumber,
      provider: "fixture",
      purpose: "target",
      requestedModel:
        index === 0
          ? '=HYPERLINK("https://example.invalid","demo")'
          : `fixture-model-${attemptNumber}`,
      responseModel: null,
      status,
      remoteOutcomeKnown: status !== "failed",
      startedAt: fixtureTimestamp,
      finishedAt: "2026-10-17T05:00:01.000Z",
      durationMs: 1_000,
      timeToFirstTokenMs: 320,
      tokensPerSecond: 19.5,
      errorCode: status === "failed" ? "FIXTURE_PROVIDER_REJECTED" : null,
      usage:
        index === 0
          ? {
              inputTokens: reportedMetric(1_200),
              outputTokens: reportedMetric(480),
              cacheReadTokens: unavailableMetric(),
              cacheWriteTokens: unavailableMetric(),
              completeness: "partial",
            }
          : index === 1
            ? {
                inputTokens: estimatedMetric(400),
                outputTokens: unavailableMetric(),
                cacheReadTokens: unavailableMetric(),
                cacheWriteTokens: unavailableMetric(),
                completeness: "partial",
              }
            : null,
    };
  },
);

function createFixtureState(
  overrides: Partial<MonitoringFixtureState> = {},
): MonitoringFixtureState {
  return {
    summaryMode: "populated",
    requestMode: "populated",
    eventMode: "activity",
    apiCalls: [],
    eventCalls: [],
    unexpectedRequests: [],
    ...overrides,
  };
}

function summaryPayload(mode: FixtureMode, range: string) {
  const common = {
    projectId,
    range: {
      from: "2026-10-16T00:00:00.000Z",
      to: "2026-10-17T00:00:00.000Z",
      label: range,
    },
    refreshedAt: "2026-10-17T06:00:00.000Z",
  };

  if (mode === "empty") {
    return {
      ...common,
      summary: {
        requests: {
          total: 0,
          succeeded: 0,
          failed: 0,
          canceled: 0,
          unknown: 0,
          inProgress: 0,
          byStatus: {},
          errorRate: null,
          errorRateDenominator: 0,
        },
        activeRuns: { total: 0, byStatus: {} },
        tokens: {
          input: {
            reported: null,
            estimated: null,
            reportedRecords: 0,
            estimatedRecords: 0,
          },
          output: {
            reported: null,
            estimated: null,
            reportedRecords: 0,
            estimatedRecords: 0,
          },
          cacheRead: {
            reported: null,
            estimated: null,
            reportedRecords: 0,
            estimatedRecords: 0,
          },
          cacheWrite: {
            reported: null,
            estimated: null,
            reportedRecords: 0,
            estimatedRecords: 0,
          },
          cacheReadShare: null,
          cacheReadShareRecords: 0,
          usageRecords: 0,
        },
        latency: [],
        timeToFirstToken: [],
        tokensPerSecond: [],
        agentActivity: {
          eventsInRange: 0,
          lastObservedAt: null,
          status: "unavailable",
        },
        worker: {
          status: "unavailable",
          lastHeartbeatAt: null,
          reason: "No worker heartbeat in offline test data.",
        },
      },
    };
  }

  return {
    ...common,
    summary: {
      requests: {
        total: 21,
        succeeded: 17,
        failed: 3,
        canceled: 1,
        unknown: 0,
        inProgress: 0,
        byStatus: { succeeded: 17, failed: 3, canceled: 1 },
        errorRate: 3 / 20,
        errorRateDenominator: 20,
      },
      activeRuns: { total: 1, byStatus: { running: 1 } },
      tokens: {
        input: {
          reported: 1_200,
          estimated: 400,
          reportedRecords: 1,
          estimatedRecords: 1,
        },
        output: {
          reported: 480,
          estimated: null,
          reportedRecords: 1,
          estimatedRecords: 0,
        },
        cacheRead: {
          reported: null,
          estimated: null,
          reportedRecords: 0,
          estimatedRecords: 0,
        },
        cacheWrite: {
          reported: null,
          estimated: null,
          reportedRecords: 0,
          estimatedRecords: 0,
        },
        cacheReadShare: null,
        cacheReadShareRecords: 0,
        usageRecords: 2,
      },
      latency: [
        {
          provider: "fixture",
          purpose: "target",
          samples: 1,
          median: 1_000,
          p95: 1_000,
        },
      ],
      timeToFirstToken: [],
      tokensPerSecond: [],
      agentActivity: {
        eventsInRange: 4,
        lastObservedAt: fixtureTimestamp,
        status: "observed",
      },
      worker: {
        status: "unavailable",
        lastHeartbeatAt: null,
        reason: "No worker heartbeat in offline test data.",
      },
    },
  };
}

function requestPayload(mode: FixtureMode, search: URLSearchParams) {
  const page = Number(search.get("page") ?? "1");
  const pageSize = Number(search.get("pageSize") ?? "20");
  const status = search.get("status") ?? "all";
  const provider = search.get("provider") ?? "all";
  const purpose = search.get("purpose") ?? "all";
  const query = (search.get("search") ?? "").toLocaleLowerCase("id-ID");

  if (mode === "empty")
    return { projectId, page, pageSize, total: 0, totalPages: 0, requests: [] };

  const filtered = requestFixtures.filter((request) => {
    if (status !== "all" && request.status !== status) return false;
    if (provider !== "all" && request.provider !== provider) return false;
    if (purpose !== "all" && request.purpose !== purpose) return false;
    if (
      query &&
      ![
        request.attemptId,
        request.provider,
        request.requestedModel,
        request.responseModel,
      ].some((value) => value?.toLocaleLowerCase("id-ID").includes(query))
    )
      return false;
    return true;
  });
  const start = (page - 1) * pageSize;

  return {
    projectId,
    page,
    pageSize,
    total: filtered.length,
    totalPages: Math.ceil(filtered.length / pageSize),
    requests: filtered.slice(start, start + pageSize),
  };
}

function activityEvent(sequence: number) {
  return {
    id: `4d5a5412-7abe-4a48-b733-4e41508c9fc${sequence}`,
    runId,
    attemptId: null,
    sequence,
    timestamp: fixtureTimestamp,
    eventType: "usage.snapshot",
  };
}

function eventStream(eventName?: string, event?: unknown): string {
  const eventId =
    event && typeof event === "object" && "id" in event
      ? `id: ${(event as { id: string }).id}\n`
      : "";
  const message =
    eventName && event
      ? `${eventId}event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`
      : "";
  return `retry: 5000\n\n${message}`;
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function handleApiRequest(
  route: Route,
  state: MonitoringFixtureState,
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const call = { method, path: url.pathname, search: url.search };
  state.apiCalls.push(call);

  if (method === "GET" && url.pathname === "/api/projects") {
    await fulfillJson(route, {
      projects: [{ id: projectId, name: projectName, objective: null }],
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/providers") {
    await fulfillJson(route, {
      providers: [
        {
          provider: "codex_app_server",
          role: "target",
          status: "unavailable",
          requestedModel: null,
          responseModel: null,
          checkedAt: null,
          reason: "Provider status unavailable in offline test data.",
          capabilities: { quotaReporting: { status: "unknown" } },
        },
      ],
    });
    return;
  }

  if (
    method === "GET" &&
    url.pathname === `/api/projects/${projectId}/monitoring/summary`
  ) {
    if (state.summaryMode === "unavailable") {
      await fulfillJson(route, { error: "DATABASE_UNAVAILABLE" }, 503);
      return;
    }
    await fulfillJson(
      route,
      summaryPayload(state.summaryMode, url.searchParams.get("range") ?? "24h"),
    );
    return;
  }

  if (
    method === "GET" &&
    url.pathname === `/api/projects/${projectId}/monitoring/requests`
  ) {
    if (state.requestMode === "unavailable") {
      await fulfillJson(route, { error: "DATABASE_UNAVAILABLE" }, 503);
      return;
    }
    await fulfillJson(
      route,
      requestPayload(state.requestMode, url.searchParams),
    );
    return;
  }

  if (
    method === "GET" &&
    url.pathname === `/api/projects/${projectId}/monitoring/events`
  ) {
    const requestTarget = `${url.pathname}${url.search}`;
    state.eventCalls.push(requestTarget);
    const resync = url.searchParams.has("resync");
    const recovery = state.eventMode === "recovery";
    const body = resync
      ? eventStream("monitoring.activity", activityEvent(2))
      : recovery
        ? eventStream("monitoring.error", {
            error: "MONITORING_STREAM_UNAVAILABLE",
          })
        : state.eventMode === "activity"
          ? eventStream("monitoring.activity", activityEvent(1))
          : eventStream();
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
      body,
    });
    return;
  }

  if (method === "GET" && url.pathname === `/api/projects/${projectId}/runs`) {
    await fulfillJson(route, { runs: [] });
    return;
  }

  const description = `${method} ${url.pathname}${url.search}`;
  state.unexpectedRequests.push(description);
  await fulfillJson(
    route,
    { error: "UNEXPECTED_BROWSER_ACCEPTANCE_REQUEST" },
    599,
  );
}

async function installStrictApiFixtures(
  page: Page,
  state: MonitoringFixtureState,
): Promise<void> {
  const configuredBaseUrl = process.env.PROMPTLAB_ACCEPTANCE_BASE_URL;
  if (!configuredBaseUrl)
    throw new Error(
      "PROMPTLAB_ACCEPTANCE_BASE_URL must be configured by the acceptance config.",
    );
  const origin = new URL(configuredBaseUrl).origin;

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      state.unexpectedRequests.push(
        `${route.request().method()} ${url.origin}${url.pathname}`,
      );
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(route, state);
      return;
    }
    await route.continue();
  });
}

async function openMonitoring(
  page: Page,
  state: MonitoringFixtureState,
): Promise<void> {
  await installStrictApiFixtures(page, state);
  await page.goto("/monitoring");
  await expect(
    page.getByRole("heading", { name: "Monitoring", exact: true }),
  ).toBeVisible();
  await expectActiveProjectId(page, projectId);
  await expect(
    page.getByRole("heading", { name: "Log permintaan model" }),
  ).toBeVisible();
}

function hasRequestQuery(
  state: MonitoringFixtureState,
  expected: Record<string, string>,
): boolean {
  return state.apiCalls.some((call) => {
    if (call.path !== `/api/projects/${projectId}/monitoring/requests`)
      return false;
    const params = new URLSearchParams(call.search);
    return Object.entries(expected).every(
      ([key, value]) => params.get(key) === value,
    );
  });
}

function hasSummaryRange(
  state: MonitoringFixtureState,
  range: string,
): boolean {
  return state.apiCalls.some((call) => {
    if (call.path !== `/api/projects/${projectId}/monitoring/summary`)
      return false;
    return new URLSearchParams(call.search).get("range") === range;
  });
}

test("shows persisted usage provenance and captures desktop and narrow Monitoring", async ({
  page,
}) => {
  const state = createFixtureState();
  await openMonitoring(page, state);

  await expect(
    page.getByText(`Proyek aktif · ${projectName}`, { exact: true }),
  ).toBeVisible();
  const summary = page.getByRole("region", { name: "Ringkasan aktivitas" });
  await expect(summary).toContainText("21");
  await expect(summary).toContainText("17 berhasil · 3 gagal · 1 dibatalkan");
  await expect(summary).toContainText("1.200");
  await expect(summary).toContainText("Estimasi terpisah: 400");
  await expect(summary).toContainText("480");

  const diagnostics = page.locator("details").filter({
    has: page.getByText("Lihat coverage dan durasi", { exact: true }),
  });
  await diagnostics.locator("summary").click();
  await expect(diagnostics).toContainText("Input estimasi");
  await expect(diagnostics).toContainText("Cache read dilaporkan");
  await expect(
    page
      .getByText("Cache input dilaporkan", { exact: true })
      .locator("xpath=.."),
  ).toContainText("Tidak ada pasangan metrik provider yang kompatibel");
  await expect(diagnostics).toContainText(
    "Nilai unavailable tidak dihitung sebagai nol.",
  );

  const rangeControl = page.getByLabel("Rentang waktu monitoring");
  await rangeControl.selectOption("7d");
  await expect.poll(() => hasSummaryRange(state, "7d")).toBe(true);
  await expect(rangeControl).toHaveValue("7d");
  const summaryCallsBeforeRefresh = state.apiCalls.filter(
    (call) =>
      call.path === `/api/projects/${projectId}/monitoring/summary` &&
      new URLSearchParams(call.search).get("range") === "7d",
  ).length;
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect
    .poll(
      () =>
        state.apiCalls.filter(
          (call) =>
            call.path === `/api/projects/${projectId}/monitoring/summary` &&
            new URLSearchParams(call.search).get("range") === "7d",
        ).length,
    )
    .toBeGreaterThan(summaryCallsBeforeRefresh);
  await expect
    .poll(() =>
      hasRequestQuery(state, { range: "7d", page: "1", pageSize: "20" }),
    )
    .toBe(true);

  await rangeControl.selectOption("24h");
  await expect.poll(() => hasSummaryRange(state, "24h")).toBe(true);
  await expect(
    page.getByText("Usage tersimpan", { exact: true }),
  ).toBeVisible();

  const screenshotDirectory = resolve(
    process.cwd(),
    "apps/web/e2e/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "monitoring-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const tableWrap = document.querySelector<HTMLElement>("[class*=tableWrap]");
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      tableWrapWidth: tableWrap?.clientWidth ?? null,
      tableContentWidth: tableWrap?.scrollWidth ?? null,
      tableOverflowX: tableWrap ? getComputedStyle(tableWrap).overflowX : null,
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  if (
    layout.tableContentWidth !== null &&
    layout.tableWrapWidth !== null &&
    layout.tableContentWidth > layout.tableWrapWidth
  ) {
    expect(layout.tableOverflowX).toMatch(/auto|scroll/);
  }
  await page.screenshot({
    path: resolve(screenshotDirectory, "monitoring-narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(state.unexpectedRequests).toEqual([]);
});

test("filters and paginates request details and exports formula-safe CSV", async ({
  page,
}) => {
  const state = createFixtureState({ eventMode: "empty" });
  await openMonitoring(page, state);
  const logs = page.getByRole("region", { name: "Log permintaan model" });
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "all",
        provider: "all",
        purpose: "all",
      }),
    )
    .toBe(true);
  await expect(logs).toContainText(
    '=HYPERLINK("https://example.invalid","demo")',
  );

  await logs.getByText("Lihat", { exact: true }).first().click();
  await expect(logs).toContainText("ID request");
  await expect(logs).toContainText("Outcome remote");
  await expect(logs).toContainText("Tidak tersedia");
  await expect(logs).toContainText("Kelengkapan usage");

  await logs.getByLabel("Status").selectOption("failed");
  await expect(logs).toContainText("FIXTURE_PROVIDER_REJECTED");
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "failed",
        provider: "all",
        purpose: "all",
      }),
    )
    .toBe(true);
  await logs.getByRole("combobox").nth(1).selectOption("fixture");
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "failed",
        provider: "fixture",
        purpose: "all",
      }),
    )
    .toBe(true);
  await logs.getByLabel("Tujuan").selectOption("target");
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "failed",
        provider: "fixture",
        purpose: "target",
      }),
    )
    .toBe(true);

  await logs.getByLabel("Status").selectOption("all");
  await logs.getByRole("combobox").nth(1).selectOption("all");
  await logs.getByLabel("Tujuan").selectOption("all");
  await expect(logs).toContainText("Halaman 1 dari 2");
  await logs.getByRole("button", { name: "Berikutnya" }).click();
  await expect(logs).toContainText("Halaman 2 dari 2");
  await expect(logs).toContainText("fixture-model-21");
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "2",
        pageSize: "20",
        status: "all",
        provider: "all",
        purpose: "all",
      }),
    )
    .toBe(true);

  await logs.getByRole("button", { name: "Sebelumnya" }).click();
  await expect(logs).toContainText("Halaman 1 dari 2");
  const search = logs.getByLabel("Cari ID, model, atau provider");
  await search.fill("fixture-model-21");
  await expect(logs).toContainText("fixture-model-21");
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "all",
        provider: "all",
        purpose: "all",
        search: "fixture-model-21",
      }),
    )
    .toBe(true);
  await search.fill("");
  await expect(logs).toContainText(
    '=HYPERLINK("https://example.invalid","demo")',
  );
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "all",
        provider: "all",
        purpose: "all",
      }),
    )
    .toBe(true);

  const downloadPromise = page.waitForEvent("download");
  await logs.getByRole("button", { name: "Ekspor halaman ini" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "promptlab-monitoring-24h-halaman-1.csv",
  );
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const csv = await readFile(downloadPath!, "utf8");
  expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"",""demo"")"');
  expect(csv).not.toContain(
    '"=HYPERLINK(""https://example.invalid"",""demo"")"',
  );
  expect(state.unexpectedRequests).toEqual([]);
});

test("shows stored live activity after a disconnected stream is resynchronized", async ({
  page,
}) => {
  const state = createFixtureState({ eventMode: "recovery" });
  await openMonitoring(page, state);
  const activity = page.getByRole("region", { name: "Aktivitas langsung" });

  await expect(
    activity.getByText("Live activity terputus sementara; mencoba kembali."),
  ).toBeVisible();
  await expect(
    activity.getByText("Menghubungkan kembali", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Resinkronkan event terbaru" })
    .click();
  await expect(
    activity.getByText("Usage tersimpan", { exact: true }),
  ).toBeVisible();
  await expect(activity.getByText("#2", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      state.eventCalls.some((target) => target.endsWith("?resync=1&attempt=1")),
    )
    .toBe(true);
  expect(state.eventCalls).toContain(
    `/api/projects/${projectId}/monitoring/events`,
  );
  expect(state.unexpectedRequests).toEqual([]);
});

test("keeps empty telemetry unavailable and reports API failures without inventing values", async ({
  page,
}) => {
  const state = createFixtureState({
    summaryMode: "empty",
    requestMode: "empty",
    eventMode: "empty",
  });
  await openMonitoring(page, state);

  const summary = page.getByRole("region", { name: "Ringkasan aktivitas" });
  const logs = page.getByRole("region", { name: "Log permintaan model" });
  await expect(summary).toContainText("Tidak tersedia");
  await expect(summary).toContainText(
    "Belum ada attempt terminal yang memenuhi denominator",
  );
  await expect(logs).toContainText(
    "Belum ada attempt provider pada rentang ini.",
  );
  await expect(
    page.getByRole("region", { name: "Aktivitas langsung" }).getByRole("list"),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      hasRequestQuery(state, {
        range: "24h",
        page: "1",
        pageSize: "20",
        status: "all",
        provider: "all",
        purpose: "all",
      }),
    )
    .toBe(true);

  state.summaryMode = "unavailable";
  state.requestMode = "unavailable";
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect(
    page.getByText("Ringkasan telemetry tidak tersedia.", { exact: false }),
  ).toBeVisible();
  await expect(logs.getByRole("alert")).toContainText(
    "Log permintaan tidak tersedia.",
  );
  expect(state.unexpectedRequests).toEqual([]);
});
