import { once } from "node:events";

import { describe, expect, it } from "vitest";

import {
  buildWorkerServiceReadiness,
  startWorkerReadinessServer,
} from "./readiness.ts";

describe("worker service readiness", () => {
  it("requires the database, migrations, Redis, and an active consumer", () => {
    expect(
      buildWorkerServiceReadiness({
        database: true,
        migrations: true,
        redis: true,
        consumer: false,
      }),
    ).toMatchObject({
      status: "not_ready",
      service: "worker",
      checks: { consumer: "not_ready" },
    });
  });

  it("serves liveness independently from dependency readiness", async () => {
    const server = startWorkerReadinessServer(0, async () => ({
      database: false,
      migrations: false,
      redis: false,
      consumer: true,
    }));
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Worker readiness server did not bind a TCP port.");
    }

    try {
      const live = await fetch(`http://127.0.0.1:${address.port}/health/live`);
      const ready = await fetch(
        `http://127.0.0.1:${address.port}/health/ready`,
      );

      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok", service: "worker" });
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({
        status: "not_ready",
        checks: {
          database: "not_ready",
          migrations: "not_ready",
          redis: "not_ready",
          consumer: "ready",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
