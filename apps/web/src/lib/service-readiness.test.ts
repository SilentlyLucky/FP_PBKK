import { describe, expect, it } from "vitest";

import { buildWebServiceReadiness } from "./service-readiness.ts";

describe("web service readiness", () => {
  it("reports ready when database, migrations, and Redis are ready", () => {
    expect(
      buildWebServiceReadiness({
        database: true,
        migrations: true,
        redis: true,
      }),
    ).toEqual({
      status: "ready",
      service: "web",
      checks: {
        database: "ready",
        migrations: "ready",
        redis: "ready",
      },
    });
  });

  it("does not make provider or project knowledge state a startup dependency", () => {
    const result = buildWebServiceReadiness({
      database: true,
      migrations: true,
      redis: true,
    });

    expect(result.status).toBe("ready");
    expect(result.checks).not.toHaveProperty("provider");
    expect(result.checks).not.toHaveProperty("knowledge");
  });

  it("reports a missing migration separately from database connectivity", () => {
    expect(
      buildWebServiceReadiness({
        database: true,
        migrations: false,
        redis: true,
      }),
    ).toMatchObject({
      status: "not_ready",
      checks: { database: "ready", migrations: "not_ready", redis: "ready" },
    });
  });
});
