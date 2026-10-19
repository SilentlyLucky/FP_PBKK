import { z } from "zod";

import type { ControlledEvaluationRequest } from "@promptlab/contracts";
import type { ExperimentPilotMetadata } from "@promptlab/agent/experiment-metadata";

export {
  ExperimentArmSchema,
  ExperimentPilotMetadataSchema,
  isExperimentPilotConfigurationValid,
  parseStoredControlledEvaluationMetadata,
  parseStoredExperimentPilotMetadata,
} from "@promptlab/agent/experiment-metadata";
export type {
  ExperimentArm,
  ExperimentPilotMetadata,
} from "@promptlab/agent/experiment-metadata";

export const ExperimentDecisionSchema = z.strictObject({
  decision: z.enum(["accepted", "rejected", "inconclusive"]),
  note: z.string().trim().max(500).default(""),
});

export type ExperimentDecision = z.infer<
  typeof ExperimentDecisionSchema
>["decision"];

export interface ExperimentRecordBase {
  experimentId: string;
  runId: string;
  status: string;
  errorSummary: string | null;
  evidenceEligible: boolean;
  decisionVerified: boolean;
  createdAt: string;
  decision: ExperimentDecision | null;
  decisionNote: string | null;
  decidedAt: string | null;
}

export interface ExperimentPilotRecord extends ExperimentRecordBase {
  mode: "pilot";
  metadata: ExperimentPilotMetadata;
}

export interface ControlledEvaluationRecord extends ExperimentRecordBase {
  mode: "controlled_evaluation";
  metadata: ControlledEvaluationRequest;
}

export type ExperimentRecord =
  ExperimentPilotRecord | ControlledEvaluationRecord;
