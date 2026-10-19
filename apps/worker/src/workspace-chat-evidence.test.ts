import { describe, expect, it } from "vitest";

import { buildWorkspaceChatOptimizationEvidence } from "./workspace-chat-evidence.ts";

describe("workspace chat optimization evidence", () => {
  it("marks a rewrite as unscored with no fixture evaluations", () => {
    expect(
      buildWorkspaceChatOptimizationEvidence({
        clarificationRequired: false,
        hasRecommendation: true,
        noChangeRecommended: false,
      }),
    ).toEqual({
      optimizationEvidenceStatus: "rewrite_unscored",
      qualityVerified: false,
      fixtureEvaluationCount: 0,
      optimizationDecision: "candidate",
    });
  });

  it("marks a no-change decision as unscored with no fixture evaluations", () => {
    expect(
      buildWorkspaceChatOptimizationEvidence({
        clarificationRequired: false,
        hasRecommendation: false,
        noChangeRecommended: true,
      }),
    ).toEqual({
      optimizationEvidenceStatus: "no_change_unscored",
      qualityVerified: false,
      fixtureEvaluationCount: 0,
      optimizationDecision: "no_change",
    });
  });

  it("keeps clarification separate from optimization evidence", () => {
    expect(
      buildWorkspaceChatOptimizationEvidence({
        clarificationRequired: true,
        hasRecommendation: false,
        noChangeRecommended: false,
      }).optimizationEvidenceStatus,
    ).toBe("clarification_only");
  });
});
