import { createServer, type Server } from "node:http";

export interface WorkerServiceReadinessChecks {
  database: boolean;
  migrations: boolean;
  redis: boolean;
  consumer: boolean;
}

export function buildWorkerServiceReadiness(
  checks: WorkerServiceReadinessChecks,
) {
  const states = {
    database: checks.database ? "ready" : "not_ready",
    migrations: checks.migrations ? "ready" : "not_ready",
    redis: checks.redis ? "ready" : "not_ready",
    consumer: checks.consumer ? "ready" : "not_ready",
  };

  return {
    status: Object.values(checks).every(Boolean) ? "ready" : "not_ready",
    service: "worker" as const,
    checks: states,
  };
}

export function startWorkerReadinessServer(
  port: number,
  probe: () => Promise<WorkerServiceReadinessChecks>,
): Server {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://worker.local")
      .pathname;
    response.setHeader("cache-control", "no-store");

    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }

    if (pathname === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "worker" }));
      return;
    }

    if (pathname !== "/health/ready") {
      response.writeHead(404).end();
      return;
    }

    void probe()
      .then((checks) => {
        const readiness = buildWorkerServiceReadiness(checks);
        response.writeHead(readiness.status === "ready" ? 200 : 503, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(readiness));
      })
      .catch(() => {
        const readiness = buildWorkerServiceReadiness({
          database: false,
          migrations: false,
          redis: false,
          consumer: false,
        });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify(readiness));
      });
  });

  server.listen(port, "0.0.0.0");
  return server;
}
