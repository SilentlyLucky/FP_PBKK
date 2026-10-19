import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  replaceKnowledgeSource: vi.fn(),
  putSnapshot: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => ({ db: mocks.db }),
  };
});

vi.mock("@promptlab/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptlab/db")>();
  return {
    ...actual,
    replaceKnowledgeSource: mocks.replaceKnowledgeSource,
  };
});

vi.mock("@promptlab/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptlab/tools")>();
  return {
    ...actual,
    knowledgeSnapshotStoreFromEnvironment: () => ({ put: mocks.putSnapshot }),
  };
});

import { PUT } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const rawBytes = new TextEncoder().encode("updated raw source content");
const sha256 = "a".repeat(64);

describe("knowledge source replacement upload", () => {
  beforeEach(() => {
    mocks.db = {};
    mocks.replaceKnowledgeSource.mockReset().mockResolvedValue({
      id: sourceId,
      version: 2,
    });
    mocks.putSnapshot.mockReset().mockResolvedValue({
      sha256,
      size: rawBytes.byteLength,
    });
  });

  it("stores the uploaded raw bytes and binds the snapshot digest to the replacement", async () => {
    const form = new FormData();
    const fileBytes = new ArrayBuffer(rawBytes.byteLength);
    new Uint8Array(fileBytes).set(rawBytes);
    form.set("sourceKind", "upload");
    form.set("permission", "local_only");
    form.set(
      "file",
      new File([fileBytes], "updated.md", { type: "text/markdown" }),
    );

    const response = await PUT(
      new Request(
        `http://localhost/api/projects/${projectId}/knowledge/sources/${sourceId}`,
        { method: "PUT", body: form },
      ),
      { params: Promise.resolve({ projectId, sourceId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.putSnapshot).toHaveBeenCalledWith(projectId, rawBytes);
    expect(mocks.replaceKnowledgeSource).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        projectId,
        sourceId,
        displayName: "updated.md",
        content: "updated raw source content",
        permission: "local_only",
        rawByteSha256: sha256,
        rawByteSize: rawBytes.byteLength,
      }),
    );
    expect(mocks.replaceKnowledgeSource.mock.calls[0]?.[1]).not.toHaveProperty(
      "rawBytes",
    );
    expect(await response.json()).toEqual({
      source: { id: sourceId, version: 2 },
    });
  });
});
