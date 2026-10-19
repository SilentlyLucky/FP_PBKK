import {
  ControlledEvaluationRequestSchema,
  IdSchema,
  RunRetrievalSelectionSchema,
  type ControlledEvaluationRequest,
} from "@promptlab/contracts";
import { z } from "zod";

const FrozenSourceSchema = z.strictObject({
  id: IdSchema,
  title: z.string().trim().min(1).max(240),
  version: z.number().int().positive(),
  versionId: IdSchema,
  checksum: z.string().min(1).max(256),
});

export const ExperimentArmSchema = z.enum(["original", "rag", "graphrag"]);

export const ExperimentPilotMetadataSchema = z.strictObject({
  datasetName: z.string().trim().min(1).max(120),
  datasetVersion: z.string().trim().min(1).max(80),
  arm: ExperimentArmSchema,
  split: z.literal("development"),
  caseId: z.string().trim().min(1).max(80),
  input: z.string().trim().min(1).max(10_000),
  promptId: IdSchema,
  promptVersionId: IdSchema,
  promptName: z.string().trim().min(1).max(160),
  promptVersion: z.number().int().positive(),
  baselinePrompt: z.string().min(1).max(100_000),
  requestedModel: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(32).nullable(),
  retrieval: RunRetrievalSelectionSchema,
  activeSnapshotId: IdSchema.nullable(),
  sources: z.array(FrozenSourceSchema).max(20),
});

const LegacyExperimentPilotMetadataSchema = ExperimentPilotMetadataSchema.omit({
  arm: true,
  split: true,
});

export type ExperimentPilotMetadata = z.infer<
  typeof ExperimentPilotMetadataSchema
>;
export type ExperimentArm = z.infer<typeof ExperimentArmSchema>;

export function isExperimentPilotConfigurationValid(
  metadata: ExperimentPilotMetadata,
): boolean {
  const sourceIds = metadata.sources.map((source) => source.id).sort();
  const selectedSourceIds = [...metadata.retrieval.sourceIds].sort();
  if (
    metadata.split !== "development" ||
    new Set(sourceIds).size !== sourceIds.length ||
    JSON.stringify(sourceIds) !== JSON.stringify(selectedSourceIds)
  ) {
    return false;
  }

  const retrievalSnapshotId = metadata.retrieval.snapshotId ?? null;
  if (metadata.arm === "original") {
    return (
      sourceIds.length === 0 &&
      metadata.retrieval.strategy === "lexical" &&
      retrievalSnapshotId === null &&
      metadata.activeSnapshotId === null
    );
  }
  if (metadata.arm === "rag") {
    return (
      sourceIds.length > 0 &&
      metadata.retrieval.strategy === "lexical" &&
      retrievalSnapshotId === null &&
      metadata.activeSnapshotId === null
    );
  }
  return (
    sourceIds.length > 0 &&
    metadata.retrieval.strategy === "graph" &&
    Boolean(metadata.activeSnapshotId) &&
    retrievalSnapshotId === metadata.activeSnapshotId
  );
}

/** Preserve legacy pilot history for display while excluding it from acceptance. */
export function parseStoredExperimentPilotMetadata(
  value: unknown,
): { metadata: ExperimentPilotMetadata; legacy: boolean } | null {
  const current = ExperimentPilotMetadataSchema.safeParse(value);
  if (current.success) return { metadata: current.data, legacy: false };

  const legacy = LegacyExperimentPilotMetadataSchema.safeParse(value);
  if (!legacy.success) return null;
  const arm: ExperimentArm =
    legacy.data.sources.length === 0
      ? "original"
      : legacy.data.retrieval.strategy === "graph"
        ? "graphrag"
        : "rag";
  return {
    metadata: { ...legacy.data, arm, split: "development" },
    legacy: true,
  };
}

export function parseStoredControlledEvaluationMetadata(
  value: unknown,
): ControlledEvaluationRequest | null {
  const parsed = ControlledEvaluationRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
