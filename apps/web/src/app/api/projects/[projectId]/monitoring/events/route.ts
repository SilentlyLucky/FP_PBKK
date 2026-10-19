import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@promptlab/db";

import {
  isMonitoringDurableEventCursor,
  monitoringEventCursorRequest,
} from "@/lib/monitoring-event-cursor";
import {
  createDurableMonitoringEventStream,
  createMonitoringEventStream,
  type MonitoringDurableEventPage,
  type MonitoringEventLedger,
  type MonitoringEventRow,
} from "@/lib/monitoring-event-stream";
import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const eventBatchSize = 100;
const replayWindow = sql`interval '5 minutes'`;

interface DurableEventQueryRow {
  high_water: string;
  ordinal: string | null;
  outbox_event_id: string | null;
  run_event_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  sequence: number | null;
  event_type: string | null;
  created_at: Date | string | null;
  cursor_at: string | null;
  payload: unknown;
}

function durableQueryRowToPage(
  rows: DurableEventQueryRow[],
): MonitoringDurableEventPage {
  const first = rows[0];
  return {
    highWater: first?.high_water ?? "0",
    entries: rows.flatMap((row) => {
      if (row.ordinal === null || row.outbox_event_id === null) return [];
      const rawCreatedAt = row.created_at;
      const createdAt =
        rawCreatedAt instanceof Date
          ? rawCreatedAt
          : typeof rawCreatedAt === "string"
            ? new Date(rawCreatedAt)
            : null;
      const event: MonitoringEventRow | null =
        row.run_event_id &&
        row.run_id &&
        row.sequence !== null &&
        row.event_type &&
        createdAt &&
        Number.isFinite(createdAt.getTime()) &&
        row.cursor_at
          ? {
              id: row.run_event_id,
              runId: row.run_id,
              attemptId: row.attempt_id,
              sequence: row.sequence,
              eventType: row.event_type,
              createdAt,
              cursorAt: row.cursor_at,
              payload: row.payload,
            }
          : null;
      return [
        {
          ordinal: row.ordinal,
          eventId: row.outbox_event_id,
          event,
        },
      ];
    }),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });

  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const [project] = await database.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          isNull(schema.projects.deletedAt),
        ),
      )
      .limit(1);
    if (!project)
      return Response.json({ error: "PROJECT_NOT_FOUND" }, { status: 404 });
  } catch {
    return safeApiFailure();
  }

  const params = new URL(request.url).searchParams;
  const resync = params.get("resync") === "1";
  const cursorResult = monitoringEventCursorRequest(request);
  if (!resync && cursorResult.status === "invalid")
    return Response.json({ error: "INVALID_EVENT_CURSOR" }, { status: 400 });
  let requestedCursor =
    !resync && cursorResult.status === "valid" ? cursorResult.cursor : null;

  let durableMode = false;
  try {
    const capability = await database.db.execute(
      sql<{
        outbox_table: string | null;
        counter_table: string | null;
      }>`
        SELECT
          to_regclass('public.monitoring_event_outbox')::text AS outbox_table,
          to_regclass('public.monitoring_event_counters')::text AS counter_table
      `,
    );
    const [tables] = capability.rows;
    durableMode = Boolean(tables?.outbox_table && tables.counter_table);
  } catch {
    return safeApiFailure();
  }

  if (durableMode && requestedCursor && !resync) {
    try {
      if (isMonitoringDurableEventCursor(requestedCursor)) {
        if (requestedCursor.projectId !== projectId) {
          return Response.json(
            { error: "EVENT_CURSOR_PROJECT_MISMATCH", resync: true },
            { status: 409 },
          );
        }
        const [storedCursor] = await database.db
          .select({ ordinal: schema.monitoringEventOutbox.ordinal })
          .from(schema.monitoringEventOutbox)
          .where(
            and(
              eq(schema.monitoringEventOutbox.projectId, projectId),
              eq(
                schema.monitoringEventOutbox.ordinal,
                BigInt(requestedCursor.ordinal),
              ),
              eq(schema.monitoringEventOutbox.eventId, requestedCursor.eventId),
            ),
          )
          .limit(1);
        if (!storedCursor) {
          return Response.json(
            { error: "EVENT_CURSOR_RESYNC_REQUIRED", resync: true },
            { status: 409 },
          );
        }
      } else {
        const [storedCursor] = await database.db
          .select({
            ordinal: schema.monitoringEventOutbox.ordinal,
            eventId: schema.monitoringEventOutbox.eventId,
          })
          .from(schema.monitoringEventOutbox)
          .where(
            and(
              eq(schema.monitoringEventOutbox.projectId, projectId),
              eq(schema.monitoringEventOutbox.eventId, requestedCursor.id),
            ),
          )
          .limit(1);
        if (!storedCursor) {
          return Response.json(
            { error: "EVENT_CURSOR_RESYNC_REQUIRED", resync: true },
            { status: 409 },
          );
        }
        requestedCursor = {
          version: 2,
          projectId,
          ordinal: storedCursor.ordinal.toString(),
          eventId: storedCursor.eventId,
        };
      }
    } catch {
      return safeApiFailure();
    }
  } else if (
    !durableMode &&
    !resync &&
    requestedCursor &&
    isMonitoringDurableEventCursor(requestedCursor)
  ) {
    return Response.json(
      { error: "DURABLE_EVENT_CURSOR_UNSUPPORTED", resync: true },
      { status: 409 },
    );
  }

  if (durableMode) {
    const cursor =
      !resync && isMonitoringDurableEventCursor(requestedCursor)
        ? requestedCursor
        : null;
    const readPage = async (
      scopedProjectId: string,
      limit: number,
      afterOrdinal: string | null,
    ): Promise<MonitoringDurableEventPage> => {
      const selectedEvents = afterOrdinal
        ? sql`
            SELECT project_id, ordinal, event_id
            FROM public.monitoring_event_outbox
            WHERE project_id = ${scopedProjectId}::uuid
              AND ordinal > ${afterOrdinal}::bigint
            ORDER BY ordinal ASC
            LIMIT ${limit}
          `
        : sql`
            SELECT project_id, ordinal, event_id
            FROM public.monitoring_event_outbox
            WHERE project_id = ${scopedProjectId}::uuid
            ORDER BY ordinal DESC
            LIMIT ${limit}
          `;
      const result = await database.db.execute(
        sql<DurableEventQueryRow>`
          WITH selected_events AS (${selectedEvents})
          SELECT
            COALESCE((
              SELECT last_ordinal
              FROM public.monitoring_event_counters
              WHERE project_id = ${scopedProjectId}::uuid
            ), 0)::text AS high_water,
            selected_events.ordinal::text AS ordinal,
            selected_events.event_id::text AS outbox_event_id,
            run_events.id::text AS run_event_id,
            run_events.run_id::text AS run_id,
            run_events.attempt_id::text AS attempt_id,
            run_events.sequence,
            run_events.event_type,
            run_events.created_at,
            run_events.payload,
            run_events.created_at::text AS cursor_at
          FROM (SELECT 1) AS singleton
          LEFT JOIN selected_events ON TRUE
          LEFT JOIN public.run_events AS run_events
            ON run_events.project_id = selected_events.project_id
            AND run_events.id = selected_events.event_id
          ORDER BY selected_events.ordinal ASC NULLS LAST
        `,
      );
      const rows = result.rows as unknown as DurableEventQueryRow[];
      return durableQueryRowToPage(rows);
    };

    const { stream } = createDurableMonitoringEventStream({
      projectId,
      signal: request.signal,
      ledger: {
        latestDurable: (scopedProjectId, limit) =>
          readPage(scopedProjectId, limit, null),
        afterDurable: (scopedProjectId, ordinal, limit) =>
          readPage(scopedProjectId, limit, ordinal),
      },
      cursor,
      resync,
      batchSize: eventBatchSize,
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-monitoring-cursor-mode": "durable-v2",
      },
    });
  }

  const cursor =
    !resync &&
    cursorResult.status === "valid" &&
    !isMonitoringDurableEventCursor(cursorResult.cursor)
      ? cursorResult.cursor
      : null;
  const ledger: MonitoringEventLedger = {
    latest: (scopedProjectId, limit) =>
      database.db
        .select({
          id: schema.runEvents.id,
          runId: schema.runEvents.runId,
          attemptId: schema.runEvents.attemptId,
          sequence: schema.runEvents.sequence,
          eventType: schema.runEvents.eventType,
          createdAt: schema.runEvents.createdAt,
          payload: schema.runEvents.payload,
          cursorAt: sql<string>`${schema.runEvents.createdAt}::text`,
        })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.projectId, scopedProjectId))
        .orderBy(desc(schema.runEvents.createdAt), desc(schema.runEvents.id))
        .limit(limit)
        .then((rows) => rows.reverse()),
    after: (scopedProjectId, afterCursor, limit) =>
      database.db
        .select({
          id: schema.runEvents.id,
          runId: schema.runEvents.runId,
          attemptId: schema.runEvents.attemptId,
          sequence: schema.runEvents.sequence,
          eventType: schema.runEvents.eventType,
          createdAt: schema.runEvents.createdAt,
          payload: schema.runEvents.payload,
          cursorAt: sql<string>`${schema.runEvents.createdAt}::text`,
        })
        .from(schema.runEvents)
        .where(
          afterCursor
            ? and(
                eq(schema.runEvents.projectId, scopedProjectId),
                sql`(
                  ${schema.runEvents.createdAt} > ${afterCursor.createdAt}::timestamptz
                  OR (
                    ${schema.runEvents.createdAt} = ${afterCursor.createdAt}::timestamptz
                    AND ${schema.runEvents.id} > ${afterCursor.id}::uuid
                  )
                )`,
              )
            : eq(schema.runEvents.projectId, scopedProjectId),
        )
        .orderBy(asc(schema.runEvents.createdAt), asc(schema.runEvents.id))
        .limit(limit),
    replayPage: (scopedProjectId, floor, afterCursor, limit) =>
      database.db
        .select({
          id: schema.runEvents.id,
          runId: schema.runEvents.runId,
          attemptId: schema.runEvents.attemptId,
          sequence: schema.runEvents.sequence,
          eventType: schema.runEvents.eventType,
          createdAt: schema.runEvents.createdAt,
          cursorAt: sql<string>`${schema.runEvents.createdAt}::text`,
        })
        .from(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.projectId, scopedProjectId),
            sql`${schema.runEvents.createdAt} >= ${floor.createdAt}::timestamptz - ${replayWindow}`,
            ...(afterCursor
              ? [
                  sql`(
                    ${schema.runEvents.createdAt} > ${afterCursor.createdAt}::timestamptz
                    OR (
                      ${schema.runEvents.createdAt} = ${afterCursor.createdAt}::timestamptz
                      AND ${schema.runEvents.id} > ${afterCursor.id}::uuid
                    )
                  )`,
                ]
              : []),
          ),
        )
        .orderBy(asc(schema.runEvents.createdAt), asc(schema.runEvents.id))
        .limit(limit),
  };
  const { stream } = createMonitoringEventStream({
    projectId,
    signal: request.signal,
    ledger,
    cursor,
    resync,
    batchSize: eventBatchSize,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-monitoring-cursor-mode": "bounded-legacy",
    },
  });
}
