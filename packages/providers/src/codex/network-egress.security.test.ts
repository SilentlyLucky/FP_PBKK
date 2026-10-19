import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import type { LookupAddress } from "node:dns";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  parseConnectRequestHead,
  parseConnectAuthority,
  parseTlsClientHelloSni,
  resolveAllowedProviderHost,
  startCodexEgressBroker,
  type CodexEgressConnect,
} from "./network-egress.js";

const PUBLIC_IPV4: LookupAddress = { address: "93.184.216.34", family: 4 };

describe("Codex egress security", () => {
  it("rejects standard and draft ECH extensions before accepting an outer SNI", () => {
    expect(parseTlsClientHelloSni(clientHello("api.openai.com")).status).toBe(
      "complete",
    );
    expect(
      parseTlsClientHelloSni(clientHello("api.openai.com", 0xfe0d)).status,
    ).toBe("invalid");
    expect(
      parseTlsClientHelloSni(clientHello("api.openai.com", 0xffce)).status,
    ).toBe("invalid");
  });

  it("keeps CONNECT authority exact and rejects non-public DNS answers", async () => {
    const mismatchedHostHeader = Buffer.from(
      "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: API.openai.com:443\r\n\r\n",
    );
    expect(() => parseConnectRequestHead(mismatchedHostHeader)).toThrow(
      "exactly match its authority",
    );

    await expect(
      resolveAllowedProviderHost("api.openai.com", async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("private or reserved");
    await expect(
      resolveAllowedProviderHost("api.openai.com", async () => [PUBLIC_IPV4]),
    ).resolves.toEqual([PUBLIC_IPV4]);
  });

  it("rejects path-like, tunneled, unknown-host, and oversized CONNECT inputs", () => {
    for (const authority of [
      "https://api.openai.com:443",
      "api.openai.com:443/path",
      "api.openai.com:443?next=evil",
      "api.openai.com:443@127.0.0.1",
      "api.openai.com.evil.test:443",
      "127.0.0.1:443",
      "api.openai.com:80",
    ]) {
      expect(() => parseConnectAuthority(authority)).toThrow();
    }

    const validHead = Buffer.from(
      "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n",
    );
    expect(() =>
      parseConnectRequestHead(
        Buffer.concat([validHead, Buffer.alloc(65_537, 0x16)]),
      ),
    ).toThrow("Optimistic TLS data exceeded");
    expect(() =>
      parseConnectRequestHead(
        Buffer.from(
          "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nProxy-Authorization: test-value\r\n\r\n",
        ),
      ),
    ).toThrow("Unsupported CONNECT header");
  });

  it("rejects private, link-local, shared, and reserved DNS destinations", async () => {
    for (const address of [
      "10.0.0.1",
      "169.254.10.2",
      "100.64.0.1",
      "198.18.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
    ]) {
      const family = net.isIP(address) as 4 | 6;
      await expect(
        resolveAllowedProviderHost("api.openai.com", async () => [
          { address, family },
        ]),
      ).rejects.toThrow("private or reserved");
    }
  });

  it("destroys both sides on SNI mismatch or ECH", async () => {
    const upstreams: FakeUpstream[] = [];
    const connect = fakeConnect(upstreams);

    await withSocketPath(async (socketPath) => {
      const broker = await startCodexEgressBroker(socketPath, {
        lookup: async () => [PUBLIC_IPV4],
        connect,
      });
      try {
        const { client, response } = await connectAndRequest(socketPath);
        expect(response.toString("latin1")).toContain(
          "200 Connection Established",
        );
        const clientClosed = waitForClose(client);
        client.write(clientHello("auth.openai.com"));
        await clientClosed;
        expect(upstreams).toHaveLength(1);
        expect(upstreams[0]!.socket.destroyed).toBe(true);
        expect(upstreams[0]!.received).toEqual([]);

        const { client: echClient, response: echResponse } =
          await connectAndRequest(socketPath);
        expect(echResponse.toString("latin1")).toContain(
          "200 Connection Established",
        );
        const echClientClosed = waitForClose(echClient);
        echClient.write(clientHello("api.openai.com", 0xfe0d));
        await echClientClosed;
        expect(upstreams).toHaveLength(2);
        expect(upstreams[1]!.socket.destroyed).toBe(true);
        expect(upstreams[1]!.received).toEqual([]);
      } finally {
        await broker.close();
      }
    });
  });

  it("forwards a matching ClientHello only after SNI validation", async () => {
    const upstreams: FakeUpstream[] = [];

    await withSocketPath(async (socketPath) => {
      const broker = await startCodexEgressBroker(socketPath, {
        lookup: async () => [PUBLIC_IPV4],
        connect: fakeConnect(upstreams),
      });
      try {
        const { client, response } = await connectAndRequest(socketPath);
        expect(response.toString("latin1")).toContain(
          "200 Connection Established",
        );
        const hello = clientHello("api.openai.com");
        const forwarded = waitForFirstChunk(upstreams[0]!.socket);
        client.write(hello);
        await expect(forwarded).resolves.toEqual(hello);
        client.destroy();
      } finally {
        await broker.close();
      }
    });
  });

  it("enforces an absolute ClientHello deadline despite incoming trickle data", async () => {
    const upstreams: FakeUpstream[] = [];

    await withSocketPath(async (socketPath) => {
      const broker = await startCodexEgressBroker(socketPath, {
        lookup: async () => [PUBLIC_IPV4],
        connect: fakeConnect(upstreams),
        handshakeTimeoutMs: 80,
      });
      try {
        const { client, response } = await connectAndRequest(socketPath);
        expect(response.toString("latin1")).toContain(
          "200 Connection Established",
        );
        const clientClosed = waitForClose(client);
        const startedAt = Date.now();
        const incompleteHello = clientHello("api.openai.com").subarray(0, 24);
        let offset = 0;
        const trickle = setInterval(() => {
          if (offset < incompleteHello.length && !client.destroyed) {
            client.write(incompleteHello.subarray(offset, offset + 1));
            offset += 1;
          }
        }, 10);
        try {
          await clientClosed;
        } finally {
          clearInterval(trickle);
        }
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(upstreams[0]!.socket.destroyed).toBe(true);
        expect(upstreams[0]!.received).toEqual([]);
      } finally {
        await broker.close();
      }
    });
  });

  it("aborts pending DNS and cannot connect after broker close", async () => {
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let lookupSignal: AbortSignal | undefined;
    let resolveLookup!: (addresses: LookupAddress[]) => void;
    let connectCalls = 0;
    const connect = () => {
      connectCalls += 1;
      throw new Error("connect must not run after close");
    };

    await withSocketPath(async (socketPath) => {
      const broker = await startCodexEgressBroker(socketPath, {
        lookup: (_hostname, signal) => {
          lookupSignal = signal;
          markLookupStarted();
          return new Promise((resolve) => {
            resolveLookup = resolve;
          });
        },
        connect,
      });
      const client = await sendConnectRequest(socketPath);
      try {
        await lookupStarted;
        await broker.close();
        expect(lookupSignal?.aborted).toBe(true);
        resolveLookup([PUBLIC_IPV4]);
        await waitForClose(client);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(connectCalls).toBe(0);
      } finally {
        await broker.close();
      }
    });
  });

  it("destroys an in-progress upstream connect and waits for its handler on close", async () => {
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    const upstreams: FakeUpstream[] = [];

    await withSocketPath(async (socketPath) => {
      const broker = await startCodexEgressBroker(socketPath, {
        lookup: async () => [PUBLIC_IPV4],
        connect: (address, signal) => {
          const upstream = createFakeUpstream();
          upstreams.push(upstream);
          signal.addEventListener("abort", () => upstream.socket.destroy(), {
            once: true,
          });
          markConnectStarted();
          return upstream.socket;
        },
      });
      const client = await sendConnectRequest(socketPath);
      await connectStarted;
      await broker.close();
      await waitForClose(client);
      expect(upstreams[0]!.socket.destroyed).toBe(true);
    });
  });

  it("requires a private parent and removes the listener when socket chmod fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-egress-security-"));
    const socketPath = join(directory, "broker.sock");
    try {
      await chmod(directory, 0o700);
      await chmod(directory, 0o755);
      await expect(startCodexEgressBroker(socketPath)).rejects.toThrow(
        "private directory",
      );
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });

      await chmod(directory, 0o700);
      await expect(
        startCodexEgressBroker(socketPath, {
          chmodSocket: async () => {
            throw new Error("injected chmod failure");
          },
        }),
      ).rejects.toThrow("injected chmod failure");
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });

      const broker = await startCodexEgressBroker(socketPath);
      await broker.close();
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface FakeUpstream {
  socket: Socket;
  received: Buffer[];
}

function createFakeUpstream(): FakeUpstream {
  const socket = new PassThrough() as unknown as Socket;
  const received: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
  return { socket, received };
}

function fakeConnect(upstreams: FakeUpstream[]): CodexEgressConnect {
  return () => {
    const upstream = createFakeUpstream();
    upstreams.push(upstream);
    queueMicrotask(() => {
      if (!upstream.socket.destroyed) upstream.socket.emit("connect");
    });
    return upstream.socket;
  };
}

async function withSocketPath(
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-egress-security-"));
  const socketPath = join(directory, "broker.sock");
  await chmod(directory, 0o700);
  try {
    await run(socketPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sendConnectRequest(socketPath: string): Promise<Socket> {
  const client = await connectLocalSocket(socketPath);
  client.write(
    "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n",
  );
  return client;
}

async function connectAndRequest(
  socketPath: string,
): Promise<{ client: Socket; response: Buffer }> {
  const client = await sendConnectRequest(socketPath);
  const response = await readUntil(client, Buffer.from("\r\n\r\n"));
  return { client, response };
}

function connectLocalSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

function readUntil(socket: Socket, delimiter: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes(delimiter)) {
        cleanup();
        resolve(received);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(
        new Error("Socket closed before receiving the expected response."),
      );
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function waitForFirstChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
  });
}

function clientHello(hostname: string, extraExtensionType?: number): Buffer {
  const name = Buffer.from(hostname, "ascii");
  const nameEntry = Buffer.alloc(3 + name.length);
  nameEntry[0] = 0;
  nameEntry.writeUInt16BE(name.length, 1);
  name.copy(nameEntry, 3);
  const sni = Buffer.concat([u16(nameEntry.length), nameEntry]);
  const extensions = [Buffer.concat([u16(0), u16(sni.length), sni])];
  if (extraExtensionType !== undefined) {
    const ech = Buffer.from([0x01, 0x02, 0x03]);
    extensions.push(
      Buffer.concat([u16(extraExtensionType), u16(ech.length), ech]),
    );
  }
  const extensionBytes = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensionBytes.length),
    extensionBytes,
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 0x01;
  handshake.writeUIntBE(body.length, 1, 3);
  const recordBody = Buffer.concat([handshake, body]);
  return Buffer.concat([
    Buffer.from([0x16, 0x03, 0x03]),
    u16(recordBody.length),
    recordBody,
  ]);
}

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}
