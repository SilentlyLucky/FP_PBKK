import {
  composeWorkspaceFileDraftPrompt as composeCodexFileDraftPrompt,
  MAX_WORKSPACE_FILE_DRAFT_TASK_CHARACTERS,
  parseWorkspaceFileDraftPrompt as parseCodexFileDraftPrompt,
} from "@promptlab/contracts";
import type { WorkspaceRunCreateRequest } from "./workspace-conversations.js";

export const MAX_CODEX_FILE_DRAFT_INPUT_BYTES = 64 * 1024;
export const MAX_CODEX_FILE_DRAFT_TASK_CHARACTERS =
  MAX_WORKSPACE_FILE_DRAFT_TASK_CHARACTERS;
export const MAX_CODEX_FILE_DRAFT_ANSWER_BYTES = 128 * 1024;
export const MAX_CODEX_FILE_DRAFT_PROMPT_CHARACTERS = 100_000;
export { composeCodexFileDraftPrompt, parseCodexFileDraftPrompt };

export interface CodexFileDraftContext {
  projectId: string;
  path: string;
  snapshotHash: string | null;
  readGrantId: string;
  readGrantExpiresAt: string;
  writeGrantId: string;
  writeGrantExpiresAt: string;
}

export interface CodexFileDraftPendingRun {
  version: 1;
  context: CodexFileDraftContext;
  request: WorkspaceRunCreateRequest;
}

export interface CodexFileDraftActiveRun {
  version: 1;
  context: CodexFileDraftContext;
  request: WorkspaceRunCreateRequest;
  runId: string;
  status: string;
}

export interface CodexFileDraftPendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CodexFileDraftPendingRead {
  value: CodexFileDraftPendingRun | null;
  blocked: boolean;
}

export interface CodexFileDraftActiveRead {
  value: CodexFileDraftActiveRun | null;
  blocked: boolean;
}

export type CodexFileDraftBlockReason =
  | "task_optimization_consent_required"
  | "optimizer_unavailable"
  | "sharing_consent_required"
  | "retention_consent_required"
  | "empty_task"
  | "task_too_large"
  | "missing_snapshot_hash"
  | "input_too_large"
  | "prompt_too_large"
  | "grant_expired"
  | "project_changed"
  | "file_changed"
  | "snapshot_changed"
  | "grant_changed"
  | "answer_too_large"
  | "target_unavailable"
  | "target_changed";

export function isValidWorkspaceContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function saveCodexFileDraftPendingRun(
  storage: CodexFileDraftPendingStorage,
  key: string,
  pending: CodexFileDraftPendingRun,
): boolean {
  try {
    const encoded = JSON.stringify(pending);
    storage.setItem(key, encoded);
    return storage.getItem(key) === encoded;
  } catch {
    return false;
  }
}

export function loadCodexFileDraftPendingRun(
  storage: CodexFileDraftPendingStorage,
  key: string,
  projectId: string,
): CodexFileDraftPendingRead {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { value: null, blocked: true };
  }
  if (!raw) return { value: null, blocked: false };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { value: null, blocked: true };
    }
    const context = parseStoredContext(parsed.context, projectId);
    const request = context
      ? parseStoredRequest(parsed.request, projectId, context)
      : null;
    if (!context || !request) {
      return { value: null, blocked: true };
    }
    return {
      value: {
        version: 1,
        context,
        request,
      },
      blocked: false,
    };
  } catch {
    return { value: null, blocked: true };
  }
}

export function saveCodexFileDraftActiveRun(
  storage: CodexFileDraftPendingStorage,
  key: string,
  active: CodexFileDraftActiveRun,
): boolean {
  try {
    const encoded = JSON.stringify(active);
    storage.setItem(key, encoded);
    return storage.getItem(key) === encoded;
  } catch {
    return false;
  }
}

export function loadCodexFileDraftActiveRun(
  storage: CodexFileDraftPendingStorage,
  key: string,
  projectId: string,
): CodexFileDraftActiveRead {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { value: null, blocked: true };
  }
  if (!raw) return { value: null, blocked: false };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.runId !== "string" ||
      !parsed.runId ||
      typeof parsed.status !== "string" ||
      !parsed.status
    ) {
      return { value: null, blocked: true };
    }
    const context = parseStoredContext(parsed.context, projectId);
    const request = context
      ? parseStoredRequest(parsed.request, projectId, context)
      : null;
    if (!context || !request) return { value: null, blocked: true };
    return {
      value: {
        version: 1,
        context,
        request,
        runId: parsed.runId,
        status: parsed.status,
      },
      blocked: false,
    };
  } catch {
    return { value: null, blocked: true };
  }
}

export function clearCodexFileDraftActiveRun(
  storage: CodexFileDraftPendingStorage,
  key: string,
): boolean {
  try {
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

export function clearCodexFileDraftPendingRun(
  storage: CodexFileDraftPendingStorage,
  key: string,
): boolean {
  try {
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

export function validateCodexFileDraftRequest(input: {
  task: string;
  fileText: string;
  context: CodexFileDraftContext;
  taskOptimizationConsent: boolean;
  optimizerReady: boolean;
  sharingConsent: boolean;
  retentionConsent: boolean;
  now?: number;
}): CodexFileDraftBlockReason | null {
  if (!input.taskOptimizationConsent)
    return "task_optimization_consent_required";
  if (!input.optimizerReady) return "optimizer_unavailable";
  if (!input.sharingConsent) return "sharing_consent_required";
  if (!input.retentionConsent) return "retention_consent_required";
  if (!input.task.trim()) return "empty_task";
  if (Array.from(input.task).length > MAX_CODEX_FILE_DRAFT_TASK_CHARACTERS) {
    return "task_too_large";
  }
  if (!isValidWorkspaceContentHash(input.context.snapshotHash)) {
    return "missing_snapshot_hash";
  }
  if (
    new TextEncoder().encode(input.fileText).byteLength >
    MAX_CODEX_FILE_DRAFT_INPUT_BYTES
  ) {
    return "input_too_large";
  }
  if (
    composeCodexFileDraftPrompt({
      task: input.task,
      fileText: input.fileText,
    }).length > MAX_CODEX_FILE_DRAFT_PROMPT_CHARACTERS
  ) {
    return "prompt_too_large";
  }
  return validateDraftGrantLifetime(input.context, input.now ?? Date.now());
}

export function validateCodexFileDraftResult(input: {
  answer: string;
  captured: CodexFileDraftContext;
  current: CodexFileDraftContext | null;
  now?: number;
}): CodexFileDraftBlockReason | null {
  if (
    new TextEncoder().encode(input.answer).byteLength >
    MAX_CODEX_FILE_DRAFT_ANSWER_BYTES
  ) {
    return "answer_too_large";
  }
  if (!input.current) return "project_changed";
  const contextReason = compareCodexFileDraftContexts(
    input.captured,
    input.current,
    input.now ?? Date.now(),
  );
  return contextReason;
}

export function compareCodexFileDraftContexts(
  captured: CodexFileDraftContext,
  current: CodexFileDraftContext,
  now = Date.now(),
): CodexFileDraftBlockReason | null {
  if (
    !isValidWorkspaceContentHash(captured.snapshotHash) ||
    !isValidWorkspaceContentHash(current.snapshotHash)
  ) {
    return "missing_snapshot_hash";
  }
  if (captured.projectId !== current.projectId) return "project_changed";
  if (captured.path !== current.path) return "file_changed";
  if (captured.snapshotHash !== current.snapshotHash) return "snapshot_changed";
  const lifetimeReason = validateDraftGrantLifetime(current, now);
  if (lifetimeReason) return lifetimeReason;
  if (
    captured.readGrantId !== current.readGrantId ||
    captured.writeGrantId !== current.writeGrantId ||
    captured.readGrantExpiresAt !== current.readGrantExpiresAt ||
    captured.writeGrantExpiresAt !== current.writeGrantExpiresAt
  ) {
    return "grant_changed";
  }
  return null;
}

export function validateCodexFileDraftRetry(input: {
  captured: CodexFileDraftContext;
  current: CodexFileDraftContext | null;
  request: {
    projectId: string;
    provider: string;
    purpose: string;
    requestedModel: string;
    reasoningEffort?: string;
  };
  target: {
    state: "loading" | "available" | "unavailable";
    modelId: string | null;
    reasoningEffort?: string;
  };
  taskOptimizationConsent: boolean;
  optimizerReady: boolean;
  sharingConsent: boolean;
  retentionConsent: boolean;
  now?: number;
}): CodexFileDraftBlockReason | null {
  if (!input.current) return "project_changed";
  const contextReason = compareCodexFileDraftContexts(
    input.captured,
    input.current,
    input.now ?? Date.now(),
  );
  if (contextReason) return contextReason;
  if (input.request.projectId !== input.current.projectId) {
    return "project_changed";
  }
  if (
    input.request.provider !== "codex_app_server" ||
    input.request.purpose !== "target"
  ) {
    return "target_changed";
  }
  if (input.target.state !== "available" || !input.target.modelId) {
    return "target_unavailable";
  }
  if (
    input.target.modelId !== input.request.requestedModel ||
    input.target.reasoningEffort !== input.request.reasoningEffort
  ) {
    return "target_changed";
  }
  if (!input.taskOptimizationConsent)
    return "task_optimization_consent_required";
  if (!input.optimizerReady) return "optimizer_unavailable";
  if (!input.sharingConsent) return "sharing_consent_required";
  if (!input.retentionConsent) return "retention_consent_required";
  return null;
}

export function classifyCodexDraftRunCreation(input: {
  ok: boolean;
  status: number;
  error: string | null;
  runId: string | null;
}): "accepted" | "confirmed_absent" | "unknown" {
  if (input.ok && input.runId) return "accepted";
  if (
    !input.ok &&
    input.status >= 400 &&
    input.status < 500 &&
    input.error !== "IDEMPOTENCY_KEY_CONFLICT"
  ) {
    return "confirmed_absent";
  }
  return "unknown";
}

function validateDraftGrantLifetime(
  context: CodexFileDraftContext,
  now: number,
): CodexFileDraftBlockReason | null {
  const readExpiry = Date.parse(context.readGrantExpiresAt);
  const writeExpiry = Date.parse(context.writeGrantExpiresAt);
  return Number.isFinite(readExpiry) &&
    Number.isFinite(writeExpiry) &&
    readExpiry > now &&
    writeExpiry > now
    ? null
    : "grant_expired";
}

function parseStoredContext(
  value: unknown,
  projectId: string,
): CodexFileDraftContext | null {
  if (
    !isRecord(value) ||
    value.projectId !== projectId ||
    typeof value.path !== "string" ||
    !value.path ||
    !isValidWorkspaceContentHash(value.snapshotHash) ||
    typeof value.readGrantId !== "string" ||
    !value.readGrantId ||
    typeof value.readGrantExpiresAt !== "string" ||
    typeof value.writeGrantId !== "string" ||
    !value.writeGrantId ||
    typeof value.writeGrantExpiresAt !== "string"
  ) {
    return null;
  }
  return {
    projectId,
    path: value.path,
    snapshotHash: value.snapshotHash,
    readGrantId: value.readGrantId,
    readGrantExpiresAt: value.readGrantExpiresAt,
    writeGrantId: value.writeGrantId,
    writeGrantExpiresAt: value.writeGrantExpiresAt,
  };
}

function parseStoredRequest(
  value: unknown,
  projectId: string,
  context: CodexFileDraftContext,
): WorkspaceRunCreateRequest | null {
  const workspaceFileDraft = isRecord(value) ? value.workspaceFileDraft : null;
  const hasWorkspaceFileDraft =
    isRecord(value) && Object.hasOwn(value, "workspaceFileDraft");
  const expectedFileDraft = {
    format: "promptlab-workspace-file-draft-run-v1" as const,
    path: context.path,
    snapshotHash: context.snapshotHash!,
    readGrantId: context.readGrantId,
    writeGrantId: context.writeGrantId,
    taskOptimizationConsent: true as const,
  };
  if (
    !isRecord(value) ||
    value.projectId !== projectId ||
    typeof value.promptVersionId !== "string" ||
    !value.promptVersionId ||
    value.provider !== "codex_app_server" ||
    value.purpose !== "target" ||
    value.intent !== "workspace_file_draft" ||
    !hasWorkspaceFileDraft ||
    ("workspaceChat" in value && value.workspaceChat !== undefined) ||
    ("optimization" in value && value.optimization !== undefined) ||
    ("controlledEvaluation" in value &&
      value.controlledEvaluation !== undefined) ||
    !isRecord(workspaceFileDraft) ||
    workspaceFileDraft.format !== expectedFileDraft.format ||
    workspaceFileDraft.path !== expectedFileDraft.path ||
    workspaceFileDraft.snapshotHash !== expectedFileDraft.snapshotHash ||
    workspaceFileDraft.readGrantId !== expectedFileDraft.readGrantId ||
    workspaceFileDraft.writeGrantId !== expectedFileDraft.writeGrantId ||
    workspaceFileDraft.taskOptimizationConsent !==
      expectedFileDraft.taskOptimizationConsent ||
    typeof value.requestedModel !== "string" ||
    !value.requestedModel ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length < 8 ||
    value.idempotencyKey.length > 160 ||
    ("reasoningEffort" in value && typeof value.reasoningEffort !== "string") ||
    !isRecord(value.retrieval) ||
    value.retrieval.strategy !== "lexical" ||
    !Array.isArray(value.retrieval.sourceIds) ||
    value.retrieval.sourceIds.length !== 0
  ) {
    return null;
  }
  return {
    projectId,
    promptVersionId: value.promptVersionId,
    provider: "codex_app_server",
    requestedModel: value.requestedModel,
    purpose: "target",
    intent: "workspace_file_draft",
    ...(typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    idempotencyKey: value.idempotencyKey,
    retrieval: { strategy: "lexical", sourceIds: [] },
    workspaceFileDraft: expectedFileDraft,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
