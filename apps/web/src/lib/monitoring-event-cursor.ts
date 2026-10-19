import { Buffer } from "node:buffer";

import { IdSchema } from "@promptlab/contracts";

export interface MonitoringEventCursor {
  createdAt: string;
  id: string;
}

export interface MonitoringDurableEventCursor {
  version: 2;
  projectId: string;
  ordinal: string;
  eventId: string;
}

export type MonitoringEventCursorValue =
  MonitoringEventCursor | MonitoringDurableEventCursor;

export type MonitoringEventCursorRequest =
  | { status: "none" }
  | { status: "valid"; cursor: MonitoringEventCursorValue }
  | { status: "invalid" };

const timestampPattern =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const decimalBigintPattern = /^[1-9]\d{0,18}$/;
const maxPostgresBigint = "9223372036854775807";

function isLegacyCursor(value: unknown): value is MonitoringEventCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const cursor = value as Record<string, unknown>;
  return (
    typeof cursor.createdAt === "string" &&
    cursor.createdAt.length <= 64 &&
    timestampPattern.test(cursor.createdAt) &&
    Number.isFinite(Date.parse(cursor.createdAt)) &&
    typeof cursor.id === "string" &&
    IdSchema.safeParse(cursor.id).success
  );
}

export function isMonitoringDurableEventCursor(
  value: unknown,
): value is MonitoringDurableEventCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const cursor = value as Record<string, unknown>;
  if (
    cursor.version !== 2 ||
    typeof cursor.ordinal !== "string" ||
    !decimalBigintPattern.test(cursor.ordinal) ||
    typeof cursor.projectId !== "string" ||
    !IdSchema.safeParse(cursor.projectId).success ||
    typeof cursor.eventId !== "string" ||
    !IdSchema.safeParse(cursor.eventId).success
  ) {
    return false;
  }
  return (
    cursor.ordinal.length < maxPostgresBigint.length ||
    (cursor.ordinal.length === maxPostgresBigint.length &&
      cursor.ordinal <= maxPostgresBigint)
  );
}

function isCursor(value: unknown): value is MonitoringEventCursorValue {
  return isLegacyCursor(value) || isMonitoringDurableEventCursor(value);
}

export function encodeMonitoringEventCursor(
  cursor: MonitoringEventCursorValue,
): string {
  if (!isCursor(cursor)) throw new Error("Invalid monitoring event cursor.");
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMonitoringEventCursor(
  value: string | null | undefined,
): MonitoringEventCursorValue | null {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    return isCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function monitoringEventCursorFromRequest(
  request: Request,
): MonitoringEventCursorValue | null {
  const result = monitoringEventCursorRequest(request);
  return result.status === "valid" ? result.cursor : null;
}

export function monitoringEventCursorRequest(
  request: Request,
): MonitoringEventCursorRequest {
  const header = request.headers.get("last-event-id");
  if (header !== null) {
    const cursor = decodeMonitoringEventCursor(header);
    return cursor ? { status: "valid", cursor } : { status: "invalid" };
  }

  const params = new URL(request.url).searchParams;
  if (!params.has("after")) return { status: "none" };
  const cursor = decodeMonitoringEventCursor(params.get("after"));
  return cursor ? { status: "valid", cursor } : { status: "invalid" };
}
