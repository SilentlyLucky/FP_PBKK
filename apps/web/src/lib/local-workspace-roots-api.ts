import { eq } from "drizzle-orm";
import { IdSchema } from "@promptlab/contracts";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable } from "@/lib/api";
import {
  assertLocalSameOrigin,
  getServerLocalWorkspaceDirectoryPicker,
  getServerLocalWorkspaceRootRegistry,
  getServerLocalWorkspaceRuntime,
  invalidateServerLocalWorkspaceRuntime,
  LocalWorkspaceApiError,
  safeLocalWorkspaceError,
} from "@/lib/local-workspace";

interface RootApiDependencies {
  readonly registry?: ReturnType<typeof getServerLocalWorkspaceRootRegistry>;
  readonly picker?: ReturnType<typeof getServerLocalWorkspaceDirectoryPicker>;
  readonly getRuntime?: typeof getServerLocalWorkspaceRuntime;
  readonly projectExists?: (projectId: string) => Promise<boolean>;
  readonly invalidateRuntime?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw new LocalWorkspaceApiError("REQUEST_INVALID");
  }
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 2_048) {
        await reader.cancel().catch(() => undefined);
        throw new LocalWorkspaceApiError("REQUEST_TOO_LARGE");
      }
      parts.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!isRecord(payload)) throw new Error("invalid body");
    return payload;
  } catch {
    throw new LocalWorkspaceApiError("REQUEST_INVALID");
  }
}

async function projectExists(projectId: string): Promise<boolean> {
  const database = databaseOrUnavailable();
  if ("response" in database) return false;
  const [project] = await database.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return Boolean(project);
}

function requireProject(request: Request, rawProjectId: string) {
  assertLocalSameOrigin(request);
  const parsed = IdSchema.safeParse(rawProjectId);
  if (!parsed.success) throw new LocalWorkspaceApiError("REQUEST_INVALID");
  return parsed.data;
}

export function createLocalWorkspaceRootHandlers(
  dependencies: RootApiDependencies = {},
) {
  const registry =
    dependencies.registry ?? getServerLocalWorkspaceRootRegistry();
  const picker =
    dependencies.picker ?? getServerLocalWorkspaceDirectoryPicker();
  const getRuntime = dependencies.getRuntime ?? getServerLocalWorkspaceRuntime;
  const doesProjectExist = dependencies.projectExists ?? projectExists;
  const invalidateRuntime =
    dependencies.invalidateRuntime ?? invalidateServerLocalWorkspaceRuntime;

  async function requireExistingProject(
    request: Request,
    rawProjectId: string,
  ) {
    const projectId = requireProject(request, rawProjectId);
    if (!(await doesProjectExist(projectId))) {
      throw new LocalWorkspaceApiError("PROJECT_NOT_CONFIGURED");
    }
    return projectId;
  }

  return {
    async list(request: Request, rawProjectId: string): Promise<Response> {
      try {
        const projectId = await requireExistingProject(request, rawProjectId);
        const [registeredRoots, runtime] = await Promise.all([
          registry.list(projectId),
          getRuntime(),
        ]);
        const environmentRoots =
          runtime.kind === "available"
            ? runtime.gateway
                .listRoots(projectId)
                .filter((root) => root.source === "environment")
            : [];
        const roots = [
          ...environmentRoots.map((root) => ({
            rootId: root.rootId,
            displayName: root.displayName,
            source: "environment" as const,
            available: root.available,
            createdAt: null,
          })),
          ...registry.summaries(registeredRoots).map((root) => ({
            rootId: root.rootId,
            displayName: root.displayName,
            source: root.source,
            available: root.available,
            createdAt: root.createdAt,
          })),
        ];
        return Response.json(
          {
            roots,
            canChooseDirectory: true,
            runtimeAvailable: runtime.kind === "available",
            unavailableReason:
              runtime.kind === "unavailable" ? runtime.reason : null,
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async pickerListing(
      request: Request,
      rawProjectId: string,
    ): Promise<Response> {
      try {
        const projectId = await requireExistingProject(request, rawProjectId);
        const url = new URL(request.url);
        const tokens = url.searchParams.getAll("token");
        if (tokens.length > 1) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const listing = tokens[0]
          ? await picker.browse(projectId, tokens[0])
          : await picker.begin(projectId);
        return Response.json(listing, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return safeLocalWorkspaceError(error);
      }
    },

    async register(request: Request, rawProjectId: string): Promise<Response> {
      try {
        const projectId = await requireExistingProject(request, rawProjectId);
        const body = await readBody(request);
        if (
          Object.keys(body).length !== 1 ||
          typeof body.selectionToken !== "string" ||
          body.selectionToken.length > 80
        ) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const selection = await picker.resolveSelection(
          projectId,
          body.selectionToken,
        );
        const root = await registry.register(projectId, selection.rootPath);
        invalidateRuntime();
        const runtime = await getRuntime();
        if (
          runtime.kind !== "available" ||
          !runtime.gateway
            .listRoots(projectId)
            .some((item) => item.rootId === root.rootId && item.available)
        ) {
          throw new Error("ROOT_REGISTRATION_UNAVAILABLE");
        }
        return Response.json(
          {
            root: {
              rootId: root.rootId,
              displayName: root.displayName,
              source: "registered",
              available: true,
            },
          },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof LocalWorkspaceApiError) {
          return safeLocalWorkspaceError(error);
        }
        if (
          error instanceof Error &&
          error.message === "ROOT_REGISTRATION_INVALID"
        ) {
          return Response.json(
            {
              error: "ROOT_REGISTRATION_INVALID",
              message: "Folder tidak dapat diizinkan.",
            },
            { status: 400 },
          );
        }
        return Response.json(
          {
            error: "ROOT_REGISTRATION_UNAVAILABLE",
            message: "Pendaftaran folder belum tersedia.",
          },
          { status: 503 },
        );
      }
    },

    async revoke(request: Request, rawProjectId: string): Promise<Response> {
      try {
        const projectId = await requireExistingProject(request, rawProjectId);
        const body = await readBody(request);
        if (
          Object.keys(body).length !== 1 ||
          typeof body.rootId !== "string" ||
          !IdSchema.safeParse(body.rootId).success
        ) {
          throw new LocalWorkspaceApiError("REQUEST_INVALID");
        }
        const revoked = await registry.revoke(projectId, body.rootId);
        if (revoked) invalidateRuntime();
        return Response.json(
          { revoked },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof LocalWorkspaceApiError) {
          return safeLocalWorkspaceError(error);
        }
        return Response.json(
          {
            error: "ROOT_REGISTRY_UNAVAILABLE",
            message: "Pendaftaran folder belum tersedia.",
          },
          { status: 503 },
        );
      }
    },
  };
}

export const localWorkspaceRootHandlers = createLocalWorkspaceRootHandlers();
