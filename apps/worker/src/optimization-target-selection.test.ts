import { describe, expect, it, vi } from "vitest";

import {
  OptimizationTargetSelectionError,
  resolveWorkspaceChatTargetSelection,
  resolveOptimizationTargetSelection,
} from "./optimization-target-selection.js";

const models = [
  {
    id: "gpt-next-codex",
    displayName: "GPT Next Codex",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    inputModalities: ["text"],
  },
  {
    id: "gpt-current-codex",
    displayName: "GPT Current Codex",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["medium", "high"],
    inputModalities: ["text", "image"],
  },
  {
    id: "image-only",
    displayName: "Image Only",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
    inputModalities: ["image"],
  },
];

describe("optimization target selection", () => {
  it("keeps the requested model and effort when selection is omitted", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "gpt-current-codex",
      requestedReasoningEffort: "high",
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe("gpt-current-codex");
    expect(result.sentReasoningEffort).toBe("high");
    expect(result.evidence).toMatchObject({
      selection: { model: "selected", reasoningEffort: "selected" },
      requestedModel: "gpt-current-codex",
      resolvedModel: "gpt-current-codex",
      requestedReasoningEffort: "high",
      resolvedReasoningEffort: "high",
      capabilitySource: "live_codex_model_list",
      modelCatalogPosition: 2,
    });
  });

  it("leaves the provider default untouched when the user selected no effort", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "gpt-current-codex",
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.sentReasoningEffort).toBeUndefined();
    expect(result.evidence).toMatchObject({
      selection: { reasoningEffort: "selected" },
      requestedReasoningEffort: null,
      resolvedReasoningEffort: null,
      effortResolution: "provider_default",
    });
  });

  it("selects the first current text model and its advertised default effort", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "gpt-current-codex",
      selection: { model: "auto", reasoningEffort: "auto" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe("gpt-next-codex");
    expect(result.sentReasoningEffort).toBe("medium");
    expect(result.evidence).toMatchObject({
      modelResolution: "first_current_compatible_text_model",
      effortResolution: "advertised_default",
      modelCapabilities: {
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    });
  });

  it("uses a supported listed effort when the provider default is not advertised", () => {
    const result = resolveOptimizationTargetSelection({
      models: [
        {
          ...models[0]!,
          defaultReasoningEffort: "xhigh",
          supportedReasoningEfforts: ["low", "high"],
        },
      ],
      requestedModel: "gpt-next-codex",
      selection: { model: "auto", reasoningEffort: "auto" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.sentReasoningEffort).toBe("low");
    expect(result.evidence.effortResolution).toBe("first_advertised_supported");
  });

  it("keeps an explicit effort while selecting only a compatible live model", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "not-in-catalog",
      requestedReasoningEffort: "high",
      selection: { model: "auto", reasoningEffort: "selected" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe("gpt-next-codex");
    expect(result.sentReasoningEffort).toBe("high");
    expect(result.evidence.requestedReasoningEffort).toBe("high");
  });

  it("uses a compatible Senopati recommendation only for auto fields", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "gpt-next-codex",
      selection: { model: "auto", reasoningEffort: "auto" },
      recommendation: {
        modelId: "gpt-current-codex",
        reasoningEffort: "high",
      },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe("gpt-current-codex");
    expect(result.sentReasoningEffort).toBe("high");
    expect(result.evidence).toMatchObject({
      modelResolution: "task_aware_recommendation",
      effortResolution: "task_aware_recommendation",
    });
  });

  it("always resolves Luna Auto to max when the live catalog supports it", () => {
    const luna = {
      ...models[0]!,
      id: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
    };
    const result = resolveOptimizationTargetSelection({
      models: [luna],
      requestedModel: luna.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      recommendation: { modelId: null, reasoningEffort: "medium" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.sentReasoningEffort).toBe("max");
    expect(result.evidence).toMatchObject({
      selection: { model: "selected", reasoningEffort: "auto" },
      resolvedReasoningEffort: "max",
      sentReasoningEffort: "max",
      effortResolution: "model_specific_auto_policy",
      selectionReason: expect.stringContaining("max"),
    });
  });

  it("does not silently lower Luna Auto when max is absent from the live catalog", () => {
    const luna = {
      ...models[0]!,
      id: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      supportedReasoningEfforts: ["low", "medium", "high"],
    };

    expect(() =>
      resolveOptimizationTargetSelection({
        models: [luna],
        requestedModel: luna.id,
        selection: { model: "selected", reasoningEffort: "auto" },
        observedAt: "2026-10-15T00:00:00.000Z",
      }),
    ).toThrow(
      expect.objectContaining({ code: "codex_reasoning_effort_unavailable" }),
    );
  });

  it("uses Sol 6.1 and Astra task-aware recommendations only in their Auto ranges", () => {
    const sol = {
      ...models[0]!,
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    };
    const astra = {
      ...models[1]!,
      id: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      supportedReasoningEfforts: ["medium", "high", "xhigh"],
    };
    const solResult = resolveOptimizationTargetSelection({
      models: [sol],
      requestedModel: sol.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      recommendation: { modelId: null, reasoningEffort: "high" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });
    const solBoundedResult = resolveOptimizationTargetSelection({
      models: [sol],
      requestedModel: sol.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      recommendation: { modelId: null, reasoningEffort: "medium" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });
    const astraResult = resolveOptimizationTargetSelection({
      models: [astra],
      requestedModel: astra.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      recommendation: { modelId: null, reasoningEffort: "xhigh" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });
    const astraRoutineResult = resolveOptimizationTargetSelection({
      models: [astra],
      requestedModel: astra.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      recommendation: { modelId: null, reasoningEffort: "medium" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(solResult.sentReasoningEffort).toBe("high");
    expect(solResult.evidence.effortResolution).toBe(
      "task_aware_recommendation",
    );
    expect(solBoundedResult.sentReasoningEffort).toBe("medium");
    expect(astraResult.sentReasoningEffort).toBe("xhigh");
    expect(astraRoutineResult.sentReasoningEffort).toBe("high");
    expect(astraRoutineResult.evidence.effortResolution).toBe(
      "unsupported_recommendation_fallback",
    );
  });

  it("keeps Sol and Astra fallback choices inside their Auto policy ranges", () => {
    const sol = {
      ...models[0]!,
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high"],
    };
    const astra = {
      ...models[1]!,
      id: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["medium", "high", "xhigh"],
    };
    const solFallback = resolveOptimizationTargetSelection({
      models: [sol],
      requestedModel: sol.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });
    const astraFallback = resolveOptimizationTargetSelection({
      models: [astra],
      requestedModel: astra.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(solFallback.sentReasoningEffort).toBe("medium");
    expect(astraFallback.sentReasoningEffort).toBe("high");
    expect(solFallback.evidence.effortResolution).toBe(
      "first_advertised_supported",
    );
    expect(astraFallback.evidence.effortResolution).toBe(
      "first_advertised_supported",
    );
  });

  it("applies Sol and Astra Auto policy to catalog model variants", () => {
    const sol = {
      ...models[0]!,
      id: "gpt-6.1-sol-codex-latest",
      displayName: "GPT-6.1 Sol Codex latest",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high"],
    };
    const astra = {
      ...models[1]!,
      id: "gpt-6-astra-preview",
      displayName: "GPT-6 Astra Preview",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["medium", "high", "xhigh"],
    };
    const solResult = resolveOptimizationTargetSelection({
      models: [sol],
      requestedModel: sol.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });
    const astraResult = resolveOptimizationTargetSelection({
      models: [astra],
      requestedModel: astra.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(solResult.sentReasoningEffort).toBe("medium");
    expect(astraResult.sentReasoningEffort).toBe("high");
    expect(solResult.evidence.effortResolution).toBe(
      "first_advertised_supported",
    );
    expect(astraResult.evidence.effortResolution).toBe(
      "first_advertised_supported",
    );
  });

  it("fails before a target call when no live effort is inside the Auto policy range", () => {
    const sol = {
      ...models[0]!,
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      supportedReasoningEfforts: ["low"],
    };

    expect(() =>
      resolveWorkspaceChatTargetSelection({
        models: [sol],
        requestedModel: sol.id,
        reasoningEffortMode: "auto",
        observedAt: "2026-10-15T00:00:00.000Z",
      }),
    ).toThrow(
      expect.objectContaining({ code: "codex_reasoning_effort_unavailable" }),
    );
  });

  it("rejects an explicit Workspace effort that the live model no longer supports", () => {
    const targetCall = vi.fn();

    expect(() => {
      const selection = resolveWorkspaceChatTargetSelection({
        models,
        requestedModel: "gpt-next-codex",
        reasoningEffort: "max",
        reasoningEffortMode: "selected",
        observedAt: "2026-10-15T00:00:00.000Z",
      });
      targetCall(selection.sentReasoningEffort);
    }).toThrow(
      expect.objectContaining({ code: "codex_reasoning_effort_unavailable" }),
    );

    expect(targetCall).not.toHaveBeenCalled();
  });

  it("keeps Workspace Auto separate from the explicitly selected effort field", () => {
    const result = resolveWorkspaceChatTargetSelection({
      models: [
        {
          ...models[0]!,
          id: "gpt-6-luna",
          displayName: "GPT-6 Luna",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
        },
      ],
      requestedModel: "gpt-6-luna",
      reasoningEffort: "low",
      reasoningEffortMode: "auto",
      recommendation: "medium",
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.sentReasoningEffort).toBe("max");
    expect(result.evidence.requestedReasoningEffort).toBeNull();
    expect(result.evidence.selection).toEqual({
      model: "selected",
      reasoningEffort: "auto",
    });
  });

  it("keeps both manual choices authoritative over a recommendation", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "gpt-next-codex",
      requestedReasoningEffort: "low",
      recommendation: {
        modelId: "gpt-current-codex",
        reasoningEffort: "high",
      },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe("gpt-next-codex");
    expect(result.sentReasoningEffort).toBe("low");
    expect(result.evidence.modelResolution).toBe("explicit");
    expect(result.evidence.effortResolution).toBe("explicit");
  });

  it("keeps a manual Luna effort even when the Auto-only policy prefers max", () => {
    const luna = {
      ...models[0]!,
      id: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
    };
    const result = resolveOptimizationTargetSelection({
      models: [luna],
      requestedModel: luna.id,
      requestedReasoningEffort: "medium",
      selection: { model: "selected", reasoningEffort: "selected" },
      recommendation: { modelId: null, reasoningEffort: "max" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe(luna.id);
    expect(result.sentReasoningEffort).toBe("medium");
    expect(result.evidence.effortResolution).toBe("explicit");
  });

  it("labels an unsupported concrete recommendation when Auto uses a listed fallback", () => {
    const result = resolveOptimizationTargetSelection({
      models: [models[1]!],
      requestedModel: models[1]!.id,
      selection: { model: "selected", reasoningEffort: "auto" },
      recommendation: { modelId: null, reasoningEffort: "max" },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.sentReasoningEffort).toBe("high");
    expect(result.evidence.effortResolution).toBe(
      "unsupported_recommendation_fallback",
    );
    expect(result.evidence.selectionReason).toContain("tidak cocok");
  });

  it("falls back to listed capabilities when a recommendation is incompatible", () => {
    const result = resolveOptimizationTargetSelection({
      models,
      requestedModel: "gpt-next-codex",
      requestedReasoningEffort: "high",
      selection: { model: "auto", reasoningEffort: "selected" },
      recommendation: {
        modelId: "image-only",
        reasoningEffort: "high",
      },
      observedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(result.model.id).toBe("gpt-next-codex");
    expect(result.sentReasoningEffort).toBe("high");
    expect(result.evidence.modelResolution).toBe(
      "first_current_compatible_text_model",
    );
  });

  it("does not invent an unsupported model or effort", () => {
    expect(() =>
      resolveOptimizationTargetSelection({
        models,
        requestedModel: "missing",
        requestedReasoningEffort: "max",
        selection: { model: "auto", reasoningEffort: "selected" },
        observedAt: "2026-10-15T00:00:00.000Z",
      }),
    ).toThrow(OptimizationTargetSelectionError);
    expect(() =>
      resolveOptimizationTargetSelection({
        models: [{ ...models[1]!, supportedReasoningEfforts: [] }],
        requestedModel: "gpt-current-codex",
        selection: { model: "selected", reasoningEffort: "auto" },
        observedAt: "2026-10-15T00:00:00.000Z",
      }),
    ).toThrow(
      expect.objectContaining({ code: "codex_reasoning_effort_unavailable" }),
    );
  });
});
