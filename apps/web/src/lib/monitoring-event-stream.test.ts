import { describe, expect, it, vi } from "vitest";

import {
  decodeMonitoringEventCursor,
  type MonitoringEventCursor,
} from "./monitoring-event-cursor.js";
import {
  createDurableMonitoringEventStream,
  createMonitoringEventStream,
  type MonitoringDurableEventEntry,
  type MonitoringDurableEventLedger,
  type MonitoringDurableEventPage,
  type MonitoringEventLedger,
  type MonitoringEventRow,
} from "./monitoring-event-stream.js";
import type { MonitoringDurableEventCursor } from "./monitoring-event-cursor.js";
import {
  createMonitoringActivitySeenSet,
  rememberMonitoringActivity,
  type MonitoringActivityIdentity,
} from "./monitoring-client.js";

const projectA = "0d5a5412-7abe-4a48-b733-4e41508c9fc0";
const projectB = "1d5a5412-7abe-4a48-b733-4e41508c9fc0";
const runId = "2d5a5412-7abe-4a48-b733-4e41508c9fc0";
const attemptId = "3d5a5412-7abe-4a48-b733-4e41508c9fc0";

function event(
  id: string,
  cursorAt: string,
  sequence: number,
  extras: Record<string, unknown> = {},
): MonitoringEventRow {
  return {
    id,
    runId,
    attemptId,
    sequence,
    eventType: "run.status",
    createdAt: new Date(cursorAt),
    cursorAt,
    ...extras,
  };
}

function durableEntry(
  ordinal: string,
  row: MonitoringEventRow | null,
  eventId = row?.id ?? event3.id,
): MonitoringDurableEventEntry {
  return { ordinal, eventId, event: row };
}

class MockDurableEventLedger implements MonitoringDurableEventLedger {
  readonly calls: Array<{
    method: string;
    projectId: string;
    ordinal?: string;
  }> = [];
  latestPage: MonitoringDurableEventPage = { highWater: "0", entries: [] };
  afterPage: MonitoringDurableEventPage = { highWater: "0", entries: [] };

  async latestDurable(
    projectId: string,
    limit: number,
  ): Promise<MonitoringDurableEventPage> {
    this.calls.push({ method: "latest", projectId });
    return {
      ...this.latestPage,
      entries: this.latestPage.entries.slice(0, limit),
    };
  }

  async afterDurable(
    projectId: string,
    ordinal: string,
    limit: number,
  ): Promise<MonitoringDurableEventPage> {
    this.calls.push({ method: "after", projectId, ordinal });
    return {
      ...this.afterPage,
      entries: this.afterPage.entries.slice(0, limit),
    };
  }
}

const event1 = event(
  "4d5a5412-7abe-4a48-b733-4e41508c9fc0",
  "2026-10-16 12:00:00.000001+00",
  1,
  { payload: { prompt: "private prompt", token: "sk-test-secret-value" } },
);
const event2 = event(
  "5d5a5412-7abe-4a48-b733-4e41508c9fc0",
  "2026-10-16 12:00:00.000002+00",
  2,
);
const event3 = event(
  "bd5a5412-7abe-4a48-b733-4e41508c9fc0",
  "2026-10-16 12:00:00.000003+00",
  3,
  { eventType: "authorization=Bearer hidden-value" },
);

function comparePosition(
  left: { cursorAt?: string; createdAt?: Date | string; id: string },
  right: { cursorAt?: string; createdAt?: Date | string; id: string },
): number {
  const leftAt =
    left.cursorAt ?? (typeof left.createdAt === "string" ? left.createdAt : "");
  const rightAt =
    right.cursorAt ??
    (typeof right.createdAt === "string" ? right.createdAt : "");
  return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id);
}

class MockEventLedger implements MonitoringEventLedger {
  private rows: Array<{ projectId: string; event: MonitoringEventRow }> = [];
  readonly calls: Array<{ method: string; projectId: string }> = [];

  append(projectId: string, row: MonitoringEventRow): void {
    this.rows.push({ projectId, event: row });
  }

  async latest(
    projectId: string,
    limit: number,
  ): Promise<MonitoringEventRow[]> {
    this.calls.push({ method: "latest", projectId });
    return this.rows
      .filter((row) => row.projectId === projectId)
      .map((row) => row.event)
      .sort((left, right) => comparePosition(left, right))
      .slice(-limit);
  }

  async after(
    projectId: string,
    cursor: MonitoringEventCursor | null,
    limit: number,
  ): Promise<MonitoringEventRow[]> {
    this.calls.push({ method: "after", projectId });
    return this.rows
      .filter((row) => row.projectId === projectId)
      .map((row) => row.event)
      .filter((row) => !cursor || comparePosition(row, cursor) > 0)
      .sort((left, right) => comparePosition(left, right))
      .slice(0, limit);
  }

  async replayPage(
    projectId: string,
    floor: MonitoringEventCursor,
    after: MonitoringEventCursor | null,
    limit: number,
  ): Promise<MonitoringEventRow[]> {
    this.calls.push({ method: "replayPage", projectId });
    const floorTime = Date.parse(floor.createdAt) - 5 * 60_000;
    return this.rows
      .filter((row) => row.projectId === projectId)
      .map((row) => row.event)
      .filter(
        (row) =>
          Date.parse(row.cursorAt) >= floorTime &&
          (!after || comparePosition(row, after) > 0),
      )
      .sort((left, right) => comparePosition(left, right))
      .slice(0, limit);
  }
}

function controlledSleep() {
  const waiters: Array<() => void> = [];
  let active = 0;
  return {
    sleep: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        active += 1;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          active -= 1;
          signal.removeEventListener("abort", finish);
          resolve();
        };
        if (signal.aborted) {
          finish();
          return;
        }
        waiters.push(finish);
        signal.addEventListener("abort", finish, { once: true });
      }),
    wake: () => waiters.shift()?.(),
    get active() {
      return active;
    },
  };
}

async function nextActivity(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ frame: string; data: Record<string, unknown> }> {
  const decoder = new TextDecoder();
  while (true) {
    const result = await reader.read();
    if (result.done) throw new Error("Stream ended before an activity event");
    const frame = decoder.decode(result.value);
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (dataLine)
      return {
        frame,
        data: JSON.parse(dataLine.slice("data: ".length)) as Record<
          string,
          unknown
        >,
      };
  }
}

describe("monitoring event stream replay and reconciliation", () => {
  it("keeps events project-scoped and serializes metadata without payloads", async () => {
    const ledger = new MockEventLedger();
    ledger.append(projectA, event1);
    ledger.append(projectA, event2);
    ledger.append(projectA, event3);
    ledger.append(
      projectB,
      event("6d5a5412-7abe-4a48-b733-4e41508c9fc0", event2.cursorAt, 9),
    );
    const controller = new AbortController();
    const sleeper = controlledSleep();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: null,
      pollIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      sleep: sleeper.sleep,
    });
    const reader = result.stream.getReader();
    const first = await nextActivity(reader);
    const second = await nextActivity(reader);
    const third = await nextActivity(reader);

    expect(first.data.id).toBe(event1.id);
    expect(second.data.id).toBe(event2.id);
    expect(third.data).toMatchObject({
      id: event3.id,
      eventType: "monitoring.event",
    });
    expect(ledger.calls).toEqual([{ method: "latest", projectId: projectA }]);
    const frames = `${first.frame}${second.frame}${third.frame}`;
    expect(frames).not.toContain("private prompt");
    expect(frames).not.toContain("sk-test-secret-value");
    expect(frames).not.toContain("hidden-value");
    expect(
      JSON.parse(first.frame.match(/data: (.+)\n/)![1]!).payload,
    ).toBeUndefined();

    controller.abort();
    await result.done;
    expect(sleeper.active).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("preserves safe candidate proposal events without proposal content", async () => {
    const ledger = new MockEventLedger();
    ledger.append(
      projectA,
      event("8d5a5412-7abe-4a48-b733-4e41508c9fc0", event2.cursorAt, 4, {
        eventType: "candidate.proposed",
        payload: {
          summary: "private candidate summary",
          candidate: { prompt: "private candidate prompt" },
        },
      }),
    );
    const controller = new AbortController();
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: null,
      pollIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      sleep: controlledSleep().sleep,
    });
    const reader = result.stream.getReader();
    const proposal = await nextActivity(reader);

    expect(proposal.data.eventType).toBe("candidate.proposed");
    expect(proposal.data.payload).toBeUndefined();
    expect(proposal.frame).not.toMatch(
      /private candidate summary|private candidate prompt/,
    );
    controller.abort();
    await reader.cancel();
    await result.done;
  });

  it("sends allowlisted activity details without prompts, paths, or credentials", async () => {
    const ledger = new MockEventLedger();
    ledger.append(
      projectA,
      event("7d5a5412-7abe-4a48-b733-4e41508c9fc0", event2.cursorAt, 4, {
        eventType: "tool.started",
        payload: {
          toolName: "search_knowledge",
          retrievalStrategy: "graph",
          argumentsSummary: {
            sourceCount: 2,
            query: "private prompt search text",
            path: "/home/person/private.txt",
          },
          token: "sk-live-secret-value",
        },
      }),
    );
    const controller = new AbortController();
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: null,
      pollIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      sleep: controlledSleep().sleep,
    });
    const reader = result.stream.getReader();
    const eventResult = await nextActivity(reader);

    expect(eventResult.data.payload).toEqual({
      retrievalStrategy: "graph",
      toolName: "search_knowledge",
      argumentsSummary: { sourceCount: 2 },
    });
    expect(eventResult.frame).not.toMatch(
      /private prompt search text|\/home\/person\/private\.txt|sk-live-secret-value/,
    );
    controller.abort();
    await reader.cancel();
    await result.done;
  });

  it("projects Workspace completion to provenance counts without source text", async () => {
    const ledger = new MockEventLedger();
    ledger.append(
      projectA,
      event("6d5a5412-7abe-4a48-b733-4e41508c9fc0", event2.cursorAt, 4, {
        eventType: "run.completed",
        payload: {
          status: "succeeded",
          mode: "workspace_chat",
          text: "Private answer text",
          workspaceChat: {
            outcome: "optimized_prompt_executed",
            retrievalStrategy: "graph",
            sourceIds: [projectA, projectB],
            graphEvidenceStatus: "evidence_included",
            graphEvidence: [
              {
                quote: "Private graph quote",
                sourceRef: "/private/graph-source.md#p2",
                documentName: "private-graph.md",
              },
            ],
            graphTraceIds: ["private-graph-trace"],
            retrievalEvidenceStatus: "evidence_included",
            retrievalEvidence: [
              {
                quote: "Private lexical quote",
                sourceRef: "/private/lexical-source.md#p3",
                documentName: "private-lexical.md",
              },
            ],
            retrievalTraceIds: ["private-retrieval-trace"],
            targetContextHash: "a".repeat(64),
            targetPromptCharacters: 820,
            codexTargetCalls: 1,
            targetInputArtifact: {
              format: "promptlab-workspace-target-input-v1",
              targetInput: "Private exact target input and source quotes",
              evidencePacks: [{ contextText: "Private packed source text" }],
            },
          },
        },
      }),
    );
    const controller = new AbortController();
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: null,
      pollIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      sleep: controlledSleep().sleep,
    });
    const reader = result.stream.getReader();
    const completion = await nextActivity(reader);

    expect(completion.data.payload).toEqual({
      status: "succeeded",
      mode: "workspace_chat",
      answerPresent: true,
      workspaceChat: {
        retrievalStrategy: "graph",
        sourceCount: 2,
        graphEvidenceStatus: "evidence_included",
        retrievalEvidenceStatus: "evidence_included",
        graphEvidenceCount: 1,
        retrievalEvidenceCount: 1,
        traceCount: 2,
        targetCallCount: 1,
        targetPromptCharacters: 820,
        targetContextHashPresent: true,
        targetInputArtifactPresent: true,
        outcome: "optimized_prompt_executed",
      },
    });
    expect(completion.frame).not.toMatch(
      /Private answer text|Private graph quote|Private lexical quote|private-graph\.md|private-lexical\.md|Private exact target input|Private packed source text|private-graph-trace|private-retrieval-trace|\/private\//,
    );
    controller.abort();
    await reader.cancel();
    await result.done;
  });

  it("replays overlap on reconnect and lets the client suppress duplicate IDs and sequences", async () => {
    const ledger = new MockEventLedger();
    ledger.append(projectA, event1);
    ledger.append(projectA, event2);
    const seen = createMonitoringActivitySeenSet();
    expect(rememberMonitoringActivity(event1, seen)).toBe(true);
    expect(rememberMonitoringActivity(event2, seen)).toBe(true);
    const controller = new AbortController();
    const sleeper = controlledSleep();
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: { createdAt: event2.cursorAt, id: event2.id },
      pollIntervalMs: 60_000,
      reconciliationIntervalMs: 0,
      now: () => 1_000,
      sleep: sleeper.sleep,
    });
    const reader = result.stream.getReader();
    const replayedFirst = await nextActivity(reader);
    const replayedSecond = await nextActivity(reader);

    expect(replayedFirst.data.id).toBe(event1.id);
    expect(replayedSecond.data.id).toBe(event2.id);
    expect(
      rememberMonitoringActivity(
        replayedFirst.data as unknown as MonitoringActivityIdentity,
        seen,
      ),
    ).toBe(false);
    expect(
      rememberMonitoringActivity(
        replayedSecond.data as unknown as MonitoringActivityIdentity,
        seen,
      ),
    ).toBe(false);

    controller.abort();
    await result.done;
    expect(sleeper.active).toBe(0);
  });

  it("finds a row committed late behind the emitted cursor within the replay window", async () => {
    const ledger = new MockEventLedger();
    ledger.append(projectA, event1);
    ledger.append(projectA, event2);
    let now = 1_000;
    const sleeper = controlledSleep();
    const controller = new AbortController();
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: null,
      pollIntervalMs: 1_000,
      reconciliationIntervalMs: 15,
      now: () => now,
      sleep: sleeper.sleep,
    });
    const reader = result.stream.getReader();
    await nextActivity(reader);
    await nextActivity(reader);

    const late = event(
      "7d5a5412-7abe-4a48-b733-4e41508c9fc0",
      "2026-10-16 11:59:59.999999+00",
      3,
    );
    ledger.append(projectA, late);
    now += 16;
    sleeper.wake();
    const discovered = await nextActivity(reader);

    expect(discovered.data.id).toBe(late.id);
    expect(discovered.frame).toContain("event: monitoring.activity");
    const sseCursor = decodeMonitoringEventCursor(
      discovered.frame.match(/^id: (.+)$/m)?.[1],
    );
    expect(sseCursor).toEqual({ createdAt: event2.cursorAt, id: event2.id });
    expect(
      sseCursor && "createdAt" in sseCursor ? sseCursor.createdAt : null,
    ).toContain(".000002");
    expect(ledger.calls.some((call) => call.method === "replayPage")).toBe(
      true,
    );

    controller.abort();
    await result.done;
    expect(sleeper.active).toBe(0);
  });

  it("keeps resync bounded to the latest 100 plus the five-minute replay window", async () => {
    const ledger = new MockEventLedger();
    const oldLate = event(
      "8d5a5412-7abe-4a48-b733-4e41508c9fc0",
      "2026-10-16 11:54:59.999999+00",
      1,
    );
    ledger.append(projectA, oldLate);
    for (let index = 0; index < 101; index += 1) {
      const id = `9d5a5412-7abe-4a48-b733-${index.toString(16).padStart(12, "0")}`;
      const minute = 55 + Math.floor(index / 60);
      const seconds = String(index % 60).padStart(2, "0");
      ledger.append(
        projectA,
        event(id, `2026-10-16 11:${minute}:${seconds}.000000+00`, index + 1),
      );
    }
    const latest = event(
      "ad5a5412-7abe-4a48-b733-4e41508c9fc0",
      "2026-10-16 12:00:00.000000+00",
      102,
    );
    ledger.append(projectA, latest);

    const controller = new AbortController();
    const sleeper = controlledSleep();
    const result = createMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: { createdAt: latest.cursorAt, id: latest.id },
      resync: true,
      pollIntervalMs: 60_000,
      reconciliationIntervalMs: 0,
      now: () => 1_000,
      sleep: sleeper.sleep,
    });
    const reader = result.stream.getReader();
    const delivered = new Set<string>();
    for (let index = 0; index < 102; index += 1) {
      const item = await nextActivity(reader);
      delivered.add(String(item.data.id));
    }

    expect(ledger.calls[0]).toEqual({ method: "latest", projectId: projectA });
    expect(delivered.size).toBe(102);
    expect(delivered.has(oldLate.id)).toBe(false);

    controller.abort();
    await result.done;
    expect(sleeper.active).toBe(0);
  });
});

describe("durable monitoring event stream cursors", () => {
  it("reconnects with exact decimal bigint ordinals and project-scoped reads", async () => {
    const ledger = new MockDurableEventLedger();
    const cursor: MonitoringDurableEventCursor = {
      version: 2,
      projectId: projectA,
      ordinal: "9007199254740993",
      eventId: event2.id,
    };
    ledger.afterPage = {
      highWater: "9007199254740994",
      entries: [durableEntry("9007199254740994", event3)],
    };
    const controller = new AbortController();
    const sleeper = controlledSleep();
    const result = createDurableMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor,
      pollIntervalMs: 60_000,
      sleep: sleeper.sleep,
    });
    const reader = result.stream.getReader();
    const item = await nextActivity(reader);

    expect(item.data.id).toBe(event3.id);
    expect(ledger.calls[0]).toEqual({
      method: "after",
      projectId: projectA,
      ordinal: "9007199254740993",
    });
    expect(
      decodeMonitoringEventCursor(item.frame.match(/^id: (.+)$/m)?.[1]),
    ).toEqual({
      version: 2,
      projectId: projectA,
      ordinal: "9007199254740994",
      eventId: event3.id,
    });

    controller.abort();
    await result.done;
    expect(sleeper.active).toBe(0);
  });

  it("requests resync when a reconnect crosses a missing retained ordinal", async () => {
    const ledger = new MockDurableEventLedger();
    ledger.afterPage = {
      highWater: "3",
      entries: [durableEntry("3", event3)],
    };
    const controller = new AbortController();
    const result = createDurableMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: {
        version: 2,
        projectId: projectA,
        ordinal: "1",
        eventId: event1.id,
      },
      sleep: controlledSleep().sleep,
    });
    const reader = result.stream.getReader();
    const gap = await nextActivity(reader);

    expect(gap.frame).toContain("event: monitoring.resync-required");
    expect(gap.data).toMatchObject({
      error: "MONITORING_RESYNC_REQUIRED",
      reason: "OUTBOX_GAP",
      expectedOrdinal: "2",
      resync: true,
    });
    expect(gap.frame).not.toContain("monitoring.activity");
    await result.done;
  });

  it("reports a retention gap when outbox metadata remains but its event row is gone", async () => {
    const ledger = new MockDurableEventLedger();
    ledger.afterPage = {
      highWater: "2",
      entries: [durableEntry("2", null, event2.id)],
    };
    const controller = new AbortController();
    const result = createDurableMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: {
        version: 2,
        projectId: projectA,
        ordinal: "1",
        eventId: event1.id,
      },
      sleep: controlledSleep().sleep,
    });
    const reader = result.stream.getReader();
    const gap = await nextActivity(reader);

    expect(gap.frame).toContain("event: monitoring.resync-required");
    expect(gap.data).toMatchObject({
      error: "MONITORING_RESYNC_REQUIRED",
      reason: "EVENT_RETAINED",
      expectedOrdinal: "2",
      resync: true,
    });
    await result.done;
  });

  it("rejects a durable cursor bound to another project before querying the ledger", async () => {
    const ledger = new MockDurableEventLedger();
    const controller = new AbortController();
    const result = createDurableMonitoringEventStream({
      projectId: projectA,
      signal: controller.signal,
      ledger,
      cursor: {
        version: 2,
        projectId: projectB,
        ordinal: "1",
        eventId: event1.id,
      },
      sleep: controlledSleep().sleep,
    });
    const reader = result.stream.getReader();
    const gap = await nextActivity(reader);

    expect(gap.data).toMatchObject({
      error: "MONITORING_RESYNC_REQUIRED",
      reason: "CURSOR_PROJECT_MISMATCH",
      resync: true,
    });
    expect(ledger.calls).toEqual([]);
    await result.done;
  });
});
