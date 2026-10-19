import { describe, expect, it } from "vitest";

import { developerComposeArgs } from "./dev-stack-compose.mjs";

describe("developer Compose selection", () => {
  it("keeps dev:stack on the PostgreSQL and Redis developer file", () => {
    expect(
      developerComposeArgs("up", "-d", "--wait", "postgres", "redis"),
    ).toEqual([
      "compose",
      "-f",
      "docker-compose.yml",
      "up",
      "-d",
      "--wait",
      "postgres",
      "redis",
    ]);
  });
});
