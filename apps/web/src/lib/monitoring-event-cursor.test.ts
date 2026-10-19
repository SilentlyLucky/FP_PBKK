import { describe, expect, it } from "vitest";

import {
  decodeMonitoringEventCursor,
  encodeMonitoringEventCursor,
  monitoringEventCursorFromRequest,
  monitoringEventCursorRequest,
} from "./monitoring-event-cursor.js";

const cursor = {
  createdAt: "2026-10-16 12:00:00.123456+00",
  id: "d0f3c340-2d63-4b58-b82f-61e7b1b0b623",
};

describe("project monitoring event cursors", () => {
  it("round-trips the exact database timestamp and event id", () => {
    const encoded = encodeMonitoringEventCursor(cursor);
    expect(decodeMonitoringEventCursor(encoded)).toEqual(cursor);
  });

  it("round-trips durable bigint ordinals without converting them to numbers", () => {
    const durable = {
      version: 2 as const,
      projectId: "0d5a5412-7abe-4a48-b733-4e41508c9fc0",
      ordinal: "9007199254740993",
      eventId: "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
    };

    expect(
      decodeMonitoringEventCursor(encodeMonitoringEventCursor(durable)),
    ).toEqual(durable);
  });

  it("rejects malformed, oversized, and invalid identity cursors", () => {
    expect(decodeMonitoringEventCursor("not-a-cursor")).toBeNull();
    expect(decodeMonitoringEventCursor("A".repeat(513))).toBeNull();
    expect(
      decodeMonitoringEventCursor(
        Buffer.from(
          JSON.stringify({
            createdAt: "2026-10-16T12:00:00Z",
            id: "not-a-uuid",
          }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });

  it("rejects non-decimal, leading-zero, and out-of-range durable ordinals", () => {
    const decode = (ordinal: string) =>
      decodeMonitoringEventCursor(
        Buffer.from(
          JSON.stringify({
            version: 2,
            projectId: "0d5a5412-7abe-4a48-b733-4e41508c9fc0",
            ordinal,
            eventId: "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
          }),
        ).toString("base64url"),
      );

    expect(decode("01")).toBeNull();
    expect(decode("1.0")).toBeNull();
    expect(decode("9007199254740993x")).toBeNull();
    expect(decode("9223372036854775808")).toBeNull();
    expect(decode("0")).toBeNull();
  });

  it("uses Last-Event-ID on reconnect and the query cursor on first connect", () => {
    const encoded = encodeMonitoringEventCursor(cursor);
    const resumed = new Request("http://localhost/events?after=ignored", {
      headers: { "Last-Event-ID": encoded },
    });
    const initial = new Request(`http://localhost/events?after=${encoded}`);

    expect(monitoringEventCursorFromRequest(resumed)).toEqual(cursor);
    expect(monitoringEventCursorFromRequest(initial)).toEqual(cursor);
  });

  it("distinguishes an absent cursor from an explicitly invalid cursor", () => {
    expect(
      monitoringEventCursorRequest(new Request("http://localhost/events")),
    ).toEqual({ status: "none" });
    expect(
      monitoringEventCursorRequest(
        new Request("http://localhost/events?after=not-a-cursor"),
      ),
    ).toEqual({ status: "invalid" });
    expect(
      monitoringEventCursorRequest(
        new Request("http://localhost/events", {
          headers: { "Last-Event-ID": "not-a-cursor" },
        }),
      ),
    ).toEqual({ status: "invalid" });
  });
});
