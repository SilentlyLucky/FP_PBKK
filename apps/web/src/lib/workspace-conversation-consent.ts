export interface ConversationSourcePermission {
  id: string;
  displayName: string;
  permission: string;
  deleted: boolean;
  eligible: boolean;
  versionId: string | null;
}

export interface SelectedSourceIssue {
  id: string;
  displayName: string;
  reason: string;
}

export type SourceSnapshotState = "loading" | "ready" | "failed";

export interface SourceSelectionValidation {
  allowedSourceIds: string[];
  issues: SelectedSourceIssue[];
}

export function validateConversationSourceSelection(
  selectedSourceIds: string[],
  sources: readonly ConversationSourcePermission[],
  snapshotState: SourceSnapshotState,
): SourceSelectionValidation {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const allowedSourceIds: string[] = [];
  const issues: SelectedSourceIssue[] = [];

  for (const id of [...new Set(selectedSourceIds)]) {
    const source = byId.get(id);
    let reason: string | null = null;

    if (snapshotState === "loading") {
      reason = "Daftar sumber masih dimuat.";
    } else if (snapshotState === "failed") {
      reason = "Status sumber terbaru tidak dapat diperiksa.";
    } else if (!source) {
      reason = "Sumber tidak lagi tersedia atau telah dihapus.";
    } else if (source.deleted) {
      reason = "Sumber telah dihapus.";
    } else if (!source.eligible || !source.versionId) {
      reason = "Sumber belum memiliki versi aktif yang layak digunakan.";
    }

    if (reason) {
      issues.push({
        id,
        displayName: source?.displayName || "Sumber tidak tersedia",
        reason,
      });
    } else {
      allowedSourceIds.push(id);
    }
  }

  return { allowedSourceIds, issues };
}
