import { describe, expect, it } from "vitest";

import {
  ExperimentPilotMetadataSchema,
  isExperimentPilotConfigurationValid,
  parseStoredExperimentPilotMetadata,
} from "./experiment-pilot";

const source = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Source One",
  version: 2,
  versionId: "22222222-2222-4222-8222-222222222222",
  checksum: "source-checksum-v2",
};
const snapshotId = "33333333-3333-4333-8333-333333333333";

function metadata(
  arm: "original" | "rag" | "graphrag",
) {
  const retrieval = {
    strategy: arm === "graphrag" ? "graph" : "lexical",
    sourceIds: arm === "original" ? [] : [source.id],
    snapshotId: arm === "graphrag" ? snapshotId : null,
  } as const;
  return ExperimentPilotMetadataSchema.parse({
    datasetName: "Development pilot",
    datasetVersion: "v1",
    arm,
    split: "development",
    caseId: "case-1",
    input: "Summarize this source.",
    promptId: "44444444-4444-4444-8444-444444444444",
    promptVersionId: "55555555-5555-4555-8555-555555555555",
    promptName: "Support",
    promptVersion: 1,
    baselinePrompt: "Answer clearly.",
    requestedModel: "gpt-test",
    reasoningEffort: null,
    retrieval,
    activeSnapshotId: arm === "graphrag" ? snapshotId : null,
    sources: arm === "original" ? [] : [source],
  });
}

describe("experiment pilot configuration", () => {
  it.each(["original", "rag", "graphrag"] as const)(
    "keeps the %s arm within one development case and a matching frozen context",
    (arm) => {
      expect(isExperimentPilotConfigurationValid(metadata(arm))).toBe(true);
    },
  );

  it("rejects a source list that differs from the frozen retrieval selection", () => {
    const rag = metadata("rag");
    const invalid = ExperimentPilotMetadataSchema.parse({
      ...rag,
      retrieval: { ...rag.retrieval, sourceIds: [] },
    });
    expect(isExperimentPilotConfigurationValid(invalid)).toBe(false);
  });

  it("keeps holdout cases outside the current development-only pilot contract", () => {
    const parsed = ExperimentPilotMetadataSchema.safeParse({
      ...metadata("original"),
      split: "holdout",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a GraphRAG arm without the same selected snapshot", () => {
    const graph = metadata("graphrag");
    const invalid = ExperimentPilotMetadataSchema.parse({
      ...graph,
      activeSnapshotId: null,
    });
    expect(isExperimentPilotConfigurationValid(invalid)).toBe(false);
  });

  it("keeps legacy pilot history visible while marking it for unverified projection", () => {
    const original = metadata("original");
    const { arm: _arm, split: _split, ...legacyPayload } = original;
    expect(parseStoredExperimentPilotMetadata(legacyPayload)).toMatchObject({
      legacy: true,
      metadata: { arm: "original", split: "development" },
    });
  });
});
