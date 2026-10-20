import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { IdSchema } from "@promptlab/contracts";
import {
  createLocalWorkspaceService,
  LocalWorkspaceError,
  type LocalWorkspacePatch,
  type LocalWorkspacePatchAction,
  type LocalWorkspaceEvaluationCommandConfiguration,
  type LocalWorkspaceEvaluationStatus,
  type LocalWorkspaceProjectRoot,
  type LocalWorkspaceService,
} from "../../../../packages/tools/src/local-workspace.ts";
import {
  validateWorkspaceEvaluationCommand,
  type WorkspaceEvaluationCommand,
} from "../../../../packages/tools/src/workspace-evaluation-runner.ts";
import { LocalWorkspaceDirectoryPicker } from "../../../../packages/tools/src/local-workspace-picker.ts";
import {
  defaultLocalWorkspaceRootRegistry,
  type RegisteredWorkspaceRoot,
} from "@/lib/local-workspace-roots";

export const LOCAL_WORKSPACE_GRANT_TTL_MS = 15 * 60 * 1_000;
export const LOCAL_WORKSPACE_WRITE_GRANT_TTL_MS = 5 * 60 * 1_000;

export type LocalWorkspaceUnavailableReason =
  "not_configured" | "configuration_invalid";

export type LocalWorkspaceEvaluationUnavailableReason =
  | "no_server_evaluation_tests_configured"
  | "evaluation_configuration_invalid"
  | "project_not_configured"
  | "workspace_write_not_configured"
  | "verified_isolated_project_test_runner_unavailable";

export type LocalWorkspaceRuntime =
  | { readonly kind: "available"; readonly gateway: LocalWorkspaceGateway }
  | {
      readonly kind: "unavailable";
      readonly reason: LocalWorkspaceUnavailableReason;
    };

export class LocalWorkspaceApiError extends Error {
  constructor(
    readonly code:
      | "ORIGIN_NOT_ALLOWED"
      | "PROJECT_NOT_CONFIGURED"
      | "GRANT_EXPIRED"
      | "GRANT_NOT_FOUND"
      | "APPROVAL_REQUIRED"
      | "WRITE_APPROVAL_REQUIRED"
      | "PATCH_APPROVAL_REQUIRED"
      | "WRITE_NOT_CONFIGURED"
      | "DATABASE_UNAVAILABLE"
      | "REQUEST_INVALID"
      | "REQUEST_TOO_LARGE"
      | "WORKSPACE_EVALUATION_NOT_CONFIGURED",
  ) {
    super(code);
    this.name = "LocalWorkspaceApiError";
  }
}

export function parseLocalWorkspaceRoots(
  raw: string | undefined,
):
  | { readonly roots: readonly LocalWorkspaceProjectRoot[] }
  | { readonly invalid: true } {
  if (!raw?.trim()) return { roots: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { invalid: true };
  }
  if (!Array.isArray(value)) return { invalid: true };

  const roots: LocalWorkspaceProjectRoot[] = [];
  const projectIds = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 2 ||
      !("projectId" in item) ||
      !("rootPath" in item)
    ) {
      return { invalid: true };
    }
    const candidate = item as { projectId: unknown; rootPath: unknown };
    const project = IdSchema.safeParse(candidate.projectId);
    if (
      !project.success ||
      typeof candidate.rootPath !== "string" ||
      candidate.rootPath.length === 0 ||
      candidate.rootPath.trim() !== candidate.rootPath ||
      candidate.rootPath.includes("\0") ||
      !isAbsolute(candidate.rootPath) ||
      projectIds.has(project.data)
    ) {
      return { invalid: true };
    }
    projectIds.add(project.data);
    roots.push({ projectId: project.data, rootPath: candidate.rootPath });
  }
  return { roots };
}

export function parseLocalWorkspaceWriteProjects(
  raw: string | undefined,
): { readonly projectIds: readonly string[] } | { readonly invalid: true } {
  if (!raw?.trim()) return { projectIds: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { invalid: true };
  }
  if (!Array.isArray(value)) return { invalid: true };
  const projectIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = IdSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data)) return { invalid: true };
    seen.add(parsed.data);
    projectIds.push(parsed.data);
  }
  return { projectIds };
}

export function parseLocalWorkspaceEvaluationCommands(raw: string | undefined):
  | {
      readonly commands: readonly LocalWorkspaceEvaluationCommandConfiguration[];
    }
  | { readonly invalid: true } {
  if (!raw?.trim()) return { commands: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { invalid: true };
  }
  if (!Array.isArray(value) || value.length > 128) return { invalid: true };
  const commands: LocalWorkspaceEvaluationCommandConfiguration[] = [];
  const projectIds = new Set<string>();
  const commandIds = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 2 ||
      !("projectId" in item) ||
      !("commands" in item)
    ) {
      return { invalid: true };
    }
    const configured = item as { projectId: unknown; commands: unknown };
    const parsedProject = IdSchema.safeParse(configured.projectId);
    if (
      !parsedProject.success ||
      projectIds.has(parsedProject.data) ||
      !Array.isArray(configured.commands) ||
      configured.commands.length < 1 ||
      configured.commands.length > 32
    ) {
      return { invalid: true };
    }
    projectIds.add(parsedProject.data);
    for (const candidate of configured.commands) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return { invalid: true };
      }
      const allowedKeys = new Set([
        "id",
        "label",
        "executable",
        "args",
        "runtimePaths",
        "timeoutMs",
      ]);
      if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
        return { invalid: true };
      }
      try {
        const validated = validateWorkspaceEvaluationCommand(
          candidate as WorkspaceEvaluationCommand,
        );
        const commandKey = `${parsedProject.data}\0${validated.id}`;
        if (commandIds.has(commandKey)) return { invalid: true };
        commandIds.add(commandKey);
      } catch {
        return { invalid: true };
      }
      commands.push({
        projectId: parsedProject.data,
        command: candidate as WorkspaceEvaluationCommand,
      });
    }
  }
  return { commands };
}

interface GrantRecord {
  readonly projectId: string;
  readonly serviceGrantId: string;
  readonly expiresAt: number;
  readonly access: "read_only" | "workspace_write";
}

export interface LocalWorkspaceRootMapping {
  readonly projectId: string;
  readonly rootId: string;
  readonly serviceProjectId: string;
  readonly displayName: string;
  readonly source: "environment" | "registered";
  readonly available: boolean;
}

export interface LocalWorkspaceRootChoice {
  readonly rootId: string;
  readonly displayName: string;
  readonly source: "environment" | "registered";
  readonly available: boolean;
}

export class LocalWorkspaceGateway {
  private readonly grants = new Map<string, GrantRecord>();
  private readonly configuredProjectIds: ReadonlySet<string>;
  private readonly configuredWriteProjectIds: ReadonlySet<string>;
  private readonly rootMappings: readonly LocalWorkspaceRootMapping[];

  constructor(
    private readonly service: LocalWorkspaceService,
    projectIds: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly ttlMs = LOCAL_WORKSPACE_GRANT_TTL_MS,
    writeProjectIds: readonly string[] = [],
    private readonly writeTtlMs = LOCAL_WORKSPACE_WRITE_GRANT_TTL_MS,
    rootMappings?: readonly LocalWorkspaceRootMapping[],
    private readonly workspaceEvaluationConfigurationInvalid = false,
  ) {
    this.rootMappings =
      rootMappings ??
      projectIds.map((projectId) => ({
        projectId,
        rootId: "environment:" + projectId,
        serviceProjectId: projectId,
        displayName: "Folder dari konfigurasi server",
        source: "environment" as const,
        available: true,
      }));
    this.configuredProjectIds = new Set(
      this.rootMappings
        .filter((root) => root.available)
        .map((root) => root.projectId),
    );
    this.configuredWriteProjectIds = new Set(writeProjectIds);
  }

  isProjectConfigured(projectId: string): boolean {
    return this.configuredProjectIds.has(projectId);
  }

  isWriteConfigured(projectId: string): boolean {
    return (
      this.isProjectConfigured(projectId) &&
      this.configuredWriteProjectIds.has(projectId)
    );
  }

  listRoots(projectId: string): LocalWorkspaceRootChoice[] {
    return this.rootMappings
      .filter((root) => root.projectId === projectId)
      .map((root) => ({
        rootId: root.rootId,
        displayName: root.displayName,
        source: root.source,
        available: root.available,
      }));
  }

  issueGrant(
    projectId: string,
    rootId?: string,
  ): { grantId: string; expiresAt: string; rootId: string } {
    this.pruneExpiredGrants();
    const roots = this.rootMappings.filter(
      (root) => root.projectId === projectId && root.available,
    );
    const root = rootId
      ? roots.find((candidate) => candidate.rootId === rootId)
      : (roots.find((candidate) => candidate.source === "environment") ??
        roots[0]);
    if (!root) {
      throw new LocalWorkspaceApiError("PROJECT_NOT_CONFIGURED");
    }
    const serviceGrant = this.service.issueGrant(root.serviceProjectId);
    const grantId = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.grants.set(grantId, {
      projectId,
      serviceGrantId: serviceGrant.grantId,
      expiresAt,
      access: "read_only",
    });
    return {
      grantId,
      expiresAt: new Date(expiresAt).toISOString(),
      rootId: root.rootId,
    };
  }

  issueWriteGrant(projectId: string): { grantId: string; expiresAt: string } {
    this.pruneExpiredGrants();
    if (!this.isWriteConfigured(projectId)) {
      throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
    }
    const serviceGrant = this.service.issueWriteGrant(projectId);
    const grantId = randomUUID();
    const expiresAt = this.now() + this.writeTtlMs;
    this.grants.set(grantId, {
      projectId,
      serviceGrantId: serviceGrant.grantId,
      expiresAt,
      access: "workspace_write",
    });
    return { grantId, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeGrant(projectId: string, grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.projectId !== projectId) {
      throw new LocalWorkspaceApiError("GRANT_NOT_FOUND");
    }
    this.revokeRecord(grantId, grant);
    return true;
  }

  list(projectId: string, grantId: string, relativePath: string) {
    return this.withGrant(projectId, grantId, (serviceGrantId) =>
      this.service.list(serviceGrantId, relativePath),
    );
  }

  read(projectId: string, grantId: string, relativePath: string) {
    return this.withGrant(projectId, grantId, (serviceGrantId) =>
      this.service.read(serviceGrantId, relativePath),
    );
  }

  async verifyFileDraftRunContext(input: {
    projectId: string;
    readGrantId: string;
    writeGrantId: string;
    relativePath: string;
    snapshotHash: string;
    fileText: string;
  }): Promise<boolean> {
    const readGrant = this.requireActiveGrant(
      input.projectId,
      input.readGrantId,
    );
    const writeGrant = this.requireActiveGrant(
      input.projectId,
      input.writeGrantId,
    );
    if (
      readGrant.access !== "read_only" ||
      writeGrant.access !== "workspace_write"
    ) {
      return false;
    }
    const current = await this.withGrant(
      input.projectId,
      input.readGrantId,
      (serviceGrantId) => this.service.read(serviceGrantId, input.relativePath),
    );
    if (
      current.contentHash !== input.snapshotHash ||
      current.content !== input.fileText
    ) {
      return false;
    }
    await this.withWriteGrant(
      input.projectId,
      input.writeGrantId,
      async () => undefined,
    );
    return true;
  }

  search(projectId: string, grantId: string, query: string) {
    return this.withGrant(projectId, grantId, (serviceGrantId) =>
      this.service.search(serviceGrantId, query),
    );
  }

  proposePatch(
    projectId: string,
    grantId: string,
    relativePath: string,
    proposedContent: string,
    expectedBeforeHash?: string,
  ): Promise<LocalWorkspacePatch> {
    return this.withWriteGrant(projectId, grantId, (serviceGrantId) => {
      if (
        expectedBeforeHash !== undefined &&
        !isSha256Hash(expectedBeforeHash)
      ) {
        throw new LocalWorkspaceApiError("REQUEST_INVALID");
      }
      return this.service.proposePatch(
        serviceGrantId,
        relativePath,
        proposedContent,
        expectedBeforeHash,
      );
    });
  }

  getPatch(
    projectId: string,
    grantId: string,
    patchId: string,
  ): Promise<LocalWorkspacePatch> {
    return this.withWriteGrant(projectId, grantId, (serviceGrantId) =>
      this.service.getPatch(serviceGrantId, patchId),
    );
  }

  async workspaceEvaluationStatus(
    projectId: string,
  ): Promise<LocalWorkspaceEvaluationStatus> {
    if (!this.isProjectConfigured(projectId)) {
      return {
        executionAvailable: false,
        reasonCode: "project_not_configured",
        tests: [],
      };
    }
    if (!this.isWriteConfigured(projectId)) {
      return {
        executionAvailable: false,
        reasonCode: "workspace_write_not_configured",
        tests: [],
      };
    }
    if (this.workspaceEvaluationConfigurationInvalid) {
      return {
        executionAvailable: false,
        reasonCode: "evaluation_configuration_invalid",
        tests: [],
      };
    }
    return this.service.workspaceEvaluationStatus(projectId);
  }

  evaluatePatch(
    projectId: string,
    grantId: string,
    patchId: string,
    testId: string,
  ) {
    return this.withWriteGrant(projectId, grantId, (serviceGrantId) =>
      this.service.evaluatePatch(serviceGrantId, patchId, testId),
    );
  }

  rejectPatch(
    projectId: string,
    grantId: string,
    patchId: string,
  ): Promise<LocalWorkspacePatch> {
    return this.withWriteGrant(projectId, grantId, (serviceGrantId) =>
      this.service.rejectPatch(serviceGrantId, patchId),
    );
  }

  approvePatch(
    projectId: string,
    grantId: string,
    patchId: string,
  ): Promise<LocalWorkspacePatchAction> {
    return this.withWriteMutation(projectId, grantId, (serviceGrantId) =>
      this.service.approvePatch(serviceGrantId, patchId),
    );
  }

  rollbackPatch(
    projectId: string,
    grantId: string,
    patchId: string,
  ): Promise<LocalWorkspacePatchAction> {
    return this.withWriteMutation(projectId, grantId, (serviceGrantId) =>
      this.service.rollbackPatch(serviceGrantId, patchId),
    );
  }

  private async withGrant<T>(
    projectId: string,
    grantId: string,
    operation: (serviceGrantId: string) => Promise<T>,
  ): Promise<T> {
    const grant = this.requireActiveGrant(projectId, grantId);
    const result = await operation(grant.serviceGrantId);
    const current = this.grants.get(grantId);
    if (current !== grant || this.now() >= grant.expiresAt) {
      this.revokeRecord(grantId, grant);
      throw new LocalWorkspaceApiError("GRANT_EXPIRED");
    }
    return result;
  }

  private withWriteGrant<T>(
    projectId: string,
    grantId: string,
    operation: (serviceGrantId: string) => Promise<T>,
  ): Promise<T> {
    const grant = this.requireActiveGrant(projectId, grantId);
    if (grant.access !== "workspace_write") {
      throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
    }
    return this.withGrant(projectId, grantId, operation);
  }

  private async withWriteMutation<T>(
    projectId: string,
    grantId: string,
    operation: (serviceGrantId: string) => Promise<T>,
  ): Promise<T> {
    const grant = this.requireActiveGrant(projectId, grantId);
    if (grant.access !== "workspace_write") {
      throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
    }
    // The service rechecks the grant immediately before its atomic rename. Once
    // that commit succeeds, expiry/revocation must not hide the commit result.
    return operation(grant.serviceGrantId);
  }

  private requireActiveGrant(projectId: string, grantId: string): GrantRecord {
    const grant = this.grants.get(grantId);
    if (!grant || grant.projectId !== projectId) {
      throw new LocalWorkspaceApiError("GRANT_NOT_FOUND");
    }
    if (this.now() >= grant.expiresAt) {
      this.revokeRecord(grantId, grant);
      throw new LocalWorkspaceApiError("GRANT_EXPIRED");
    }
    return grant;
  }

  private pruneExpiredGrants(): void {
    const now = this.now();
    for (const [grantId, grant] of this.grants) {
      if (now >= grant.expiresAt) this.revokeRecord(grantId, grant);
    }
  }

  private revokeRecord(grantId: string, grant: GrantRecord): void {
    if (this.grants.get(grantId) !== grant) return;
    this.grants.delete(grantId);
    this.service.revokeGrant(grant.serviceGrantId);
  }
}

export interface LocalWorkspaceWriteRuntimeOptions {
  readonly enabled?: boolean;
  readonly rawProjectIds?: string | undefined;
}

export interface LocalWorkspaceEvaluationRuntimeOptions {
  readonly rawCommands?: string | undefined;
}

export function createLocalWorkspaceRuntime(
  rawConfiguration: string | undefined,
  serviceFactory: (
    roots: readonly LocalWorkspaceProjectRoot[],
    write: {
      readonly enabled: boolean;
      readonly projectIds: readonly string[];
    },
    evaluationCommands: readonly LocalWorkspaceEvaluationCommandConfiguration[],
  ) => Promise<LocalWorkspaceService> = (roots, write, evaluationCommands) =>
    createLocalWorkspaceService({
      allowedProjectRoots: roots,
      enableWrites: write.enabled,
      allowedWriteProjectIds: write.projectIds,
      workspaceEvaluationCommands: evaluationCommands,
    }),
  writeConfiguration: LocalWorkspaceWriteRuntimeOptions = {
    enabled: process.env.PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED === "1",
    rawProjectIds: process.env.PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS,
  },
  registeredRoots: readonly RegisteredWorkspaceRoot[] = [],
  evaluationConfiguration: LocalWorkspaceEvaluationRuntimeOptions = {
    rawCommands: process.env.PROMPTLAB_LOCAL_WORKSPACE_EVALUATION_COMMANDS,
  },
): Promise<LocalWorkspaceRuntime> {
  return (async () => {
    const parsed = parseLocalWorkspaceRoots(rawConfiguration);
    if ("invalid" in parsed) {
      return { kind: "unavailable", reason: "configuration_invalid" };
    }
    if (parsed.roots.length === 0 && registeredRoots.length === 0) {
      return { kind: "unavailable", reason: "not_configured" };
    }
    try {
      const rootMappings: Array<
        LocalWorkspaceRootMapping & { rootPath: string }
      > = [
        ...parsed.roots.map((root) => ({
          projectId: root.projectId,
          rootId: "environment:" + root.projectId,
          serviceProjectId: root.projectId,
          rootPath: root.rootPath,
          displayName: "Folder dari konfigurasi server",
          source: "environment" as const,
          available: true,
        })),
        ...registeredRoots.map((root) => ({
          projectId: root.projectId,
          rootId: root.rootId,
          serviceProjectId: "registered:" + root.rootId,
          rootPath: root.rootPath,
          displayName: root.displayName,
          source: "registered" as const,
          available: root.available,
        })),
      ];
      const serviceRoots = rootMappings
        .filter((root) => root.available)
        .map((root) => ({
          projectId: root.serviceProjectId,
          rootPath: root.rootPath,
        }));
      if (serviceRoots.length === 0) {
        return { kind: "unavailable", reason: "not_configured" };
      }
      const configuredIds = new Set(parsed.roots.map((root) => root.projectId));
      const parsedWriteProjects = parseLocalWorkspaceWriteProjects(
        writeConfiguration.rawProjectIds,
      );
      const requestedWriteIds =
        "invalid" in parsedWriteProjects ? [] : parsedWriteProjects.projectIds;
      const writeProjectIds =
        writeConfiguration.enabled === true &&
        requestedWriteIds.every((projectId) => configuredIds.has(projectId))
          ? requestedWriteIds
          : [];
      const writeEnabled = writeProjectIds.length > 0;
      const parsedEvaluationCommands = parseLocalWorkspaceEvaluationCommands(
        evaluationConfiguration.rawCommands,
      );
      const evaluationConfigurationInvalid =
        "invalid" in parsedEvaluationCommands ||
        ("commands" in parsedEvaluationCommands &&
          parsedEvaluationCommands.commands.some(
            ({ projectId }) => !writeProjectIds.includes(projectId),
          ));
      const evaluationCommands = evaluationConfigurationInvalid
        ? []
        : parsedEvaluationCommands.commands;
      const service = await serviceFactory(
        serviceRoots,
        {
          enabled: writeEnabled,
          projectIds: writeProjectIds,
        },
        evaluationCommands,
      );
      return {
        kind: "available",
        gateway: new LocalWorkspaceGateway(
          service,
          [...new Set(rootMappings.map((root) => root.projectId))],
          Date.now,
          LOCAL_WORKSPACE_GRANT_TTL_MS,
          writeProjectIds,
          LOCAL_WORKSPACE_WRITE_GRANT_TTL_MS,
          rootMappings,
          evaluationConfigurationInvalid,
        ),
      };
    } catch {
      return { kind: "unavailable", reason: "configuration_invalid" };
    }
  })();
}

type LocalWorkspaceGlobal = typeof globalThis & {
  __promptlabLocalWorkspaceRuntime?: Promise<LocalWorkspaceRuntime>;
  __promptlabLocalWorkspaceRootRegistry?: ReturnType<
    typeof defaultLocalWorkspaceRootRegistry
  >;
  __promptlabLocalWorkspaceDirectoryPicker?: LocalWorkspaceDirectoryPicker;
};

export function getServerLocalWorkspaceRootRegistry() {
  const shared = globalThis as LocalWorkspaceGlobal;
  shared.__promptlabLocalWorkspaceRootRegistry ??=
    defaultLocalWorkspaceRootRegistry();
  return shared.__promptlabLocalWorkspaceRootRegistry;
}

export function getServerLocalWorkspaceDirectoryPicker() {
  const shared = globalThis as LocalWorkspaceGlobal;
  shared.__promptlabLocalWorkspaceDirectoryPicker ??=
    new LocalWorkspaceDirectoryPicker(
      undefined,
      undefined,
      () => process.env.PROMPTLAB_LOCAL_WORKSPACE_PICKER_ROOT,
    );
  return shared.__promptlabLocalWorkspaceDirectoryPicker;
}

export function invalidateServerLocalWorkspaceRuntime(): void {
  const shared = globalThis as LocalWorkspaceGlobal;
  delete shared.__promptlabLocalWorkspaceRuntime;
}

export function getServerLocalWorkspaceRuntime(): Promise<LocalWorkspaceRuntime> {
  const shared = globalThis as LocalWorkspaceGlobal;
  shared.__promptlabLocalWorkspaceRuntime ??= (async () => {
    try {
      const registeredRoots =
        await getServerLocalWorkspaceRootRegistry().list();
      return createLocalWorkspaceRuntime(
        process.env.PROMPTLAB_LOCAL_WORKSPACE_ROOTS,
        undefined,
        {
          enabled: process.env.PROMPTLAB_LOCAL_WORKSPACE_WRITE_ENABLED === "1",
          rawProjectIds: process.env.PROMPTLAB_LOCAL_WORKSPACE_WRITE_PROJECTS,
        },
        registeredRoots,
        {
          rawCommands:
            process.env.PROMPTLAB_LOCAL_WORKSPACE_EVALUATION_COMMANDS,
        },
      );
    } catch {
      return { kind: "unavailable", reason: "configuration_invalid" };
    }
  })();
  return shared.__promptlabLocalWorkspaceRuntime;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1"
  ) {
    return true;
  }
  if (isIP(normalized) !== 4) return false;
  return Number(normalized.split(".")[0]) === 127;
}

function isUnspecifiedBindHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "0.0.0.0" || normalized === "::";
}

export function assertLocalSameOrigin(request: Request): void {
  const target = new URL(request.url);
  const hostHeader = request.headers.get("host");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const forwardedPort = request.headers.get("x-forwarded-port");
  const originHeader = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  let requestHost: URL | null = null;
  if (hostHeader) {
    try {
      requestHost = new URL(`${target.protocol}//${hostHeader}`);
    } catch {
      requestHost = null;
    }
  }
  const effectivePort =
    requestHost?.port ||
    forwardedPort ||
    target.port ||
    (target.protocol === "https:" ? "443" : "80");
  const requestOrigin = requestHost?.origin;
  const allowUnspecifiedBindHost =
    process.env.PROMPTLAB_LOCAL_WORKSPACE_ALLOW_UNSPECIFIED_BIND_HOST === "1" &&
    isUnspecifiedBindHost(target.hostname);
  const portMismatch = Boolean(
    (requestHost?.port && target.port && requestHost.port !== target.port) ||
    (forwardedPort && forwardedPort !== effectivePort) ||
    (target.port && target.port !== effectivePort),
  );
  const invalidRequestOrigin =
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    (!isLoopbackHost(target.hostname) && !allowUnspecifiedBindHost) ||
    !hostHeader ||
    !requestHost ||
    requestHost.host.toLowerCase() !== hostHeader.toLowerCase() ||
    !isLoopbackHost(requestHost.hostname) ||
    portMismatch ||
    request.headers.has("forwarded") ||
    (forwardedHost &&
      forwardedHost.toLowerCase() !== requestHost.host.toLowerCase()) ||
    (forwardedProtocol &&
      forwardedProtocol.toLowerCase() !== target.protocol.slice(0, -1)) ||
    (forwardedPort && forwardedPort !== effectivePort);
  if (invalidRequestOrigin) {
    throw new LocalWorkspaceApiError("ORIGIN_NOT_ALLOWED");
  }

  if (fetchSite && fetchSite !== "same-origin") {
    throw new LocalWorkspaceApiError("ORIGIN_NOT_ALLOWED");
  }
  if (originHeader) {
    let origin: URL;
    try {
      origin = new URL(originHeader);
    } catch {
      throw new LocalWorkspaceApiError("ORIGIN_NOT_ALLOWED");
    }
    if (origin.origin !== requestOrigin || originHeader !== origin.origin) {
      throw new LocalWorkspaceApiError("ORIGIN_NOT_ALLOWED");
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new LocalWorkspaceApiError("ORIGIN_NOT_ALLOWED");
  }
  const referer = request.headers.get("referer");
  const sameOriginFetch = fetchSite === "same-origin";
  let sameOriginReferer = false;
  if (referer) {
    try {
      sameOriginReferer = new URL(referer).origin === requestOrigin;
    } catch {
      sameOriginReferer = false;
    }
  }
  if (!sameOriginFetch && !sameOriginReferer) {
    throw new LocalWorkspaceApiError("ORIGIN_NOT_ALLOWED");
  }
}

export function safeLocalWorkspaceError(error: unknown): Response {
  if (error instanceof LocalWorkspaceError) {
    const status =
      error.code === "PROJECT_NOT_ALLOWLISTED"
        ? 403
        : error.code === "GRANT_NOT_FOUND" || error.code === "PATCH_NOT_FOUND"
          ? 404
          : error.code === "PATCH_CONFLICT" ||
              error.code === "PATCH_STATE_INVALID"
            ? 409
            : error.code === "GRANT_EXPIRED" || error.code === "PATCH_EXPIRED"
              ? 410
              : error.code === "PATCH_LIMIT_REACHED"
                ? 429
                : error.code === "FILE_TOO_LARGE"
                  ? 413
                  : error.code === "BINARY_FILE"
                    ? 415
                    : error.code === "INVALID_PATH" ||
                        error.code === "PATCH_HASH_INVALID" ||
                        error.code === "INVALID_SEARCH_QUERY" ||
                        error.code === "NOT_A_DIRECTORY" ||
                        error.code === "NOT_A_FILE"
                      ? 400
                      : error.code === "CONFIGURATION_INVALID" ||
                          error.code === "WRITE_NOT_CONFIGURED" ||
                          error.code ===
                            "WORKSPACE_EVALUATION_NOT_CONFIGURED" ||
                          error.code === "WORKSPACE_EVALUATION_UNAVAILABLE"
                        ? 503
                        : error.code === "IO_ERROR"
                          ? 500
                          : 404;
    return Response.json(error.toJSON(), { status });
  }
  if (error instanceof LocalWorkspaceApiError) {
    const messages: Record<LocalWorkspaceApiError["code"], string> = {
      ORIGIN_NOT_ALLOWED: "Permintaan workspace lokal ditolak.",
      PROJECT_NOT_CONFIGURED: "Folder proyek ini belum diizinkan di server.",
      GRANT_EXPIRED:
        "Izin workspace sementara sudah berakhir. Minta izin baru untuk melanjutkan.",
      GRANT_NOT_FOUND: "Izin workspace tidak aktif untuk proyek ini.",
      APPROVAL_REQUIRED: "Setujui akses baca sementara terlebih dahulu.",
      WRITE_APPROVAL_REQUIRED:
        "Konfirmasi niat mengubah file sebelum meminta izin tulis.",
      PATCH_APPROVAL_REQUIRED:
        "Setujui perubahan atau pemulihan yang ditampilkan terlebih dahulu.",
      WRITE_NOT_CONFIGURED:
        "Izin tulis lokal belum diaktifkan untuk proyek ini.",
      DATABASE_UNAVAILABLE: "Database knowledge lokal belum tersedia.",
      REQUEST_INVALID: "Permintaan workspace tidak valid.",
      REQUEST_TOO_LARGE: "Permintaan workspace melebihi batas.",
      WORKSPACE_EVALUATION_NOT_CONFIGURED:
        "Tes proyek belum diizinkan di konfigurasi server.",
    };
    const status =
      error.code === "ORIGIN_NOT_ALLOWED"
        ? 403
        : error.code === "PROJECT_NOT_CONFIGURED" ||
            error.code === "DATABASE_UNAVAILABLE" ||
            error.code === "WRITE_NOT_CONFIGURED" ||
            error.code === "WORKSPACE_EVALUATION_NOT_CONFIGURED"
          ? 503
          : error.code === "GRANT_NOT_FOUND"
            ? 404
            : error.code === "GRANT_EXPIRED"
              ? 410
              : 400;
    return Response.json(
      { error: error.code, message: messages[error.code] },
      { status },
    );
  }
  return Response.json(
    {
      error: "INTERNAL_ERROR",
      message: "Permintaan workspace lokal tidak dapat diproses.",
    },
    { status: 500 },
  );
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
