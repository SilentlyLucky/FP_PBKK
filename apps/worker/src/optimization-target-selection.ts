import type { PromptOptimizationTargetSelection } from "@promptlab/contracts";
import type {
  OptimizationTargetRecommendation,
  OptimizationTargetSelectionEvidence,
} from "@promptlab/agent";

export interface CurrentCodexModelCapability {
  id: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  inputModalities: string[];
}

export class OptimizationTargetSelectionError extends Error {
  constructor(
    readonly code:
      "codex_model_unavailable" | "codex_reasoning_effort_unavailable",
  ) {
    super(code);
    this.name = "OptimizationTargetSelectionError";
  }
}

function normalizedModelNames(model: CurrentCodexModelCapability): string[] {
  return [model.id, model.displayName].map((value) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/gu, "-"),
  );
}

function autoEffortPolicy(model: CurrentCodexModelCapability): {
  requiredEffort?: string;
  recommendedEfforts?: readonly string[];
} | null {
  const names = normalizedModelNames(model);
  // These rules apply only to Auto. The live catalog remains authoritative.
  if (names.some((name) => /(?:^|-)luna(?:-|$)/u.test(name))) {
    return { requiredEffort: "max" };
  }
  if (names.some((name) => /(?:^|-)gpt-6\.1-sol(?:-|$)/u.test(name))) {
    return { recommendedEfforts: ["medium", "high"] };
  }
  if (names.some((name) => /(?:^|-)gpt-6-astra(?:-|$)/u.test(name))) {
    return { recommendedEfforts: ["high", "xhigh"] };
  }
  return null;
}

export function resolveOptimizationTargetSelection(input: {
  models: readonly CurrentCodexModelCapability[];
  requestedModel: string;
  requestedReasoningEffort?: string;
  selection?: PromptOptimizationTargetSelection;
  recommendation?: OptimizationTargetRecommendation | null;
  frozenSelection?: OptimizationTargetSelectionEvidence | null;
  observedAt: string;
}): {
  model: CurrentCodexModelCapability;
  sentReasoningEffort: string | undefined;
  evidence: OptimizationTargetSelectionEvidence;
} {
  const selection = input.selection ?? {
    model: "selected" as const,
    reasoningEffort: "selected" as const,
  };
  if (input.frozenSelection) {
    return resolveFrozenSelection(input, selection);
  }
  const textModels = input.models.filter((model) =>
    model.inputModalities.includes("text"),
  );
  let model: CurrentCodexModelCapability | undefined;
  let modelCatalogPosition = 0;
  let modelResolution: OptimizationTargetSelectionEvidence["modelResolution"] =
    "explicit";
  const requestedEffort = input.requestedReasoningEffort;
  const recommendationModel = input.recommendation?.modelId
    ? input.models.find(
        (item) =>
          item.id === input.recommendation?.modelId &&
          item.inputModalities.includes("text") &&
          (selection.reasoningEffort !== "auto" ||
            item.supportedReasoningEfforts.length > 0) &&
          (selection.reasoningEffort !== "selected" ||
            requestedEffort === undefined ||
            item.supportedReasoningEfforts.includes(requestedEffort)),
      )
    : undefined;

  if (selection.model === "selected") {
    model = input.models.find((item) => item.id === input.requestedModel);
    if (!model || !model.inputModalities.includes("text")) {
      throw new OptimizationTargetSelectionError("codex_model_unavailable");
    }
    modelCatalogPosition = input.models.indexOf(model) + 1;
  } else {
    if (recommendationModel) {
      model = recommendationModel;
      modelCatalogPosition = input.models.indexOf(model) + 1;
      modelResolution = "task_aware_recommendation";
    } else {
      modelCatalogPosition = input.models.findIndex(
        (item) =>
          item.inputModalities.includes("text") &&
          (selection.reasoningEffort !== "auto" ||
            item.supportedReasoningEfforts.length > 0) &&
          (selection.reasoningEffort !== "selected" ||
            requestedEffort === undefined ||
            item.supportedReasoningEfforts.includes(requestedEffort)),
      );
      if (modelCatalogPosition >= 0) {
        model = input.models[modelCatalogPosition];
        modelCatalogPosition += 1;
      }
      modelResolution = "first_current_compatible_text_model";
    }
    if (!model) {
      if (
        textModels.length > 0 &&
        (selection.reasoningEffort === "auto" ||
          (input.requestedReasoningEffort !== undefined &&
            !textModels.some((item) =>
              item.supportedReasoningEfforts.includes(
                input.requestedReasoningEffort!,
              ),
            )))
      ) {
        throw new OptimizationTargetSelectionError(
          "codex_reasoning_effort_unavailable",
        );
      }
      throw new OptimizationTargetSelectionError("codex_model_unavailable");
    }
  }

  let resolvedReasoningEffort: string | null = null;
  let sentReasoningEffort: string | undefined;
  let effortResolution: OptimizationTargetSelectionEvidence["effortResolution"];
  if (selection.reasoningEffort === "auto") {
    const supported = model.supportedReasoningEfforts;
    if (supported.length === 0) {
      throw new OptimizationTargetSelectionError(
        "codex_reasoning_effort_unavailable",
      );
    }
    const policy = autoEffortPolicy(model);
    if (policy?.requiredEffort) {
      if (!supported.includes(policy.requiredEffort)) {
        throw new OptimizationTargetSelectionError(
          "codex_reasoning_effort_unavailable",
        );
      }
      resolvedReasoningEffort = policy.requiredEffort;
      sentReasoningEffort = policy.requiredEffort;
      effortResolution = "model_specific_auto_policy";
    } else {
      const recommendationMatchesModel =
        selection.model === "auto"
          ? input.recommendation?.modelId === model.id
          : !input.recommendation?.modelId ||
            input.recommendation.modelId === model.id;
      const recommendedEffort = recommendationMatchesModel
        ? input.recommendation?.reasoningEffort
        : undefined;
      const recommendationAllowed =
        typeof recommendedEffort === "string" &&
        (!policy?.recommendedEfforts ||
          policy.recommendedEfforts.includes(recommendedEffort));
      if (recommendationAllowed && supported.includes(recommendedEffort)) {
        resolvedReasoningEffort = recommendedEffort;
        sentReasoningEffort = recommendedEffort;
        effortResolution = "task_aware_recommendation";
      } else {
        const fallbackEfforts = policy?.recommendedEfforts
          ? policy.recommendedEfforts.filter((effort) =>
              supported.includes(effort),
            )
          : supported;
        if (fallbackEfforts.length === 0) {
          throw new OptimizationTargetSelectionError(
            "codex_reasoning_effort_unavailable",
          );
        }
        const selectedEffort = fallbackEfforts.includes(
          model.defaultReasoningEffort,
        )
          ? model.defaultReasoningEffort
          : fallbackEfforts[0]!;
        resolvedReasoningEffort = selectedEffort;
        sentReasoningEffort = selectedEffort;
        const hasUnusedConcreteRecommendation = Boolean(
          input.recommendation?.reasoningEffort,
        );
        effortResolution = hasUnusedConcreteRecommendation
          ? "unsupported_recommendation_fallback"
          : selectedEffort === model.defaultReasoningEffort
            ? "advertised_default"
            : "first_advertised_supported";
      }
    }
  } else if (input.requestedReasoningEffort !== undefined) {
    if (
      !model.supportedReasoningEfforts.includes(input.requestedReasoningEffort)
    ) {
      throw new OptimizationTargetSelectionError(
        "codex_reasoning_effort_unavailable",
      );
    }
    resolvedReasoningEffort = input.requestedReasoningEffort;
    sentReasoningEffort = input.requestedReasoningEffort;
    effortResolution = "explicit";
  } else {
    resolvedReasoningEffort = null;
    effortResolution = "provider_default";
  }

  return {
    model,
    sentReasoningEffort,
    evidence: {
      selection,
      requestedModel: input.requestedModel,
      resolvedModel: model.id,
      requestedReasoningEffort: input.requestedReasoningEffort ?? null,
      resolvedReasoningEffort,
      sentReasoningEffort: sentReasoningEffort ?? null,
      modelResolution: modelResolution,
      effortResolution,
      capabilitySource: "live_codex_model_list",
      observedAt: input.observedAt,
      modelCatalogPosition,
      modelCatalogCount: input.models.length,
      modelCapabilities: {
        displayName: model.displayName,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: [...model.supportedReasoningEfforts],
        inputModalities: [...model.inputModalities],
      },
      selectionReason:
        effortResolution === "model_specific_auto_policy"
          ? `Kebijakan effort Auto untuk ${model.displayName} memilih ${sentReasoningEffort}; nilai ini divalidasi terhadap katalog Codex live.`
          : effortResolution === "unsupported_recommendation_fallback"
            ? "Rekomendasi effort tidak cocok dengan kebijakan atau kemampuan model; Auto memakai effort bawaan atau effort pertama yang didukung katalog."
            : input.recommendation && recommendationModel
              ? (validateOptimizationTargetRecommendation({
                  recommendation: input.recommendation,
                  selection,
                  capabilities: input.models,
                }) ??
                buildSelectionReason({
                  selection,
                  modelResolution,
                  effortResolution,
                }))
              : buildSelectionReason({
                  selection,
                  modelResolution,
                  effortResolution,
                }),
    },
  };
}

/** Resolve an ordinary Workspace target using its explicit model and optional Auto effort. */
export function resolveWorkspaceChatTargetSelection(input: {
  models: readonly CurrentCodexModelCapability[];
  requestedModel: string;
  reasoningEffort?: string | null;
  reasoningEffortMode?: "selected" | "auto";
  recommendation?: string | null;
  observedAt: string;
}) {
  const reasoningEffortMode = input.reasoningEffortMode ?? "selected";
  return resolveOptimizationTargetSelection({
    models: input.models,
    requestedModel: input.requestedModel,
    ...(reasoningEffortMode === "selected" && input.reasoningEffort
      ? { requestedReasoningEffort: input.reasoningEffort }
      : {}),
    selection: { model: "selected", reasoningEffort: reasoningEffortMode },
    ...(reasoningEffortMode === "auto"
      ? {
          recommendation: {
            modelId: input.requestedModel,
            reasoningEffort: input.recommendation ?? null,
          },
        }
      : {}),
    observedAt: input.observedAt,
  });
}

export function validateOptimizationTargetRecommendation(input: {
  recommendation: OptimizationTargetRecommendation | null;
  selection: PromptOptimizationTargetSelection;
  capabilities: readonly CurrentCodexModelCapability[];
}): string | null {
  const recommendation = input.recommendation;
  if (!recommendation) return null;
  const model = recommendation.modelId
    ? input.capabilities.find((item) => item.id === recommendation.modelId)
    : undefined;
  if (!model && input.selection.model === "auto") return null;
  if (recommendation.modelId) {
    if (!model || !model.inputModalities.includes("text")) return null;
    if (
      input.selection.reasoningEffort === "auto" &&
      model.supportedReasoningEfforts.length === 0
    ) {
      return null;
    }
  }
  if (recommendation.reasoningEffort) {
    const eligibleModels = recommendation.modelId
      ? model
        ? [model]
        : []
      : input.capabilities.filter((item) =>
          item.inputModalities.includes("text"),
        );
    if (
      !eligibleModels.some((item) =>
        item.supportedReasoningEfforts.includes(
          recommendation.reasoningEffort!,
        ),
      )
    ) {
      return null;
    }
  }
  if (input.selection.model === "selected" && recommendation.modelId !== null) {
    return null;
  }
  if (
    input.selection.reasoningEffort === "selected" &&
    recommendation.reasoningEffort !== null
  ) {
    return null;
  }
  return recommendation.modelId || recommendation.reasoningEffort
    ? "Senopati merekomendasikan target dari kemampuan yang tercantum di katalog Codex live; pilihan auto divalidasi sebelum digunakan."
    : null;
}

function resolveFrozenSelection(
  input: {
    models: readonly CurrentCodexModelCapability[];
    requestedModel: string;
    requestedReasoningEffort?: string;
    frozenSelection?: OptimizationTargetSelectionEvidence | null;
    observedAt: string;
  },
  selection: PromptOptimizationTargetSelection,
): ReturnType<typeof resolveOptimizationTargetSelection> {
  const frozen = input.frozenSelection;
  if (
    !frozen ||
    frozen.requestedModel !== input.requestedModel ||
    JSON.stringify(frozen.selection) !== JSON.stringify(selection) ||
    frozen.requestedReasoningEffort !== (input.requestedReasoningEffort ?? null)
  ) {
    throw new OptimizationTargetSelectionError("codex_model_unavailable");
  }
  const model = input.models.find(
    (item) =>
      item.id === frozen.resolvedModel && item.inputModalities.includes("text"),
  );
  if (!model) {
    throw new OptimizationTargetSelectionError("codex_model_unavailable");
  }
  const effort = frozen.sentReasoningEffort;
  if (
    (effort !== null && !model.supportedReasoningEfforts.includes(effort)) ||
    (selection.reasoningEffort === "auto" && effort === null) ||
    (selection.reasoningEffort === "selected" &&
      input.requestedReasoningEffort !== undefined &&
      effort !== input.requestedReasoningEffort) ||
    (selection.reasoningEffort === "selected" &&
      input.requestedReasoningEffort === undefined &&
      effort !== null)
  ) {
    throw new OptimizationTargetSelectionError(
      "codex_reasoning_effort_unavailable",
    );
  }
  return {
    model,
    sentReasoningEffort: effort ?? undefined,
    evidence: {
      ...frozen,
      capabilitySource: "live_codex_model_list",
      modelCatalogPosition: input.models.indexOf(model) + 1,
      modelCatalogCount: input.models.length,
      modelCapabilities: {
        displayName: model.displayName,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: [...model.supportedReasoningEfforts],
        inputModalities: [...model.inputModalities],
      },
      revalidatedAt: input.observedAt,
    },
  };
}

function buildSelectionReason(input: {
  selection: PromptOptimizationTargetSelection;
  modelResolution: OptimizationTargetSelectionEvidence["modelResolution"];
  effortResolution: OptimizationTargetSelectionEvidence["effortResolution"];
}): string {
  const modelWasManual = input.selection.model === "selected";
  const effortWasManual = input.selection.reasoningEffort === "selected";
  if (modelWasManual && effortWasManual) {
    return "Model dan effort yang dipilih manual tetap digunakan.";
  }
  if (modelWasManual) {
    return input.effortResolution === "task_aware_recommendation"
      ? "Model manual tetap digunakan; effort rekomendasi didukung oleh katalog Codex live."
      : "Model manual tetap digunakan; effort dipilih dari kemampuan yang tercantum untuk model itu.";
  }
  if (effortWasManual) {
    return input.modelResolution === "task_aware_recommendation"
      ? "Senopati memilih model text yang cocok dan mendukung effort manual yang dipilih."
      : "Effort manual tetap digunakan; model pertama yang mendukungnya dipilih dari katalog Codex live.";
  }
  if (
    input.modelResolution === "task_aware_recommendation" &&
    input.effortResolution === "task_aware_recommendation"
  ) {
    return "Senopati mencocokkan tugas dengan model dan effort yang tercantum sebagai didukung di katalog Codex live.";
  }
  if (input.modelResolution === "task_aware_recommendation") {
    return "Senopati memilih model text yang cocok; effort memakai default yang tercantum sebagai didukung.";
  }
  return "Rekomendasi Senopati tidak kompatibel; model text dan effort dipilih dari kemampuan yang tercantum di katalog Codex live.";
}
