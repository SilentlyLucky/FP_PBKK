export interface RunActivityEvent {
  id?: string;
  runId?: string;
  sequence?: number;
  timestamp?: string;
  eventType: string;
  payload?: unknown;
}

export interface RunActivityContext {
  provider?: string | null;
  providerLabel?: string | null;
  model?: string | null;
  purpose?: string | null;
}

export interface RunActivityDetail {
  label: string;
  value: string;
}

export interface RunActivityPresentation {
  title: string;
  summary: string;
  toolName?: string;
  toolState?: "started" | "completed" | "failed";
  selectedToolNames?: string[];
  provider?: string;
  model?: string;
  details: RunActivityDetail[];
}

const tools = {
  analyze_history: {
    label: "Menganalisis riwayat",
    purpose: "Menggunakan ringkasan pesan terdahulu sebagai konteks.",
  },
  search_knowledge: {
    label: "Mencari sumber pengetahuan",
    purpose: "Mencari materi terpilih untuk konteks prompt.",
  },
  search_verified_memory: {
    label: "Mencari memori terverifikasi",
    purpose: "Mencari hasil eksperimen terverifikasi sebagai referensi.",
  },
  get_source: {
    label: "Membaca potongan sumber",
    purpose: "Mengambil potongan sumber yang sudah ditemukan.",
  },
  estimate_tokens: {
    label: "Memperkirakan jumlah token",
    purpose: "Mengukur perkiraan token dari teks yang diproses.",
  },
  inspect_capabilities: {
    label: "Memeriksa kemampuan provider",
    purpose: "Memeriksa kemampuan provider yang dipilih.",
  },
  validate_candidate: {
    label: "Memvalidasi kandidat prompt",
    purpose: "Memeriksa kandidat terhadap aturan dan invariant tersimpan.",
  },
  evaluate_subset: {
    label: "Menguji sebagian kasus",
    purpose: "Menjalankan pemeriksaan pada kasus uji yang dipilih.",
  },
  search_graph_entities: {
    label: "Mencari entitas di GraphRAG",
    purpose: "Mencari entitas pada indeks graf yang tersedia.",
  },
  traverse_graph: {
    label: "Menelusuri relasi GraphRAG",
    purpose: "Menelusuri relasi dari entitas yang dipilih.",
  },
  get_graph_evidence: {
    label: "Mengambil bukti GraphRAG",
    purpose: "Mengambil bukti dari pernyataan graf yang dipilih.",
  },
  get_graph_status: {
    label: "Memeriksa status GraphRAG",
    purpose: "Memeriksa ketersediaan dan ukuran indeks graf.",
  },
  campus_graph_extraction: {
    label: "Mengekstrak graf sumber",
    purpose: "Meminta ekstraksi graf untuk potongan sumber yang disetujui.",
  },
} as const;

type ToolName = keyof typeof tools;
type AgentToolName = Exclude<ToolName, "campus_graph_extraction">;

const eventTypes = new Set([
  "run.status",
  "run.enqueue",
  "agent.action",
  "agent.finished",
  "tool.started",
  "tool.completed",
  "candidate.proposed",
  "output.delta",
  "usage.snapshot",
  "quota.snapshot",
  "evaluation.result",
  "optimization.clarification.requested",
  "optimization.clarification.answered",
  "optimization.vote",
  "experiment.created",
  "experiment.decision",
  "run.completed",
  "run.failed",
]);

const safeModelPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const safeCodePattern = /^(?:[A-Z][A-Z0-9_]{0,79}|[a-z][a-z0-9_]{0,79})$/;
const safePhasePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeToolName(value: unknown): ToolName | null {
  return typeof value === "string" && Object.hasOwn(tools, value)
    ? (value as ToolName)
    : null;
}

function safeAgentToolName(value: unknown): AgentToolName | null {
  const name = safeToolName(value);
  return name && name !== "campus_graph_extraction" ? name : null;
}

function safeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return safeModelPattern.test(trimmed) ? trimmed : null;
}

function safeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return safeCodePattern.test(trimmed) ? trimmed : null;
}

function safePhase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return safePhasePattern.test(trimmed) ? trimmed : null;
}

function safeEventType(value: string): string | null {
  return /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value) &&
    value.length <= 80
    ? value
    : null;
}

function allowedValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | null {
  return typeof value === "string" &&
    (values as readonly string[]).includes(value)
    ? (value as Values[number])
    : null;
}

function safeRetrievalFallbackReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("ambiguous_entity:")) return "ambiguous_entity";
  return allowedValue(value, [
    "no_sources_selected",
    "source_selection_not_current_in_project",
    "source_permission_not_granted",
    "selected_snapshot_not_found",
    "no_active_snapshot",
    "selected_snapshot_stale_or_unavailable",
    "active_snapshot_stale",
    "selected_sources_not_in_snapshot",
    "no_current_sources_selected",
    "no_lexical_graph_seed",
    "complete_path_exceeds_context_budget",
    "no_complete_supported_path",
    "auto_graph_unavailable_at_enqueue",
    "auto_graph_unavailable_at_worker_preflight",
    "auto_graph_unavailable_during_retrieval",
    "senopati_selected_lexical",
    "senopati_selected_graph",
    "senopati_skipped_retrieval",
    "semantic_index_not_ready",
    "embedding_endpoint_not_configured",
    "embedding_credential_not_configured",
    "embedding_model_not_configured",
    "embedding_endpoint_invalid",
    "embedding_timeout_invalid",
    "embedding_configuration_invalid",
    "embedding_requested_model_mismatch",
    "embedding_profile_invalid",
    "embedding_response_invalid",
    "knowledge_embedding_persistence_failed",
    "knowledge_embedding_job_failed",
    "campus_embedding_auth_required",
    "campus_embedding_provider_http_error",
    "campus_embedding_provider_response_invalid",
    "campus_embedding_provider_timeout",
    "campus_embedding_provider_aborted",
  ] as const);
}

const providers = [
  "codex_app_server",
  "campus_gateway",
  "claude_cli",
  "fixture",
] as const;
const purposes = [
  "target",
  "optimizer",
  "evaluator",
  "auxiliary",
  "graph_indexing",
  "graph_query_model",
] as const;
const retrievalStrategies = [
  "auto",
  "none",
  "lexical",
  "hybrid",
  "graph",
  "full_context",
] as const;
const statuses = [
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "cancel_requested",
  "interrupted_unknown",
  "paused_quota",
  "paused_auth_required",
  "paused_awaiting_user",
  "paused_action_required",
] as const;
const optimizationOutcomes = [
  "candidate_ready",
  "incomplete",
  "clarification_required",
  "no_change_recommended",
  "candidate_rejected",
] as const;
const subjects = ["baseline", "candidate"] as const;
const sources = ["user", "generated"] as const;
const completenessValues = ["complete", "partial", "unknown"] as const;
const effortValues = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const effortResolutionValues = [
  "explicit",
  "advertised_default",
  "first_advertised_supported",
  "unsupported_recommendation_fallback",
  "model_specific_auto_policy",
  "provider_default",
  "task_aware_recommendation",
] as const;

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function projectMetric(value: unknown): Record<string, unknown> | null {
  const metric = record(value);
  if (!metric) return null;
  const status = allowedValue(metric.status, [
    "reported",
    "estimated",
    "unknown",
  ] as const);
  if (!status) return null;
  const projected: Record<string, unknown> = { status };
  const count = safeCount(metric.value);
  if (status === "unknown") {
    projected.value = null;
  } else if (count !== null) {
    projected.value = count;
  } else {
    return null;
  }
  return projected;
}

function projectUsage(value: unknown): Record<string, unknown> | null {
  const usage = record(value);
  if (!usage) return null;
  const projected: Record<string, unknown> = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    const metric = projectMetric(usage[key]);
    if (metric) projected[key] = metric;
  }
  const completeness = allowedValue(usage.completeness, completenessValues);
  if (completeness) projected.completeness = completeness;
  return Object.keys(projected).length ? projected : null;
}

function projectWorkspaceChatProvenance(
  value: unknown,
): Record<string, unknown> | null {
  const workspaceChat = record(value);
  if (!workspaceChat) return null;
  const projected: Record<string, unknown> = {};
  const strategy = allowedValue(
    workspaceChat.retrievalStrategy,
    retrievalStrategies,
  );
  if (strategy) projected.retrievalStrategy = strategy;
  if (Array.isArray(workspaceChat.sourceIds))
    projected.sourceCount = workspaceChat.sourceIds.length;
  for (const key of ["graphEvidenceStatus", "retrievalEvidenceStatus"]) {
    const status = allowedValue(workspaceChat[key], [
      "not_requested",
      "retrieval_not_run",
      "no_evidence_found",
      "evidence_included",
    ] as const);
    if (status) projected[key] = status;
  }
  for (const [sourceKey, targetKey] of [
    ["graphEvidence", "graphEvidenceCount"],
    ["retrievalEvidence", "retrievalEvidenceCount"],
  ] as const) {
    const evidence = workspaceChat[sourceKey];
    if (Array.isArray(evidence)) projected[targetKey] = evidence.length;
  }
  const traceIds = [
    ...(Array.isArray(workspaceChat.graphTraceIds)
      ? workspaceChat.graphTraceIds
      : []),
    ...(Array.isArray(workspaceChat.retrievalTraceIds)
      ? workspaceChat.retrievalTraceIds
      : []),
  ].filter((traceId): traceId is string => typeof traceId === "string");
  if (traceIds.length) projected.traceCount = new Set(traceIds).size;
  const targetCalls = safeCount(workspaceChat.codexTargetCalls);
  if (targetCalls !== null) projected.targetCallCount = targetCalls;
  const promptCharacters = safeCount(workspaceChat.targetPromptCharacters);
  if (promptCharacters !== null)
    projected.targetPromptCharacters = promptCharacters;
  const targetContextHash = workspaceChat.targetContextHash;
  projected.targetContextHashPresent =
    typeof targetContextHash === "string" &&
    /^[a-f0-9]{64}$/u.test(targetContextHash);
  const artifact = record(workspaceChat.targetInputArtifact);
  projected.targetInputArtifactPresent =
    artifact?.format === "promptlab-workspace-target-input-v1" &&
    typeof artifact.targetInput === "string";
  const outcome = allowedValue(workspaceChat.outcome, [
    "clarification_required",
    "no_change_recommended",
    "optimized_prompt_executed",
  ] as const);
  if (outcome) projected.outcome = outcome;
  return Object.keys(projected).length ? projected : null;
}

function projectToolSummary(
  toolName: ToolName,
  value: unknown,
  kind: "argumentsSummary" | "resultSummary",
): Record<string, unknown> | null {
  const summary = record(value);
  if (!summary) return null;
  const projected: Record<string, unknown> = {};
  const numberFieldsByTool: Record<ToolName, readonly string[]> = {
    analyze_history: ["messageCount", "findingsCount"],
    search_knowledge: ["sourceCount", "limit", "resultCount"],
    search_verified_memory: ["queryCharacters", "limit", "resultCount"],
    get_source: ["characterCount"],
    estimate_tokens: ["textCharacters", "estimatedTokens"],
    inspect_capabilities: [],
    validate_candidate: [
      "candidateCharacters",
      "invariantCount",
      "preservedCount",
      "missingCount",
    ],
    evaluate_subset: [
      "developmentCaseCount",
      "passedChecks",
      "totalChecks",
      "passedCases",
      "totalCases",
    ],
    search_graph_entities: [
      "limit",
      "resultCount",
      "pathCount",
      "evidenceCount",
      "sourceVersionCount",
    ],
    traverse_graph: [
      "seedCount",
      "maxHops",
      "maxNodes",
      "nodeCount",
      "edgeCount",
      "pathCount",
    ],
    get_graph_evidence: ["assertionCount", "resultCount"],
    get_graph_status: ["revision", "entityCount", "assertionCount"],
    campus_graph_extraction: ["attemptNumber"],
  };
  for (const key of numberFieldsByTool[toolName]) {
    const count = safeCount(summary[key]);
    if (count !== null) projected[key] = count;
  }
  for (const key of [
    "truncated",
    "valid",
    "clipped",
    "available",
    "remoteOutcomeUnknown",
    "remoteOutcomeMayBeUnknown",
  ]) {
    if (typeof summary[key] === "boolean") projected[key] = summary[key];
  }
  for (const key of [
    "invariantStatus",
    "status",
    "executionStatus",
    "errorCode",
    "method",
  ]) {
    const value = safeCode(summary[key]);
    if (value) projected[key] = value;
  }
  if (toolName === "search_verified_memory") {
    const reason = allowedValue(summary.reason, [
      "frozen_source_scope_mismatch",
      "frozen_sources_stale",
      "query_required",
      "no_matching_verified_memories",
      "context_budget_exceeded",
    ] as const);
    if (reason) projected.reason = reason;
  }
  if (kind === "argumentsSummary" && toolName === "inspect_capabilities") {
    const provider = allowedValue(summary.provider, providers);
    if (provider) projected.provider = provider;
  }
  return Object.keys(projected).length ? projected : null;
}

/**
 * Projects only presentation-safe fields for the project-wide Monitoring SSE.
 * It deliberately excludes prompts, summaries, tool arguments, answers, IDs,
 * filesystem paths, provider payloads, and arbitrary nested JSON.
 */
export function projectRunActivityPayload(
  eventType: string,
  value: unknown,
): Record<string, unknown> {
  const payload = record(value);
  if (!payload || !eventTypes.has(eventType)) return {};
  const projected: Record<string, unknown> = {};
  const status = allowedValue(payload.status, statuses);
  if (status) projected.status = status;
  const provider = allowedValue(payload.provider, providers);
  if (provider) projected.provider = provider;
  const purpose = allowedValue(payload.purpose, purposes);
  if (purpose) projected.purpose = purpose;
  for (const key of [
    "model",
    "responseModel",
    "requestedModel",
    "resolvedModel",
  ]) {
    const model = safeModel(payload[key]);
    if (model) projected[key] = model;
  }
  const phase = safePhase(payload.phase);
  if (phase) projected.phase = phase;
  const retrievalStrategy = allowedValue(
    payload.retrievalStrategy,
    retrievalStrategies,
  );
  if (retrievalStrategy) projected.retrievalStrategy = retrievalStrategy;
  if (phase === "knowledge_retrieval") {
    const strategyRequested = allowedValue(
      payload.strategyRequested,
      retrievalStrategies,
    );
    const strategyUsed = allowedValue(
      payload.strategyUsed,
      retrievalStrategies,
    );
    if (strategyRequested) projected.strategyRequested = strategyRequested;
    if (strategyUsed) projected.strategyUsed = strategyUsed;
    const fallbackReason = safeRetrievalFallbackReason(payload.fallbackReason);
    if (fallbackReason) projected.fallbackReason = fallbackReason;
    const retrievalReason = safeRetrievalFallbackReason(
      payload.retrievalReason,
    );
    if (retrievalReason) projected.retrievalReason = retrievalReason;
    for (const key of [
      "evidenceCount",
      "pathCount",
      "estimatedContextTokens",
      "elapsedMs",
    ]) {
      const count = safeCount(payload[key]);
      if (count !== null) projected[key] = count;
    }
  }
  const reasoningEffort = allowedValue(payload.reasoningEffort, effortValues);
  if (reasoningEffort) projected.reasoningEffort = reasoningEffort;
  const reasoningEffortSelection = allowedValue(
    payload.reasoningEffortSelection,
    ["selected", "auto"] as const,
  );
  if (reasoningEffortSelection)
    projected.reasoningEffortSelection = reasoningEffortSelection;
  const effortResolution = allowedValue(
    payload.effortResolution,
    effortResolutionValues,
  );
  if (effortResolution) projected.effortResolution = effortResolution;
  const mode = allowedValue(payload.mode, [
    "prompt_optimization",
    "controlled_evaluation",
    "direct_run",
    "workspace_chat",
  ] as const);
  if (mode) projected.mode = mode;
  const subject = allowedValue(payload.subject, subjects);
  if (subject) projected.subject = subject;
  const source = allowedValue(payload.source, sources);
  if (source) projected.source = source;
  const completeness = allowedValue(payload.completeness, completenessValues);
  if (completeness) projected.completeness = completeness;
  const turn = safeCount(payload.turn);
  if (turn !== null) projected.turn = turn;
  const attemptNumber = safeCount(payload.attemptNumber);
  if (attemptNumber !== null) projected.attemptNumber = attemptNumber;
  const modelCall = safeCount(payload.modelCall);
  if (modelCall !== null) projected.modelCall = modelCall;
  const caseCount = safeCount(payload.count);
  if (caseCount !== null) projected.count = caseCount;
  const sourceCount = safeCount(payload.sourceCount);
  if (sourceCount !== null) projected.sourceCount = sourceCount;
  if (typeof payload.remoteOutcomeKnown === "boolean")
    projected.remoteOutcomeKnown = payload.remoteOutcomeKnown;
  if (typeof payload.remoteOutcomeUnknown === "boolean")
    projected.remoteOutcomeUnknown = payload.remoteOutcomeUnknown;
  if (typeof payload.remoteOutcomeMayBeUnknown === "boolean")
    projected.remoteOutcomeMayBeUnknown = payload.remoteOutcomeMayBeUnknown;
  const errorCode = safeCode(payload.errorCode);
  if (errorCode) projected.errorCode = errorCode;

  const selectedTools = Array.isArray(payload.selectedTools)
    ? payload.selectedTools
        .map(safeAgentToolName)
        .filter((name): name is AgentToolName => name !== null)
        .slice(0, 8)
    : [];
  if (selectedTools.length) projected.selectedTools = selectedTools;

  const isToolEvent =
    eventType === "tool.started" || eventType === "tool.completed";
  const toolName =
    safeToolName(payload.toolName) ??
    (isToolEvent && payload.tool === "campus_graph_extraction"
      ? "campus_graph_extraction"
      : null);
  if (toolName) {
    projected.toolName = toolName;
    const graphArgumentsSummary =
      toolName === "campus_graph_extraction" &&
      payload.attemptNumber !== undefined
        ? { attemptNumber: payload.attemptNumber }
        : undefined;
    const graphResultSummary =
      toolName === "campus_graph_extraction"
        ? {
            status: payload.status,
            errorCode: payload.errorCode,
            remoteOutcomeUnknown: payload.remoteOutcomeUnknown,
            remoteOutcomeMayBeUnknown: payload.remoteOutcomeMayBeUnknown,
          }
        : undefined;
    const argumentsSummary = projectToolSummary(
      toolName,
      payload.argumentsSummary ?? graphArgumentsSummary,
      "argumentsSummary",
    );
    const resultSummary = projectToolSummary(
      toolName,
      payload.resultSummary ?? graphResultSummary,
      "resultSummary",
    );
    if (argumentsSummary) projected.argumentsSummary = argumentsSummary;
    if (resultSummary) projected.resultSummary = resultSummary;
  }

  const topLevelUsage = projectUsage(payload);
  if (topLevelUsage) Object.assign(projected, topLevelUsage);
  const usage = projectUsage(payload.usage);
  if (usage) projected.usage = usage;

  if (eventType === "run.completed") {
    if (typeof payload.text === "string")
      projected.answerPresent = payload.text.length > 0;
    const workspaceChat = projectWorkspaceChatProvenance(payload.workspaceChat);
    if (workspaceChat) projected.workspaceChat = workspaceChat;
    const result = record(payload.result);
    if (result) {
      const projectedResult: Record<string, unknown> = {};
      const resultStatus = allowedValue(result.status, optimizationOutcomes);
      const outcome = allowedValue(result.outcome, optimizationOutcomes);
      const latestRevisionOutcome = allowedValue(
        result.latestRevisionOutcome,
        optimizationOutcomes,
      );
      const candidate = record(result.candidate);
      const candidateOutcome = allowedValue(
        candidate?.outcome,
        optimizationOutcomes,
      );
      if (resultStatus) projectedResult.status = resultStatus;
      if (outcome) projectedResult.outcome = outcome;
      if (latestRevisionOutcome)
        projectedResult.latestRevisionOutcome = latestRevisionOutcome;
      if (candidateOutcome) projectedResult.candidateOutcome = candidateOutcome;
      if (Object.keys(projectedResult).length)
        projected.result = projectedResult;
    }
  }

  if (eventType === "evaluation.result") {
    const caseResults = Array.isArray(payload.caseResults)
      ? payload.caseResults.length
      : null;
    if (caseResults !== null) projected.caseCount = caseResults;
    const invariantStatus = allowedValue(payload.invariantStatus, [
      "preserved",
      "violated",
      "not_configured",
    ] as const);
    if (invariantStatus) projected.invariantStatus = invariantStatus;
  }
  return projected;
}

function countLabel(value: unknown): string | null {
  const count = safeCount(value);
  return count === null ? null : new Intl.NumberFormat("id-ID").format(count);
}

function providerLabel(value: unknown): string | null {
  switch (value) {
    case "codex_app_server":
      return "Codex";
    case "campus_gateway":
      return "Senopati";
    case "claude_cli":
      return "Claude CLI";
    case "fixture":
      return "Fixture";
    default:
      return null;
  }
}

function purposeLabel(value: unknown): string | null {
  switch (value) {
    case "target":
      return "model target";
    case "optimizer":
      return "optimizer";
    case "evaluator":
      return "evaluator";
    case "auxiliary":
      return "layanan pendukung";
    case "graph_indexing":
      return "indeks graf";
    case "graph_query_model":
      return "model query graf";
    default:
      return null;
  }
}

function strategyLabel(value: unknown): string | null {
  switch (value) {
    case "auto":
      return "Auto";
    case "none":
      return "tanpa pencarian sumber";
    case "lexical":
      return "pencarian leksikal";
    case "hybrid":
      return "pencarian hibrida";
    case "graph":
      return "GraphRAG";
    case "full_context":
      return "konteks sumber penuh";
    default:
      return null;
  }
}

function retrievalFallbackLabel(value: unknown): string | null {
  switch (value) {
    case "auto_graph_unavailable_at_enqueue":
      return "Tidak ada snapshot GraphRAG yang cocok saat run dibuat; Auto memakai pencarian leksikal bila diperlukan.";
    case "auto_graph_unavailable_at_worker_preflight":
      return "Snapshot GraphRAG tidak lagi cocok saat run dimulai; Auto memakai pencarian leksikal bila diperlukan.";
    case "auto_graph_unavailable_during_retrieval":
      return "Snapshot GraphRAG berubah saat pencarian; Auto beralih ke pencarian leksikal.";
    case "senopati_selected_lexical":
      return "Senopati memilih pencarian leksikal dari opsi Auto.";
    case "senopati_selected_graph":
      return "Senopati memilih GraphRAG dari opsi Auto.";
    case "senopati_skipped_retrieval":
      return "Senopati tidak memerlukan pencarian sumber.";
    case "no_sources_selected":
      return "Tidak ada dokumen sumber yang dipilih, jadi tidak ada konteks dokumen tambahan yang dimasukkan.";
    case "source_selection_not_current_in_project":
      return "Pilihan sumber sudah tidak cocok dengan versi proyek saat ini; konteks dokumen tidak digunakan.";
    case "source_permission_not_granted":
      return "Izin berbagi sumber belum tersedia; konteks dokumen tidak dikirim.";
    case "selected_snapshot_not_found":
    case "no_active_snapshot":
      return "Snapshot GraphRAG tidak tersedia; pencarian leksikal digunakan sebagai fallback.";
    case "selected_snapshot_stale_or_unavailable":
    case "active_snapshot_stale":
      return "Snapshot GraphRAG sudah kedaluwarsa; pencarian leksikal digunakan sebagai fallback.";
    case "selected_sources_not_in_snapshot":
      return "Sebagian sumber belum tercakup di GraphRAG; pencarian leksikal digunakan sebagai fallback.";
    case "no_current_sources_selected":
      return "Tidak ada sumber aktif untuk GraphRAG; pencarian leksikal digunakan sebagai fallback.";
    case "no_lexical_graph_seed":
    case "ambiguous_entity":
      return "Entitas GraphRAG belum dapat dipastikan; pencarian leksikal digunakan sebagai fallback.";
    case "complete_path_exceeds_context_budget":
    case "no_complete_supported_path":
      return "Jalur bukti GraphRAG yang lengkap tidak tersedia; pencarian leksikal digunakan sebagai fallback.";
    case "semantic_index_not_ready":
      return "Indeks semantik belum siap untuk sumber terpilih; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_endpoint_not_configured":
      return "Endpoint embedding Senopati belum dikonfigurasi; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_credential_not_configured":
      return "Credential endpoint embedding belum dikonfigurasi; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_model_not_configured":
      return "Model embedding belum dikonfigurasi; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_endpoint_invalid":
      return "Konfigurasi endpoint embedding tidak valid; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_timeout_invalid":
      return "Batas waktu endpoint embedding tidak valid; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_configuration_invalid":
      return "Konfigurasi embedding tidak valid; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_requested_model_mismatch":
      return "Model yang merespons berbeda dari model embedding yang diminta; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_profile_invalid":
      return "Profil embedding tidak cocok dengan indeks sumber; pencarian leksikal digunakan sebagai fallback.";
    case "embedding_response_invalid":
      return "Respons vector embedding tidak valid; pencarian leksikal digunakan sebagai fallback.";
    case "knowledge_embedding_persistence_failed":
      return "Vector embedding tidak berhasil dibaca dari penyimpanan; pencarian leksikal digunakan sebagai fallback.";
    case "knowledge_embedding_job_failed":
      return "Pekerjaan indeks semantik gagal; pencarian leksikal digunakan sebagai fallback.";
    case "campus_embedding_auth_required":
      return "Credential endpoint embedding ditolak atau tidak tersedia; pencarian leksikal digunakan sebagai fallback.";
    case "campus_embedding_provider_http_error":
      return "Endpoint embedding Senopati mengalami gangguan; pencarian leksikal digunakan sebagai fallback.";
    case "campus_embedding_provider_response_invalid":
      return "Endpoint embedding Senopati mengembalikan respons yang tidak valid; pencarian leksikal digunakan sebagai fallback.";
    case "campus_embedding_provider_timeout":
      return "Endpoint embedding Senopati tidak merespons tepat waktu; pencarian leksikal digunakan sebagai fallback.";
    case "campus_embedding_provider_aborted":
      return "Permintaan embedding dibatalkan; pencarian leksikal digunakan sebagai fallback.";
    default:
      return null;
  }
}

function toolDisplayName(value: unknown): string | null {
  const name = safeToolName(value);
  return name ? tools[name].label : null;
}

function outcomeLabel(
  value: unknown,
): { title: string; summary: string } | null {
  switch (value) {
    case "candidate_ready":
      return {
        title: "Kandidat prompt siap ditinjau",
        summary: "Kandidat dan hasil uji tercatat untuk ditinjau.",
      };
    case "no_change_recommended":
      return {
        title: "Tidak ada perubahan prompt yang direkomendasikan",
        summary:
          "Hasil optimasi mencatat rekomendasi untuk mempertahankan prompt.",
      };
    case "candidate_rejected":
      return {
        title: "Kandidat prompt ditolak oleh pemeriksaan",
        summary: "Status hasil uji menandai kandidat sebagai ditolak.",
      };
    case "incomplete":
      return {
        title: "Hasil optimasi belum lengkap",
        summary: "Sebagian pemeriksaan belum menghasilkan bukti lengkap.",
      };
    case "clarification_required":
      return {
        title: "Senopati meminta klarifikasi",
        summary: "Run menunggu jawaban sebelum optimasi dilanjutkan.",
      };
    default:
      return null;
  }
}

function statusPresentation(
  value: unknown,
  remoteOutcomeMayBeUnknown = false,
): {
  title: string;
  summary: string;
} {
  switch (value) {
    case "queued":
    case "created":
      return {
        title: "Menunggu giliran",
        summary: "Run masuk antrean dan belum mulai diproses.",
      };
    case "running":
      return {
        title: "Run mulai diproses",
        summary: "Worker mulai menjalankan run.",
      };
    case "succeeded":
      return {
        title: "Run berhasil",
        summary: "Run berakhir dengan status berhasil.",
      };
    case "failed":
      return {
        title: "Run gagal",
        summary: "Run berakhir dengan status gagal.",
      };
    case "cancel_requested":
      return {
        title: "Pembatalan diminta",
        summary:
          "Run menerima permintaan berhenti; status provider belum dipastikan.",
      };
    case "canceled":
      return {
        title: "Run dibatalkan",
        summary: remoteOutcomeMayBeUnknown
          ? "Run lokal berhenti; hasil remote belum dapat dipastikan."
          : "Run lokal berhenti; hasil provider hanya diketahui jika dicatat terpisah.",
      };
    case "interrupted_unknown":
      return {
        title: "Run terhenti; hasil provider belum diketahui",
        summary: "Koneksi berakhir sebelum hasil remote dapat dipastikan.",
      };
    case "paused_quota":
      return {
        title: "Run dijeda karena kuota",
        summary: "Run menunggu kuota tersedia.",
      };
    case "paused_auth_required":
      return {
        title: "Run dijeda; autentikasi diperlukan",
        summary: "Periksa koneksi provider sebelum melanjutkan.",
      };
    case "paused_awaiting_user":
      return {
        title: "Run menunggu jawaban",
        summary: "Run dijeda sampai klarifikasi dijawab.",
      };
    case "paused_action_required":
      return {
        title: "Run memerlukan tindakan",
        summary: "Periksa detail run untuk langkah berikutnya.",
      };
    default:
      return {
        title: "Status run diperbarui",
        summary: "Status baru tercatat; rincian status tidak tersedia.",
      };
  }
}

function usageMetricLabel(value: unknown): string {
  const metric = record(value);
  if (!metric) return "tidak tersedia";
  const status = allowedValue(metric.status, [
    "reported",
    "estimated",
    "unknown",
  ] as const);
  if (status === "unknown") return "tidak tersedia";
  const count = countLabel(metric.value);
  if (!status || count === null) return "tidak tersedia";
  return status === "reported" ? `${count} dilaporkan` : `${count} estimasi`;
}

function toolResultSummary(
  toolName: ToolName,
  result: Record<string, unknown> | null,
): string {
  if (
    toolName === "campus_graph_extraction" &&
    result?.status === "failed" &&
    result.remoteOutcomeUnknown === true
  )
    return "Ekstraksi graf gagal; hasil remote belum dapat dipastikan.";
  if (result?.executionStatus === "failed" || result?.status === "failed")
    return "Tool gagal saat dijalankan; detail kegagalan tidak dicatat.";
  if (toolName === "campus_graph_extraction" && result?.status === "succeeded")
    return "Ekstraksi graf selesai; hasil tercatat untuk diproses.";
  if (!result) return "Tool selesai; ringkasan hasil tidak tersedia.";
  if (toolName === "search_graph_entities") {
    const evidenceCount = countLabel(result.evidenceCount);
    const pathCount = countLabel(result.pathCount);
    if (evidenceCount !== null || pathCount !== null)
      return `GraphRAG menemukan ${pathCount ?? "jumlah jalur tidak tercatat"} jalur dan ${evidenceCount ?? "jumlah bukti tidak tercatat"} kutipan berbasis versi sumber.`;
  }
  if (toolName === "search_verified_memory") {
    const available = result.available === true;
    const reason = verifiedMemoryReasonLabel(result.reason);
    const resultCount = countLabel(result.resultCount);
    const truncated = result.truncated === true;
    if (!available) {
      return reason
        ? `Memori terverifikasi tidak tersedia: ${reason}.`
        : "Memori terverifikasi tidak tersedia untuk run ini.";
    }
    if (resultCount === "0") {
      if (reason === "batas ukuran konteks tercapai")
        return "Memori terverifikasi tidak masuk ke konteks karena batas ukuran tercapai.";
      if (reason === "tidak ada hasil yang cocok")
        return "Tidak ada memori terverifikasi yang cocok dengan pencarian.";
      return "Pencarian tidak menghasilkan memori terverifikasi.";
    }
    return `Memuat ${resultCount ?? "jumlah tidak tercatat"} memori terverifikasi${truncated ? "; sebagian hasil dipotong oleh batas konteks" : ""}.`;
  }
  const resultCount = countLabel(result.resultCount);
  if (resultCount !== null) return `Hasil memuat ${resultCount} item.`;
  if (toolName === "traverse_graph") {
    const nodes = countLabel(result.nodeCount);
    const edges = countLabel(result.edgeCount);
    if (nodes !== null || edges !== null)
      return `Graf menelusuri ${nodes ?? "jumlah node tidak tercatat"} node dan ${edges ?? "jumlah relasi tidak tercatat"} relasi.`;
  }
  if (toolName === "analyze_history") {
    const findings = countLabel(result.findingsCount);
    const messages = countLabel(result.messageCount);
    if (findings !== null || messages !== null)
      return `${findings ?? "Temuan tidak tercatat"} temuan dari ${messages ?? "jumlah pesan tidak tercatat"} pesan.`;
  }
  if (toolName === "validate_candidate" && typeof result.valid === "boolean")
    return result.valid
      ? "Kandidat memenuhi pemeriksaan yang dijalankan."
      : "Kandidat tidak memenuhi pemeriksaan yang dijalankan.";
  if (toolName === "evaluate_subset") {
    const passed = countLabel(result.passedChecks);
    const total = countLabel(result.totalChecks);
    if (passed !== null && total !== null)
      return `${passed} dari ${total} pemeriksaan lolos.`;
  }
  if (toolName === "estimate_tokens") {
    const estimate = countLabel(result.estimatedTokens);
    return estimate === null
      ? "Perkiraan token tidak tersedia."
      : `Perkiraan hasil: ${estimate} token.`;
  }
  return "Tool selesai; ringkasan hasil tidak tersedia.";
}

function verifiedMemoryReasonLabel(value: unknown): string | null {
  const reason = allowedValue(value, [
    "frozen_source_scope_mismatch",
    "frozen_sources_stale",
    "query_required",
    "no_matching_verified_memories",
    "context_budget_exceeded",
  ] as const);
  if (!reason) return null;
  const labels: Record<typeof reason, string> = {
    frozen_source_scope_mismatch: "cakupan sumber run tidak cocok",
    frozen_sources_stale: "versi sumber run sudah berubah",
    query_required: "kueri pencarian kosong",
    no_matching_verified_memories: "tidak ada hasil yang cocok",
    context_budget_exceeded: "batas ukuran konteks tercapai",
  };
  return labels[reason];
}

function detail(
  label: string,
  value: string | null | undefined,
): RunActivityDetail | null {
  return value ? { label, value } : null;
}

function getEventProvider(
  eventType: string,
  payload: Record<string, unknown>,
  context: RunActivityContext,
): string | null {
  const fromEvent = providerLabel(payload.provider);
  if (fromEvent) return fromEvent;
  const isGraphBuildToolEvent =
    (eventType === "tool.started" || eventType === "tool.completed") &&
    payload.toolName === "campus_graph_extraction";
  if (
    !["usage.snapshot", "run.completed", "run.failed"].includes(eventType) &&
    !(eventType === "agent.action" && payload.phase === "target_test") &&
    !isGraphBuildToolEvent
  )
    return null;
  return (
    providerLabel(context.provider) ??
    (context.providerLabel &&
    ["Codex", "Senopati", "Gateway kampus", "Claude CLI", "Fixture"].includes(
      context.providerLabel,
    )
      ? context.providerLabel
      : null)
  );
}

function getEventModel(
  eventType: string,
  payload: Record<string, unknown>,
  context: RunActivityContext,
): string | null {
  const fromEvent =
    safeModel(payload.responseModel) ??
    safeModel(payload.model) ??
    safeModel(payload.resolvedModel) ??
    safeModel(payload.requestedModel);
  if (fromEvent) return fromEvent;
  if (
    !["usage.snapshot", "run.completed", "run.failed"].includes(eventType) &&
    !(eventType === "agent.action" && payload.phase === "target_test")
  )
    return null;
  if (eventType === "agent.action" && payload.phase !== "target_test")
    return null;
  return safeModel(context.model);
}

function formatTime(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return null;
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export function describeRunActivity(
  event: RunActivityEvent,
  context: RunActivityContext = {},
): RunActivityPresentation {
  const payload = projectRunActivityPayload(event.eventType, event.payload);
  const details: Array<RunActivityDetail | null> = [];
  const provider = getEventProvider(event.eventType, payload, context);
  const model = getEventModel(event.eventType, payload, context);
  const purpose = purposeLabel(payload.purpose ?? context.purpose);
  const phase = payload.phase;
  const toolName = safeToolName(payload.toolName);
  let title = "Peristiwa run belum dikenali";
  let summary =
    "Jenis aktivitas ini belum dikenali. Isi payload tidak ditampilkan.";
  let visibleToolName: string | undefined;
  let toolState: RunActivityPresentation["toolState"];
  let selectedToolNames: string[] | undefined;

  switch (event.eventType) {
    case "run.enqueue":
      ({ title, summary } = statusPresentation(payload.status ?? "queued"));
      break;
    case "run.status":
      ({ title, summary } = statusPresentation(
        payload.status,
        payload.remoteOutcomeMayBeUnknown === true,
      ));
      break;
    case "agent.action": {
      const selectedTools = Array.isArray(payload.selectedTools)
        ? payload.selectedTools
            .map(toolDisplayName)
            .filter((value): value is string => Boolean(value))
        : [];
      switch (phase) {
        case "knowledge_retrieval": {
          const requestedStrategy = strategyLabel(payload.strategyRequested);
          const usedStrategy = strategyLabel(payload.strategyUsed);
          const evidenceCount = countLabel(payload.evidenceCount);
          const pathCount = countLabel(payload.pathCount);
          const tokenCount = countLabel(payload.estimatedContextTokens);
          const elapsedMs = countLabel(payload.elapsedMs);
          const fallback = retrievalFallbackLabel(payload.fallbackReason);
          const reason = retrievalFallbackLabel(payload.retrievalReason);
          title = "Menyiapkan konteks jawaban";
          summary =
            fallback ??
            reason ??
            (usedStrategy
              ? `Memakai ${usedStrategy}${evidenceCount !== null ? ` dan menemukan ${evidenceCount} bukti sumber` : ""}${usedStrategy === "GraphRAG" && pathCount !== null ? ` melalui ${pathCount} jalur relasi` : ""}.`
              : "Memeriksa konteks sumber yang tersedia untuk jawaban.");
          if (requestedStrategy)
            details.push(detail("Pencarian yang diminta", requestedStrategy));
          if (usedStrategy)
            details.push(detail("Pencarian yang dipakai", usedStrategy));
          if (reason) details.push(detail("Alasan rute", reason));
          if (evidenceCount !== null)
            details.push(detail("Bukti sumber", evidenceCount));
          if (pathCount !== null && payload.strategyUsed === "graph")
            details.push(detail("Jalur GraphRAG", pathCount));
          if (tokenCount !== null)
            details.push(
              detail("Perkiraan ukuran konteks", `${tokenCount} token`),
            );
          if (elapsedMs !== null)
            details.push(detail("Waktu pencarian", `${elapsedMs} ms`));
          break;
        }
        case "target_test": {
          title = provider ? `Memanggil ${provider}` : "Menguji prompt target";
          const subject =
            payload.subject === "baseline"
              ? "prompt awal"
              : payload.subject === "candidate"
                ? "prompt baru"
                : "prompt";
          summary = `Menguji ${subject} pada kasus uji yang tercatat.`;
          break;
        }
        case "generate_cases":
        case "cases_ready": {
          title = "Menyiapkan kasus uji";
          const count = countLabel(payload.count);
          summary = count
            ? `${count} kasus ${payload.source === "user" ? "dari pengguna" : payload.source === "generated" ? "disiapkan Senopati" : "tercatat"}.`
            : "Senopati menyiapkan contoh untuk menguji prompt.";
          break;
        }
        case "clarification_check":
          title = "Memeriksa konteks prompt";
          summary = "Senopati memeriksa kebutuhan informasi sebelum pengujian.";
          break;
        case "target_selection_resolved":
        case "target_selection_revalidated":
          title = "Memvalidasi model target";
          summary = "Memeriksa pilihan model dan effort yang tercatat.";
          break;
        case "clarification_required":
          title = "Senopati meminta klarifikasi";
          summary = "Run menunggu jawaban sebelum optimasi dilanjutkan.";
          break;
        case "senopati_decision":
          title = "Senopati menganalisis hasil";
          summary = "Menentukan langkah optimasi berikutnya.";
          break;
        case "decision":
          title = selectedTools.length
            ? "Senopati memilih tool"
            : "Senopati meninjau langkah berikutnya";
          summary = selectedTools.length
            ? `Tool terpilih: ${selectedTools.join(", ")}.`
            : "Tidak ada nama tool yang tercatat pada keputusan ini.";
          break;
        case "candidate.proposed":
          title = "Kandidat prompt disiapkan";
          summary =
            "Perubahan kandidat tercatat; isi prompt tidak ditampilkan.";
          break;
        case "draft_saved":
          title = "Draft prompt disimpan";
          summary =
            "Perubahan disimpan sebagai draft; prompt aktif tetap tidak berubah.";
          break;
        case "agent.finished":
          title = "Senopati menyelesaikan langkah";
          summary = "Langkah agen selesai.";
          break;
        default:
          title = "Aktivitas agen tercatat";
          summary = selectedTools.length
            ? `Agen menyiapkan ${selectedTools.join(", ")} untuk langkah berikutnya.`
            : "Ringkasan aksi yang aman untuk tahap ini belum tersedia.";
      }
      if (selectedTools.length) {
        details.push(detail("Tool terpilih", selectedTools.join(", ")));
        selectedToolNames = (payload.selectedTools as string[]).filter(
          (name) => safeToolName(name) !== null,
        );
      }
      break;
    }
    case "agent.finished":
      title = "Senopati menyelesaikan langkah";
      summary = "Langkah agen selesai.";
      break;
    case "tool.started":
    case "tool.completed": {
      const result = record(payload.resultSummary);
      const failed =
        result?.status === "failed" || result?.executionStatus === "failed";
      toolState =
        event.eventType === "tool.started"
          ? "started"
          : failed
            ? "failed"
            : "completed";
      if (toolName) {
        visibleToolName = toolName;
        const tool = tools[toolName];
        const strategy = strategyLabel(payload.retrievalStrategy);
        title =
          strategy && toolName === "search_knowledge"
            ? `${tool.label} · ${strategy}`
            : tool.label;
        if (event.eventType === "tool.started") {
          summary = tool.purpose;
          const args = record(payload.argumentsSummary);
          const sourceCount = countLabel(args?.sourceCount);
          if (toolName === "search_knowledge" && sourceCount !== null)
            summary = `${tool.purpose} ${sourceCount} sumber dipilih.`;
          if (toolName === "search_verified_memory") {
            const queryCharacters = countLabel(args?.queryCharacters);
            if (queryCharacters !== null)
              summary = `${tool.purpose} Kueri berisi ${queryCharacters} karakter.`;
          }
        } else {
          summary = toolResultSummary(toolName, result);
          details.push(detail("Kode", safeCode(payload.errorCode)));
          if (toolName === "search_verified_memory" && result) {
            const resultCount = countLabel(result.resultCount);
            const reason = verifiedMemoryReasonLabel(result.reason);
            if (resultCount !== null)
              details.push(detail("Memori ditemukan", resultCount));
            if (reason) details.push(detail("Alasan", reason));
            if (typeof result.truncated === "boolean")
              details.push(
                detail(
                  "Batas konteks",
                  result.truncated ? "hasil dipotong" : "tidak terpotong",
                ),
              );
          }
        }
      } else {
        title =
          event.eventType === "tool.started"
            ? "Tool mulai dijalankan"
            : "Hasil tool tercatat";
        summary = "Nama tool tidak tersedia pada event ini.";
      }
      break;
    }
    case "usage.snapshot": {
      title = "Usage tercatat";
      const usage = record(payload.usage) ?? payload;
      const input = usageMetricLabel(usage.inputTokens);
      const output = usageMetricLabel(usage.outputTokens);
      summary = `Input: ${input} token · output: ${output} token.`;
      for (const [key, label] of [
        ["inputTokens", "Input"],
        ["outputTokens", "Output"],
        ["cacheReadTokens", "Cache dibaca"],
        ["cacheWriteTokens", "Cache ditulis"],
      ] as const) {
        const metric = usageMetricLabel(usage[key]);
        details.push(detail(label, `${metric} token`));
      }
      const completeness = allowedValue(usage.completeness, completenessValues);
      if (completeness) details.push(detail("Kelengkapan", completeness));
      break;
    }
    case "candidate.proposed":
      title = "Kandidat prompt disiapkan";
      summary =
        "Kandidat tercatat untuk ditinjau; isi prompt tidak ditampilkan.";
      break;
    case "evaluation.result": {
      title =
        payload.subject === "candidate"
          ? "Menguji prompt baru"
          : "Menguji prompt awal";
      const count = countLabel(payload.caseCount);
      summary = count
        ? `${count} kasus uji selesai dicatat.`
        : "Hasil kasus uji tercatat.";
      const invariant = allowedValue(payload.invariantStatus, [
        "preserved",
        "violated",
        "not_configured",
      ] as const);
      if (invariant) details.push(detail("Invariant", invariant));
      break;
    }
    case "run.completed": {
      const result = record(payload.result);
      const outcome = outcomeLabel(
        result?.latestRevisionOutcome ??
          result?.candidateOutcome ??
          result?.outcome ??
          result?.status,
      );
      if (outcome) {
        ({ title, summary } = outcome);
      } else if (payload.status === "failed") {
        ({ title, summary } = statusPresentation("failed"));
      } else if (payload.status === "interrupted_unknown") {
        ({ title, summary } = statusPresentation("interrupted_unknown"));
      } else if (payload.mode === "prompt_optimization") {
        title = "Evaluasi prompt selesai";
        summary = "Hasil optimasi tersimpan untuk ditinjau.";
      } else if (typeof payload.answerPresent === "boolean") {
        title = "Jawaban diterima";
        summary = payload.answerPresent
          ? `${provider ?? "Provider"} mengembalikan jawaban.`
          : "Provider selesai tanpa jawaban teks.";
      } else {
        title = "Run selesai";
        summary =
          "Event selesai tercatat; isi hasil tidak ditampilkan di timeline.";
      }
      break;
    }
    case "run.failed": {
      const status = payload.status;
      const remoteUnknown =
        status === "interrupted_unknown" ||
        payload.remoteOutcomeKnown === false ||
        payload.remoteOutcomeUnknown === true;
      if (status === "canceled") {
        title = "Run dibatalkan";
        summary = remoteUnknown
          ? "Run lokal berhenti; hasil remote belum dapat dipastikan."
          : "Run dibatalkan; kepastian hasil provider tidak dicatat pada event.";
      } else if (remoteUnknown) {
        title = "Run terhenti; hasil provider belum diketahui";
        summary = "Koneksi berakhir sebelum hasil remote dapat dipastikan.";
      } else {
        ({ title, summary } = statusPresentation(status ?? "failed"));
      }
      details.push(detail("Kode", safeCode(payload.errorCode)));
      break;
    }
    case "optimization.clarification.requested":
      title = "Senopati meminta klarifikasi";
      summary = "Run menunggu jawaban sebelum optimasi dilanjutkan.";
      break;
    case "optimization.clarification.answered":
      title = "Klarifikasi dijawab";
      summary = "Run menerima jawaban dan dapat melanjutkan.";
      break;
    case "optimization.vote":
      title = "Penilaian hasil tersimpan";
      summary = "Keputusan penilaian tercatat.";
      break;
    case "quota.snapshot":
      title = "Status kuota diperbarui";
      summary = "Snapshot kuota tercatat.";
      break;
    case "experiment.created":
      title = "Eksperimen dicatat";
      summary = "Event eksperimen tersimpan.";
      break;
    case "experiment.decision":
      title = "Keputusan eksperimen dicatat";
      summary = "Event keputusan tersimpan.";
      break;
    case "output.delta":
      title = "Jawaban sedang diterima";
      summary =
        "Potongan output diterima; isi jawaban tidak ditampilkan di timeline.";
      break;
  }

  if (provider) details.push(detail("Provider", provider));
  if (model) details.push(detail("Model", model));
  if (purpose) details.push(detail("Tujuan", purpose));
  const reasoningEffortSelection = allowedValue(
    payload.reasoningEffortSelection,
    ["selected", "auto"] as const,
  );
  if (reasoningEffortSelection)
    details.push(
      detail(
        "Mode effort",
        reasoningEffortSelection === "auto" ? "Auto" : "Manual/default",
      ),
    );
  const reasoningEffort = allowedValue(payload.reasoningEffort, effortValues);
  if (reasoningEffort)
    details.push(
      detail(
        "Effort efektif",
        reasoningEffort === "max" ? "Maksimal" : reasoningEffort,
      ),
    );
  const effortResolution = allowedValue(
    payload.effortResolution,
    effortResolutionValues,
  );
  if (effortResolution) {
    const labels: Record<(typeof effortResolutionValues)[number], string> = {
      explicit: "Pilihan manual",
      advertised_default: "Default live yang didukung",
      first_advertised_supported: "Kemampuan live pertama yang sesuai",
      unsupported_recommendation_fallback: "Fallback yang didukung",
      model_specific_auto_policy: "Kebijakan Auto model",
      provider_default: "Default provider",
      task_aware_recommendation: "Rekomendasi tugas yang didukung",
    };
    details.push(detail("Dasar pemilihan effort", labels[effortResolution]));
  }
  if (
    phase &&
    ![
      "knowledge_retrieval",
      "decision",
      "target_test",
      "generate_cases",
      "cases_ready",
      "clarification_check",
      "target_selection_resolved",
      "target_selection_revalidated",
      "clarification_required",
      "senopati_decision",
      "candidate.proposed",
      "agent.finished",
      "draft_saved",
    ].includes(String(phase))
  )
    details.push(detail("Tahap", safePhase(phase)));
  const strategy = strategyLabel(payload.retrievalStrategy);
  if (strategy) details.push(detail("Strategi retrieval", strategy));
  if (typeof payload.turn === "number")
    details.push(detail("Putaran agen", countLabel(payload.turn)));
  if (typeof payload.modelCall === "number")
    details.push(detail("Panggilan model", countLabel(payload.modelCall)));
  if (typeof payload.attemptNumber === "number")
    details.push(detail("Percobaan", countLabel(payload.attemptNumber)));
  if (typeof payload.remoteOutcomeKnown === "boolean")
    details.push(
      detail(
        "Kepastian hasil remote",
        payload.remoteOutcomeKnown ? "diketahui" : "belum diketahui",
      ),
    );
  else if (typeof payload.remoteOutcomeUnknown === "boolean")
    details.push(
      detail(
        "Kepastian hasil remote",
        payload.remoteOutcomeUnknown ? "belum diketahui" : "diketahui",
      ),
    );
  if (typeof payload.remoteOutcomeMayBeUnknown === "boolean")
    details.push(
      detail(
        "Hasil remote",
        payload.remoteOutcomeMayBeUnknown
          ? "mungkin belum diketahui"
          : "tidak ditandai sebagai belum diketahui",
      ),
    );
  if (event.eventType.startsWith("run.") && payload.status)
    details.push(detail("Status", String(payload.status)));
  if (!eventTypes.has(event.eventType))
    details.push(detail("Jenis event", safeEventType(event.eventType)));
  const time = formatTime(event.timestamp);
  if (time) details.push(detail("Waktu", time));

  return {
    title,
    summary,
    ...(visibleToolName ? { toolName: visibleToolName } : {}),
    ...(toolState ? { toolState } : {}),
    ...(selectedToolNames ? { selectedToolNames } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    details: details.filter((item): item is RunActivityDetail => item !== null),
  };
}
