import { setTimeout as sleep } from "node:timers/promises";

import {
  encodeMonitoringEventCursor,
  type MonitoringDurableEventCursor,
  type MonitoringEventCursor,
  type MonitoringEventCursorValue,
} from "./monitoring-event-cursor.js";
import { projectRunActivityPayload } from "./run-activity.js";

export interface MonitoringEventRow {
  id: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  eventType: string;
  createdAt: Date;
  cursorAt: string;
  payload?: unknown;
}

export interface MonitoringEventLedger {
  latest(projectId: string, limit: number): Promise<MonitoringEventRow[]>;
  after(
    projectId: string,
    cursor: MonitoringEventCursor | null,
    limit: number,
  ): Promise<MonitoringEventRow[]>;
  replayPage(
    projectId: string,
    floor: MonitoringEventCursor,
    after: MonitoringEventCursor | null,
    limit: number,
  ): Promise<MonitoringEventRow[]>;
}

export interface MonitoringDurableEventEntry {
  ordinal: string;
  eventId: string;
  event: MonitoringEventRow | null;
}

export interface MonitoringDurableEventPage {
  highWater: string;
  entries: MonitoringDurableEventEntry[];
}

export interface MonitoringDurableEventLedger {
  latestDurable(
    projectId: string,
    limit: number,
  ): Promise<MonitoringDurableEventPage>;
  afterDurable(
    projectId: string,
    ordinal: string,
    limit: number,
  ): Promise<MonitoringDurableEventPage>;
}

export interface MonitoringEventStreamOptions {
  projectId: string;
  signal: AbortSignal;
  ledger: MonitoringEventLedger;
  cursor: MonitoringEventCursor | null;
  resync?: boolean;
  batchSize?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  reconciliationIntervalMs?: number;
  maxSeenEventIds?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface MonitoringDurableEventStreamOptions {
  projectId: string;
  signal: AbortSignal;
  ledger: MonitoringDurableEventLedger;
  cursor: MonitoringDurableEventCursor | null;
  resync?: boolean;
  batchSize?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxSeenEventIds?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const safeEventTypes = new Set([
  "run.status",
  "run.enqueue",
  "agent.action",
  "agent.finished",
  "tool.started",
  "tool.completed",
  "candidate.proposed",
  "usage.snapshot",
  "quota.snapshot",
  "evaluation.result",
  "optimization.clarification.requested",
  "optimization.clarification.answered",
  "run.completed",
  "run.failed",
]);

function eventCursor(event: MonitoringEventRow): MonitoringEventCursor {
  return { createdAt: event.cursorAt, id: event.id };
}

function encodeActivity(
  event: MonitoringEventRow,
  resumeCursor: MonitoringEventCursorValue,
): string {
  const eventType = safeEventTypes.has(event.eventType)
    ? event.eventType
    : "monitoring.event";
  const payload = projectRunActivityPayload(eventType, event.payload);
  const data = JSON.stringify({
    id: event.id,
    runId: event.runId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    timestamp: event.createdAt.toISOString(),
    eventType,
    ...(Object.keys(payload).length ? { payload } : {}),
  });
  return `id: ${encodeMonitoringEventCursor(resumeCursor)}\nevent: monitoring.activity\ndata: ${data}\n\n`;
}

async function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await sleep(milliseconds, undefined, { signal }).catch(() => undefined);
}

export function createMonitoringEventStream(
  options: MonitoringEventStreamOptions,
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  const {
    projectId,
    signal,
    ledger,
    resync = false,
    batchSize = 100,
    pollIntervalMs = 1_000,
    heartbeatIntervalMs = 15_000,
    reconciliationIntervalMs = 15_000,
    maxSeenEventIds = 20_000,
    now = Date.now,
    sleep: wait = defaultSleep,
  } = options;
  const encoder = new TextEncoder();
  let stopStream: () => void = () => {};
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cursor = resync ? null : options.cursor;
      let firstBatch = resync || !cursor;
      let lastHeartbeat = now();
      let nextReconciliationAt = now() + reconciliationIntervalMs;
      let reconciliationFloor: MonitoringEventCursor | null = null;
      let reconciliationAfter: MonitoringEventCursor | null = null;
      const seenIds = new Set<string>();
      const seenOrder: string[] = [];

      const close = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // The consumer may already have canceled the stream.
        }
        finish();
      };
      stopStream = close;
      const enqueue = (value: string) => {
        if (!closed && !signal.aborted)
          controller.enqueue(encoder.encode(value));
      };
      const abort = () => close();
      signal.addEventListener("abort", abort, { once: true });

      const remember = (id: string): boolean => {
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        seenOrder.push(id);
        if (seenOrder.length > maxSeenEventIds) {
          const expired = seenOrder.shift();
          if (expired) seenIds.delete(expired);
        }
        return true;
      };
      const emit = (
        event: MonitoringEventRow,
        resumeCursor: MonitoringEventCursor,
      ) => {
        if (!remember(event.id)) return;
        enqueue(encodeActivity(event, resumeCursor));
      };

      void (async () => {
        if (signal.aborted) {
          close();
          return;
        }
        enqueue("retry: 2500\n\n");
        while (!closed && !signal.aborted) {
          const events = firstBatch
            ? await ledger.latest(projectId, batchSize)
            : await ledger.after(projectId, cursor, batchSize);
          firstBatch = false;
          for (const event of events) {
            if (closed || signal.aborted) break;
            cursor = eventCursor(event);
            emit(event, cursor);
          }

          if (cursor && !closed && now() >= nextReconciliationAt) {
            reconciliationFloor ??= cursor;
            const page = await ledger.replayPage(
              projectId,
              reconciliationFloor,
              reconciliationAfter,
              batchSize,
            );
            if (closed || signal.aborted) break;
            if (page.length === 0) {
              reconciliationFloor = null;
              reconciliationAfter = null;
              nextReconciliationAt = now() + reconciliationIntervalMs;
            } else {
              for (const event of page) emit(event, cursor);
              reconciliationAfter = eventCursor(page.at(-1)!);
              if (page.length < batchSize) {
                reconciliationFloor = null;
                reconciliationAfter = null;
                nextReconciliationAt = now() + reconciliationIntervalMs;
              }
            }
          }

          if (now() - lastHeartbeat >= heartbeatIntervalMs) {
            enqueue(": keep-alive\n\n");
            lastHeartbeat = now();
          }

          await wait(pollIntervalMs, signal);
        }
        close();
      })().catch(() => {
        if (!closed) {
          enqueue(
            'event: monitoring.error\ndata: {"error":"MONITORING_STREAM_UNAVAILABLE"}\n\n',
          );
          close();
        }
      });
    },
    cancel() {
      stopStream();
    },
  });

  return { stream, done };
}

function resyncRequired(reason: string, expected?: string): string {
  const details: Record<string, unknown> = {
    error: "MONITORING_RESYNC_REQUIRED",
    reason,
    resync: true,
  };
  if (expected) details.expectedOrdinal = expected;
  return `event: monitoring.resync-required\ndata: ${JSON.stringify(details)}\n\n`;
}

export function createDurableMonitoringEventStream(
  options: MonitoringDurableEventStreamOptions,
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  const {
    projectId,
    signal,
    ledger,
    resync = false,
    batchSize = 100,
    pollIntervalMs = 1_000,
    heartbeatIntervalMs = 15_000,
    maxSeenEventIds = 20_000,
    now = Date.now,
    sleep: wait = defaultSleep,
  } = options;
  const encoder = new TextEncoder();
  let stopStream: () => void = () => {};
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cursor = resync ? null : options.cursor;
      let firstBatch = resync || !cursor;
      let lastHeartbeat = now();
      const seenIds = new Set<string>();
      const seenOrder: string[] = [];

      const close = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // The consumer may already have canceled the stream.
        }
        finish();
      };
      stopStream = close;
      const enqueue = (value: string) => {
        if (!closed && !signal.aborted)
          controller.enqueue(encoder.encode(value));
      };
      const abort = () => close();
      signal.addEventListener("abort", abort, { once: true });

      const remember = (id: string): boolean => {
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        seenOrder.push(id);
        if (seenOrder.length > maxSeenEventIds) {
          const expired = seenOrder.shift();
          if (expired) seenIds.delete(expired);
        }
        return true;
      };
      const emit = (
        event: MonitoringEventRow,
        resumeCursor: MonitoringDurableEventCursor,
      ) => {
        if (!remember(event.id)) return;
        enqueue(encodeActivity(event, resumeCursor));
      };
      const reportGap = (reason: string, expected?: string) => {
        enqueue(resyncRequired(reason, expected));
        close();
      };

      void (async () => {
        if (cursor && cursor.projectId !== projectId) {
          reportGap("CURSOR_PROJECT_MISMATCH");
          return;
        }
        if (signal.aborted) {
          close();
          return;
        }
        enqueue("retry: 2500\n\n");
        while (!closed && !signal.aborted) {
          const page = firstBatch
            ? await ledger.latestDurable(projectId, batchSize)
            : await ledger.afterDurable(
                projectId,
                cursor?.ordinal ?? "0",
                batchSize,
              );
          firstBatch = false;

          const highWater = BigInt(page.highWater);
          const cursorOrdinal = cursor ? BigInt(cursor.ordinal) : 0n;
          if (highWater < cursorOrdinal) {
            reportGap("CURSOR_AHEAD");
            return;
          }

          if (page.entries.length === 0) {
            if (highWater > cursorOrdinal) {
              reportGap("OUTBOX_GAP", (cursorOrdinal + 1n).toString());
              return;
            }
          } else {
            let previousOrdinal: bigint | null = null;
            let expectedOrdinal = cursor ? cursorOrdinal + 1n : null;
            for (const entry of page.entries) {
              const ordinal = BigInt(entry.ordinal);
              if (
                (expectedOrdinal !== null && ordinal !== expectedOrdinal) ||
                (previousOrdinal !== null && ordinal !== previousOrdinal + 1n)
              ) {
                reportGap(
                  "OUTBOX_GAP",
                  (expectedOrdinal ?? previousOrdinal! + 1n).toString(),
                );
                return;
              }
              if (!entry.event || entry.event.id !== entry.eventId) {
                reportGap("EVENT_RETAINED", ordinal.toString());
                return;
              }
              if (ordinal > highWater) {
                reportGap("COUNTER_BEHIND_OUTBOX", ordinal.toString());
                return;
              }
              previousOrdinal = ordinal;
              expectedOrdinal = ordinal + 1n;
            }

            for (const entry of page.entries) {
              if (!entry.event) continue;
              cursor = {
                version: 2,
                projectId,
                ordinal: entry.ordinal,
                eventId: entry.eventId,
              };
              emit(entry.event, cursor);
            }

            const lastOrdinal = BigInt(page.entries.at(-1)!.ordinal);
            if (page.entries.length < batchSize && lastOrdinal < highWater) {
              reportGap("OUTBOX_GAP", (lastOrdinal + 1n).toString());
              return;
            }
          }

          if (now() - lastHeartbeat >= heartbeatIntervalMs) {
            enqueue(": keep-alive\n\n");
            lastHeartbeat = now();
          }
          await wait(pollIntervalMs, signal);
        }
        close();
      })().catch(() => {
        if (!closed) {
          enqueue(
            'event: monitoring.error\ndata: {"error":"MONITORING_STREAM_UNAVAILABLE"}\n\n',
          );
          close();
        }
      });
    },
    cancel() {
      stopStream();
    },
  });

  return { stream, done };
}
