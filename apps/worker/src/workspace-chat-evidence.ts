export function buildWorkspaceChatOptimizationEvidence(input: {
  clarificationRequired: boolean;
  hasRecommendation: boolean;
  noChangeRecommended: boolean;
}) {
  return {
    optimizationEvidenceStatus: input.clarificationRequired
      ? "clarification_only"
      : input.hasRecommendation
        ? "rewrite_unscored"
        : "no_change_unscored",
    qualityVerified: false as const,
    fixtureEvaluationCount: 0 as const,
    optimizationDecision: input.noChangeRecommended
      ? "no_change"
      : input.hasRecommendation
        ? "candidate"
        : null,
  };
}
