import {
  IdSchema,
  RunCreateSchema,
  WorkspaceRunRetrievalSelectionSchema,
  type WorkspaceSourceManifest,
} from "@promptlab/contracts";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  getActiveGraphSnapshot,
  graphSnapshotIsCurrent,
  schema,
  captureWorkspaceSourceManifest,
} from "@promptlab/db";
import {
  providerConnectionMatchesPolicy,
  providerPurposePolicy,
} from "@promptlab/providers/policy";
import { codexVerificationMatchesConfiguration } from "@promptlab/providers/codex";
import {
  campusCredentialFingerprint,
  campusCredentialFingerprintFromSnapshot,
  campusVerificationMatchesConfiguration,
} from "@promptlab/providers/campus-verification";
import {
  isControlledEvaluationConfigurationValid,
  sha256Text,
} from "@promptlab/agent";

import { databaseOrUnavailable, parseRouteId, safeApiFailure } from "@/lib/api";
import { parseCodexFileDraftPrompt } from "@/lib/codex-file-draft";
import { getServerLocalWorkspaceRuntime } from "@/lib/local-workspace";

export const runtime = "nodejs";

type ExistingRunRequest = {
  id: string;
  status: string;
  promptVersionId: string | null;
  provider: string;
  requestedModel: string;
  configSnapshot: Record<string, unknown>;
};

function graphSnapshotCoversWorkspaceSources(
  graphManifest: unknown,
  sourceManifest: WorkspaceSourceManifest,
): boolean {
  if (!Array.isArray(graphManifest)) return false;
  const graphSources = new Map<string, Record<string, unknown>>();
  for (const item of graphManifest) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    if (typeof source.documentId === "string")
      graphSources.set(source.documentId, source);
  }
  return sourceManifest.sources.every((source) => {
    const graphSource = graphSources.get(source.documentId);
    return (
      graphSource?.documentVersionId === source.documentVersionId &&
      graphSource.checksum === source.checksum &&
      graphSource.permission === source.sourcePermission
    );
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const idempotencyKeys = new URL(request.url).searchParams.getAll(
      "idempotencyKey",
    );
    if (idempotencyKeys.length > 1) {
      return Response.json(
        { error: "INVALID_IDEMPOTENCY_KEY" },
        { status: 400 },
      );
    }
    if (idempotencyKeys.length === 1) {
      const key = IdSchema.safeParse(idempotencyKeys[0]);
      if (!key.success) {
        return Response.json(
          { error: "INVALID_IDEMPOTENCY_KEY" },
          { status: 400 },
        );
      }
      const [run] = await database.db
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.projectId, projectId),
            eq(schema.runs.idempotencyKey, key.data),
          ),
        )
        .limit(1);
      if (!run)
        return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
      return Response.json({ run });
    }

    const runs = await database.db
      .select({
        id: schema.runs.id,
        promptVersionId: schema.runs.promptVersionId,
        promptText: schema.promptVersions.text,
        promptName: schema.prompts.name,
        purpose: schema.runs.purpose,
        provider: schema.runs.provider,
        requestedModel: schema.runs.requestedModel,
        responseModel: schema.runs.responseModel,
        status: schema.runs.status,
        errorCode: schema.runs.errorCode,
        errorSummary: schema.runs.errorSummary,
        createdAt: schema.runs.createdAt,
      })
      .from(schema.runs)
      .leftJoin(
        schema.promptVersions,
        and(
          eq(schema.promptVersions.projectId, schema.runs.projectId),
          eq(schema.promptVersions.id, schema.runs.promptVersionId),
        ),
      )
      .leftJoin(
        schema.prompts,
        and(
          eq(schema.prompts.projectId, schema.runs.projectId),
          eq(schema.prompts.id, schema.promptVersions.promptId),
        ),
      )
      .where(eq(schema.runs.projectId, projectId))
      .orderBy(desc(schema.runs.createdAt))
      .limit(100);
    return Response.json({ runs });
  } catch {
    return safeApiFailure();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await context.params;
  const projectId = parseRouteId(rawProjectId);
  if (!projectId)
    return Response.json({ error: "INVALID_PROJECT_ID" }, { status: 400 });
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = RunCreateSchema.safeParse(body);
  if (!parsed.success || parsed.data.projectId !== projectId)
    return Response.json({ error: "INVALID_RUN_REQUEST" }, { status: 400 });
  if (
    parsed.data.intent === "workspace_chat" &&
    !parsed.data.workspaceChat?.target
  ) {
    return Response.json(
      {
        error: "WORKSPACE_CHAT_TARGET_REQUIRED",
        message:
          "Pilih target Codex terverifikasi sebelum menjalankan Workspace chat.",
      },
      { status: 409 },
    );
  }
  if (
    parsed.data.reasoningEffort !== undefined &&
    parsed.data.provider !== "codex_app_server"
  ) {
    return Response.json(
      { error: "REASONING_EFFORT_REQUIRES_CODEX" },
      { status: 400 },
    );
  }
  if (
    parsed.data.optimization &&
    (parsed.data.provider !== "codex_app_server" ||
      parsed.data.purpose !== "target")
  ) {
    return Response.json(
      { error: "OPTIMIZATION_REQUIRES_VERIFIED_CODEX_TARGET" },
      { status: 400 },
    );
  }
  if (
    parsed.data.controlledEvaluation &&
    (parsed.data.provider !== "codex_app_server" ||
      parsed.data.purpose !== "target" ||
      parsed.data.optimization ||
      !isControlledEvaluationConfigurationValid(
        parsed.data.controlledEvaluation,
      ))
  ) {
    return Response.json(
      { error: "INVALID_CONTROLLED_EVALUATION_CONFIGURATION" },
      { status: 400 },
    );
  }
  const retrieval = parsed.data.retrieval ?? {
    strategy: "lexical" as const,
    sourceIds: [],
  };
  const sourceIds = [...new Set(retrieval.sourceIds)].sort();
  if (sourceIds.length !== retrieval.sourceIds.length)
    return Response.json(
      { error: "INVALID_RETRIEVAL_SOURCES" },
      { status: 400 },
    );
  if (retrieval.strategy === "auto" && retrieval.snapshotId !== undefined)
    return Response.json(
      { error: "INVALID_RETRIEVAL_SNAPSHOT_SELECTION" },
      { status: 400 },
    );
  const fileDraftIntent = parsed.data.intent === "workspace_file_draft";
  if (
    fileDraftIntent &&
    (retrieval.strategy !== "lexical" ||
      sourceIds.length > 0 ||
      retrieval.snapshotId)
  ) {
    return Response.json(
      { error: "WORKSPACE_FILE_DRAFT_RETRIEVAL_FORBIDDEN" },
      { status: 400 },
    );
  }
  if (
    (retrieval.strategy === "graph" && sourceIds.length === 0) ||
    (retrieval.snapshotId && retrieval.strategy !== "graph")
  ) {
    return Response.json(
      { error: "INVALID_GRAPH_SNAPSHOT_SELECTION" },
      { status: 400 },
    );
  }
  let frozenRetrieval = {
    strategy: retrieval.strategy,
    sourceIds,
    snapshotId: retrieval.snapshotId ?? null,
  };
  const providerPolicy = providerPurposePolicy(
    parsed.data.provider,
    parsed.data.purpose,
  );
  if (!providerPolicy.supported || !providerPolicy.role) {
    return Response.json(
      {
        error:
          providerPolicy.reason === "fixture_provider_disabled"
            ? "FIXTURE_PROVIDER_DISABLED"
            : "PROVIDER_PURPOSE_NOT_ALLOWED",
        message:
          providerPolicy.reason === "fixture_provider_disabled"
            ? "Fixture provider tidak menjadi fallback produksi."
            : "Provider tidak diizinkan untuk purpose ini.",
      },
      { status: 409 },
    );
  }

  let matchesExistingRequest:
    ((existing: ExistingRunRequest) => boolean) | null = null;

  try {
    const [promptVersion] = await database.db
      .select({
        id: schema.promptVersions.id,
        promptId: schema.promptVersions.promptId,
        text: schema.promptVersions.text,
      })
      .from(schema.promptVersions)
      .where(
        and(
          eq(schema.promptVersions.projectId, projectId),
          eq(schema.promptVersions.id, parsed.data.promptVersionId),
        ),
      )
      .limit(1);
    if (!promptVersion)
      return Response.json(
        { error: "PROMPT_VERSION_NOT_FOUND" },
        { status: 404 },
      );

    if (parsed.data.intent === "workspace_file_draft") {
      const fileDraft = parsed.data.workspaceFileDraft!;
      const parsedFileDraftPrompt = parseCodexFileDraftPrompt(
        promptVersion.text,
      );
      if (
        !parsedFileDraftPrompt ||
        sha256Text(parsedFileDraftPrompt.fileText) !== fileDraft.snapshotHash
      ) {
        return Response.json(
          { error: "WORKSPACE_FILE_DRAFT_INTENT_INVALID" },
          { status: 409 },
        );
      }
      let contextVerified = false;
      try {
        const runtime = await getServerLocalWorkspaceRuntime();
        if (
          runtime.kind === "available" &&
          runtime.gateway.isProjectConfigured(projectId)
        ) {
          contextVerified = await runtime.gateway.verifyFileDraftRunContext({
            projectId,
            readGrantId: fileDraft.readGrantId,
            writeGrantId: fileDraft.writeGrantId,
            relativePath: fileDraft.path,
            snapshotHash: fileDraft.snapshotHash,
            fileText: parsedFileDraftPrompt.fileText,
          });
        }
      } catch {
        contextVerified = false;
      }
      if (!contextVerified) {
        return Response.json(
          { error: "WORKSPACE_FILE_DRAFT_CONTEXT_UNVERIFIED" },
          { status: 409 },
        );
      }
    }

    if (parsed.data.controlledEvaluation) {
      const controlled = parsed.data.controlledEvaluation;
      if (
        promptVersion.id !== controlled.baselinePromptVersionId ||
        promptVersion.promptId !== controlled.promptId ||
        sha256Text(promptVersion.text) !== controlled.baselinePromptHash ||
        retrieval.sourceIds.length > 0 ||
        (retrieval.snapshotId ?? null) !== null
      ) {
        return Response.json(
          { error: "CONTROLLED_EVALUATION_BASELINE_MISMATCH" },
          { status: 409 },
        );
      }
      const [candidatePromptVersion] = await database.db
        .select({
          id: schema.promptVersions.id,
          promptId: schema.promptVersions.promptId,
          text: schema.promptVersions.text,
        })
        .from(schema.promptVersions)
        .where(
          and(
            eq(schema.promptVersions.projectId, projectId),
            eq(schema.promptVersions.id, controlled.candidatePromptVersionId),
          ),
        )
        .limit(1);
      if (
        !candidatePromptVersion ||
        candidatePromptVersion.id === promptVersion.id ||
        candidatePromptVersion.promptId !== promptVersion.promptId ||
        sha256Text(candidatePromptVersion.text) !==
          controlled.candidatePromptHash ||
        candidatePromptVersion.text === promptVersion.text
      ) {
        return Response.json(
          { error: "CONTROLLED_EVALUATION_CANDIDATE_MISMATCH" },
          { status: 409 },
        );
      }

      const expectedSourceById = new Map<
        string,
        {
          documentId: string;
          documentVersionId: string;
          documentVersion: number;
          checksum: string;
        }
      >();
      for (const arm of controlled.arms) {
        const sourceIdsInArm = arm.sources
          .map((source) => source.documentId)
          .sort();
        const selectedIdsInArm = [...arm.retrieval.sourceIds].sort();
        if (
          JSON.stringify(sourceIdsInArm) !== JSON.stringify(selectedIdsInArm)
        ) {
          return Response.json(
            { error: "CONTROLLED_EVALUATION_SOURCE_SELECTION_MISMATCH" },
            { status: 400 },
          );
        }
        for (const source of arm.sources) {
          expectedSourceById.set(source.documentId, {
            documentId: source.documentId,
            documentVersionId: source.documentVersionId,
            documentVersion: source.documentVersion,
            checksum: source.checksum,
          });
        }
      }
      const controlledSourceIds = [...expectedSourceById.keys()].sort();
      const currentSources = controlledSourceIds.length
        ? await database.db
            .select({
              documentId: schema.documents.id,
              activeVersionId: schema.documents.activeVersionId,
              permission: schema.documents.trust,
              documentVersionId: schema.documentVersions.id,
              documentVersion: schema.documentVersions.version,
              checksum: schema.documentVersions.checksum,
              eligible: schema.documentVersions.eligible,
            })
            .from(schema.documents)
            .innerJoin(
              schema.documentVersions,
              and(
                eq(
                  schema.documents.projectId,
                  schema.documentVersions.projectId,
                ),
                eq(schema.documents.id, schema.documentVersions.documentId),
                eq(
                  schema.documents.activeVersionId,
                  schema.documentVersions.id,
                ),
              ),
            )
            .where(
              and(
                eq(schema.documents.projectId, projectId),
                inArray(schema.documents.id, controlledSourceIds),
                isNull(schema.documents.deletedAt),
              ),
            )
        : [];
      const currentSourceById = new Map(
        currentSources.map((source) => [source.documentId, source]),
      );
      if (
        currentSources.length !== controlledSourceIds.length ||
        currentSources.some(
          (source) =>
            source.permission !== "campus_indexer_allowed" ||
            !source.eligible ||
            source.activeVersionId !== source.documentVersionId,
        ) ||
        controlledSourceIds.some((sourceId) => {
          const expected = expectedSourceById.get(sourceId)!;
          const current = currentSourceById.get(sourceId);
          return (
            !current ||
            current.documentVersionId !== expected.documentVersionId ||
            current.documentVersion !== expected.documentVersion ||
            current.checksum !== expected.checksum
          );
        })
      ) {
        return Response.json(
          { error: "CONTROLLED_EVALUATION_SOURCE_VERSION_CHANGED" },
          { status: 409 },
        );
      }

      for (const arm of controlled.arms) {
        if (arm.arm !== "graphrag") continue;
        const activeSnapshot = await getActiveGraphSnapshot(
          database.db,
          projectId,
        );
        if (
          !activeSnapshot ||
          activeSnapshot.state !== "active" ||
          activeSnapshot.snapshotId !== arm.retrieval.snapshotId ||
          !(await graphSnapshotIsCurrent(
            database.db,
            projectId,
            activeSnapshot.sourceManifest,
          ))
        ) {
          return Response.json(
            { error: "CONTROLLED_EVALUATION_GRAPH_SNAPSHOT_NOT_CURRENT" },
            { status: 409 },
          );
        }
        const graphVersions = new Map<string, string>();
        if (Array.isArray(activeSnapshot.sourceManifest)) {
          for (const item of activeSnapshot.sourceManifest) {
            if (!item || typeof item !== "object" || Array.isArray(item))
              continue;
            const source = item as Record<string, unknown>;
            if (
              typeof source.documentId === "string" &&
              typeof source.documentVersionId === "string"
            ) {
              graphVersions.set(source.documentId, source.documentVersionId);
            }
          }
        }
        if (
          arm.sources.some(
            (source) =>
              graphVersions.get(source.documentId) !== source.documentVersionId,
          )
        ) {
          return Response.json(
            { error: "CONTROLLED_EVALUATION_GRAPH_SOURCE_MISMATCH" },
            { status: 409 },
          );
        }
      }
    }

    if (sourceIds.length) {
      const retrievalProvider = parsed.data.optimization
        ? "campus_gateway"
        : parsed.data.provider;
      if (retrievalProvider !== "campus_gateway") {
        return Response.json(
          {
            error: "RETRIEVAL_PROVIDER_PERMISSION_REQUIRED",
            message:
              "Izin Campus hanya berlaku untuk Campus Gateway. Pilih tanpa sumber atau gunakan provider dengan izin egress yang sesuai.",
          },
          { status: 409 },
        );
      }
      const eligibleSources = await database.db
        .select({
          id: schema.documents.id,
          activeVersionId: schema.documents.activeVersionId,
          permission: schema.documents.trust,
        })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.projectId, projectId),
            inArray(schema.documents.id, sourceIds),
            isNull(schema.documents.deletedAt),
            isNotNull(schema.documents.activeVersionId),
          ),
        );
      if (eligibleSources.length !== sourceIds.length) {
        return Response.json(
          { error: "RETRIEVAL_SOURCE_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (
        eligibleSources.some(
          (source) => source.permission !== "campus_indexer_allowed",
        )
      ) {
        return Response.json(
          {
            error: "RETRIEVAL_SOURCE_PERMISSION_REQUIRED",
            message:
              "Sumber local-only tidak dapat dikirim ke Campus Gateway. Cabut sumber itu dari pilihan run atau perbarui izinnya di Knowledge.",
          },
          { status: 409 },
        );
      }
      if (retrieval.strategy === "graph" && sourceIds.length > 0) {
        const activeSnapshot = await getActiveGraphSnapshot(
          database.db,
          projectId,
        );
        if (
          !activeSnapshot ||
          activeSnapshot.state !== "active" ||
          !(await graphSnapshotIsCurrent(
            database.db,
            projectId,
            activeSnapshot.sourceManifest,
          )) ||
          (retrieval.snapshotId !== undefined &&
            retrieval.snapshotId !== activeSnapshot.snapshotId)
        ) {
          return Response.json(
            {
              error: "GRAPH_SNAPSHOT_NOT_CURRENT",
              message:
                "Snapshot GraphRAG belum siap atau sudah usang. Segarkan GraphRAG di halaman Sumber lalu coba lagi.",
            },
            { status: 409 },
          );
        }
        const snapshotSourceVersions = new Map<string, string>();
        if (Array.isArray(activeSnapshot.sourceManifest)) {
          for (const item of activeSnapshot.sourceManifest) {
            if (!item || typeof item !== "object" || Array.isArray(item))
              continue;
            const source = item as Record<string, unknown>;
            if (
              typeof source.documentId === "string" &&
              typeof source.documentVersionId === "string"
            ) {
              snapshotSourceVersions.set(
                source.documentId,
                source.documentVersionId,
              );
            }
          }
        }
        if (
          eligibleSources.some(
            (source) =>
              !source.activeVersionId ||
              snapshotSourceVersions.get(source.id) !== source.activeVersionId,
          )
        ) {
          return Response.json(
            {
              error: "GRAPH_SNAPSHOT_SOURCE_MISMATCH",
              message:
                "Snapshot GraphRAG belum mencakup versi sumber terbaru yang dipilih. Segarkan GraphRAG di halaman Sumber lalu coba lagi.",
            },
            { status: 409 },
          );
        }
        frozenRetrieval = {
          strategy: retrieval.strategy,
          sourceIds,
          snapshotId: activeSnapshot.snapshotId,
        };
      }
    }

    const [connection] = await database.db
      .select({
        id: schema.providerConnections.id,
        provider: schema.providerConnections.provider,
        role: schema.providerConnections.role,
        connectionStatus: schema.providerConnections.connectionStatus,
        requestedModel: schema.providerConnections.requestedModel,
        capabilitySnapshot: schema.providerConnections.capabilitySnapshot,
      })
      .from(schema.providerConnections)
      .where(
        and(
          eq(schema.providerConnections.projectId, projectId),
          eq(schema.providerConnections.provider, parsed.data.provider),
          eq(schema.providerConnections.role, providerPolicy.role),
        ),
      )
      .limit(1);

    const envConfigured =
      parsed.data.provider === "campus_gateway"
        ? Boolean(
            process.env.PROMPTLAB_CAMPUS_API_KEY?.trim() &&
            process.env.PROMPTLAB_CAMPUS_MODEL?.trim(),
          )
        : parsed.data.provider === "codex_app_server" &&
          codexVerificationMatchesConfiguration(
            connection?.capabilitySnapshot,
            parsed.data.requestedModel,
          );
    const currentApiKey = process.env.PROMPTLAB_CAMPUS_API_KEY?.trim();
    const expectedCredentialFingerprint = currentApiKey
      ? campusCredentialFingerprint(currentApiKey)
      : null;
    const connectionMatches = providerConnectionMatchesPolicy(
      parsed.data.provider,
      parsed.data.requestedModel,
      providerPolicy,
      connection
        ? {
            ...connection,
            credentialFingerprint: campusCredentialFingerprintFromSnapshot(
              connection.capabilitySnapshot,
            ),
          }
        : connection,
      expectedCredentialFingerprint,
    );
    const modelMatches =
      connection?.requestedModel === parsed.data.requestedModel;
    const targetReady =
      providerPolicy.executable &&
      connectionMatches &&
      envConfigured &&
      modelMatches;
    let optimizerModel: string | null = null;
    let optimizerReady = true;
    const needsVerifiedOptimizer =
      Boolean(parsed.data.optimization) || fileDraftIntent;
    if (needsVerifiedOptimizer) {
      const optimizerPolicy = providerPurposePolicy(
        "campus_gateway",
        "optimizer",
      );
      const optimizerApiKey = process.env.PROMPTLAB_CAMPUS_API_KEY?.trim();
      optimizerModel = process.env.PROMPTLAB_CAMPUS_MODEL?.trim() || null;
      const [optimizerConnection] = await database.db
        .select({
          provider: schema.providerConnections.provider,
          role: schema.providerConnections.role,
          connectionStatus: schema.providerConnections.connectionStatus,
          requestedModel: schema.providerConnections.requestedModel,
          capabilitySnapshot: schema.providerConnections.capabilitySnapshot,
        })
        .from(schema.providerConnections)
        .where(
          and(
            eq(schema.providerConnections.projectId, projectId),
            eq(schema.providerConnections.provider, "campus_gateway"),
            eq(schema.providerConnections.role, "optimizer"),
          ),
        )
        .limit(1);
      const optimizerFingerprint = optimizerApiKey
        ? campusCredentialFingerprint(optimizerApiKey)
        : null;
      const optimizerConnectionMatches = providerConnectionMatchesPolicy(
        "campus_gateway",
        optimizerModel ?? "",
        optimizerPolicy,
        optimizerConnection
          ? {
              ...optimizerConnection,
              credentialFingerprint: campusCredentialFingerprintFromSnapshot(
                optimizerConnection.capabilitySnapshot,
              ),
            }
          : optimizerConnection,
        optimizerFingerprint,
      );
      optimizerReady = Boolean(
        optimizerPolicy.executable &&
        optimizerApiKey &&
        optimizerModel &&
        optimizerConnectionMatches &&
        optimizerConnection?.requestedModel === optimizerModel &&
        campusVerificationMatchesConfiguration(
          optimizerConnection?.capabilitySnapshot,
          {
            apiKey: optimizerApiKey,
            requestedModel: optimizerModel,
          },
        ),
      );
    }
    let workspaceChatTarget: {
      requestedModel: string;
      reasoningEffort: string | null;
      reasoningEffortMode?: "selected" | "auto";
    } | null = null;
    if (parsed.data.workspaceChat?.target) {
      const targetPolicy = providerPurposePolicy("codex_app_server", "target");
      const [workspaceTargetConnection] = await database.db
        .select({
          provider: schema.providerConnections.provider,
          role: schema.providerConnections.role,
          connectionStatus: schema.providerConnections.connectionStatus,
          requestedModel: schema.providerConnections.requestedModel,
          capabilitySnapshot: schema.providerConnections.capabilitySnapshot,
        })
        .from(schema.providerConnections)
        .where(
          and(
            eq(schema.providerConnections.projectId, projectId),
            eq(schema.providerConnections.provider, "codex_app_server"),
            eq(schema.providerConnections.role, "target"),
          ),
        )
        .limit(1);
      const selectedTarget = parsed.data.workspaceChat.target;
      if (
        workspaceTargetConnection?.requestedModel ===
          selectedTarget.requestedModel &&
        providerConnectionMatchesPolicy(
          "codex_app_server",
          selectedTarget.requestedModel,
          targetPolicy,
          workspaceTargetConnection,
        ) &&
        codexVerificationMatchesConfiguration(
          workspaceTargetConnection.capabilitySnapshot,
          selectedTarget.requestedModel,
        )
      ) {
        workspaceChatTarget = {
          requestedModel: selectedTarget.requestedModel,
          reasoningEffort: selectedTarget.reasoningEffort,
          ...(selectedTarget.reasoningEffortMode !== undefined
            ? { reasoningEffortMode: selectedTarget.reasoningEffortMode }
            : {}),
        };
      } else {
        return Response.json(
          {
            error: "WORKSPACE_CHAT_TARGET_UNVERIFIED",
            message:
              "Target Codex berubah sejak dipilih. Perbarui koneksi sebelum mengirim pesan ini.",
          },
          { status: 409 },
        );
      }
    }
    const ready = targetReady && optimizerReady;
    const status = ready ? "queued" : "paused_auth_required";
    const errorCode = ready
      ? null
      : needsVerifiedOptimizer && !optimizerReady
        ? !process.env.PROMPTLAB_CAMPUS_API_KEY?.trim()
          ? "optimizer_auth_required"
          : !optimizerModel
            ? "optimizer_model_required"
            : "optimizer_unverified"
        : !providerPolicy.executable
          ? (providerPolicy.reason ?? "provider_unverified")
          : !envConfigured
            ? "provider_auth_required"
            : !modelMatches
              ? "provider_model_mismatch"
              : "provider_unverified";
    const errorSummary = ready
      ? null
      : needsVerifiedOptimizer && !optimizerReady
        ? !process.env.PROMPTLAB_CAMPUS_API_KEY?.trim()
          ? "Login Senopati belum tersedia. Hubungkan provider kampus sebelum Run."
          : !optimizerModel
            ? "Model Senopati belum dikonfigurasi."
            : "Koneksi Senopati belum terverifikasi untuk model yang dikonfigurasi. Tidak ada inference yang dikirim."
        : !providerPolicy.executable
          ? "Provider target belum diverifikasi untuk authentication, generation, dan profil eksekusi bounded-native. Tidak ada inference yang dikirim."
          : !envConfigured
            ? "Provider credential, login, atau model tidak tersedia. Tidak ada inference yang dikirim."
            : !modelMatches
              ? "Requested model berbeda dari koneksi provider yang disimpan."
              : "Provider belum diverifikasi. Tidak ada inference yang dikirim.";

    matchesExistingRequest = (existing) => {
      const existingRetrieval = WorkspaceRunRetrievalSelectionSchema.safeParse(
        existing.configSnapshot.retrieval ?? {
          strategy: "lexical",
          sourceIds: [],
        },
      );
      return (
        existing.promptVersionId === parsed.data.promptVersionId &&
        existing.provider === parsed.data.provider &&
        existing.requestedModel === parsed.data.requestedModel &&
        (typeof existing.configSnapshot.reasoningEffort === "string"
          ? existing.configSnapshot.reasoningEffort
          : undefined) === parsed.data.reasoningEffort &&
        (typeof existing.configSnapshot.optimizerModel === "string"
          ? existing.configSnapshot.optimizerModel
          : null) === optimizerModel &&
        JSON.stringify(existing.configSnapshot.optimization ?? null) ===
          JSON.stringify(parsed.data.optimization ?? null) &&
        JSON.stringify(existing.configSnapshot.controlledEvaluation ?? null) ===
          JSON.stringify(parsed.data.controlledEvaluation ?? null) &&
        existing.configSnapshot.runIntent === parsed.data.intent &&
        JSON.stringify(existing.configSnapshot.workspaceFileDraft ?? null) ===
          JSON.stringify(parsed.data.workspaceFileDraft ?? null) &&
        JSON.stringify(existing.configSnapshot.workspaceChat ?? null) ===
          JSON.stringify(parsed.data.workspaceChat ?? null) &&
        JSON.stringify(existing.configSnapshot.workspaceChatTarget ?? null) ===
          JSON.stringify(workspaceChatTarget) &&
        existingRetrieval.success &&
        (retrieval.strategy === "auto"
          ? existingRetrieval.data.strategy === "auto" &&
            JSON.stringify(existingRetrieval.data.sourceIds) ===
              JSON.stringify(frozenRetrieval.sourceIds)
          : JSON.stringify(existingRetrieval.data) ===
            JSON.stringify(frozenRetrieval))
      );
    };

    const result = await database.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: schema.runs.id,
          status: schema.runs.status,
          promptVersionId: schema.runs.promptVersionId,
          provider: schema.runs.provider,
          requestedModel: schema.runs.requestedModel,
          configSnapshot: schema.runs.configSnapshot,
        })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.projectId, projectId),
            eq(schema.runs.idempotencyKey, parsed.data.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (!matchesExistingRequest?.(existing))
          return { conflict: true as const };
        return {
          conflict: false as const,
          created: false,
          run: { id: existing.id, status: existing.status },
        };
      }

      let workspaceSourceManifest: WorkspaceSourceManifest | null = null;
      if (parsed.data.intent === "workspace_chat") {
        const captured = await captureWorkspaceSourceManifest(
          tx,
          projectId,
          sourceIds,
        );
        if (!captured.ok) {
          return {
            sourceManifestError: captured.reason,
          } as const;
        }
        workspaceSourceManifest = captured.manifest;
      }
      if (
        workspaceSourceManifest &&
        parsed.data.intent === "workspace_chat" &&
        frozenRetrieval.strategy === "graph"
      ) {
        const activeSnapshot = await getActiveGraphSnapshot(tx, projectId);
        if (
          !activeSnapshot ||
          activeSnapshot.state !== "active" ||
          activeSnapshot.snapshotId !== frozenRetrieval.snapshotId ||
          !(await graphSnapshotIsCurrent(
            tx,
            projectId,
            activeSnapshot.sourceManifest,
          ))
        ) {
          return {
            sourceManifestError: "graph_snapshot_not_current",
          } as const;
        }
        if (
          !graphSnapshotCoversWorkspaceSources(
            activeSnapshot.sourceManifest,
            workspaceSourceManifest,
          )
        ) {
          return {
            sourceManifestError: "graph_snapshot_source_mismatch",
          } as const;
        }
      }
      if (
        workspaceSourceManifest &&
        parsed.data.intent === "workspace_chat" &&
        retrieval.strategy === "auto" &&
        sourceIds.length > 0
      ) {
        const activeSnapshot = await getActiveGraphSnapshot(tx, projectId);
        const graphAvailable = Boolean(
          activeSnapshot &&
          activeSnapshot.state === "active" &&
          (await graphSnapshotIsCurrent(
            tx,
            projectId,
            activeSnapshot.sourceManifest,
          )) &&
          graphSnapshotCoversWorkspaceSources(
            activeSnapshot.sourceManifest,
            workspaceSourceManifest,
          ),
        );
        frozenRetrieval = {
          strategy: "auto",
          sourceIds,
          snapshotId:
            graphAvailable && activeSnapshot ? activeSnapshot.snapshotId : null,
        };
      }

      const [run] = await tx
        .insert(schema.runs)
        .values({
          projectId,
          promptVersionId: parsed.data.promptVersionId,
          providerConnectionId: connection?.id ?? null,
          purpose: parsed.data.purpose,
          provider: parsed.data.provider,
          requestedModel: parsed.data.requestedModel,
          configSnapshot: {
            runIntent: parsed.data.intent,
            retrieval: frozenRetrieval,
            ...(parsed.data.reasoningEffort !== undefined
              ? { reasoningEffort: parsed.data.reasoningEffort }
              : {}),
            ...(optimizerModel ? { optimizerModel } : {}),
            ...(parsed.data.optimization
              ? { optimization: parsed.data.optimization }
              : {}),
            ...(parsed.data.controlledEvaluation
              ? { controlledEvaluation: parsed.data.controlledEvaluation }
              : {}),
            ...(workspaceSourceManifest ? { workspaceSourceManifest } : {}),
            ...(parsed.data.workspaceChat
              ? {
                  workspaceChat: parsed.data.workspaceChat,
                  workspaceChatTarget,
                }
              : {}),
            ...(parsed.data.workspaceFileDraft
              ? { workspaceFileDraft: parsed.data.workspaceFileDraft }
              : {}),
          },
          status,
          idempotencyKey: parsed.data.idempotencyKey,
          errorCode,
          errorSummary,
        })
        .returning({
          id: schema.runs.id,
          status: schema.runs.status,
          purpose: schema.runs.purpose,
          provider: schema.runs.provider,
          requestedModel: schema.runs.requestedModel,
          createdAt: schema.runs.createdAt,
        });
      if (!run) throw new Error("Run insert returned no row");
      const payload = ready
        ? {
            status,
            provider: parsed.data.provider,
            requestedModel: parsed.data.requestedModel,
            ...(parsed.data.reasoningEffort !== undefined
              ? { reasoningEffort: parsed.data.reasoningEffort }
              : {}),
          }
        : {
            status,
            provider: parsed.data.provider,
            requestedModel: parsed.data.requestedModel,
            reason: errorCode,
          };
      await tx.insert(schema.runEvents).values({
        projectId,
        runId: run.id,
        sequence: 1,
        eventType: "run.status",
        payload,
      });
      if (ready) {
        await tx.insert(schema.outbox).values({
          projectId,
          aggregateId: run.id,
          eventType: "run.enqueue",
          payload: { projectId, runId: run.id },
        });
      }
      return { conflict: false as const, created: true, run };
    });
    if ("sourceManifestError" in result) {
      const error =
        result.sourceManifestError === "source_permission_not_granted"
          ? "RETRIEVAL_SOURCE_PERMISSION_REQUIRED"
          : result.sourceManifestError ===
              "source_selection_not_current_in_project"
            ? "RETRIEVAL_SOURCE_NOT_FOUND"
            : result.sourceManifestError === "graph_snapshot_source_mismatch"
              ? "GRAPH_SNAPSHOT_SOURCE_MISMATCH"
              : "GRAPH_SNAPSHOT_NOT_CURRENT";
      return Response.json(
        {
          error,
          message:
            "Sumber berubah atau izinnya tidak lagi memenuhi syarat saat run dibuat. Perbarui pilihan sumber lalu coba lagi.",
        },
        { status: 409 },
      );
    }
    if (result.conflict)
      return Response.json(
        { error: "IDEMPOTENCY_KEY_CONFLICT" },
        { status: 409 },
      );
    return Response.json(
      { run: result.run },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505") {
      try {
        const [existing] = await database.db
          .select({
            id: schema.runs.id,
            status: schema.runs.status,
            promptVersionId: schema.runs.promptVersionId,
            provider: schema.runs.provider,
            requestedModel: schema.runs.requestedModel,
            configSnapshot: schema.runs.configSnapshot,
          })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.projectId, projectId),
              eq(schema.runs.idempotencyKey, parsed.data.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing && matchesExistingRequest?.(existing)) {
          return Response.json(
            { run: { id: existing.id, status: existing.status } },
            { status: 200 },
          );
        }
        if (existing)
          return Response.json(
            { error: "IDEMPOTENCY_KEY_CONFLICT" },
            { status: 409 },
          );
      } catch {
        return safeApiFailure(409);
      }
      return safeApiFailure(409);
    }
    return safeApiFailure();
  }
}
