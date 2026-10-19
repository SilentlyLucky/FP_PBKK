import { copyFileSync, constants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findAvailablePort,
  findWslHostAddress,
  webDevArguments,
} from "./dev-stack-network.mjs";
import { developerComposeArgs } from "./dev-stack-compose.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = path.join(root, ".env");
const appsOnly = process.argv.includes("--apps-only");
const windows = process.platform === "win32";
const active = new Set();
let stopping = false;
let receivedSignal;

function stop(signal = "SIGTERM") {
  stopping = true;
  for (const child of active) {
    if (!child.pid) continue;
    try {
      if (windows) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    receivedSignal = signal;
    stop(signal);
  });

function launch(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    detached: !windows,
    shell: windows,
    windowsHide: true,
  });
  active.add(child);
  return once(child, "close").then(
    ([code]) => {
      active.delete(child);
      return code ?? 1;
    },
    () => {
      active.delete(child);
      return 1;
    },
  );
}

async function run(command, args, label) {
  const code = await launch(command, args);
  if (code !== 0) {
    if (!stopping) console.error(`${label} failed.`);
    stop();
  }
  return code === 0;
}

function endpointError(name, protocols, port, pathnames) {
  const host = "127.0.0.1";
  const acceptedPaths = Array.isArray(pathnames) ? pathnames : [pathnames];
  const expected = protocols
    .flatMap((protocol) =>
      acceptedPaths.map(
        (pathname) => `${protocol}//${host}:${port}${pathname}`,
      ),
    )
    .join(" or ");
  let url;
  try {
    url = new URL(process.env[name] ?? "");
  } catch {
    return `${name} is invalid; expected ${expected}.`;
  }

  const invalid = [];
  if (!protocols.includes(url.protocol)) invalid.push("protocol");
  if (url.hostname !== host) invalid.push("hostname");
  if (url.port !== port) invalid.push("port");
  if (!acceptedPaths.includes(url.pathname)) invalid.push("path");
  if (url.href.includes("?") || url.href.includes("#"))
    invalid.push("query or fragment");
  return invalid.length
    ? `${name} has an invalid ${invalid.join(", ")}; expected ${expected}.`
    : null;
}

async function main() {
  if (appsOnly && !existsSync(envFile)) {
    console.error(
      "Create .env and start PostgreSQL/Redis before using dev:apps.",
    );
    return 1;
  }
  try {
    copyFileSync(
      path.join(root, ".env.example"),
      envFile,
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  loadEnvFile(envFile);

  const endpointErrors = [
    endpointError(
      "PROMPTLAB_DATABASE_URL",
      ["postgres:", "postgresql:"],
      "55432",
      "/promptlab",
    ),
    endpointError("PROMPTLAB_REDIS_URL", ["redis:"], "56379", ["", "/", "/0"]),
  ].filter(Boolean);
  if (endpointErrors.length) {
    for (const error of endpointErrors) console.error(`${error}`);
    return 1;
  }
  const wslHost = findWslHostAddress();
  const webHost = wslHost ?? "127.0.0.1";
  let webPort;
  try {
    webPort = await findAvailablePort(webHost);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Could not find an available web port.",
    );
    return 1;
  }

  if (!appsOnly) {
    if (
      !(await run(
        "docker",
        developerComposeArgs("up", "-d", "--wait", "postgres", "redis"),
        "Compose startup",
      ))
    )
      return 1;
    if (stopping) return 1;

    const corepack = windows ? "corepack.cmd" : "corepack";
    if (!(await run(corepack, ["pnpm", "db:migrate"], "Database migration")))
      return 1;
    if (stopping) return 1;
  }

  const webUrl = "http://" + webHost + ":" + webPort;
  console.log(
    wslHost ? "Web UI (WSL/Windows): " + webUrl : "Web UI: " + webUrl,
  );
  if (appsOnly) {
    console.log("Using existing PostgreSQL and Redis; no migration will run.");
  }

  const corepack = windows ? "corepack.cmd" : "corepack";
  const apps = [
    launch(corepack, webDevArguments(webHost, webPort)),
    launch(corepack, ["pnpm", "--filter", "@promptlab/worker", "dev"]),
  ];
  const code = await Promise.race(apps);
  if (!stopping) stop();
  await Promise.all(apps);
  if (!receivedSignal && code !== 0)
    console.error("A local application process failed.");
  return code;
}

main()
  .then((code) => {
    process.exitCode =
      receivedSignal === "SIGINT" ? 130 : receivedSignal ? 143 : code;
  })
  .catch(() => {
    console.error("Could not prepare the local development stack.");
    process.exitCode = 1;
  });
