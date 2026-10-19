import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KnowledgeSnapshotStore,
  KnowledgeSnapshotStoreError,
  MAX_KNOWLEDGE_SNAPSHOT_BYTES,
} from "./knowledge-snapshot-store.js";

const projectA = "00000000-0000-4000-8000-000000000001";
const projectB = "00000000-0000-4000-8000-000000000002";

describe("KnowledgeSnapshotStore", () => {
  let root: string;
  let store: KnowledgeSnapshotStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "promptlab-snapshots-"));
    store = new KnowledgeSnapshotStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores exact bytes immutably by project and raw-byte SHA-256", async () => {
    const original = new TextEncoder().encode("2 + 2 = 5\r\n");
    const expected = Buffer.from(original);
    const reference = await store.put(projectA, original);
    original[0] = 0;

    expect(reference.size).toBe(expected.byteLength);
    expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(store.read(projectA, reference.sha256)).resolves.toEqual(
      new Uint8Array(expected),
    );

    const same = await store.put(projectA, expected);
    expect(same).toEqual(reference);
    await expect(store.read(projectA, reference.sha256)).resolves.toEqual(
      new Uint8Array(expected),
    );
    await expect(store.read(projectB, reference.sha256)).rejects.toMatchObject({
      code: "SNAPSHOT_BLOB_INTEGRITY_ERROR",
    });
  });

  it("refuses corrupted bytes at a content-addressed key", async () => {
    const bytes = new TextEncoder().encode("source");
    const reference = await store.put(projectA, bytes);
    const path = join(
      root,
      projectA,
      "blobs",
      "sha256",
      reference.sha256.slice(0, 2),
      reference.sha256,
    );
    await writeFile(path, "different bytes");

    await expect(store.put(projectA, bytes)).rejects.toMatchObject({
      code: "SNAPSHOT_BLOB_INTEGRITY_ERROR",
    });
    await expect(store.read(projectA, reference.sha256)).rejects.toMatchObject({
      code: "SNAPSHOT_BLOB_INTEGRITY_ERROR",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("different bytes");
  });

  it("rejects invalid project IDs, empty bytes, and oversized snapshots", async () => {
    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toMatchObject(
      { code: "PROJECT_ID_INVALID" },
    );
    await expect(store.put(projectA, new Uint8Array())).rejects.toBeInstanceOf(
      KnowledgeSnapshotStoreError,
    );
    await expect(
      store.put(projectA, new Uint8Array(MAX_KNOWLEDGE_SNAPSHOT_BYTES + 1)),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
  });
});
