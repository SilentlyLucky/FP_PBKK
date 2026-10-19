import type {
  ControlledEvaluationCase,
  ControlledEvaluationRequest,
} from "@promptlab/contracts";

export interface ControlledPromptOption {
  id: string;
  name: string;
}

export interface ControlledPromptVersionOption {
  id: string;
  version: number;
  text: string;
  createdAt: string;
}

export interface ControlledModelOption {
  id: string;
  displayName: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string | null;
}

export interface ControlledSourceOption {
  id: string;
  displayName: string;
  version: number | null;
  versionId: string | null;
  checksum: string | null;
}

export type ControlledArm = ControlledEvaluationRequest["arms"][number];
export type ControlledArmId = ControlledArm["arm"];

export interface ControlledEvaluationDraft {
  datasetName: string;
  datasetVersion: string;
  promptId: string;
  baselinePrompt: ControlledPromptVersionOption;
  candidatePrompt: ControlledPromptVersionOption;
  cases: ControlledEvaluationCase[];
  arms: ControlledArm[];
  requestedModel: string;
  reasoningEffort: string;
}
