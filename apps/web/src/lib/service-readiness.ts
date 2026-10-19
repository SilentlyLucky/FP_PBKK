export type ServiceCheckState = "ready" | "not_ready";

export interface WebServiceReadinessChecks {
  database: boolean;
  migrations: boolean;
  redis: boolean;
}

export function buildWebServiceReadiness(checks: WebServiceReadinessChecks) {
  const states = {
    database: checks.database ? "ready" : "not_ready",
    migrations: checks.migrations ? "ready" : "not_ready",
    redis: checks.redis ? "ready" : "not_ready",
  } satisfies Record<keyof WebServiceReadinessChecks, ServiceCheckState>;

  return {
    status: Object.values(checks).every(Boolean) ? "ready" : "not_ready",
    service: "web" as const,
    checks: states,
  };
}
