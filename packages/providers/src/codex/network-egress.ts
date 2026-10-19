import { lookup as dnsLookup } from "node:dns/promises";
import { chmod, stat, unlink } from "node:fs/promises";
import type { LookupAddress } from "node:dns";
import net, { type Socket } from "node:net";
import { dirname } from "node:path";

export const CODEX_PROVIDER_EGRESS_HOSTS = [
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
] as const;
export const CODEX_PROVIDER_EGRESS_PORT = 443 as const;
export const CODEX_PROXY_LOOPBACK_PORT = 18765 as const;
export const CODEX_EGRESS_POLICY_VERSION = "codex-provider-egress-v1" as const;

const allowedHosts = new Set<string>(CODEX_PROVIDER_EGRESS_HOSTS);
const MAX_CONNECT_HEADER_BYTES = 8_192;
const MAX_EARLY_TUNNEL_BYTES = 65_536;
const CONNECT_TIMEOUT_MS = 5_000;

export class CodexEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexEgressError";
  }
}

export interface ParsedConnectRequest {
  host: (typeof CODEX_PROVIDER_EGRESS_HOSTS)[number];
  authority: string;
  headerBytes: Buffer;
  trailingBytes: Buffer;
}

export type TlsClientHelloSniResult =
  | { status: "incomplete" }
  | { status: "invalid" }
  | { status: "complete"; serverName: string };

export type CodexEgressLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<LookupAddress[]>;
export type CodexEgressConnect = (
  address: LookupAddress,
  signal: AbortSignal,
) => Socket;

export function parseConnectAuthority(authority: string): {
  host: (typeof CODEX_PROVIDER_EGRESS_HOSTS)[number];
  port: 443;
} {
  if (
    authority.length > 260 ||
    /[^\x21-\x7e]/u.test(authority) ||
    authority.includes("@") ||
    authority.includes("/") ||
    authority.includes("\\") ||
    authority.includes("?") ||
    authority.includes("#") ||
    authority.includes("%")
  ) {
    throw new CodexEgressError("Malformed CONNECT authority.");
  }
  const separator = authority.lastIndexOf(":");
  if (separator < 1 || authority.indexOf(":") !== separator) {
    throw new CodexEgressError("CONNECT authority must use host:443.");
  }
  const rawHost = authority.slice(0, separator);
  const rawPort = authority.slice(separator + 1);
  if (rawPort !== "443" || !isAsciiHostname(rawHost)) {
    throw new CodexEgressError(
      "CONNECT authority must use an allowed host on port 443.",
    );
  }
  const host = rawHost.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new CodexEgressError(
      "CONNECT host is outside the Codex provider allowlist.",
    );
  }
  return {
    host: host as (typeof CODEX_PROVIDER_EGRESS_HOSTS)[number],
    port: 443,
  };
}

export function parseConnectRequestHead(
  data: Buffer,
): ParsedConnectRequest | null {
  const boundary = data.indexOf("\r\n\r\n");
  if (boundary < 0) {
    if (data.length > MAX_CONNECT_HEADER_BYTES) {
      throw new CodexEgressError("CONNECT headers exceeded the size limit.");
    }
    return null;
  }
  if (boundary + 4 > MAX_CONNECT_HEADER_BYTES) {
    throw new CodexEgressError("CONNECT headers exceeded the size limit.");
  }
  const headerBytes = data.subarray(0, boundary + 4);
  const headerText = headerBytes.toString("latin1");
  if (headerText.includes("\0") || /\r(?!\n)|(?<!\r)\n/u.test(headerText)) {
    throw new CodexEgressError("Malformed CONNECT header framing.");
  }
  const lines = headerText.slice(0, -4).split("\r\n");
  const request = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/u.exec(lines.shift() ?? "");
  if (!request)
    throw new CodexEgressError("Only one HTTP CONNECT request is permitted.");

  const { host } = parseConnectAuthority(request[1]!);
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line || /^[ \t]/u.test(line)) {
      throw new CodexEgressError("Malformed CONNECT header line.");
    }
    const colon = line.indexOf(":");
    if (colon < 1) throw new CodexEgressError("Malformed CONNECT header line.");
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || headers.has(name)) {
      throw new CodexEgressError("Duplicate or invalid CONNECT header.");
    }
    if (!new Set(["host", "proxy-connection", "user-agent"]).has(name)) {
      throw new CodexEgressError("Unsupported CONNECT header.");
    }
    headers.set(name, value);
  }
  const hostHeader = headers.get("host");
  if (!hostHeader || hostHeader !== request[1]) {
    throw new CodexEgressError(
      "CONNECT Host header must exactly match its authority.",
    );
  }

  const trailingBytes = data.subarray(boundary + 4);
  if (trailingBytes.length > MAX_EARLY_TUNNEL_BYTES) {
    throw new CodexEgressError("Optimistic TLS data exceeded the size limit.");
  }
  // TLS clients normally wait for the CONNECT response. A client that sends
  // optimistic bytes may send only a TLS record, never a second HTTP request.
  if (trailingBytes.length && trailingBytes[0] !== 0x16) {
    throw new CodexEgressError("Non-TLS data followed the CONNECT request.");
  }
  return {
    host,
    authority: request[1]!,
    headerBytes,
    trailingBytes,
  };
}

export function isPublicEgressAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export async function resolveAllowedProviderHost(
  hostname: string,
  lookup: CodexEgressLookup = (host) =>
    dnsLookup(host, { all: true, verbatim: true }),
  signal?: AbortSignal,
): Promise<LookupAddress[]> {
  const normalizedHost = hostname.toLowerCase();
  if (!allowedHosts.has(normalizedHost)) {
    throw new CodexEgressError(
      "CONNECT host is outside the Codex provider allowlist.",
    );
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(normalizedHost, signal);
  } catch {
    throw new CodexEgressError("Provider host DNS resolution failed.");
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      (entry) =>
        (entry.family !== 4 && entry.family !== 6) ||
        !isPublicEgressAddress(entry.address),
    )
  ) {
    throw new CodexEgressError(
      "Provider DNS returned a private or reserved destination.",
    );
  }
  return addresses;
}

export function parseTlsClientHelloSni(data: Buffer): TlsClientHelloSniResult {
  if (data.length < 5) return { status: "incomplete" };
  if (
    data[0] !== 0x16 ||
    data[1] !== 0x03 ||
    data[2]! < 0x01 ||
    data[2]! > 0x04
  ) {
    return { status: "invalid" };
  }
  const recordLength = data.readUInt16BE(3);
  if (recordLength < 4 || recordLength > 18_432) return { status: "invalid" };
  if (data.length < 5 + recordLength) return { status: "incomplete" };
  if (data.length !== 5 + recordLength) return { status: "invalid" };

  const record = data.subarray(5);
  if (record[0] !== 0x01) return { status: "invalid" };
  const handshakeLength = record.readUIntBE(1, 3);
  if (handshakeLength !== record.length - 4) return { status: "invalid" };
  let offset = 4;
  if (offset + 34 > record.length) return { status: "invalid" };
  offset += 34; // legacy version and random
  const sessionIdLength = record[offset++];
  if (sessionIdLength === undefined || sessionIdLength > 32) {
    return { status: "invalid" };
  }
  offset += sessionIdLength;
  if (offset + 2 > record.length) return { status: "invalid" };
  const cipherLength = record.readUInt16BE(offset);
  offset += 2;
  if (
    cipherLength < 2 ||
    cipherLength % 2 !== 0 ||
    offset + cipherLength > record.length
  ) {
    return { status: "invalid" };
  }
  offset += cipherLength;
  if (offset + 1 > record.length) return { status: "invalid" };
  const compressionLength = record[offset++];
  if (
    compressionLength === undefined ||
    compressionLength < 1 ||
    offset + compressionLength > record.length
  ) {
    return { status: "invalid" };
  }
  offset += compressionLength;
  if (offset + 2 > record.length) return { status: "invalid" };
  const extensionsLength = record.readUInt16BE(offset);
  offset += 2;
  if (offset + extensionsLength !== record.length) return { status: "invalid" };
  const extensionsEnd = offset + extensionsLength;
  let serverName: string | null = null;
  while (offset < extensionsEnd) {
    if (offset + 4 > extensionsEnd) return { status: "invalid" };
    const type = record.readUInt16BE(offset);
    const length = record.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { status: "invalid" };
    // ECH can carry a different inner SNI, so an outer SNI match is not enough
    // to keep the destination confined to the CONNECT authority.
    if (type === 0xfe0d || type === 0xffce) return { status: "invalid" };
    if (type === 0) {
      if (serverName !== null || length < 5) return { status: "invalid" };
      const namesLength = record.readUInt16BE(offset);
      if (namesLength !== length - 2) return { status: "invalid" };
      let nameOffset = offset + 2;
      const namesEnd = offset + length;
      let count = 0;
      while (nameOffset < namesEnd) {
        if (nameOffset + 3 > namesEnd) return { status: "invalid" };
        const nameType = record[nameOffset]!;
        const nameLength = record.readUInt16BE(nameOffset + 1);
        nameOffset += 3;
        if (nameOffset + nameLength > namesEnd || nameType !== 0) {
          return { status: "invalid" };
        }
        const name = record
          .subarray(nameOffset, nameOffset + nameLength)
          .toString("ascii");
        if (!isAsciiHostname(name)) return { status: "invalid" };
        serverName = name.toLowerCase();
        nameOffset += nameLength;
        count += 1;
      }
      if (count !== 1) return { status: "invalid" };
    }
    offset += length;
  }
  return serverName === null
    ? { status: "invalid" }
    : { status: "complete", serverName };
}

interface BrokerConnectionPhase {
  tunnelStarted: boolean;
  destroyTunnel?: () => void;
}

interface BrokerConnectionContext {
  controller: AbortController;
  lookup?: CodexEgressLookup | undefined;
  connect: CodexEgressConnect;
  handshakeTimeoutMs: number;
  isClosing: () => boolean;
  trackUpstream: (socket: Socket, signal: AbortSignal) => void;
}

export async function startCodexEgressBroker(
  socketPath: string,
  options: {
    lookup?: CodexEgressLookup;
    connect?: CodexEgressConnect;
    handshakeTimeoutMs?: number;
    chmodSocket?: (path: string) => Promise<void>;
  } = {},
): Promise<{ close(): Promise<void> }> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs < 1) {
    throw new CodexEgressError(
      "The ClientHello deadline must be a positive duration.",
    );
  }
  await assertPrivateSocketParent(socketPath);

  const connect: CodexEgressConnect =
    options.connect ??
    ((address) =>
      net.createConnection({
        host: address.address,
        port: CODEX_PROVIDER_EGRESS_PORT,
        family: address.family as 4 | 6,
      }));
  const chmodSocket = options.chmodSocket ?? ((path) => chmod(path, 0o600));
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const pendingOperations = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const trackUpstream = (socket: Socket, signal: AbortSignal) => {
    upstreams.add(socket);
    const destroyOnAbort = () => socket.destroy();
    signal.addEventListener("abort", destroyOnAbort, { once: true });
    socket.once("close", () => {
      upstreams.delete(socket);
      signal.removeEventListener("abort", destroyOnAbort);
    });
    if (signal.aborted) socket.destroy();
  };

  const server = net.createServer((client) => {
    if (closing) {
      client.destroy();
      return;
    }
    clients.add(client);
    const controller = new AbortController();
    controllers.add(controller);
    client.once("close", () => {
      clients.delete(client);
      controller.abort();
    });
    client.once("error", () => controller.abort());

    const operation = handleBrokerConnection(client, {
      controller,
      lookup: options.lookup,
      connect,
      handshakeTimeoutMs,
      isClosing: () => closing,
      trackUpstream,
    })
      .catch(() => {
        controller.abort();
        client.destroy();
      })
      .finally(() => {
        controllers.delete(controller);
        pendingOperations.delete(operation);
      });
    pendingOperations.add(operation);
  });

  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    listening = true;
    await chmodSocket(socketPath);
  } catch (error) {
    if (listening || server.listening) {
      closing = true;
      for (const controller of controllers) controller.abort();
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      try {
        await closeServer(server);
      } catch {
        // Preserve the startup error while still attempting to remove the path.
      }
      await Promise.allSettled([...pendingOperations]);
      try {
        await unlinkSocketPath(socketPath);
      } catch {
        // Preserve the original startup error.
      }
    }
    throw error;
  }

  return {
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const serverClosed = closeServer(server);
      for (const controller of controllers) controller.abort();
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      closePromise = (async () => {
        await serverClosed;
        await Promise.allSettled([...pendingOperations]);
        await unlinkSocketPath(socketPath);
      })();
      return closePromise;
    },
  };
}

async function handleBrokerConnection(
  client: Socket,
  context: BrokerConnectionContext,
): Promise<void> {
  const { controller } = context;
  const phase: BrokerConnectionPhase = { tunnelStarted: false };
  client.setTimeout(CONNECT_TIMEOUT_MS, () => {
    if (phase.tunnelStarted) {
      phase.destroyTunnel?.();
      return;
    }
    controller.abort();
    rejectSocket(client, 408);
  });

  const request = await readConnectRequestHead(client, controller.signal);
  if (!request || controller.signal.aborted || context.isClosing()) return;
  await establishPinnedTunnel(client, request, context, phase);
}

function readConnectRequestHead(
  client: Socket,
  signal: AbortSignal,
): Promise<ParsedConnectRequest | null> {
  return new Promise((resolve) => {
    let requestBuffer = Buffer.alloc(0);
    const finish = (request: ParsedConnectRequest | null) => {
      client.off("data", onConnectData);
      signal.removeEventListener("abort", onAbort);
      resolve(request);
    };
    const onAbort = () => finish(null);
    const onConnectData = (chunk: Buffer) => {
      if (
        requestBuffer.length + chunk.length >
        MAX_CONNECT_HEADER_BYTES + MAX_EARLY_TUNNEL_BYTES
      ) {
        finish(null);
        rejectSocket(client, 400);
        return;
      }
      requestBuffer = Buffer.concat([requestBuffer, chunk]);
      try {
        const request = parseConnectRequestHead(requestBuffer);
        if (request) finish(request);
      } catch {
        finish(null);
        rejectSocket(client, 400);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    client.on("data", onConnectData);
    if (signal.aborted) onAbort();
  });
}

async function establishPinnedTunnel(
  client: Socket,
  request: ParsedConnectRequest,
  context: BrokerConnectionContext,
  phase: BrokerConnectionPhase,
): Promise<void> {
  const { controller } = context;
  const { signal } = controller;
  client.pause();

  let addresses: LookupAddress[];
  try {
    const lookupPromise = resolveAllowedProviderHost(
      request.host,
      context.lookup,
      signal,
    );
    addresses = await waitForSignal(lookupPromise, signal);
  } catch {
    if (signal.aborted || context.isClosing()) return;
    rejectSocket(client, 403);
    return;
  }
  if (signal.aborted || context.isClosing()) return;

  let upstream: Socket | null = null;
  const tunnelLifecycle: { destroy?: () => void } = {};
  let upstreamConnected = false;
  let upstreamFailedAfterConnect = false;
  let upstreamClosedAfterConnect = false;
  const onUpstreamError = () => {
    if (!upstreamConnected) return;
    if (tunnelLifecycle.destroy) tunnelLifecycle.destroy();
    else upstreamFailedAfterConnect = true;
  };
  const onUpstreamClose = () => {
    if (!upstreamConnected) return;
    if (tunnelLifecycle.destroy) tunnelLifecycle.destroy();
    else upstreamClosedAfterConnect = true;
  };

  for (const address of addresses) {
    if (signal.aborted || context.isClosing()) return;
    let candidate: Socket;
    try {
      candidate = context.connect(address, signal);
    } catch {
      continue;
    }
    context.trackUpstream(candidate, signal);
    candidate.on("error", onUpstreamError);
    candidate.on("close", onUpstreamClose);
    const connected = await waitForSocketConnect(
      candidate,
      signal,
      CONNECT_TIMEOUT_MS,
    );
    if (connected) {
      upstreamConnected = true;
      upstream = candidate;
      break;
    }
    candidate.off("error", onUpstreamError);
    candidate.off("close", onUpstreamClose);
    candidate.destroy();
    if (signal.aborted || context.isClosing()) return;
  }
  if (!upstream) {
    if (!signal.aborted && !context.isClosing()) rejectSocket(client, 502);
    return;
  }
  if (signal.aborted || context.isClosing() || upstream.destroyed) return;

  let helloBuffer = request.trailingBytes;
  let tunnelEstablished = false;
  let handshakeTimer: NodeJS.Timeout | undefined;
  const destroyPair = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
    client.off("data", onTunnelData);
    controller.abort();
    client.destroy();
    upstream!.destroy();
  };
  tunnelLifecycle.destroy = destroyPair;
  phase.tunnelStarted = true;
  phase.destroyTunnel = destroyPair;

  const onTunnelData = (chunk: Buffer) => {
    if (tunnelEstablished) return;
    helloBuffer = Buffer.concat([helloBuffer, chunk]);
    if (helloBuffer.length > MAX_EARLY_TUNNEL_BYTES) {
      destroyPair();
      return;
    }
    const hello = parseTlsClientHelloSni(helloBuffer);
    if (hello.status === "incomplete") return;
    if (hello.status !== "complete" || hello.serverName !== request.host) {
      destroyPair();
      return;
    }
    tunnelEstablished = true;
    client.off("data", onTunnelData);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
    client.setTimeout(0);
    try {
      upstream!.write(helloBuffer);
      client.pipe(upstream!);
      upstream!.pipe(client);
    } catch {
      destroyPair();
    }
  };

  if (upstreamFailedAfterConnect || upstreamClosedAfterConnect) {
    destroyPair();
    return;
  }
  upstream.once("error", destroyPair);
  upstream.once("close", () => client.destroy());
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  handshakeTimer = setTimeout(destroyPair, context.handshakeTimeoutMs);
  client.on("data", onTunnelData);
  client.resume();
}

async function waitForSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new CodexEgressError("Operation was canceled.");
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new CodexEgressError("Operation was canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function waitForSocketConnect(
  socket: Socket,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onFailure);
      socket.off("close", onFailure);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!connected) socket.destroy();
      resolve(connected);
    };
    const onConnect = () => finish(true);
    const onFailure = () => finish(false);
    const onAbort = () => finish(false);
    socket.once("connect", onConnect);
    socket.once("error", onFailure);
    socket.once("close", onFailure);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function assertPrivateSocketParent(socketPath: string): Promise<void> {
  const parent = await stat(dirname(socketPath));
  const currentUid = process.getuid?.();
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o077) !== 0 ||
    (currentUid !== undefined && parent.uid !== currentUid)
  ) {
    throw new CodexEgressError(
      "The broker socket parent must be a private directory owned by this user.",
    );
  }
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function unlinkSocketPath(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rejectSocket(socket: Socket, status: 400 | 403 | 408 | 502): void {
  if (socket.destroyed) return;
  const label =
    status === 400
      ? "Bad Request"
      : status === 403
        ? "Forbidden"
        : status === 408
          ? "Request Timeout"
          : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function isAsciiHostname(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 253 ||
    !/^[\x00-\x7f]+$/u.test(value)
  ) {
    return false;
  }
  return value
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
    );
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const value =
    (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 +
      octets[3]!) >>>
    0;
  const blocked: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc01fc400, 24],
    [0xc034c100, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc0af3000, 24],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];
  return !blocked.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function isPublicIpv6(address: string): boolean {
  if (address.includes("%") || address.includes(".")) return false;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return false;
  }
  const words = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ].map((word) =>
    /^[0-9a-f]{1,4}$/u.test(word) ? Number.parseInt(word, 16) : -1,
  );
  if (words.length !== 8 || words.some((word) => word < 0 || word > 0xffff)) {
    return false;
  }
  // Only global-unicast 2000::/3 is accepted. This excludes unspecified,
  // loopback, IPv4-mapped, link-local, unique-local, multicast, and NAT64.
  if ((words[0]! & 0xe000) !== 0x2000) return false;
  const is2001Special = words[0] === 0x2001 && words[1]! <= 0x01ff;
  const isDocumentation = words[0] === 0x2001 && words[1] === 0x0db8;
  const isSixToFour = words[0] === 0x2002;
  const isDocumentation3fff = words[0] === 0x3fff && (words[1]! & 0xf000) === 0;
  return !(
    is2001Special ||
    isDocumentation ||
    isSixToFour ||
    isDocumentation3fff
  );
}
