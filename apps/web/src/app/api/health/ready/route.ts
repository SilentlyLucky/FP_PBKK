import { getDatabaseClient } from "@promptlab/db";
import { Redis } from "ioredis";

import { buildWebServiceReadiness } from "@/lib/service-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database = false;
  let migrations = false;

  try {
    const result = await getDatabaseClient().pool.query(
      "select to_regclass('public.projects') as projects",
    );
    database = true;
    migrations = Boolean(result.rows[0]?.projects);
  } catch {
    // Health responses expose readiness state, not connection details.
  }

  let redisReady = false;
  const redisUrl = process.env.PROMPTLAB_REDIS_URL;
  if (redisUrl) {
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      redisReady = (await redis.ping()) === "PONG";
    } catch {
      // Health responses expose readiness state, not connection details.
    } finally {
      redis.disconnect();
    }
  }

  const readiness = buildWebServiceReadiness({
    database,
    migrations,
    redis: redisReady,
  });

  return Response.json(readiness, {
    status: readiness.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
