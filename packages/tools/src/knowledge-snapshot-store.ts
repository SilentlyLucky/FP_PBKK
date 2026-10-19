import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { IdSchema } from "@promptlab/contracts";

export const MAX_KNOWLEDGE_SNAPSHOT_BYTES = 5_242_880;

export interface KnowledgeSnapshotReference {
  readonly sha256: string;
  readonly size: number;
}

export class KnowledgeSnapshotStoreError extends Error {
  constructor(
    readonly code:
      | "PROJECT_ID_INVALID"
      | "SNAPSHOT_BYTES_INVALID"
      | "SNAPSHOT_TOO_LARGE"
      | "SNAPSHOT_BLOB_INTEGRITY_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeSnapshotStoreError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedProjectId(projectId: string): string {
  const parsed = IdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new KnowledgeSnapshotStoreError(
      "PROJECT_ID_INVALID",
      "Project ID is invalid",
    );
  }
  return parsed.data;
}

export class KnowledgeSnapshotStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error("SNAPSHOT_ROOT_REQUIRED");
    this.rootDirectory = resolve(rootDirectory);
  }

  async put(
    projectId: string,
    rawBytes: Uint8Array,
  ): Promise<KnowledgeSnapshotReference> {
    const project = checkedProjectId(projectId);
    if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength === 0) {
      throw new KnowledgeSnapshotStoreError(
        "SNAPSHOT_BYTES_INVALID",
        "Snapshot bytes are empty or invalid",
      );
    }
    if (rawBytes.byteLength > MAX_KNOWLEDGE_SNAPSHOT_BYTES) {
      throw new KnowledgeSnapshotStoreError(
        "SNAPSHOT_TOO_LARGE",
        "Snapshot exceeds the local source size limit",
      );
    }

    const bytes = Buffer.from(rawBytes);
    const digest = sha256(bytes);
    const directory = join(
      this.rootDirectory,
      project,
      "blobs",
      "sha256",
      digest.slice(0, 2),
    );
    const destination = join(directory, digest);
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    let createdTemporary = false;
    try {
      const handle = await open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      createdTemporary = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await link(temporary, destination);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        await this.verifyFile(destination, digest, bytes.byteLength);
      }
      return { sha256: digest, size: bytes.byteLength };
    } finally {
      if (createdTemporary) await unlink(temporary).catch(() => undefined);
    }
  }

  async read(
    projectId: string,
    digest: string,
  ): Promise<Uint8Array> {
    const project = checkedProjectId(projectId);
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new KnowledgeSnapshotStoreError(
        "SNAPSHOT_BLOB_INTEGRITY_ERROR",
        "Snapshot reference is invalid",
      );
    }
    const path = join(
      this.rootDirectory,
      project,
      "blobs",
      "sha256",
      digest.slice(0, 2),
      digest,
    );
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || sha256(bytes) !== digest) {
      throw new KnowledgeSnapshotStoreError(
        "SNAPSHOT_BLOB_INTEGRITY_ERROR",
        "Snapshot blob is missing or failed its SHA-256 check",
      );
    }
    return new Uint8Array(bytes);
  }

  private async verifyFile(
    path: string,
    digest: string,
    expectedSize: number,
  ): Promise<void> {
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || bytes.byteLength !== expectedSize || sha256(bytes) !== digest) {
      throw new KnowledgeSnapshotStoreError(
        "SNAPSHOT_BLOB_INTEGRITY_ERROR",
        "Existing content-addressed blob failed verification",
      );
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export function knowledgeSnapshotStoreFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeSnapshotStore {
  const configuredRoot = env.PROMPTLAB_DATA_DIR?.trim();
  const root = configuredRoot || join(process.cwd(), ".local", "promptlab-data");
  return new KnowledgeSnapshotStore(root);
}
