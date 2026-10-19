import { describe, expect, it } from "vitest";
import { composeWorkspaceFileDraftPrompt } from "@promptlab/contracts";
import { sha256Text } from "@promptlab/agent";

import {
  createFileDraftTaskOptimizationEvidence,
  createFileDraftTaskOptimizationInput,
  parseFileDraftPromptForOptimization,
  selectFileDraftTaskOptimization,
} from "./file-draft-optimization.ts";

describe("file-draft task optimization", () => {
  it("parses the canonical prompt and binds only its file snapshot hash", () => {
    const prompt = composeWorkspaceFileDraftPrompt({
      task: "Rewrite the introduction",
      fileText: "Local file contents",
    });

    expect(
      parseFileDraftPromptForOptimization(prompt, sha256Text("Local file contents")),
    ).toEqual({
      task: "Rewrite the introduction",
      fileText: "Local file contents",
    });
    expect(
      parseFileDraftPromptForOptimization(prompt, "b".repeat(64)),
    ).toBeNull();
    expect(
      parseFileDraftPromptForOptimization(
        prompt + "\nadditional provider instructions",
        sha256Text("Local file contents"),
      ),
    ).toBeNull();
  });

  it("builds the shared optimizer request from task text without a file field", () => {
    const task = "Rewrite the introduction";
    const request = createFileDraftTaskOptimizationInput(task);

    expect(request.originalPrompt).toBe(task);
    expect(request).toMatchObject({
      invariants: [],
      sourceIds: [],
      history: [],
      request: {
        maxIterations: 1,
        testCases: [],
        targetSelection: {
          model: "selected",
          reasoningEffort: "selected",
        },
      },
    });
    expect(request).not.toHaveProperty("fileText");
  });

  it("uses only a tested optimizer rewrite and keeps final draft evidence unscored", () => {
    const selection = selectFileDraftTaskOptimization({
      originalTask: "Rewrite the introduction",
      status: "candidate_ready",
      candidate: {
        prompt: "Rewrite the introduction in concise, plain language.",
        testingStatus: "ready",
        evidenceBoundToPrompt: true,
      },
    });

    expect(selection).toEqual({
      task: "Rewrite the introduction in concise, plain language.",
      outcome: "rewrite_unscored",
    });
    expect(
      selectFileDraftTaskOptimization({
        originalTask: "Rewrite the introduction",
        status: "no_change_recommended",
        candidate: null,
      }),
    ).toEqual({
      task: "Rewrite the introduction",
      outcome: "no_change_unscored",
    });

    const evidence = createFileDraftTaskOptimizationEvidence({
      originalTask: "Rewrite the introduction",
      optimizedTask: selection.task,
      outcome: selection.outcome,
      optimizerStatus: "candidate_ready",
    });
    expect(evidence).toMatchObject({
      outcome: "rewrite_unscored",
      optimizerStatus: "candidate_ready",
      qualityVerified: false,
      fixtureEvaluationCount: 0,
    });
    expect(evidence).not.toHaveProperty("fileText");
  });

  it("fails closed when the shared optimizer has no tested candidate", () => {
    expect(() =>
      selectFileDraftTaskOptimization({
        originalTask: "Rewrite the introduction",
        status: "incomplete",
        candidate: null,
      }),
    ).toThrow("WORKSPACE_FILE_DRAFT_OPTIMIZATION_INCOMPLETE");
  });
});
