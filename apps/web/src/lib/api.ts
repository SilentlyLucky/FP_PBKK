import { IdSchema } from "@promptlab/contracts";

import { getDatabaseClient } from "@promptlab/db";

export function parseRouteId(value: string): string | null {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function databaseOrUnavailable():
  { db: ReturnType<typeof getDatabaseClient>["db"] } | { response: Response } {
  if (!process.env.PROMPTLAB_DATABASE_URL) {
    return {
      response: Response.json(
        {
          error: "DATABASE_UNAVAILABLE",
          message: "Database lokal belum dikonfigurasi.",
        },
        { status: 503 },
      ),
    };
  }
  try {
    return { db: getDatabaseClient().db };
  } catch {
    return {
      response: Response.json(
        {
          error: "DATABASE_UNAVAILABLE",
          message: "Database lokal tidak tersedia.",
        },
        { status: 503 },
      ),
    };
  }
}

export function safeApiFailure(status = 500): Response {
  return Response.json(
    {
      error: status === 409 ? "CONFLICT" : "INTERNAL_ERROR",
      message: "Permintaan tidak dapat diproses.",
    },
    { status },
  );
}
