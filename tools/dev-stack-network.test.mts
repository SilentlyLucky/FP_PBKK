import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import {
  findAvailablePort,
  findWslHostAddress,
  webDevArguments,
} from "./dev-stack-network.mjs";

describe("local web startup networking", () => {
  it("selects the WSL interface address and stays local outside WSL", () => {
    const interfaces = {
      eth0: [{ family: "IPv4", address: "172.26.30.102", internal: false }],
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    };
    expect(
      findWslHostAddress(interfaces, { WSL_DISTRO_NAME: "Ubuntu" }, "linux"),
    ).toBe("172.26.30.102");
    expect(findWslHostAddress(interfaces, {}, "Linux")).toBeNull();
  });

  it("skips ports already owned by another service", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("No test port.");

    try {
      const port = await findAvailablePort(
        "127.0.0.1",
        address.port,
        address.port + 10,
      );
      expect(port).not.toBe(address.port);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("binds Next only to the selected host and port", () => {
    expect(webDevArguments("172.26.30.102", 3001)).toEqual([
      "pnpm",
      "--filter",
      "@promptlab/web",
      "exec",
      "next",
      "dev",
      "--hostname",
      "172.26.30.102",
      "--port",
      "3001",
    ]);
  });
});
