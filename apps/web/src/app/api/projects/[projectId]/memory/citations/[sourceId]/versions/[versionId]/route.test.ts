import { schema, type Database } from "@promptlab/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  sourceVersionId: "66666666-6666-4666-8666-666666666666",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => ({ db: mocks.db }),
  };
});

import { GET } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceId = "55555555-5555-4555-8555-555555555555";
const checksum = "a".repeat(64);

function database(
  activeVersionId = mocks.sourceVersionId,
  permission = "campus_indexer_allowed",
): Database {
  const query = (selection: Record<string, unknown>) => {
    let table: unknown;
    const rows = () => {
      if (table === schema.documents) {
        return [
          {
            id: sourceId,
            name: "Policy source",
            activeVersionId,
            deletedAt: null,
            permission,
            versionId: mocks.sourceVersionId,
            version: 2,
            checksum,
            eligible: true,
            contentType: "text/plain",
          },
        ];
      }
      if (table === schema.chunks) {
        return [
          {
            ordinal: 0,
            heading: "Current rules",
            pageNumber: 1,
            content: "The cited policy text.",
            contentHash: "b".repeat(64),
          },
        ];
      }
      return [];
    };
    const builder = {
      from(value: unknown) {
        table = value;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit: async () => rows(),
    };
    void selection;
    return builder;
  };
  return {
    select: (selection: Record<string, unknown>) => query(selection),
  } as unknown as Database;
}

function context() {
  return {
    params: Promise.resolve({
      projectId,
      sourceId,
      versionId: mocks.sourceVersionId,
    }),
  };
}

describe("verified memory source citation", () => {
  beforeEach(() => {
    mocks.sourceVersionId = "66666666-6666-4666-8666-666666666666";
    mocks.db = database();
  });

  it("serves the exact permission-approved source version and checksum", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory/citations/${sourceId}/versions/${mocks.sourceVersionId}?checksum=${checksum}`,
      ),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: { id: sourceId, versionId: mocks.sourceVersionId, checksum },
      chunks: [{ content: "The cited policy text." }],
    });
  });

  it("requires a checksum and retains exact historical citations while permission remains", async () => {
    const withoutChecksum = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory/citations/${sourceId}/versions/${mocks.sourceVersionId}`,
      ),
      context(),
    );
    expect(withoutChecksum.status).toBe(400);

    mocks.db = database("99999999-9999-4999-8999-999999999999");
    const historical = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory/citations/${sourceId}/versions/${mocks.sourceVersionId}?checksum=${checksum}`,
      ),
      context(),
    );
    expect(historical.status).toBe(200);

    mocks.db = database(mocks.sourceVersionId, "unreviewed");
    const permissionRevoked = await GET(
      new Request(
        `http://localhost/api/projects/${projectId}/memory/citations/${sourceId}/versions/${mocks.sourceVersionId}?checksum=${checksum}`,
      ),
      context(),
    );
    expect(permissionRevoked.status).toBe(404);
  });
});
