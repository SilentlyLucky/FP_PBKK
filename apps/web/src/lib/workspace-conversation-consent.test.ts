import { describe, expect, it } from "vitest";

import { validateConversationSourceSelection } from "./workspace-conversation-consent.js";

const sharedSource = {
  id: "source-shared",
  displayName: "Dokumen bersama",
  permission: "campus_indexer_allowed",
  deleted: false,
  eligible: true,
  versionId: "version-1",
};

describe("workspace conversation source consent", () => {
  it("keeps only selected active, eligible, versioned sources with sharing permission", () => {
    const result = validateConversationSourceSelection(
      [
        sharedSource.id,
        "source-revoked",
        "source-deleted",
        "source-unavailable",
      ],
      [
        sharedSource,
        {
          ...sharedSource,
          id: "source-revoked",
          displayName: "Izin dicabut",
          permission: "local_only",
        },
        {
          ...sharedSource,
          id: "source-deleted",
          displayName: "Dokumen dihapus",
          deleted: true,
        },
      ],
      "ready",
    );

    expect(result.allowedSourceIds).toEqual([sharedSource.id]);
    expect(result.issues).toEqual([
      {
        id: "source-revoked",
        displayName: "Izin dicabut",
        reason: "Izin berbagi sudah dicabut; sumber ini hanya untuk lokal.",
      },
      {
        id: "source-deleted",
        displayName: "Dokumen dihapus",
        reason: "Sumber telah dihapus.",
      },
      {
        id: "source-unavailable",
        displayName: "Sumber tidak tersedia",
        reason: "Sumber tidak lagi tersedia atau telah dihapus.",
      },
    ]);
  });

  it("rejects an ineligible or unversioned source", () => {
    const result = validateConversationSourceSelection(
      ["source-ineligible", "source-unversioned"],
      [
        { ...sharedSource, id: "source-ineligible", eligible: false },
        { ...sharedSource, id: "source-unversioned", versionId: null },
      ],
      "ready",
    );

    expect(result.allowedSourceIds).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.reason.includes("versi aktif"))).toBe(
      true,
    );
  });

  it("treats loading and failed permission refreshes as non-shareable", () => {
    const selected = [sharedSource.id];

    expect(
      validateConversationSourceSelection(selected, [sharedSource], "loading")
        .allowedSourceIds,
    ).toEqual([]);
    expect(
      validateConversationSourceSelection(selected, [sharedSource], "failed")
        .issues[0]?.reason,
    ).toBe("Izin berbagi terbaru tidak dapat diverifikasi.");
  });

  it("never adds sources that were not selected", () => {
    const result = validateConversationSourceSelection(
      [sharedSource.id],
      [sharedSource, { ...sharedSource, id: "source-other" }],
      "ready",
    );

    expect(result.allowedSourceIds).toEqual([sharedSource.id]);
  });
});
