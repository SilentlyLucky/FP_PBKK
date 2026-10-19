import { createServer } from "node:net";
import { networkInterfaces, release } from "node:os";

/**
 * @param {Record<string, Array<{family: string | number, address: string, internal: boolean}> | undefined>} interfaces
 * @param {Record<string, string | undefined>} environment
 * @param {string} kernelRelease
 */
export function findWslHostAddress(
  interfaces = networkInterfaces(),
  environment = process.env,
  kernelRelease = release(),
) {
  const isWsl = Boolean(
    environment.WSL_DISTRO_NAME ||
    environment.WSL_INTEROP ||
    /microsoft/iu.test(kernelRelease),
  );
  if (!isWsl) return null;

  const addresses = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(
        (entry) =>
          !entry.internal &&
          (entry.family === "IPv4" || entry.family === 4) &&
          entry.address,
      )
      .map((entry) => ({ name, address: entry.address })),
  );
  return (
    addresses.find((entry) => entry.name === "eth0")?.address ??
    addresses[0]?.address ??
    null
  );
}

function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function findAvailablePort(host, start = 3000, end = 3099) {
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(host, port)) return port;
  }
  throw new Error(
    `No available web port on ${host} between ${start} and ${end}.`,
  );
}

export function webDevArguments(host, port) {
  return [
    "pnpm",
    "--filter",
    "@promptlab/web",
    "exec",
    "next",
    "dev",
    "--hostname",
    host,
    "--port",
    String(port),
  ];
}
