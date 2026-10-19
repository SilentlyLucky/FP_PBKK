import { aggregateUsageProvenance } from "@promptlab/providers/usage-provenance";
import {
  CampusChatProvider,
  ProviderRequestError,
} from "@promptlab/providers/campus";
import {
  campusCapabilityCampaignMatchesConfiguration,
  campusCapabilitiesFromSnapshot,
  campusCredentialFingerprint,
  campusVerificationMatchesConfiguration,
  campusVerificationFailureMessage,
  createCampusFailureSnapshot,
  createCampusVerificationSnapshot,
  unknownCampusCapabilities,
} from "@promptlab/providers/campus-verification";
import {
  CAPABILITY_CAMPAIGN_INFERENCE_CALLS,
  campaignCapabilityEvidence,
  makeCapabilityCampaign,
  type CapabilityEvidence,
  type CapabilityCampaign,
  type CapabilityName,
} from "@promptlab/providers/capability-campaign";
import {
  isProviderVerificationCampaignConfigured,
  recordInferenceOutcome,
  reserveInferenceCall,
  reserveInferenceCalls,
} from "@promptlab/providers/provider-smoke-ledger";
import {
  CodexProviderError,
  codexConfigurationFingerprint,
  codexUsageObservationStatus,
  codexVerificationReceipt,
  connectCodexAppServer,
  executeCodexTurn,
  listCodexModels,
  readCodexAccount,
} from "@promptlab/providers/codex";
import { schema, type Database } from "@promptlab/db";
import {
  CapabilityEvidenceSchema,
  type ProviderConnectionState,
  type ProviderCompletion,
} from "@promptlab/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { databaseOrUnavailable } from "@/lib/api";
import {
  codexLoginStatus,
  codexReceiptMatchesRuntime,
  inspectCodexRuntime,
  startCodexLogin,
  type CodexRuntimeSnapshot,
} from "@/lib/codex-runtime";
import { isSelectedCodexModelVerified } from "@/lib/provider-settings-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAMPUS_ENDPOINT_LABEL =
  "Gateway kampus · OpenAI-compatible chat completions";
const CAMPUS_ROLES = ["optimizer", "auxiliary"] as const;
type CampusRole = (typeof CAMPUS_ROLES)[number];

interface CampusEnvironment {
  apiKey: string | null;
  requestedModel: string | null;
}

interface CampusConnectionRow {
  projectId: string;
  role: string;
  connectionStatus: string;
  requestedModel: string | null;
  responseModel: string | null;
  capabilitySnapshot: unknown;
  checkedAt: Date | null;
}

interface CampusProjectRow {
  id: string;
}

type ProjectPrerequisite = "satisfied" | "missing" | "unknown";

interface PersistedProviderRow extends CampusConnectionRow {
  provider: string;
  projectId: string;
}

function campusEnvironment(): CampusEnvironment {
  return {
    apiKey: process.env.PROMPTLAB_CAMPUS_API_KEY?.trim() || null,
    requestedModel: process.env.PROMPTLAB_CAMPUS_MODEL?.trim() || null,
  };
}

function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

function recordSnapshotMatches(
  row: CampusConnectionRow,
  environment: CampusEnvironment,
): boolean {
  if (!environment.apiKey || !environment.requestedModel) return false;
  if (
    row.connectionStatus !== "verified" ||
    row.requestedModel !== environment.requestedModel
  ) {
    return false;
  }

  return (
    campusVerificationMatchesConfiguration(row.capabilitySnapshot, {
      apiKey: environment.apiKey,
      requestedModel: environment.requestedModel,
    }) &&
    isRecord(row.capabilitySnapshot) &&
    isRecord(row.capabilitySnapshot.verification) &&
    row.capabilitySnapshot.verification.responseModel === row.responseModel
  );
}

function checkedAtForRows(
  rows: CampusConnectionRow[],
  verified: boolean,
): string | null {
  const timestamps = rows
    .map((row) => row.checkedAt?.getTime())
    .filter((value): value is number => value !== undefined);
  if (!timestamps.length) return null;
  return new Date(
    verified ? Math.min(...timestamps) : Math.max(...timestamps),
  ).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentFailureCode(snapshot: unknown): string | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.verification)) return null;
  return typeof snapshot.verification.failureCode === "string"
    ? snapshot.verification.failureCode
    : null;
}

function campusState(
  role: CampusRole,
  environment: CampusEnvironment,
  projects: CampusProjectRow[],
  connections: CampusConnectionRow[],
  databaseAvailable: boolean,
): ProviderConnectionState {
  const roleRows = connections.filter((row) => row.role === role);
  const configurationAvailable =
    Boolean(environment.apiKey) && Boolean(environment.requestedModel);
  const everyProjectVerified =
    configurationAvailable &&
    databaseAvailable &&
    projects.length > 0 &&
    projects.every((project) => {
      const projectRows = roleRows.filter(
        (row) => row.projectId === project.id,
      );
      return (
        projectRows.length > 0 &&
        projectRows.every((row) => recordSnapshotMatches(row, environment))
      );
    });
  const responseModels = new Set(
    roleRows
      .filter((row) => recordSnapshotMatches(row, environment))
      .map((row) => row.responseModel),
  );
  const sameResponseModel = responseModels.size <= 1;
  const verified = everyProjectVerified && sameResponseModel;
  const firstCurrentRow = roleRows.find((row) =>
    recordSnapshotMatches(row, environment),
  );
  const campaignRow = roleRows.find(
    (row) =>
      row.requestedModel === environment.requestedModel &&
      Boolean(environment.apiKey) &&
      campusCapabilityCampaignMatchesConfiguration(row.capabilitySnapshot, {
        apiKey: environment.apiKey ?? "",
        requestedModel: environment.requestedModel ?? "",
      }),
  );
  const campaignCapabilities = campaignRow
    ? campusCapabilitiesFromSnapshot(campaignRow.capabilitySnapshot)
    : null;

  let reason: string;
  if (!configurationAvailable) {
    reason =
      "Credential dan model kampus belum tersedia pada environment server. Secret tidak ditampilkan.";
  } else if (!databaseAvailable) {
    reason =
      "Database provider tidak tersedia. Verifikasi belum dapat disimpan.";
  } else if (projects.length === 0) {
    reason =
      "Belum ada proyek aktif untuk menyimpan koneksi. Buat proyek sebelum memverifikasi provider.";
  } else if (verified) {
    reason =
      "Request chat non-streaming berhasil dan bukti tersimpan untuk konfigurasi server saat ini.";
  } else if (
    roleRows.some(
      (row) =>
        row.connectionStatus === "verified" &&
        !recordSnapshotMatches(row, environment),
    )
  ) {
    reason =
      "Model atau credential berubah sejak verifikasi terakhir. Verifikasi koneksi kembali.";
  } else {
    const failedRow = [...roleRows]
      .filter((row) => row.connectionStatus !== "verified")
      .sort(
        (left, right) =>
          (right.checkedAt?.getTime() ?? 0) - (left.checkedAt?.getTime() ?? 0),
      )[0];
    const failureCode = currentFailureCode(failedRow?.capabilitySnapshot);
    reason = failedRow
      ? campusVerificationFailureMessage(
          failureCode as Parameters<typeof campusVerificationFailureMessage>[0],
        )
      : "Koneksi belum memiliki bukti runtime. Pilih Verifikasi koneksi untuk mengirim satu request terbatas.";
  }

  return {
    provider: "campus_gateway",
    role,
    status: !configurationAvailable
      ? "unavailable"
      : verified
        ? "verified"
        : "configured_unverified",
    requestedModel: environment.requestedModel,
    responseModel:
      verified && sameResponseModel
        ? (firstCurrentRow?.responseModel ?? null)
        : null,
    endpointLabel: CAMPUS_ENDPOINT_LABEL,
    checkedAt: checkedAtForRows(roleRows, verified),
    reason,
    capabilities:
      campaignCapabilities ??
      (verified
        ? (campusCapabilitiesFromSnapshot(
            firstCurrentRow?.capabilitySnapshot,
          ) ?? unknownCampusCapabilities("Bukti capability tidak dapat dibaca."))
        : unknownCampusCapabilities(
            "Belum diamati oleh request provider yang berhasil untuk konfigurasi ini.",
          )),
  };
}

function fixedProviderStates(
  campus: ProviderConnectionState[],
  codex: ProviderConnectionState,
): ProviderConnectionState[] {
  const unknown = unknownCampusCapabilities(
    "Belum diuji pada request provider yang berhasil.",
  );
  return [
    ...campus,
    codex,
    {
      provider: "claude_cli",
      role: "optimizer",
      status: "blocked",
      requestedModel: null,
      responseModel: null,
      endpointLabel: "Claude CLI",
      checkedAt: null,
      reason:
        "Gate teknis/ketentuan belum dijalankan. Gunakan jalur manual sampai verifikasi selesai.",
      capabilities: unknown,
    },
  ];
}

async function providerStates(
  db: Database,
  environment: CampusEnvironment,
  runtime?: CodexRuntimeSnapshot,
  activeProjects?: CampusProjectRow[],
): Promise<ProviderConnectionState[]> {
  const codexRuntime = runtime ?? (await inspectCodexRuntime());
  const projects =
    activeProjects ??
    (await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(isNull(schema.projects.deletedAt)));
  const connections = projects.length
    ? await db
        .select({
          projectId: schema.providerConnections.projectId,
          provider: schema.providerConnections.provider,
          role: schema.providerConnections.role,
          connectionStatus: schema.providerConnections.connectionStatus,
          requestedModel: schema.providerConnections.requestedModel,
          responseModel: schema.providerConnections.responseModel,
          capabilitySnapshot: schema.providerConnections.capabilitySnapshot,
          checkedAt: schema.providerConnections.checkedAt,
        })
        .from(schema.providerConnections)
        .where(
          and(
            inArray(schema.providerConnections.provider, [
              "campus_gateway",
              "codex_app_server",
            ]),
            inArray(schema.providerConnections.role, [
              ...CAMPUS_ROLES,
              "target",
            ]),
            inArray(
              schema.providerConnections.projectId,
              projects.map((project) => project.id),
            ),
          ),
        )
    : [];

  const projectRows = projects.map((project) => ({ id: project.id }));
  const connectionRows: PersistedProviderRow[] = connections.map((row) => ({
    ...row,
    capabilitySnapshot: row.capabilitySnapshot as unknown,
  }));
  return fixedProviderStates(
    CAMPUS_ROLES.map((role) =>
      campusState(
        role,
        environment,
        projectRows,
        connectionRows.filter((row) => row.provider === "campus_gateway"),
        true,
      ),
    ),
    codexState(projectRows, connectionRows, codexRuntime),
  );
}

function unavailableProviderStates(
  environment: CampusEnvironment,
): ProviderConnectionState[] {
  return fixedProviderStates(
    CAMPUS_ROLES.map((role) => campusState(role, environment, [], [], false)),
    {
      provider: "codex_app_server",
      role: "target",
      status: "unavailable",
      requestedModel: null,
      responseModel: null,
      endpointLabel: "Codex CLI · app-server stdio",
      checkedAt: null,
      reason:
        "Database provider tidak tersedia. Codex belum dapat diverifikasi.",
      capabilities: codexCapabilities(null, false),
    },
  );
}

type ProviderCapabilityEvidence =
  ProviderConnectionState["capabilities"][string];

function codexCapabilities(
  verification: Record<string, unknown> | null,
  verified: boolean,
  campaignCapabilities: ProviderConnectionState["capabilities"] | null = null,
): ProviderConnectionState["capabilities"] {
  if (campaignCapabilities) return campaignCapabilities;
  const usage =
    verified && isRecord(verification?.usage) ? verification.usage : null;
  const checkedAt =
    verified && typeof verification?.checkedAt === "string"
      ? verification.checkedAt
      : null;
  const adapterVersion =
    verified && typeof verification?.adapterVersion === "string"
      ? verification.adapterVersion
      : null;
  const isReportedCount = (name: string): boolean => {
    const value = usage?.[name];
    return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
  };
  const usageFields = [
    isReportedCount("inputTokens") ? `token input ${usage?.inputTokens}` : null,
    isReportedCount("outputTokens")
      ? `token output ${usage?.outputTokens}`
      : null,
  ].filter((field): field is string => field !== null);
  const evidence = (
    status: ProviderCapabilityEvidence["status"],
    name: string,
    reason: string,
  ): ProviderCapabilityEvidence => ({
    status,
    checkedAt,
    adapterVersion,
    evidenceRef:
      name === "native-tools"
        ? "codex:promptlab-bounded-native-policy"
        : checkedAt
          ? `codex:${name}`
          : null,
    reason,
  });
  const observed = (
    condition: boolean,
    name: string,
    supportedReason: string,
    unknownReason: string,
    unverifiedReason: string,
  ): ProviderCapabilityEvidence =>
    evidence(
      condition ? "supported" : "unknown",
      name,
      condition
        ? supportedReason
        : verified
          ? unknownReason
          : unverifiedReason,
    );

  return {
    streamText: observed(
      verified && verification?.streamObserved === true,
      "stream",
      "Codex app-server mengirim event text delta selama request verifikasi ini.",
      "Request verifikasi selesai tanpa event text delta; satu request ini tidak cukup untuk menyimpulkan bahwa streaming tidak didukung.",
      "Belum ada request Codex yang selesai untuk mengamati event text delta.",
    ),
    reportedUsage: observed(
      usageFields.length > 0,
      "usage",
      `Codex app-server melaporkan ${usageFields.join(" dan ")} pada request verifikasi ini.`,
      "App-server tidak melaporkan inputTokens atau outputTokens pada request ini; dukungan usage tetap belum diketahui.",
      "Belum ada request sukses untuk mengamati bidang inputTokens atau outputTokens.",
    ),
    cacheReadReporting: observed(
      isReportedCount("cachedInputTokens"),
      "cache-read",
      `App-server melaporkan cachedInputTokens=${usage?.cachedInputTokens}. Request tunggal ini tidak menguji cache hit dengan input berulang.`,
      "Verifikasi tidak mengulang input untuk membuat cache hit, dan tidak ada cachedInputTokens yang dilaporkan; dukungan laporan cache read tetap belum diketahui.",
      "Probe ini tidak mengulang input untuk cache hit; belum ada nilai cachedInputTokens yang diamati.",
    ),
    cacheWriteReporting: observed(
      isReportedCount("cacheWriteInputTokens"),
      "cache-write",
      `App-server melaporkan cacheWriteInputTokens=${usage?.cacheWriteInputTokens}. Request tunggal ini tidak menguji perilaku cache write berulang.`,
      "Verifikasi tidak menguji workload cache write berulang, dan tidak ada cacheWriteInputTokens yang dilaporkan; dukungannya tetap belum diketahui.",
      "Probe ini tidak menguji workload cache berulang; belum ada nilai cacheWriteInputTokens yang diamati.",
    ),
    cancellation: evidence(
      "unknown",
      "local-cancellation",
      "Verifikasi membiarkan request selesai; pembatalan lokal tidak diuji agar satu smoke request tidak berubah menjadi pengujian gangguan.",
    ),
    remoteCancellation: evidence(
      "unknown",
      "remote-cancellation",
      "Verifikasi tidak mengirim turn/interrupt; pembatalan remote tidak diuji.",
    ),
    structuredOutput: evidence(
      verified && verification?.structuredOutputObserved === true
        ? "supported"
        : "unknown",
      "output-schema",
      verified && verification?.structuredOutputObserved === true
        ? "Respons request verifikasi cocok dengan schema ketat { answer: string } yang dikirim ke Codex app-server."
        : verified && verification?.structuredOutputObserved === false
          ? "Request memakai schema { answer: string }, tetapi respons tidak cocok dengan object tersebut; dukungan structured output belum dapat dikonfirmasi."
          : verified
            ? "Receipt ini tidak mencatat validasi schema output; dukungan structured output belum diketahui."
            : "Belum ada respons sukses yang diperiksa terhadap schema { answer: string }.",
    ),
    toolCalls: evidence(
      "policy_restricted",
      "native-tools",
      "PromptLab menerapkan profil bounded-native dan menolak permintaan native tool atau approval. Ini adalah pembatasan kebijakan PromptLab, bukan bukti bahwa Codex tidak mendukung tool calls.",
    ),
    quotaReporting: evidence(
      "unknown",
      "quota",
      "Request verifikasi tidak meminta informasi kuota dan tidak mengirim probe tambahan; dukungan pelaporan kuota belum diketahui.",
    ),
  };
}

const PROVIDER_CAPABILITY_NAMES: CapabilityName[] = [
  "streamText",
  "reportedUsage",
  "cacheReadReporting",
  "cacheWriteReporting",
  "cancellation",
  "remoteCancellation",
  "structuredOutput",
  "toolCalls",
  "quotaReporting",
];

function codexCampaignCapabilities(
  snapshot: unknown,
  requestedModel: string,
  runtime: CodexRuntimeSnapshot,
): ProviderConnectionState["capabilities"] | null {
  if (
    runtime.status !== "ready" ||
    !isRecord(snapshot) ||
    !isRecord(snapshot.capabilityCampaign)
  ) {
    return null;
  }
  const campaign = snapshot.capabilityCampaign;
  if (
    campaign.schemaVersion !== 1 ||
    campaign.provider !== "codex_app_server" ||
    campaign.requestedModel !== requestedModel ||
    campaign.configurationFingerprint !==
      codexConfigurationFingerprint(requestedModel) ||
    campaign.accountFingerprint !== runtime.account.identityFingerprint ||
    campaign.codexHomeFingerprint !== runtime.codexHomeFingerprint ||
    !isRecord(campaign.capabilities)
  ) {
    return null;
  }
  const capabilities: ProviderConnectionState["capabilities"] = {};
  for (const name of PROVIDER_CAPABILITY_NAMES) {
    const parsed = CapabilityEvidenceSchema.safeParse(
      campaign.capabilities[name],
    );
    if (!parsed.success) return null;
    capabilities[name] = parsed.data;
  }
  return capabilities;
}

function codexState(
  projects: CampusProjectRow[],
  rows: PersistedProviderRow[],
  runtime: CodexRuntimeSnapshot,
): ProviderConnectionState {
  const codexRows = rows.filter(
    (row) => row.provider === "codex_app_server" && row.role === "target",
  );
  const requestedModel =
    codexRows.find((row) => row.requestedModel)?.requestedModel ?? null;
  const currentRows = codexRows.filter(
    (row) => row.requestedModel === requestedModel,
  );
  const verified =
    runtime.status === "ready" &&
    Boolean(requestedModel) &&
    projects.length > 0 &&
    projects.every((project) => {
      const row = currentRows.find(
        (candidate) => candidate.projectId === project.id,
      );
      return Boolean(
        row &&
        row.connectionStatus === "verified" &&
        row.responseModel === requestedModel &&
        codexReceiptMatchesRuntime(
          row.capabilitySnapshot,
          requestedModel!,
          runtime,
        ),
      );
    });
  const receiptRow = currentRows.find(
    (row) => row.connectionStatus === "verified",
  );
  const verification =
    isRecord(receiptRow?.capabilitySnapshot) &&
    isRecord(receiptRow.capabilitySnapshot.codexVerification)
      ? receiptRow.capabilitySnapshot.codexVerification
      : null;
  const campaignRow =
    runtime.status === "ready" && requestedModel
      ? currentRows.find(
          (row) =>
            codexCampaignCapabilities(
              row.capabilitySnapshot,
              requestedModel,
              runtime,
            ) !== null,
        )
      : undefined;
  const campaignCapabilities = campaignRow
    ? codexCampaignCapabilities(
        campaignRow.capabilitySnapshot,
        requestedModel ?? "",
        runtime,
      )
    : null;
  const capabilities = codexCapabilities(
    verification,
    verified,
    campaignCapabilities,
  );

  let reason: string;
  if (runtime.status === "unavailable") reason = runtime.reason;
  else if (
    runtime.status === "not_logged_in" ||
    runtime.status === "unsupported_account"
  ) {
    reason = runtime.reason;
  } else if (projects.length === 0) {
    reason =
      "Buat proyek terlebih dahulu agar verifikasi Codex dapat disimpan.";
  } else if (!requestedModel) {
    reason = "Pilih model yang tersedia lalu jalankan Verifikasi Codex.";
  } else if (!runtime.models.some((model) => model.id === requestedModel)) {
    reason = "Model tersimpan tidak tersedia pada akun Codex saat ini.";
  } else if (verified) {
    reason =
      verification?.streamObserved === true
        ? "ChatGPT subscription, model efektif, streaming, dan kebijakan bounded-native telah diverifikasi."
        : "ChatGPT subscription, model efektif, dan kebijakan bounded-native telah diverifikasi; event streaming tidak teramati pada smoke.";
  } else {
    reason =
      "Login aktif. Jalankan satu smoke kecil untuk mengaktifkan target Workshop.";
  }
  const responseModels = new Set(
    currentRows
      .filter((row) => row.connectionStatus === "verified")
      .map((row) => row.responseModel),
  );
  return {
    provider: "codex_app_server",
    role: "target",
    status:
      runtime.status === "unavailable"
        ? "unavailable"
        : verified
          ? "verified"
          : "configured_unverified",
    requestedModel,
    responseModel:
      verified && responseModels.size === 1
        ? ([...responseModels][0] ?? null)
        : null,
    endpointLabel: "Codex CLI · app-server stdio",
    checkedAt:
      verified && typeof verification?.checkedAt === "string"
        ? verification.checkedAt
        : campaignRow?.checkedAt?.toISOString() ?? null,
    reason,
    capabilities,
  };
}

async function saveCampusReceipt(
  db: Database,
  projectIds: string[],
  values: {
    requestedModel: string;
    responseModel: string | null;
    status: "verified" | "configured_unverified";
    checkedAt: Date;
    snapshot: Record<string, unknown>;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    for (const projectId of projectIds) {
      for (const role of CAMPUS_ROLES) {
        const conditions = and(
          eq(schema.providerConnections.projectId, projectId),
          eq(schema.providerConnections.provider, "campus_gateway"),
          eq(schema.providerConnections.role, role),
        );
        const existing = await transaction
          .select({ id: schema.providerConnections.id })
          .from(schema.providerConnections)
          .where(conditions);
        const connectionValues = {
          provider: "campus_gateway" as const,
          role,
          authKind: "environment_bearer",
          secretRef: null,
          endpointLabel: CAMPUS_ENDPOINT_LABEL,
          requestedModel: values.requestedModel,
          responseModel: values.responseModel,
          connectionStatus: values.status,
          capabilitySnapshot: values.snapshot,
          checkedAt: values.checkedAt,
        };
        if (existing.length) {
          await transaction
            .update(schema.providerConnections)
            .set(connectionValues)
            .where(conditions);
        } else {
          await transaction.insert(schema.providerConnections).values({
            projectId,
            ...connectionValues,
          });
        }
      }
    }
  });
}

async function saveCodexReceipt(
  db: Database,
  projectIds: string[],
  values: {
    requestedModel: string;
    responseModel: string | null;
    status: "verified" | "configured_unverified";
    checkedAt: Date;
    snapshot: Record<string, unknown>;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    for (const projectId of projectIds) {
      const conditions = and(
        eq(schema.providerConnections.projectId, projectId),
        eq(schema.providerConnections.provider, "codex_app_server"),
        eq(schema.providerConnections.role, "target"),
      );
      const existing = await transaction
        .select({ id: schema.providerConnections.id })
        .from(schema.providerConnections)
        .where(conditions);
      const connectionValues = {
        provider: "codex_app_server" as const,
        role: "target" as const,
        authKind: "official_cli",
        secretRef: null,
        endpointLabel: "Codex CLI · app-server stdio",
        requestedModel: values.requestedModel,
        responseModel: values.responseModel,
        connectionStatus: values.status,
        capabilitySnapshot: values.snapshot,
        checkedAt: values.checkedAt,
      };
      if (existing.length) {
        await transaction
          .update(schema.providerConnections)
          .set(connectionValues)
          .where(conditions);
      } else {
        await transaction.insert(schema.providerConnections).values({
          projectId,
          ...connectionValues,
        });
      }
    }
  });
}

async function saveCapabilityCampaign(
  db: Database,
  provider: "campus_gateway" | "codex_app_server",
  projectIds: string[],
  requestedModel: string,
  campaign: CapabilityCampaign & Record<string, unknown>,
  baseVerification?: Record<string, unknown>,
): Promise<void> {
  const roles = provider === "campus_gateway" ? CAMPUS_ROLES : ["target"];
  await db.transaction(async (transaction) => {
    for (const projectId of projectIds) {
      for (const role of roles) {
        const conditions = and(
          eq(schema.providerConnections.projectId, projectId),
          eq(schema.providerConnections.provider, provider),
          eq(schema.providerConnections.role, role),
        );
        const existing = await transaction
          .select({
            id: schema.providerConnections.id,
            connectionStatus: schema.providerConnections.connectionStatus,
            requestedModel: schema.providerConnections.requestedModel,
            responseModel: schema.providerConnections.responseModel,
            capabilitySnapshot: schema.providerConnections.capabilitySnapshot,
          })
          .from(schema.providerConnections)
          .where(conditions);
        const old = existing[0];
        const oldSnapshot = isRecord(old?.capabilitySnapshot)
          ? old.capabilitySnapshot
          : {};
        const verificationSnapshot = baseVerification ?? {};
        const snapshot = {
          ...oldSnapshot,
          ...verificationSnapshot,
          capabilityCampaign: campaign,
        };
        const newCampusVerification = isRecord(verificationSnapshot.verification)
          ? verificationSnapshot.verification
          : null;
        const newCodexVerification = isRecord(
          verificationSnapshot.codexVerification,
        )
          ? verificationSnapshot.codexVerification
          : null;
        const newlyVerified =
          newCampusVerification?.status === "verified" ||
          newCodexVerification?.status === "verified";
        const keepVerifiedReceipt =
          old?.connectionStatus === "verified" &&
          old.requestedModel === requestedModel;
        const responseModel =
          typeof newCampusVerification?.responseModel === "string" ||
          newCampusVerification?.responseModel === null
            ? newCampusVerification.responseModel
            : typeof newCodexVerification?.responseModel === "string"
              ? newCodexVerification.responseModel
              : keepVerifiedReceipt
                ? old.responseModel
                : null;
        const connectionValues = {
          provider,
          role,
          authKind:
            provider === "campus_gateway" ? "environment_bearer" : "official_cli",
          secretRef: null,
          endpointLabel:
            provider === "campus_gateway"
              ? CAMPUS_ENDPOINT_LABEL
              : "Codex CLI · app-server stdio",
          requestedModel,
          responseModel,
          connectionStatus: newlyVerified || keepVerifiedReceipt
            ? "verified"
            : "configured_unverified",
          capabilitySnapshot: snapshot,
          checkedAt: new Date(campaign.checkedAt),
        };
        if (old) {
          await transaction
            .update(schema.providerConnections)
            .set(connectionValues)
            .where(conditions);
        } else {
          await transaction.insert(schema.providerConnections).values({
            projectId,
            ...connectionValues,
          });
        }
      }
    }
  });
}

async function recordLedgerOutcome(
  outcome: Parameters<typeof recordInferenceOutcome>[1],
): Promise<boolean> {
  if (!isProviderVerificationCampaignConfigured()) return false;
  try {
    await recordInferenceOutcome("campus_gateway", outcome);
    return true;
  } catch {
    return false;
  }
}

async function recordCodexLedgerOutcome(
  outcome: Parameters<typeof recordInferenceOutcome>[1],
): Promise<boolean> {
  if (!isProviderVerificationCampaignConfigured()) return false;
  try {
    await recordInferenceOutcome("codex_app_server", outcome);
    return true;
  } catch {
    return false;
  }
}

function failureCode(
  error: unknown,
):
  | "AUTH_REQUIRED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ABORTED"
  | "PROVIDER_ERROR" {
  return error instanceof ProviderRequestError ? error.code : "PROVIDER_ERROR";
}

function capabilityEvidence(
  provider: "campus_gateway" | "codex_app_server",
  name: CapabilityName,
  status: CapabilityEvidence["status"],
  checkedAt: string,
  reason: string,
): CapabilityEvidence {
  return campaignCapabilityEvidence({
    provider,
    name,
    status,
    checkedAt,
    reason,
  });
}

function structuredProbeOutputIsValid(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return (
      isRecord(value) &&
      Object.keys(value).length === 1 &&
      typeof value.answer === "string" &&
      value.answer.trim().length > 0
    );
  } catch {
    return false;
  }
}

function campusStreamAsCompletion(
  result: Awaited<
    ReturnType<CampusChatProvider["streamCapabilityProbe"]>
  >,
  requestedModel: string,
  checkedAt: string,
): ProviderCompletion {
  const reported = (
    value: number | undefined,
    method: string,
  ): ProviderCompletion["usage"]["inputTokens"] =>
    value === undefined
      ? {
          status: "unknown",
          value: null,
          reason: "Gateway tidak melaporkan bidang token ini pada probe kampanye.",
        }
      : { status: "reported", value, observedAt: checkedAt, method };
  const metrics = [
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cacheReadTokens,
    result.usage.cacheWriteTokens,
  ];
  const present = metrics.filter((value) => value !== undefined).length;
  return {
    provider: "campus_gateway",
    requestedModel,
    responseModel: result.responseModel,
    responseId: null,
    text: result.text,
    observedAt: checkedAt,
    usage: {
      inputTokens: reported(
        result.usage.inputTokens,
        "campaign stream usage.prompt_tokens",
      ),
      outputTokens: reported(
        result.usage.outputTokens,
        "campaign stream usage.completion_tokens",
      ),
      cacheReadTokens: reported(
        result.usage.cacheReadTokens,
        "campaign stream usage.prompt_tokens_details.cached_tokens",
      ),
      cacheWriteTokens: reported(
        result.usage.cacheWriteTokens,
        "campaign stream usage.completion_tokens_details.cache_write_tokens",
      ),
      completeness:
        present === metrics.length
          ? "complete"
          : present === 0
            ? "unknown"
            : "partial",
      responseId: null,
      mapperVersion: "campus-openai-compatible-v1",
    },
  };
}

function campaignProbeErrorCode(error: unknown): string {
  if (error instanceof ProviderRequestError) return error.code;
  if (error instanceof CodexProviderError) return error.code;
  return "PROBE_ERROR";
}

function campaignResponseStatus(status: CapabilityCampaign["status"]): number {
  return status === "blocked" ? 409 : 200;
}

async function runCampusCapabilityCampaign(
  body: Record<string, unknown>,
): Promise<Response> {
  if (
    body.action !== "campus-capability-campaign" ||
    Object.keys(body).length !== 1
  ) {
    return noStoreJson(
      { outcome: "invalid_request", message: "Kampanye Gateway Kampus tidak valid." },
      { status: 400 },
    );
  }

  const environment = campusEnvironment();
  const requestedModel = environment.requestedModel ?? "not configured";
  const checkedAt = new Date().toISOString();
  const database = databaseOrUnavailable();
  const db = "response" in database ? null : database.db;
  let projects: CampusProjectRow[] = [];
  if (db) {
    projects = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(isNull(schema.projects.deletedAt))
      .catch(() => []);
  }

  const blocked = async (reason: string, httpStatus: number) => {
    const campaign = makeCapabilityCampaign({
      provider: "campus_gateway",
      requestedModel,
      checkedAt,
      attemptedInferenceCalls: 0,
      status: "blocked",
      reason,
      blockedReason: reason,
    });
    const campaignReceipt = environment.apiKey
      ? {
          ...campaign,
          credentialFingerprint: campusCredentialFingerprint(environment.apiKey),
        }
      : null;
    if (db && projects.length && campaignReceipt) {
      await saveCapabilityCampaign(
        db,
        "campus_gateway",
        projects.map(({ id }) => id),
        requestedModel,
        campaignReceipt as CapabilityCampaign & Record<string, unknown>,
      ).catch(() => undefined);
    }
    const providers = db
      ? await providerStates(db, environment, undefined, projects).catch(() =>
          unavailableProviderStates(environment),
        )
      : unavailableProviderStates(environment);
    return noStoreJson(
      {
        outcome: "capability_campaign_blocked",
        message: reason,
        campaign,
        providers,
      },
      { status: httpStatus },
    );
  };

  if (!db)
    return blocked(
      "Database tidak tersedia. Semua probe ditandai diblokir; tidak ada request inference yang dikirim.",
      503,
    );
  if (!projects.length)
    return blocked(
      "Belum ada proyek aktif untuk menyimpan receipt. Semua probe ditandai diblokir; tidak ada request inference yang dikirim.",
      409,
    );
  if (!environment.apiKey || !environment.requestedModel)
    return blocked(
      "Credential atau model Gateway Kampus belum dikonfigurasi. Semua probe ditandai diblokir; tidak ada request yang dikirim.",
      409,
    );
  if (!isProviderVerificationCampaignConfigured())
    return blocked(
      `Campaign budget server belum dikonfigurasi. Kampanye memerlukan ${CAPABILITY_CAMPAIGN_INFERENCE_CALLS.campus_gateway} slot request; tidak ada request yang dikirim.`,
      409,
    );

  try {
    await reserveInferenceCalls(
      "campus_gateway",
      CAPABILITY_CAMPAIGN_INFERENCE_CALLS.campus_gateway,
    );
  } catch (error) {
    const isBudgetExhausted =
      error instanceof Error && error.message.includes("cap reached");
    const reason = isBudgetExhausted
      ? `Sisa budget campaign Gateway Kampus kurang dari ${CAPABILITY_CAMPAIGN_INFERENCE_CALLS.campus_gateway} request. Tidak ada probe yang dikirim.`
      : "Safety ledger campaign tidak tersedia. Tidak ada probe yang dikirim.";
    if (isBudgetExhausted)
      await recordLedgerOutcome({ outcome: "blocked_budget_exhausted" });
    return blocked(reason, isBudgetExhausted ? 409 : 503);
  }

  const provider = new CampusChatProvider({ apiKey: environment.apiKey });
  const probeRequest = {
    model: environment.requestedModel,
    purpose: "optimizer" as const,
    maxOutputTokens: 96,
    messages: [
      {
        role: "user" as const,
        content:
          "Return one JSON object with an answer equal to PROMPTLAB CAPABILITY READY.",
      },
    ],
  };
  type StreamResult = Awaited<
    ReturnType<CampusChatProvider["streamCapabilityProbe"]>
  >;
  const streamResults: Array<{ value: StreamResult | null; error: string | null }> =
    [];
  let attemptedInferenceCalls = 0;
  let failedProbes = 0;
  for (let index = 0; index < 2; index += 1) {
    attemptedInferenceCalls += 1;
    try {
      streamResults.push({
        value: await provider.streamCapabilityProbe(probeRequest),
        error: null,
      });
    } catch (error) {
      failedProbes += 1;
      streamResults.push({
        value: null,
        error: campaignProbeErrorCode(error),
      });
    }
  }

  let toolCallObserved: boolean | null = null;
  let toolCallError: string | null = null;
  attemptedInferenceCalls += 1;
  try {
    toolCallObserved = await provider.probeToolCall({
      model: environment.requestedModel,
      purpose: "optimizer",
      maxOutputTokens: 64,
      messages: [
        {
          role: "user",
          content: "Call the provided function with its required confirmation marker.",
        },
      ],
    });
  } catch (error) {
    failedProbes += 1;
    toolCallError = campaignProbeErrorCode(error);
  }

  let cancellationError: string | null = null;
  let cancellationObserved = false;
  attemptedInferenceCalls += 1;
  const cancellation = new AbortController();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = provider.complete(
      {
        model: environment.requestedModel,
        purpose: "optimizer",
        maxOutputTokens: 256,
        messages: [
          {
            role: "user",
            content:
              "Produce a long explanation of why this disposable request may be canceled.",
          },
        ],
      },
      { signal: cancellation.signal },
    );
    cancelTimer = setTimeout(() => cancellation.abort(), 100);
    await pending;
  } catch (error) {
    if (error instanceof ProviderRequestError && error.code === "PROVIDER_ABORTED") {
      cancellationObserved = true;
    } else {
      cancellationError = campaignProbeErrorCode(error);
      failedProbes += 1;
    }
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
  }

  const overrides: Partial<Record<CapabilityName, CapabilityEvidence>> = {};
  const successfulStreams = streamResults.flatMap((probe) =>
    probe.value ? [probe.value] : [],
  );
  const hasTextDelta = successfulStreams.some(
    (probe) => probe.textDeltaObserved,
  );
  const hasStructuredOutput = successfulStreams.some((probe) =>
    structuredProbeOutputIsValid(probe.text),
  );
  const reportsInputAndOutput = successfulStreams.some(
    (probe) =>
      probe.usage.inputTokens !== undefined &&
      probe.usage.outputTokens !== undefined,
  );
  const secondUsage = streamResults[1]?.value?.usage;
  const hasCacheRead = (secondUsage?.cacheReadTokens ?? 0) > 0;
  const hasCacheWrite = successfulStreams.some(
    (probe) => (probe.usage.cacheWriteTokens ?? 0) > 0,
  );
  const set = (
    name: CapabilityName,
    status: CapabilityEvidence["status"],
    reason: string,
  ) => {
    overrides[name] = capabilityEvidence(
      "campus_gateway",
      name,
      status,
      checkedAt,
      reason,
    );
  };

  set(
    "streamText",
    hasTextDelta
      ? "supported"
      : successfulStreams.length
        ? "not_observed"
        : "failed",
    hasTextDelta
      ? "Gateway mengirim delta teks saat request stream berlangsung."
      : successfulStreams.length
        ? "Dua request streaming selesai, tetapi tidak ada delta teks non-kosong yang teramati."
        : `Probe streaming gagal (${streamResults.map((probe) => probe.error).filter(Boolean).join(", ") || "tidak ada respons"}).`,
  );
  set(
    "structuredOutput",
    hasStructuredOutput
      ? "supported"
      : successfulStreams.length
        ? "not_observed"
        : "failed",
    hasStructuredOutput
      ? "Respons streaming cocok dengan JSON schema ketat { answer: string }."
      : successfulStreams.length
        ? "Request memakai JSON schema ketat, tetapi respons tidak cocok dengan bentuk { answer: string }."
        : "Probe JSON schema gagal sebelum respons dapat divalidasi.",
  );
  set(
    "reportedUsage",
    reportsInputAndOutput
      ? "supported"
      : successfulStreams.length
        ? "not_observed"
        : "failed",
    reportsInputAndOutput
      ? "Gateway melaporkan prompt_tokens dan completion_tokens pada request streaming."
      : successfulStreams.length
        ? "Response tidak memuat kedua bidang token input dan output."
        : "Usage tidak dapat diperiksa karena probe streaming gagal.",
  );
  set(
    "cacheReadReporting",
    hasCacheRead
      ? "supported"
      : successfulStreams.length === 2
        ? "not_observed"
        : "failed",
    hasCacheRead
      ? `Request identik kedua melaporkan cached_tokens=${secondUsage?.cacheReadTokens}.`
      : successfulStreams.length === 2
        ? "Request identik kedua tidak melaporkan token cache read positif; cache hit tidak teramati pada percobaan ini."
        : "Cache read tidak dapat diuji karena kedua request identik tidak selesai dengan sukses.",
  );
  set(
    "cacheWriteReporting",
    hasCacheWrite
      ? "supported"
      : successfulStreams.length === 2
        ? "not_observed"
        : "failed",
    hasCacheWrite
      ? "Salah satu response request identik melaporkan cache_write_tokens positif."
      : successfulStreams.length === 2
        ? "Dua response request identik tidak melaporkan cache write token positif; write tidak teramati pada percobaan ini."
        : "Cache write tidak dapat diuji karena kedua request identik tidak selesai dengan sukses.",
  );
  set(
    "toolCalls",
    toolCallObserved === null
      ? "failed"
      : toolCallObserved
        ? "supported"
        : "not_observed",
    toolCallObserved === true
      ? "Gateway mengembalikan forced function call dengan argumen yang cocok schema. PromptLab hanya mengamati dan tidak menjalankan fungsi."
      : toolCallObserved === false
        ? "Request forced function call selesai, tetapi tidak ada pemanggilan fungsi valid yang teramati."
        : `Probe function call gagal (${toolCallError ?? "error tidak diketahui"}). Fungsi tidak pernah dijalankan oleh PromptLab.`,
  );
  set(
    "cancellation",
    cancellationObserved
      ? "supported"
      : cancellationError
        ? "failed"
        : "not_observed",
    cancellationObserved
      ? "AbortSignal lokal membatalkan request fetch dan adapter melaporkan PROVIDER_ABORTED. Ini tidak membuktikan gateway menghentikan pemrosesan remote."
      : cancellationError
        ? `Probe batal lokal gagal (${cancellationError}).`
        : "Response selesai sebelum AbortSignal lokal membatalkan fetch.",
  );
  const status = failedProbes ? "partial" : "completed";
  const campaign = makeCapabilityCampaign({
    provider: "campus_gateway",
    requestedModel: environment.requestedModel,
    checkedAt,
    attemptedInferenceCalls,
    status,
    reason: `${attemptedInferenceCalls} dari ${CAPABILITY_CAMPAIGN_INFERENCE_CALLS.campus_gateway} panggilan dicoba; ${failedProbes} probe gagal. Status tiap capability disimpan terpisah.`,
    overrides,
  });
  const identityStream = successfulStreams.find(
    (probe) =>
      probe.responseModel === environment.requestedModel &&
      structuredProbeOutputIsValid(probe.text),
  );
  const baseVerification = identityStream
    ? (createCampusVerificationSnapshot(
        campusStreamAsCompletion(
          identityStream,
          environment.requestedModel,
          checkedAt,
        ),
        { apiKey: environment.apiKey, checkedAt },
      ) as unknown as Record<string, unknown>)
    : undefined;
  const campaignReceipt = {
    ...campaign,
    credentialFingerprint: campusCredentialFingerprint(environment.apiKey),
  } as CapabilityCampaign & Record<string, unknown>;
  const receiptSaved = await saveCapabilityCampaign(
    db,
    "campus_gateway",
    projects.map(({ id }) => id),
    environment.requestedModel,
    campaignReceipt,
    baseVerification,
  )
    .then(() => true)
    .catch(() => false);
  await recordLedgerOutcome({
    outcome: failedProbes ? "failed" : "succeeded",
    requestedModel: environment.requestedModel,
    capabilitiesObserved: Object.entries(
      campaign.capabilities as Record<string, CapabilityEvidence>,
    ).map(
      ([name, evidence]) => `${name}:${evidence.status}`,
    ),
  });
  const providers = await providerStates(db, environment, undefined, projects).catch(
    () => unavailableProviderStates(environment),
  );
  return noStoreJson(
    {
      outcome: receiptSaved
        ? status === "completed"
          ? "capability_campaign_completed"
          : "capability_campaign_partial"
        : "capability_campaign_receipt_save_failed",
      message: receiptSaved
        ? campaign.reason
        : "Probe selesai, tetapi receipt tidak dapat disimpan. Hasil tersedia hanya pada respons ini.",
      campaign,
      providers,
    },
    { status: receiptSaved ? 200 : 503 },
  );
}

async function runCodexCapabilityCampaign(
  body: Record<string, unknown>,
): Promise<Response> {
  if (
    body.action !== "codex-capability-campaign" ||
    Object.keys(body).length !== 2 ||
    typeof body.model !== "string" ||
    !body.model.trim() ||
    body.model.length > 200
  ) {
    return noStoreJson(
      { outcome: "invalid_request", message: "Kampanye Codex tidak valid." },
      { status: 400 },
    );
  }
  const requestedModel = body.model.trim();
  const checkedAt = new Date().toISOString();
  const database = databaseOrUnavailable();
  const db = "response" in database ? null : database.db;
  const projects = db
    ? await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(isNull(schema.projects.deletedAt))
        .catch(() => [])
    : [];

  const blockedCampaign = (reason: string) =>
    makeCapabilityCampaign({
      provider: "codex_app_server",
      requestedModel,
      checkedAt,
      attemptedInferenceCalls: 0,
      status: "blocked",
      reason,
      blockedReason: reason,
    });
  const respondBlocked = async (
    campaign: CapabilityCampaign,
    httpStatus: number,
    runtime?: CodexRuntimeSnapshot,
    accountFingerprint?: string,
    codexHomeFingerprint?: string,
  ) => {
    let saved = false;
    if (
      db &&
      projects.length &&
      runtime?.status === "ready" &&
      accountFingerprint &&
      codexHomeFingerprint
    ) {
      const receipt = {
        ...campaign,
        configurationFingerprint:
          codexConfigurationFingerprint(requestedModel),
        accountFingerprint,
        codexHomeFingerprint,
      } as CapabilityCampaign & Record<string, unknown>;
      saved = await saveCapabilityCampaign(
        db,
        "codex_app_server",
        projects.map(({ id }) => id),
        requestedModel,
        receipt,
      )
        .then(() => true)
        .catch(() => false);
    }
    const providers = db
      ? await providerStates(db, campusEnvironment(), runtime, projects).catch(() =>
          unavailableProviderStates(campusEnvironment()),
        )
      : unavailableProviderStates(campusEnvironment());
    return noStoreJson(
      {
        outcome: "capability_campaign_blocked",
        message: saved ? campaign.reason : `${campaign.reason}${db && projects.length ? " Receipt belum dapat disimpan." : ""}`,
        campaign,
        providers,
      },
      { status: httpStatus },
    );
  };

  if (!db)
    return respondBlocked(
      blockedCampaign(
        "Database tidak tersedia. Semua probe ditandai diblokir; tidak ada turn inference yang dikirim.",
      ),
      503,
    );
  if (!projects.length)
    return respondBlocked(
      blockedCampaign(
        "Belum ada proyek aktif untuk menyimpan receipt. Semua probe ditandai diblokir; tidak ada turn inference yang dikirim.",
      ),
      409,
    );

  let connected: Awaited<ReturnType<typeof connectCodexAppServer>> | null = null;
  try {
    connected = await connectCodexAppServer();
    const account = await readCodexAccount(
      connected.session,
      connected.codexHomeFingerprint,
    );
    const models = await listCodexModels(connected.session);
    const runtime: CodexRuntimeSnapshot = {
      status: "ready",
      account,
      models,
      codexHomeFingerprint: connected.codexHomeFingerprint,
      isolationPolicyVersion: connected.isolationPolicyVersion,
    };
    if (!models.some((model) => model.id === requestedModel))
      return await respondBlocked(
        blockedCampaign(
          "Model terpilih tidak tersedia pada akun Codex saat ini. Semua probe ditandai diblokir; tidak ada turn inference yang dikirim.",
        ),
        409,
        runtime,
        account.identityFingerprint,
        connected.codexHomeFingerprint,
      );
    if (!isProviderVerificationCampaignConfigured())
      return await respondBlocked(
        blockedCampaign(
          `Campaign budget server belum dikonfigurasi. Kampanye memerlukan ${CAPABILITY_CAMPAIGN_INFERENCE_CALLS.codex_app_server} turn; tidak ada turn inference yang dikirim.`,
        ),
        409,
        runtime,
        account.identityFingerprint,
        connected.codexHomeFingerprint,
      );

    try {
      await reserveInferenceCalls(
        "codex_app_server",
        CAPABILITY_CAMPAIGN_INFERENCE_CALLS.codex_app_server,
      );
    } catch (error) {
      const isBudgetExhausted =
        error instanceof Error && error.message.includes("cap reached");
      const reason = isBudgetExhausted
        ? `Sisa budget campaign Codex kurang dari ${CAPABILITY_CAMPAIGN_INFERENCE_CALLS.codex_app_server} turn. Tidak ada probe yang dikirim.`
        : "Safety ledger campaign tidak tersedia. Tidak ada probe yang dikirim.";
      if (isBudgetExhausted)
        await recordCodexLedgerOutcome({ outcome: "blocked_budget_exhausted" });
      return await respondBlocked(
        blockedCampaign(reason),
        isBudgetExhausted ? 409 : 503,
        runtime,
        account.identityFingerprint,
        connected.codexHomeFingerprint,
      );
    }

    const turnText =
      "Reply with exactly this text: PROMPTLAB CAPABILITY CAMPAIGN READY";
    type TurnResult = Awaited<ReturnType<typeof executeCodexTurn>>;
    const turnResults: Array<{ value: TurnResult | null; error: string | null }> =
      [];
    let attemptedInferenceCalls = 0;
    let failedProbes = 0;
    for (let index = 0; index < 2; index += 1) {
      attemptedInferenceCalls += 1;
      try {
        turnResults.push({
          value: await executeCodexTurn({
            session: connected.session,
            cliVersion: connected.cliVersion,
            codexHomeFingerprint: connected.codexHomeFingerprint,
            expectedAccountFingerprint: account.identityFingerprint,
            requestedModel,
            text: turnText,
            timeoutMs: 30_000,
          }),
          error: null,
        });
      } catch (error) {
        failedProbes += 1;
        turnResults.push({ value: null, error: campaignProbeErrorCode(error) });
      }
    }

    let cancellationObserved = false;
    let remoteCancellationObserved = false;
    let cancellationError: string | null = null;
    attemptedInferenceCalls += 1;
    const cancelController = new AbortController();
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await executeCodexTurn({
        session: connected.session,
        cliVersion: connected.cliVersion,
        codexHomeFingerprint: connected.codexHomeFingerprint,
        expectedAccountFingerprint: account.identityFingerprint,
        requestedModel,
        text: "Reply with exactly this text: PROMPTLAB CANCELLATION CAMPAIGN READY",
        timeoutMs: 10_000,
        signal: cancelController.signal,
        beforeGeneration: async () => {
          cancelTimer = setTimeout(() => cancelController.abort(), 100);
        },
      });
    } catch (error) {
      if (
        error instanceof CodexProviderError &&
        error.code === "codex_turn_interrupted"
      ) {
        cancellationObserved = true;
        remoteCancellationObserved = error.remoteInterruptAcknowledged;
      } else {
        failedProbes += 1;
        cancellationError = campaignProbeErrorCode(error);
      }
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
    }

    const successfulTurns = turnResults.flatMap((probe) =>
      probe.value ? [probe.value] : [],
    );
    const hasStream = successfulTurns.some((turn) => turn.streamObserved);
    const hasStructuredOutput = successfulTurns.some(
      (turn) => turn.structuredOutputObserved,
    );
    const hasUsage = successfulTurns.some(
      (turn) =>
        turn.usage?.inputTokens !== undefined ||
        turn.usage?.outputTokens !== undefined,
    );
    const repeatedUsage = turnResults[1]?.value?.usage;
    const hasCacheRead = (repeatedUsage?.cachedInputTokens ?? 0) > 0;
    const hasCacheWrite = successfulTurns.some(
      (turn) => (turn.usage?.cacheWriteInputTokens ?? 0) > 0,
    );
    const overrides: Partial<Record<CapabilityName, CapabilityEvidence>> = {};
    const set = (
      name: CapabilityName,
      status: CapabilityEvidence["status"],
      reason: string,
    ) => {
      overrides[name] = capabilityEvidence(
        "codex_app_server",
        name,
        status,
        checkedAt,
        reason,
      );
    };
    set(
      "streamText",
      hasStream
        ? "supported"
        : successfulTurns.length
          ? "not_observed"
          : "failed",
      hasStream
        ? "Codex app-server mengirim event text delta selama turn kampanye."
        : successfulTurns.length
          ? "Dua turn selesai tanpa event text delta yang teramati."
          : `Probe streaming gagal (${turnResults.map((probe) => probe.error).filter(Boolean).join(", ") || "tidak ada respons"}).`,
    );
    set(
      "structuredOutput",
      hasStructuredOutput
        ? "supported"
        : successfulTurns.length
          ? "not_observed"
          : "failed",
      hasStructuredOutput
        ? "Output Codex cocok dengan schema ketat { answer: string }."
        : successfulTurns.length
          ? "Turn selesai, tetapi object output tidak cocok dengan schema { answer: string }."
          : "Structured output tidak dapat diperiksa karena kedua turn gagal.",
    );
    set(
      "reportedUsage",
      hasUsage
        ? "supported"
        : successfulTurns.length
          ? "not_observed"
          : "failed",
      hasUsage
        ? "Codex app-server melaporkan token input atau output pada turn kampanye."
        : successfulTurns.length
          ? "Turn selesai tanpa inputTokens maupun outputTokens pada event usage."
          : "Usage tidak dapat diperiksa karena kedua turn gagal.",
    );
    set(
      "cacheReadReporting",
      hasCacheRead
        ? "supported"
        : successfulTurns.length === 2
          ? "not_observed"
          : "failed",
      hasCacheRead
        ? `Turn identik kedua melaporkan cachedInputTokens=${repeatedUsage?.cachedInputTokens}.`
        : successfulTurns.length === 2
          ? "Turn identik kedua tidak melaporkan token cache read positif; cache hit tidak teramati pada percobaan ini."
          : "Cache read tidak dapat diuji karena dua turn identik tidak selesai dengan sukses.",
    );
    set(
      "cacheWriteReporting",
      hasCacheWrite
        ? "supported"
        : successfulTurns.length === 2
          ? "not_observed"
          : "failed",
      hasCacheWrite
        ? "Salah satu turn identik melaporkan cacheWriteInputTokens positif."
        : successfulTurns.length === 2
          ? "Dua turn identik tidak melaporkan cache write token positif; write tidak teramati pada percobaan ini."
          : "Cache write tidak dapat diuji karena dua turn identik tidak selesai dengan sukses.",
    );
    set(
      "cancellation",
      cancellationObserved
        ? "supported"
        : cancellationError
          ? "failed"
          : "not_observed",
      cancellationObserved
        ? "AbortSignal lokal menginterupsi turn yang sudah dimulai pada Codex app-server."
        : cancellationError
          ? `Probe batal lokal gagal (${cancellationError}).`
          : "Turn selesai sebelum AbortSignal lokal terlihat.",
    );
    set(
      "remoteCancellation",
      remoteCancellationObserved
        ? "supported"
        : cancellationObserved
          ? "not_observed"
          : cancellationError
            ? "failed"
            : "not_observed",
      remoteCancellationObserved
        ? "Codex app-server mengakui request turn/interrupt selama probe pembatalan."
        : cancellationObserved
          ? "Pembatalan lokal teramati, tetapi app-server tidak mengakui turn/interrupt sebelum probe berakhir."
          : cancellationError
            ? `Probe turn/interrupt gagal (${cancellationError}).`
            : "Turn selesai sebelum request turn/interrupt dikirim.",
    );

    const campaign = makeCapabilityCampaign({
      provider: "codex_app_server",
      requestedModel,
      checkedAt,
      attemptedInferenceCalls,
      status: failedProbes ? "partial" : "completed",
      reason: `${attemptedInferenceCalls} dari ${CAPABILITY_CAMPAIGN_INFERENCE_CALLS.codex_app_server} turn dicoba; ${failedProbes} probe gagal. Status tiap capability disimpan terpisah.`,
      overrides,
    });
    const campaignReceipt = {
      ...campaign,
      configurationFingerprint:
        codexConfigurationFingerprint(requestedModel),
      accountFingerprint: account.identityFingerprint,
      codexHomeFingerprint: connected.codexHomeFingerprint,
    } as CapabilityCampaign & Record<string, unknown>;
    const firstSuccessfulTurn = successfulTurns[0];
    const baseVerification = firstSuccessfulTurn
      ? {
          codexVerification: codexVerificationReceipt({
            account: firstSuccessfulTurn.account,
            codexHomeFingerprint: firstSuccessfulTurn.codexHomeFingerprint,
            requestedModel,
            responseModel: firstSuccessfulTurn.responseModel,
            checkedAt,
            usage: firstSuccessfulTurn.usage,
            streamObserved: firstSuccessfulTurn.streamObserved,
            structuredOutputObserved:
              firstSuccessfulTurn.structuredOutputObserved,
            toolCallsObserved: firstSuccessfulTurn.toolCallsObserved,
          }),
        }
      : undefined;
    const receiptSaved = await saveCapabilityCampaign(
      db,
      "codex_app_server",
      projects.map(({ id }) => id),
      requestedModel,
      campaignReceipt,
      baseVerification,
    )
      .then(() => true)
      .catch(() => false);
    await recordCodexLedgerOutcome({
      outcome: failedProbes ? "failed" : "succeeded",
      requestedModel,
      responseModel: successfulTurns[0]?.responseModel ?? null,
      usage: successfulTurns.some((turn) =>
        codexUsageObservationStatus(turn.usage) === "reported",
      )
        ? "reported"
        : "unknown",
      capabilitiesObserved: Object.entries(
        campaign.capabilities as Record<string, CapabilityEvidence>,
      ).map(
        ([name, evidence]) => `${name}:${evidence.status}`,
      ),
    });
    const providers = await providerStates(
      db,
      campusEnvironment(),
      runtime,
      projects,
    ).catch(() => unavailableProviderStates(campusEnvironment()));
    return noStoreJson(
      {
        outcome: receiptSaved
          ? failedProbes
            ? "capability_campaign_partial"
            : "capability_campaign_completed"
          : "capability_campaign_receipt_save_failed",
        message: receiptSaved
          ? campaign.reason
          : "Probe selesai, tetapi receipt tidak dapat disimpan. Hasil tersedia hanya pada respons ini.",
        campaign,
        providers,
        codexModels: models,
      },
      { status: receiptSaved ? 200 : 503 },
    );
  } catch (error) {
    const campaign = blockedCampaign(
      `Codex belum siap untuk menjalankan probe (${campaignProbeErrorCode(error)}). Semua capability probe ditandai diblokir; tidak ada klaim dukungan yang dibuat.`,
    );
    return respondBlocked(campaign, 503);
  } finally {
    await connected?.session.close();
  }
}

export async function GET(request: Request) {
  const environment = campusEnvironment();
  const codexRuntime = await inspectCodexRuntime();
  const database = databaseOrUnavailable();
  const requestedProjectId = new URL(request.url).searchParams.get("projectId");
  const projectId = requestedProjectId?.trim() ?? null;
  if (requestedProjectId !== null && (!projectId || projectId.length > 200)) {
    return noStoreJson(
      {
        outcome: "invalid_request",
        message: "ID proyek untuk status provider tidak valid.",
      },
      { status: 400 },
    );
  }
  if ("response" in database) {
    return noStoreJson({
      providers: unavailableProviderStates(environment),
      codexModels: codexRuntime.status === "ready" ? codexRuntime.models : [],
      projectPrerequisite: "unknown" satisfies ProjectPrerequisite,
    });
  }

  let projectPrerequisite: ProjectPrerequisite = "unknown";
  try {
    const projects = projectId
      ? await database.db
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.id, projectId),
              isNull(schema.projects.deletedAt),
            ),
          )
      : await database.db
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(isNull(schema.projects.deletedAt));
    if (projectId && projects.length === 0) {
      return noStoreJson(
        {
          outcome: "project_not_found",
          message: "Proyek aktif tidak ditemukan.",
        },
        { status: 404 },
      );
    }
    projectPrerequisite = projects.length > 0 ? "satisfied" : "missing";
    return noStoreJson({
      providers: await providerStates(
        database.db,
        environment,
        codexRuntime,
        projects,
      ),
      codexModels: codexRuntime.status === "ready" ? codexRuntime.models : [],
      projectPrerequisite,
    });
  } catch {
    return noStoreJson({
      providers: unavailableProviderStates(environment),
      codexModels: codexRuntime.status === "ready" ? codexRuntime.models : [],
      projectPrerequisite,
    });
  }
}

async function codexAction(
  body: Record<string, unknown>,
): Promise<Response | null> {
  if (body.action === "codex-login-start" && Object.keys(body).length === 1) {
    try {
      const login = await startCodexLogin();
      return noStoreJson({
        outcome: "login_started",
        message: "Masukkan kode ini pada halaman login ChatGPT resmi.",
        login,
      });
    } catch (error) {
      const reason =
        error instanceof CodexProviderError
          ? error.code === "codex_cli_unavailable"
            ? "Codex CLI tidak ditemukan di server lokal."
            : error.code === "codex_cli_version_unsupported"
              ? "Versi Codex CLI belum didukung adapter yang diverifikasi."
              : "Alur login resmi Codex belum dapat dimulai."
          : "Alur login resmi Codex belum dapat dimulai.";
      return noStoreJson(
        { outcome: "login_unavailable", message: reason },
        { status: 503 },
      );
    }
  }

  if (body.action === "codex-login-status" && Object.keys(body).length === 2) {
    const login = codexLoginStatus(body.loginId);
    return login
      ? noStoreJson({ outcome: login.status, login })
      : noStoreJson(
          { outcome: "login_expired", message: "Sesi login sudah berakhir." },
          { status: 404 },
        );
  }

  if (
    body.action !== "codex-verify" ||
    Object.keys(body).length !== 2 ||
    typeof body.model !== "string" ||
    !body.model.trim() ||
    body.model.length > 200
  ) {
    return null;
  }

  const requestedModel = body.model.trim();
  const database = databaseOrUnavailable();
  if ("response" in database) {
    return noStoreJson(
      {
        outcome: "database_unavailable",
        message:
          "Database tidak tersedia. Tidak ada inference Codex yang dikirim.",
      },
      { status: 503 },
    );
  }

  const projects = await database.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(isNull(schema.projects.deletedAt))
    .catch(() => []);
  if (!projects.length) {
    await recordCodexLedgerOutcome({ outcome: "blocked_no_active_projects" });
    return noStoreJson(
      {
        outcome: "no_active_projects",
        message:
          "Buat proyek terlebih dahulu. Tidak ada inference Codex yang dikirim.",
      },
      { status: 409 },
    );
  }

  let connected: Awaited<ReturnType<typeof connectCodexAppServer>> | null =
    null;
  let reserved = false;
  let reservationFailure: "budget_exhausted" | "unavailable" | null = null;
  try {
    connected = await connectCodexAppServer();
    const account = await readCodexAccount(
      connected.session,
      connected.codexHomeFingerprint,
    );
    const models = await listCodexModels(connected.session);
    if (!models.some((model) => model.id === requestedModel)) {
      await recordCodexLedgerOutcome({
        outcome: "blocked_missing_credentials_or_model",
        requestedModel,
      });
      return noStoreJson(
        {
          outcome: "model_unavailable",
          message:
            "Pilih model yang tersedia pada akun Codex ini. Tidak ada inference yang dikirim.",
        },
        { status: 409 },
      );
    }

    const runtimeForExistingReceipt: CodexRuntimeSnapshot = {
      status: "ready",
      account,
      models,
      codexHomeFingerprint: connected.codexHomeFingerprint,
      isolationPolicyVersion: connected.isolationPolicyVersion,
    };
    const currentProviders = await providerStates(
      database.db,
      campusEnvironment(),
      runtimeForExistingReceipt,
      projects,
    );
    const currentCodexTarget = currentProviders.find(
      (provider) =>
        provider.provider === "codex_app_server" && provider.role === "target",
    );
    if (isSelectedCodexModelVerified(currentCodexTarget, requestedModel)) {
      return noStoreJson({
        outcome: "verified",
        message:
          "Model ini sudah terverifikasi untuk konfigurasi aktif. Tidak ada inference baru yang dikirim.",
        providers: currentProviders,
        codexModels: models,
      });
    }

    const completion = await executeCodexTurn({
      session: connected.session,
      cliVersion: connected.cliVersion,
      codexHomeFingerprint: connected.codexHomeFingerprint,
      expectedAccountFingerprint: account.identityFingerprint,
      requestedModel,
      text: "Reply with exactly this text: PROMPTLAB CODEX READY",
      timeoutMs: 30_000,
      beforeGeneration: async () => {
        if (!isProviderVerificationCampaignConfigured()) return;
        try {
          await reserveInferenceCall("codex_app_server");
          reserved = true;
        } catch (error) {
          reservationFailure =
            error instanceof Error && error.message.includes("cap reached")
              ? "budget_exhausted"
              : "unavailable";
          if (reservationFailure === "budget_exhausted") {
            await recordCodexLedgerOutcome({
              outcome: "blocked_budget_exhausted",
            });
          }
          throw error;
        }
      },
    });
    const checkedAt = new Date();
    const receipt = codexVerificationReceipt({
      account: completion.account,
      codexHomeFingerprint: completion.codexHomeFingerprint,
      requestedModel,
      responseModel: completion.responseModel,
      checkedAt: checkedAt.toISOString(),
      usage: completion.usage,
      streamObserved: completion.streamObserved,
      structuredOutputObserved: completion.structuredOutputObserved,
      toolCallsObserved: completion.toolCallsObserved,
    });
    await saveCodexReceipt(
      database.db,
      projects.map((project) => project.id),
      {
        requestedModel,
        responseModel: completion.responseModel,
        status: "verified",
        checkedAt,
        snapshot: { codexVerification: receipt },
      },
    );
    await recordCodexLedgerOutcome({
      outcome: "succeeded",
      requestedModel,
      responseModel: completion.responseModel,
      usage: codexUsageObservationStatus(completion.usage),
      capabilitiesObserved: [
        "bounded chat generation succeeded",
        `effective model ${completion.responseModel}`,
        ...(completion.streamObserved ? ["stream text observed"] : []),
        ...(completion.structuredOutputObserved
          ? ["structured output matched the answer schema"]
          : ["structured output did not match the answer schema"]),
        ...(completion.usage?.cachedInputTokens !== undefined
          ? ["cache read token count reported"]
          : []),
        ...(completion.usage?.cacheWriteInputTokens !== undefined
          ? ["cache write token count reported"]
          : []),
        "native tool and approval requests are refused by the protocol guard",
        "bounded-native filesystem and provider-egress profile confirmed",
      ],
    });

    const codexRuntime = await inspectCodexRuntime();
    return noStoreJson({
      outcome: "verified",
      message:
        completion.structuredOutputObserved
          ? "Verifikasi Codex berhasil. Satu request kecil menghasilkan output sesuai schema; tidak ada retry."
          : "Koneksi Codex berhasil, tetapi respons tidak cocok dengan schema output. Structured output tetap belum diketahui; tidak ada retry.",
      providers: await providerStates(
        database.db,
        campusEnvironment(),
        codexRuntime,
      ),
      codexModels: codexRuntime.status === "ready" ? codexRuntime.models : [],
    });
  } catch (error) {
    if (reservationFailure) {
      return noStoreJson(
        {
          outcome:
            reservationFailure === "budget_exhausted"
              ? "budget_exhausted"
              : "safety_ledger_unavailable",
          message:
            reservationFailure === "budget_exhausted"
              ? "Budget verifikasi Codex untuk campaign PromptLab ini sudah tercapai. Tidak ada inference tambahan yang dikirim. Target dengan bukti terverifikasi untuk konfigurasi aktif tetap dapat digunakan."
              : "Safety ledger tidak tersedia. Tidak ada inference yang dikirim.",
        },
        { status: reservationFailure === "budget_exhausted" ? 409 : 503 },
      );
    }
    if (reserved) {
      await recordCodexLedgerOutcome({
        outcome: "failed",
        requestedModel,
        usage: "unknown",
        capabilitiesObserved: [
          error instanceof CodexProviderError
            ? error.code
            : "codex_verification_failed",
        ],
      });
    } else if (
      error instanceof CodexProviderError &&
      error.code === "codex_not_logged_in"
    ) {
      await recordCodexLedgerOutcome({ outcome: "blocked_not_logged_in" });
    } else if (
      error instanceof CodexProviderError &&
      error.code === "codex_subscription_required"
    ) {
      await recordCodexLedgerOutcome({
        outcome: "blocked_missing_credentials_or_model",
      });
    }
    const message =
      error instanceof CodexProviderError
        ? error.code === "codex_not_logged_in"
          ? "Hubungkan akun ChatGPT lewat tombol Login Codex terlebih dahulu. Tidak ada inference yang dikirim."
          : error.code === "codex_subscription_required"
            ? "Gunakan login ChatGPT subscription resmi, bukan API key. Tidak ada inference yang dikirim."
            : error.code === "codex_policy_unverified"
              ? "Codex tidak mengonfirmasi model atau profil bounded-native yang diwajibkan. Hasil tidak diaktifkan."
              : "Verifikasi Codex gagal. Otomatis retry tidak dilakukan."
        : "Verifikasi Codex gagal. Otomatis retry tidak dilakukan.";
    return noStoreJson(
      { outcome: "verification_failed", message },
      { status: 502 },
    );
  } finally {
    await connected?.session.close();
  }
}

export async function POST(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return noStoreJson(
      {
        outcome: "invalid_request",
        message: "Request verifikasi harus dikirim sebagai JSON.",
      },
      { status: 415 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson(
      { outcome: "invalid_request", message: "Request JSON tidak valid." },
      { status: 400 },
    );
  }
  if (!isRecord(body)) {
    return noStoreJson(
      {
        outcome: "invalid_request",
        message: "Request verifikasi harus berupa object JSON.",
      },
      { status: 400 },
    );
  }
  if (body.action === "campus-capability-campaign")
    return runCampusCapabilityCampaign(body);
  if (body.action === "codex-capability-campaign")
    return runCodexCapabilityCampaign(body);
  if (typeof body.action === "string") {
    const result = await codexAction(body);
    if (result) return result;
  }
  if (Object.keys(body).length !== 0) {
    return noStoreJson(
      {
        outcome: "invalid_request",
        message: "Verifikasi memakai konfigurasi server yang sudah disimpan.",
      },
      { status: 400 },
    );
  }

  const environment = campusEnvironment();
  const database = databaseOrUnavailable();
  if ("response" in database) {
    return noStoreJson(
      {
        outcome: "database_unavailable",
        message:
          "Database provider tidak tersedia. Tidak ada request yang dikirim.",
        providers: unavailableProviderStates(environment),
      },
      { status: 503 },
    );
  }

  if (!environment.apiKey || !environment.requestedModel) {
    await recordLedgerOutcome({
      outcome: "blocked_missing_credentials_or_model",
    });
    return noStoreJson(
      {
        outcome: "missing_configuration",
        message:
          "Credential atau model kampus belum tersedia di environment server. Tidak ada request yang dikirim.",
        providers: await providerStates(database.db, environment).catch(() =>
          unavailableProviderStates(environment),
        ),
      },
      { status: 503 },
    );
  }

  let projects: CampusProjectRow[];
  try {
    projects = await database.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(isNull(schema.projects.deletedAt));
  } catch {
    return noStoreJson(
      {
        outcome: "database_unavailable",
        message:
          "Daftar proyek tidak dapat dibaca. Tidak ada request yang dikirim.",
        providers: unavailableProviderStates(environment),
      },
      { status: 503 },
    );
  }
  if (projects.length === 0) {
    await recordLedgerOutcome({ outcome: "blocked_no_active_projects" });
    return noStoreJson(
      {
        outcome: "no_active_projects",
        message:
          "Buat proyek aktif terlebih dahulu agar bukti koneksi dapat disimpan. Tidak ada request yang dikirim.",
        providers: await providerStates(database.db, environment).catch(() =>
          unavailableProviderStates(environment),
        ),
      },
      { status: 409 },
    );
  }

  if (isProviderVerificationCampaignConfigured()) {
    try {
      await reserveInferenceCall("campus_gateway");
    } catch (error) {
      const isBudgetExhausted =
        error instanceof Error && error.message.includes("cap reached");
      if (isBudgetExhausted) {
        await recordLedgerOutcome({ outcome: "blocked_budget_exhausted" });
      }
      return noStoreJson(
        {
          outcome: isBudgetExhausted
            ? "budget_exhausted"
            : "safety_ledger_unavailable",
          message: isBudgetExhausted
            ? "Budget verifikasi Campus untuk campaign PromptLab ini sudah tercapai. Tidak ada request tambahan yang dikirim."
            : "Safety ledger tidak tersedia. Tidak ada request yang dikirim.",
          providers: await providerStates(database.db, environment).catch(() =>
            unavailableProviderStates(environment),
          ),
        },
        { status: isBudgetExhausted ? 429 : 503 },
      );
    }
  }

  const provider = new CampusChatProvider({ apiKey: environment.apiKey });
  let completion;
  try {
    completion = await provider.complete(
      {
        model: environment.requestedModel,
        purpose: "optimizer",
        maxOutputTokens: 16,
        messages: [
          {
            role: "user",
            content: "Reply exactly: PromptLab provider smoke OK.",
          },
        ],
      },
      { signal: request.signal },
    );
  } catch (error) {
    const code = failureCode(error);
    const checkedAt = new Date();
    await recordLedgerOutcome({
      outcome: "failed",
      requestedModel: environment.requestedModel,
      capabilitiesObserved: [`single request failed (${code})`],
    });
    const snapshot = createCampusFailureSnapshot({
      apiKey: environment.apiKey,
      requestedModel: environment.requestedModel,
      checkedAt: checkedAt.toISOString(),
      failureCode: code,
    });
    try {
      await saveCampusReceipt(
        database.db,
        projects.map(({ id }) => id),
        {
          requestedModel: environment.requestedModel,
          responseModel: null,
          status: "configured_unverified",
          checkedAt,
          snapshot: snapshot as unknown as Record<string, unknown>,
        },
      );
    } catch {
      // The sanitized response below still reports failure and never exposes provider data.
    }
    return noStoreJson(
      {
        outcome: "failed",
        message: campusVerificationFailureMessage(code),
        providers: await providerStates(database.db, environment).catch(() =>
          unavailableProviderStates(environment),
        ),
      },
      { status: 502 },
    );
  }

  const checkedAt = new Date(completion.observedAt);
  const snapshot = createCampusVerificationSnapshot(completion, {
    apiKey: environment.apiKey,
    checkedAt: checkedAt.toISOString(),
  });
  const ledgerRecorded = await recordLedgerOutcome({
    outcome: "succeeded",
    requestedModel: completion.requestedModel,
    responseModel: completion.responseModel,
    usage: aggregateUsageProvenance(completion.usage),
    capabilitiesObserved: snapshot.observed,
  });

  try {
    await saveCampusReceipt(
      database.db,
      projects.map(({ id }) => id),
      {
        requestedModel: completion.requestedModel,
        responseModel: completion.responseModel,
        status: "verified",
        checkedAt,
        snapshot: snapshot as unknown as Record<string, unknown>,
      },
    );
  } catch {
    return noStoreJson(
      {
        outcome: "receipt_persistence_failed",
        message:
          "Gateway merespons, tetapi bukti tidak dapat disimpan ke database. Tidak ada retry otomatis.",
        providers: await providerStates(database.db, environment).catch(() =>
          unavailableProviderStates(environment),
        ),
      },
      { status: 503 },
    );
  }

  return noStoreJson({
    outcome: "verified",
    message:
      !isProviderVerificationCampaignConfigured() || ledgerRecorded
        ? "Koneksi terverifikasi dan bukti tersimpan untuk peran optimizer serta auxiliary pada proyek aktif."
        : "Koneksi terverifikasi dan bukti tersimpan. Reservasi request tetap dihitung; hasil ledger tidak dapat diperbarui.",
    providers: await providerStates(database.db, environment).catch(() =>
      unavailableProviderStates(environment),
    ),
  });
}
