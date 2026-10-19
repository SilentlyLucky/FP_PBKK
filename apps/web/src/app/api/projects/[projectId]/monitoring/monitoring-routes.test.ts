import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeMonitoringEventCursor } from "@/lib/monitoring-event-cursor.js";

const mockState = vi.hoisted(() => ({
  unavailable: true,
  calls: 0,
  durableInstalled: false,
  cursorMapping: null as { ordinal: bigint; eventId: string } | null,
  cursorLookupCount: 0,
  durablePageRows: null as Array<Record<string, unknown>> | null,
  durableExecuteCount: 0,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => {
      mockState.calls += 1;
      if (mockState.unavailable)
        return {
          response: Response.json(
            { error: "DATABASE_UNAVAILABLE" },
            { status: 503 },
          ),
        };
      const query = (fields: string[]) => {
        const builder = {
          from: () => builder,
          where: () => builder,
          limit: async () => {
            if (fields.includes("ordinal")) {
              mockState.cursorLookupCount += 1;
              return mockState.cursorMapping ? [mockState.cursorMapping] : [];
            }
            return [{ id: projectId }];
          },
        };
        return builder;
      };
      return {
        db: {
          select: (selection: Record<string, unknown>) =>
            query(Object.keys(selection)),
          execute: async () => {
            if (mockState.durablePageRows) {
              if (mockState.durableExecuteCount > 0) {
                return { rows: mockState.durablePageRows };
              }
              mockState.durableExecuteCount += 1;
            }
            return {
              rows: [
                {
                  outbox_table: mockState.durableInstalled
                    ? "monitoring_event_outbox"
                    : null,
                  counter_table: mockState.durableInstalled
                    ? "monitoring_event_counters"
                    : null,
                },
              ],
            };
          },
        } as never,
      };
    },
  };
});

import { GET as eventsGET } from "./events/route.js";
import { GET as requestsGET } from "./requests/route.js";
import { GET as summaryGET } from "./summary/route.js";

const projectId = "0d5a5412-7abe-4a48-b733-4e41508c9fc0";
const context = (id = projectId) => ({
  params: Promise.resolve({ projectId: id }),
});
const url = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("monitoring route validation and unavailable database behavior", () => {
  beforeEach(() => {
    mockState.unavailable = true;
    mockState.calls = 0;
    mockState.durableInstalled = false;
    mockState.cursorMapping = null;
    mockState.cursorLookupCount = 0;
    mockState.durablePageRows = null;
    mockState.durableExecuteCount = 0;
  });

  it("rejects invalid project IDs before requesting a database", async () => {
    const summary = await summaryGET(
      url("/api/projects/bad/monitoring/summary?range=24h"),
      context("bad"),
    );
    const requests = await requestsGET(
      url("/api/projects/bad/monitoring/requests?range=24h"),
      context("bad"),
    );

    expect(summary.status).toBe(400);
    expect(requests.status).toBe(400);
    expect(mockState.calls).toBe(0);
  });

  it.each([
    ["unsupported named range", "?range=all"],
    ["missing custom range end", "?from=2026-01-01T00:00:00Z"],
    [
      "custom range over 90 days",
      "?from=2026-01-01T00:00:00Z&to=2026-04-03T00:00:00Z",
    ],
  ])(
    "rejects summary %s before requesting a database",
    async (_name, query) => {
      const response = await summaryGET(
        url(`/api/projects/${projectId}/monitoring/summary${query}`),
        context(),
      );
      expect(response.status).toBe(400);
      expect(await responseBody(response)).toMatchObject({
        error: "INVALID_MONITORING_RANGE",
      });
      expect(mockState.calls).toBe(0);
    },
  );

  it.each([
    ["invalid page", "?range=24h&page=0"],
    ["oversized page size", "?range=24h&pageSize=51"],
    ["unsupported status", "?range=24h&status=partial"],
    ["unsupported provider", "?range=24h&provider=unknown"],
    ["unsupported purpose", "?range=24h&purpose=unknown"],
    ["oversized search", `?range=24h&search=${"x".repeat(121)}`],
    ["unsupported range", "?range=all"],
  ])(
    "rejects request-log %s before requesting a database",
    async (_name, query) => {
      const response = await requestsGET(
        url(`/api/projects/${projectId}/monitoring/requests${query}`),
        context(),
      );
      expect(response.status).toBe(400);
      const body = await responseBody(response);
      expect(body.error).toMatch(
        /INVALID_MONITORING_RANGE|INVALID_REQUEST_FILTER/,
      );
      expect(mockState.calls).toBe(0);
    },
  );

  it("returns a safe unavailable response for summary and request logs", async () => {
    const summary = await summaryGET(
      url(`/api/projects/${projectId}/monitoring/summary?range=24h`),
      context(),
    );
    const requests = await requestsGET(
      url(`/api/projects/${projectId}/monitoring/requests?range=24h`),
      context(),
    );

    expect(summary.status).toBe(503);
    expect(requests.status).toBe(503);
    expect(await responseBody(summary)).toEqual({
      error: "DATABASE_UNAVAILABLE",
    });
    expect(await responseBody(requests)).toEqual({
      error: "DATABASE_UNAVAILABLE",
    });
    expect(mockState.calls).toBe(2);
  });

  it("rejects an invalid event cursor after project resolution without opening SSE", async () => {
    mockState.unavailable = false;
    const response = await eventsGET(
      url(`/api/projects/${projectId}/monitoring/events?after=not-a-cursor`),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({
      error: "INVALID_EVENT_CURSOR",
    });
    expect(mockState.calls).toBe(1);
  });

  it("advertises bounded legacy mode and rejects durable cursors when the migration is absent", async () => {
    mockState.unavailable = false;
    const controller = new AbortController();
    const response = await eventsGET(
      url(`/api/projects/${projectId}/monitoring/events`, {
        signal: controller.signal,
      }),
      context(),
    );

    expect(response.headers.get("x-monitoring-cursor-mode")).toBe(
      "bounded-legacy",
    );
    controller.abort();

    const durableCursor = encodeMonitoringEventCursor({
      version: 2,
      projectId,
      ordinal: "1",
      eventId: "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
    });
    const unsupported = await eventsGET(
      url(
        `/api/projects/${projectId}/monitoring/events?after=${durableCursor}`,
      ),
      context(),
    );

    expect(unsupported.status).toBe(409);
    expect(await responseBody(unsupported)).toEqual({
      error: "DURABLE_EVENT_CURSOR_UNSUPPORTED",
      resync: true,
    });
  });

  it("rejects a durable reconnect cursor bound to another project", async () => {
    mockState.unavailable = false;
    mockState.durableInstalled = true;
    const durableCursor = encodeMonitoringEventCursor({
      version: 2,
      projectId: "1d5a5412-7abe-4a48-b733-4e41508c9fc0",
      ordinal: "1",
      eventId: "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
    });
    const response = await eventsGET(
      url(
        `/api/projects/${projectId}/monitoring/events?after=${durableCursor}`,
      ),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await responseBody(response)).toEqual({
      error: "EVENT_CURSOR_PROJECT_MISMATCH",
      resync: true,
    });
    expect(mockState.cursorLookupCount).toBe(0);
  });

  it("uses the durable mode after schema detection and resolves a legacy cursor within the project", async () => {
    mockState.unavailable = false;
    mockState.durableInstalled = true;
    const eventId = "4d5a5412-7abe-4a48-b733-4e41508c9fc0";
    mockState.cursorMapping = { ordinal: 9007199254740993n, eventId };
    const legacyCursor = encodeMonitoringEventCursor({
      createdAt: "2026-10-16 12:00:00.123456+00",
      id: eventId,
    });
    const controller = new AbortController();
    const response = await eventsGET(
      url(
        `/api/projects/${projectId}/monitoring/events?after=${legacyCursor}`,
        { signal: controller.signal },
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-monitoring-cursor-mode")).toBe("durable-v2");
    expect(mockState.cursorLookupCount).toBe(1);
    controller.abort();
  });

  it("serializes durable SSE rows when raw Drizzle timestamps arrive as strings", async () => {
    mockState.unavailable = false;
    mockState.durableInstalled = true;
    mockState.durablePageRows = [
      {
        high_water: "1",
        ordinal: "1",
        outbox_event_id: "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
        run_event_id: "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
        run_id: "2d5a5412-7abe-4a48-b733-4e41508c9fc0",
        attempt_id: null,
        sequence: 1,
        event_type: "run.status",
        created_at: "2026-10-17T05:00:00.123Z",
        cursor_at: "2026-10-17 05:00:00.123+00",
      },
    ];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const response = await eventsGET(
      url(`/api/projects/${projectId}/monitoring/events`, {
        signal: controller.signal,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let body = "";
    try {
      while (
        !body.includes("event: monitoring.activity") &&
        !controller.signal.aborted
      ) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        body += new TextDecoder().decode(chunk.value);
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    }

    expect(body).toContain("event: monitoring.activity");
    expect(body).not.toContain("event: monitoring.error");
    expect(body).toContain('"timestamp":"2026-10-17T05:00:00.123Z"');
  });
});
