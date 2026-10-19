import { describe, expect, it, vi } from "vitest";

import type { Database } from "./index.js";
import {
  captureWorkspaceSourceManifest,
  isWorkspaceSourceManifestCurrent,
  parseWorkspaceSourceManifest,
  workspaceSourceManifestMatchesCurrent,
} from "./workspace-source-manifest.js";
import { retrieveKnowledgeContext } from "./graph-retrieval.js";

const sourceA = "11111111-1111-4111-8111-111111111111";
const versionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const checksumA = "a".repeat(64);

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    documentId: sourceA,
    activeVersionId: versionA,
    deletedAt: null,
    permission: "campus_indexer_allowed",
    documentVersionId: versionA,
    documentVersion: 4,
    checksum: checksumA,
    eligible: true,
    ...overrides,
  };
}

function databaseWithRows(rows: unknown[]): Database {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return { select: vi.fn(() => query) } as unknown as Database;
}

describe("Workspace source manifest", () => {
  it("parses the canonical bounded contracts manifest", () => {
    const manifest = {
      format: "promptlab-workspace-source-manifest-v1",
      sources: [
        {
          documentId: sourceA,
          documentVersionId: versionA,
          documentVersion: 4,
          checksum: checksumA,
          sourcePermission: "campus_indexer_allowed",
        },
      ],
    };
    expect(parseWorkspaceSourceManifest(manifest)).toEqual(manifest);
    expect(
      parseWorkspaceSourceManifest({
        ...manifest,
        sources: Array.from({ length: 21 }, () => manifest.sources[0]),
      }),
    ).toBeNull();
    expect(
      parseWorkspaceSourceManifest({ ...manifest, format: "legacy" }),
    ).toBeNull();
  });

  it("captures the selected active source version, checksum, and egress permission", async () => {
    const captured = await captureWorkspaceSourceManifest(
      databaseWithRows([sourceRow()]),
      "project-a",
      [sourceA],
    );

    expect(captured).toEqual({
      ok: true,
      manifest: {
        format: "promptlab-workspace-source-manifest-v1",
        sources: [
          {
            documentId: sourceA,
            documentVersionId: versionA,
            documentVersion: 4,
            checksum: checksumA,
            sourcePermission: "campus_indexer_allowed",
          },
        ],
      },
    });
  });

  it("refuses deleted, ineligible, missing, and local-only selected sources", async () => {
    await expect(
      captureWorkspaceSourceManifest(
        databaseWithRows([sourceRow({ deletedAt: new Date() })]),
        "project-a",
        [sourceA],
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "source_selection_not_current_in_project",
    });

    await expect(
      captureWorkspaceSourceManifest(
        databaseWithRows([sourceRow({ eligible: false })]),
        "project-a",
        [sourceA],
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "source_selection_not_current_in_project",
    });

    await expect(
      captureWorkspaceSourceManifest(databaseWithRows([]), "project-a", [
        sourceA,
      ]),
    ).resolves.toMatchObject({
      ok: false,
      reason: "source_selection_not_current_in_project",
    });

    await expect(
      captureWorkspaceSourceManifest(
        databaseWithRows([sourceRow({ permission: "local_only" })]),
        "project-a",
        [sourceA],
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "source_permission_not_granted",
    });
  });

  it("treats version, checksum, permission, or source-set changes as stale", async () => {
    const captured = await captureWorkspaceSourceManifest(
      databaseWithRows([sourceRow()]),
      "project-a",
      [sourceA],
    );
    if (!captured.ok) throw new Error("Expected a valid source manifest");
    const expected = captured.manifest.sources;

    expect(
      workspaceSourceManifestMatchesCurrent(expected, [
        {
          documentId: sourceA,
          documentVersionId: versionA,
          documentVersion: 4,
          checksum: checksumA,
          permission: "campus_indexer_allowed",
        },
      ]),
    ).toBe(true);
    expect(
      workspaceSourceManifestMatchesCurrent(expected, [
        {
          documentId: sourceA,
          documentVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          documentVersion: 5,
          checksum: "b".repeat(64),
          permission: "campus_indexer_allowed",
        },
      ]),
    ).toBe(false);
    expect(
      workspaceSourceManifestMatchesCurrent(expected, [
        {
          documentId: sourceA,
          documentVersionId: versionA,
          documentVersion: 4,
          checksum: checksumA,
          permission: "local_only",
        },
      ]),
    ).toBe(false);
    expect(workspaceSourceManifestMatchesCurrent(expected, [])).toBe(false);
  });

  it("revalidates a frozen manifest against the current selected source", async () => {
    const captured = await captureWorkspaceSourceManifest(
      databaseWithRows([sourceRow()]),
      "project-a",
      [sourceA],
    );
    if (!captured.ok) throw new Error("Expected a valid source manifest");

    await expect(
      isWorkspaceSourceManifestCurrent(
        databaseWithRows([sourceRow()]),
        "project-a",
        captured.manifest,
      ),
    ).resolves.toBe(true);
    await expect(
      isWorkspaceSourceManifestCurrent(
        databaseWithRows([sourceRow({ checksum: "c".repeat(64) })]),
        "project-a",
        captured.manifest,
      ),
    ).resolves.toBe(false);
  });

  it("rejects retrieval before reading chunks when a frozen version has changed", async () => {
    const expectedManifest = {
      documentId: sourceA,
      documentVersionId: versionA,
      documentVersion: 4,
      checksum: checksumA,
      sourcePermission: "campus_indexer_allowed" as const,
    };
    const query = {
      from: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(async () => [
        sourceRow({
          documentVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          documentVersion: 5,
          checksum: "b".repeat(64),
        }),
      ]),
    };
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => query),
    };
    const db = {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as Database;

    await expect(
      retrieveKnowledgeContext(db, {
        projectId: "project-a",
        query: "refund policy",
        strategy: "lexical",
        sourceIds: [sourceA],
        sourceManifest: [expectedManifest],
        requireCampusPermission: true,
      }),
    ).rejects.toThrow("WORKSPACE_SOURCE_MANIFEST_CHANGED");
    expect(tx.select).toHaveBeenCalledTimes(1);
  });
});
