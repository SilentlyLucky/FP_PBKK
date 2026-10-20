import {
  checksumText,
  createKnowledgeSource,
  KnowledgeOperationError,
  listKnowledgeSources,
  replaceKnowledgeSource,
  validateKnowledgeText,
  type KnowledgeSourceInput,
  type SourcePermission,
} from "@promptlab/db";
import { knowledgeSnapshotStoreFromEnvironment } from "@promptlab/tools";
import { IdSchema } from "@promptlab/contracts";
import type { LocalWorkspaceReadResult } from "../../../../packages/tools/src/local-workspace.ts";

import { databaseOrUnavailable } from "@/lib/api";
import {
  assertLocalSameOrigin,
  getServerLocalWorkspaceRuntime,
  LocalWorkspaceApiError,
  safeLocalWorkspaceError,
  type LocalWorkspaceRuntime,
} from "@/lib/local-workspace";

type ImportResult = {
  sourceId: string;
  version: number;
  checksum: string;
  chunkCount: number;
  updated: boolean;
  permission: SourcePermission;
};

export interface LocalWorkspaceRouteDependencies {
  readonly getRuntime?: () => Promise<LocalWorkspaceRuntime>;
  readonly databaseConfigured?: () => boolean;
  readonly persistSource?: (
    projectId: string,
    file: LocalWorkspaceReadResult,
  ) => Promise<ImportResult>;
  readonly now?: () => Date;
}

const LOCAL_PATCH_REQUEST_LIMIT_BYTES = 8_500_000;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function readJsonBody(
  request: Request,
  limitBytes: number,
): Promise<unknown> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw new LocalWorkspaceApiError("REQUEST_INVALID");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new LocalWorkspaceApiError("REQUEST_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LocalWorkspaceApiError("REQUEST_TOO_LARGE");
      }
      parts.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalWorkspaceApiError("REQUEST_INVALID");
  }
}

function requireProjectId(value: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new LocalWorkspaceApiError("REQUEST_INVALID");
  return parsed.data;
}

function requireOneQueryValue(
  url: URL,
  key: string,
  required: boolean,
): string {
  const values = url.searchParams.getAll(key);
  if (values.length > 1 || (required && (values.length !== 1 || !values[0]))) {
    throw new LocalWorkspaceApiError("REQUEST_INVALID");
  }
  return values[0] ?? "";
}

export function buildLocalWorkspaceKnowledgeSourceInput(
  projectId: string,
  file: LocalWorkspaceReadResult,
  now: Date,
): KnowledgeSourceInput {
  const name = file.path.split("/").at(-1) ?? "";
  const isMarkdown = /\.(md|markdown)$/iu.test(name);

  const checked = validateKnowledgeText({
    displayName: name,
    content: file.content,
  });
  const contentType = isMarkdown ? "text/markdown" : "text/plain";
  return {
    projectId,
    displayName: checked.displayName,
    content: checked.content,
    contentType,
    sourceKind: "upload",
    permission: "campus_indexer_allowed",
    sourceRef: null,
    sourceMetadata: {
      origin: "local_workspace",
      relativePath: file.path,
      importedAt: now.toISOString(),
      extractedTextSha256: checksumText(checked.content),
    },
    rawByteSha256: file.contentHash,
    rawByteSize: file.bytes,
  };
}

async function persistLocalWorkspaceSource(
  projectId: string,
  file: LocalWorkspaceReadResult,
  now: Date,
): Promise<ImportResult> {
  const database = databaseOrUnavailable();
  if ("response" in database) {
    throw new LocalWorkspaceApiError("DATABASE_UNAVAILABLE");
  }
  const input = buildLocalWorkspaceKnowledgeSourceInput(projectId, file, now);
  const snapshot = await knowledgeSnapshotStoreFromEnvironment().put(
    projectId,
    file.rawBytes,
  );
  const existingSources = await listKnowledgeSources(database.db, projectId);
  const existing = existingSources.find((source) => {
    const metadata = source.sourceMetadata as Record<string, unknown>;
    return (
      !source.deleted &&
      metadata.origin === "local_workspace" &&
      metadata.relativePath === file.path
    );
  });
  const source = existing
    ? await replaceKnowledgeSource(database.db, {
        ...input,
        rawByteSha256: snapshot.sha256,
        rawByteSize: snapshot.size,
        sourceId: existing.id,
      })
    : await createKnowledgeSource(database.db, {
        ...input,
        rawByteSha256: snapshot.sha256,
        rawByteSize: snapshot.size,
      });
  return {
    sourceId: source.sourceId,
    version: source.version,
    checksum: source.checksum,
    chunkCount: source.chunkCount,
    updated: Boolean(existing),
    permission: "campus_indexer_allowed",
  };
}

export function createLocalWorkspaceRouteHandlers(
  dependencies: LocalWorkspaceRouteDependencies = {},
) {
  const getRuntime = dependencies.getRuntime ?? getServerLocalWorkspaceRuntime;
  const databaseConfigured =
    dependencies.databaseConfigured ??
    (() => Boolean(process.env.PROMPTLAB_DATABASE_URL?.trim()));
  const now = dependencies.now ?? (() => new Date());
  const persistSource =
    dependencies.persistSource ??
    ((projectId: string, file: LocalWorkspaceReadResult) =>
      persistLocalWorkspaceSource(projectId, file, now()));

  function guard(request: Request, rawProjectId: string) {
    assertLocalSameOrigin(request);
    return requireProjectId(rawProjectId);
  }

  async function gatewayForProject(projectId: string) {
    const runtime = await getRuntime();
    if (runtime.kind === "unavailable") return runtime;
    if (!runtime.gateway.isProjectConfigured(projectId)) {
      throw new LocalWorkspaceApiError("PROJECT_NOT_CONFIGURED");
    }
    return runtime;
  }

  return {
    async status(request: Request, rawProjectId: string): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const runtime = await getRuntime();
        const configured =
          runtime.kind === "available" &&
          runtime.gateway.isProjectConfigured(projectId);
        const roots =
          runtime.kind === "available"
            ? runtime.gateway.listRoots(projectId)
            : [];
        const writeAvailable =
          runtime.kind === "available" &&
          runtime.gateway.isWriteConfigured(projectId);
        const isolatedEvaluation =
          runtime.kind === "available"
            ? await runtime.gateway.workspaceEvaluationStatus(projectId)
            : {
                executionAvailable: false,
                reasonCode:
                  runtime.reason === "configuration_invalid"
                    ? "evaluation_configuration_invalid"
                    : "project_not_configured",
                tests: [],
              };
        return Response.json({
          projectConfigured: configured,
          databaseConfigured: databaseConfigured(),
          isolatedEvaluation: {
            ...isolatedEvaluation,
            message: isolatedEvaluation.executionAvailable
              ? "Tes proyek tersedia untuk dijalankan pada salinan baseline dan kandidat yang terisolasi."
              : "Tes proyek belum dapat dijalankan dengan konfigurasi atau sandbox yang tersedia.",
          },
          reason:
            runtime.kind === "unavailable"
              ? runtime.reason
              : configured
                ? null
                : "project_not_configured",
          access: configured ? "read_only" : null,
          grantDurationSeconds: configured ? 15 * 60 : null,
          roots,
          canChooseDirectory: true,
          writeAvailable,
          writeGrantDurationSeconds: writeAvailable ? 5 * 60 : null,
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async approve(request: Request, rawProjectId: string): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 512);
        if (
          !record(body) ||
          ![1, 2].includes(Object.keys(body).length) ||
          Object.keys(body).some(
            (key) => !["approval", "rootId"].includes(key),
          ) ||
          body.approval !== "read_only_project_root" ||
          (body.rootId !== undefined &&
            (typeof body.rootId !== "string" || body.rootId.length > 160))
        ) {
          throw new LocalWorkspaceApiError("APPROVAL_REQUIRED");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          return Response.json(
            {
              error:
                runtime.reason === "configuration_invalid"
                  ? "WORKSPACE_CONFIGURATION_INVALID"
                  : "WORKSPACE_NOT_CONFIGURED",
              message:
                "Folder proyek ini belum dikonfigurasi untuk akses baca lokal.",
            },
            { status: 503 },
          );
        }
        const grant = runtime.gateway.issueGrant(
          projectId,
          typeof body.rootId === "string" ? body.rootId : undefined,
        );
        return Response.json(
          {
            grantId: grant.grantId,
            expiresAt: grant.expiresAt,
            rootId: grant.rootId,
            access: "read_only",
            scope: "project_root",
          },
          { status: 201 },
        );
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async approveWrite(
      request: Request,
      rawProjectId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 512);
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          body.approval !== "workspace_write_project_root"
        ) {
          throw new LocalWorkspaceApiError("WRITE_APPROVAL_REQUIRED");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const grant = runtime.gateway.issueWriteGrant(projectId);
        return Response.json(
          {
            grantId: grant.grantId,
            expiresAt: grant.expiresAt,
            access: "workspace_write",
            scope: "project_root",
          },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async revoke(
      request: Request,
      rawProjectId: string,
      grantId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          return Response.json({ revoked: false });
        }
        runtime.gateway.revokeGrant(projectId, grantId);
        return Response.json({ revoked: true });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async list(
      request: Request,
      rawProjectId: string,
      grantId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const path = requireOneQueryValue(new URL(request.url), "path", false);
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          return Response.json(
            { error: "WORKSPACE_NOT_CONFIGURED" },
            { status: 503 },
          );
        }
        const result = await runtime.gateway.list(projectId, grantId, path);
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async read(
      request: Request,
      rawProjectId: string,
      grantId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const path = requireOneQueryValue(new URL(request.url), "path", true);
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          return Response.json(
            { error: "WORKSPACE_NOT_CONFIGURED" },
            { status: 503 },
          );
        }
        const result = await runtime.gateway.read(projectId, grantId, path);
        const { rawBytes: _rawBytes, ...publicResult } = result;
        return Response.json(publicResult, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async search(
      request: Request,
      rawProjectId: string,
      grantId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const query = requireOneQueryValue(new URL(request.url), "q", true);
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          return Response.json(
            { error: "WORKSPACE_NOT_CONFIGURED" },
            { status: 503 },
          );
        }
        const result = await runtime.gateway.search(projectId, grantId, query);
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async import(
      request: Request,
      rawProjectId: string,
      grantId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 4_096);
        if (!record(body)) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        if (Object.keys(body).length !== 1) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        if (typeof body.path !== "string" || !body.path) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        if (!databaseConfigured()) {
          throw new LocalWorkspaceApiError("DATABASE_UNAVAILABLE");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          return Response.json(
            { error: "WORKSPACE_NOT_CONFIGURED" },
            { status: 503 },
          );
        }
        const file = await runtime.gateway.read(projectId, grantId, body.path);
        const imported = await persistSource(projectId, file);
        return Response.json(imported, { status: 201 });
      } catch (error) {
        if (error instanceof KnowledgeOperationError) {
          const status =
            error.code === "PROJECT_NOT_FOUND" ||
            error.code === "SOURCE_NOT_FOUND"
              ? 404
              : error.code === "SOURCE_TOO_LARGE"
                ? 413
                : 400;
          return Response.json(
            { error: error.code, message: error.message },
            { status },
          );
        }
        return safeLocalWorkspaceError(error);
      }
    },

    async proposePatch(
      request: Request,
      rawProjectId: string,
      grantId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(
          request,
          LOCAL_PATCH_REQUEST_LIMIT_BYTES,
        );
        if (!record(body)) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const hasExpectedBeforeHash = Object.hasOwn(body, "expectedBeforeHash");
        if (
          Object.keys(body).length !== (hasExpectedBeforeHash ? 4 : 3) ||
          typeof body.path !== "string" ||
          !body.path ||
          typeof body.content !== "string" ||
          body.source !== "user_editor" ||
          (hasExpectedBeforeHash && !isSha256Hash(body.expectedBeforeHash))
        ) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const expectedBeforeHash = hasExpectedBeforeHash
          ? (body.expectedBeforeHash as string)
          : undefined;
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const patch = await runtime.gateway.proposePatch(
          projectId,
          grantId,
          body.path,
          body.content,
          expectedBeforeHash,
        );
        return Response.json(patch, {
          status: 201,
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async getPatch(
      request: Request,
      rawProjectId: string,
      grantId: string,
      patchId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const patch = await runtime.gateway.getPatch(
          projectId,
          grantId,
          patchId,
        );
        return Response.json(patch, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async evaluatePatch(
      request: Request,
      rawProjectId: string,
      grantId: string,
      patchId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 512);
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          typeof body.testId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(body.testId)
        ) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const report = await runtime.gateway.evaluatePatch(
          projectId,
          grantId,
          patchId,
          body.testId,
        );
        return Response.json(report, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async approvePatch(
      request: Request,
      rawProjectId: string,
      grantId: string,
      patchId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 512);
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          body.approval !== "apply_exact_patch"
        ) {
          throw new LocalWorkspaceApiError("PATCH_APPROVAL_REQUIRED");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const result = await runtime.gateway.approvePatch(
          projectId,
          grantId,
          patchId,
        );
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async rejectPatch(
      request: Request,
      rawProjectId: string,
      grantId: string,
      patchId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 512);
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          body.decision !== "reject_patch"
        ) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const patch = await runtime.gateway.rejectPatch(
          projectId,
          grantId,
          patchId,
        );
        return Response.json(patch, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async rollbackPatch(
      request: Request,
      rawProjectId: string,
      grantId: string,
      patchId: string,
    ): Promise<Response> {
      try {
        const projectId = guard(request, rawProjectId);
        const body = await readJsonBody(request, 512);
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          body.approval !== "restore_exact_before_bytes"
        ) {
          throw new LocalWorkspaceApiError("PATCH_APPROVAL_REQUIRED");
        }
        const runtime = await gatewayForProject(projectId);
        if (runtime.kind === "unavailable") {
          throw new LocalWorkspaceApiError("WRITE_NOT_CONFIGURED");
        }
        const result = await runtime.gateway.rollbackPatch(
          projectId,
          grantId,
          patchId,
        );
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },
  };
}

export const localWorkspaceRouteHandlers = createLocalWorkspaceRouteHandlers();
