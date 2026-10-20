import { describe, expect, it } from "vitest";

import {
  describeRunActivity,
  projectRunActivityPayload,
} from "./run-activity.js";

describe("run activity presentation", () => {
  it("describes a real Codex target call using its recorded provider, model, and subject", () => {
    const activity = describeRunActivity({
      sequence: 3,
      eventType: "agent.action",
      payload: {
        mode: "prompt_optimization",
        phase: "target_test",
        provider: "codex_app_server",
        model: "gpt-6-codex",
        reasoningEffort: "high",
        subject: "candidate",
        caseId: "case-private-id",
        summary: "private model reasoning must stay hidden",
      },
    });

    expect(activity).toMatchObject({
      title: "Memanggil Codex",
      summary: "Menguji prompt baru pada kasus uji yang tercatat.",
      provider: "Codex",
      model: "gpt-6-codex",
    });
    expect(JSON.stringify(activity)).not.toContain("private model reasoning");
    expect(JSON.stringify(activity)).not.toContain("case-private-id");
  });

  it("projects and presents Auto resolving to the effective max effort", () => {
    const payload = {
      phase: "target_test",
      provider: "codex_app_server",
      model: "gpt-6-luna",
      reasoningEffortSelection: "auto",
      reasoningEffort: "max",
      effortResolution: "model_specific_auto_policy",
      prompt: "private prompt",
    };
    const projected = projectRunActivityPayload("agent.action", payload);
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload,
    });

    expect(projected).toMatchObject({
      phase: "target_test",
      provider: "codex_app_server",
      model: "gpt-6-luna",
      reasoningEffortSelection: "auto",
      reasoningEffort: "max",
      effortResolution: "model_specific_auto_policy",
    });
    expect(activity.details).toContainEqual({
      label: "Mode effort",
      value: "Auto",
    });
    expect(activity.details).toContainEqual({
      label: "Effort efektif",
      value: "Maksimal",
    });
    expect(activity.details).toContainEqual({
      label: "Dasar pemilihan effort",
      value: "Kebijakan Auto model",
    });
    expect(JSON.stringify([projected, activity])).not.toContain(
      "private prompt",
    );
  });

  it("preserves the real Campus model identifier", () => {
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload: {
        phase: "senopati_decision",
        provider: "campus_gateway",
        model: "qwen3:14b",
      },
    });

    expect(activity).toMatchObject({
      provider: "Senopati",
      model: "qwen3:14b",
    });
    expect(
      projectRunActivityPayload("agent.action", { model: "qwen3:14b" }),
    ).toEqual({
      model: "qwen3:14b",
    });
  });

  it("explains the recorded retrieval phase without leaking trace identifiers", () => {
    const payload = {
      phase: "knowledge_retrieval",
      strategyRequested: "lexical",
      strategyUsed: "lexical",
      snapshotId: "private-snapshot-id",
      traceId: "private-trace-id",
      evidenceCount: 0,
      pathCount: 0,
      fallbackReason: "no_sources_selected",
      estimatedContextTokens: 24,
    };
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload,
    });

    expect(activity).toMatchObject({
      title: "Menyiapkan konteks jawaban",
      summary:
        "Tidak ada dokumen sumber yang dipilih, jadi tidak ada konteks dokumen tambahan yang dimasukkan.",
      details: [
        { label: "Pencarian yang diminta", value: "pencarian leksikal" },
        { label: "Pencarian yang dipakai", value: "pencarian leksikal" },
        { label: "Bukti sumber", value: "0" },
        { label: "Perkiraan ukuran konteks", value: "24 token" },
      ],
    });
    expect(projectRunActivityPayload("agent.action", payload)).toMatchObject({
      phase: "knowledge_retrieval",
      strategyRequested: "lexical",
      strategyUsed: "lexical",
      fallbackReason: "no_sources_selected",
      evidenceCount: 0,
      pathCount: 0,
      estimatedContextTokens: 24,
    });
    expect(JSON.stringify(activity)).not.toMatch(
      /private-snapshot-id|private-trace-id/,
    );
  });

  it("shows the Senopati-selected Auto route and an Auto lexical fallback", () => {
    const graphPayload = {
      phase: "knowledge_retrieval",
      strategyRequested: "auto",
      strategyUsed: "graph",
      retrievalReason: "senopati_selected_graph",
      evidenceCount: 2,
      pathCount: 1,
    };
    expect(
      projectRunActivityPayload("agent.action", graphPayload),
    ).toMatchObject({
      strategyRequested: "auto",
      strategyUsed: "graph",
      retrievalReason: "senopati_selected_graph",
    });
    expect(
      describeRunActivity({ eventType: "agent.action", payload: graphPayload }),
    ).toMatchObject({
      summary: "Senopati memilih GraphRAG dari opsi Auto.",
      details: expect.arrayContaining([
        { label: "Pencarian yang diminta", value: "Auto" },
        { label: "Pencarian yang dipakai", value: "GraphRAG" },
      ]),
    });

    const fallbackPayload = {
      phase: "knowledge_retrieval",
      strategyRequested: "auto",
      strategyUsed: "lexical",
      retrievalReason: "auto_graph_unavailable_during_retrieval",
      fallbackReason: "auto_graph_unavailable_during_retrieval",
      evidenceCount: 2,
    };
    expect(
      projectRunActivityPayload("agent.action", fallbackPayload),
    ).toMatchObject({
      strategyRequested: "auto",
      strategyUsed: "lexical",
      retrievalReason: "auto_graph_unavailable_during_retrieval",
      fallbackReason: "auto_graph_unavailable_during_retrieval",
    });
    expect(
      describeRunActivity({
        eventType: "agent.action",
        payload: fallbackPayload,
      }),
    ).toMatchObject({
      summary:
        "Snapshot GraphRAG berubah saat pencarian; Auto beralih ke pencarian leksikal.",
      details: expect.arrayContaining([
        { label: "Pencarian yang diminta", value: "Auto" },
        { label: "Pencarian yang dipakai", value: "pencarian leksikal" },
      ]),
    });
  });

  it.each([
    [
      "semantic_index_not_ready",
      "Indeks semantik belum siap untuk sumber terpilih",
    ],
    [
      "embedding_endpoint_not_configured",
      "Endpoint embedding Senopati belum dikonfigurasi",
    ],
    [
      "embedding_requested_model_mismatch",
      "Model yang merespons berbeda dari model embedding yang diminta",
    ],
    [
      "embedding_profile_invalid",
      "Profil embedding tidak cocok dengan indeks sumber",
    ],
    ["embedding_response_invalid", "Respons vector embedding tidak valid"],
    [
      "campus_embedding_auth_required",
      "Credential endpoint embedding ditolak atau tidak tersedia",
    ],
    [
      "campus_embedding_provider_http_error",
      "Endpoint embedding Senopati mengalami gangguan",
    ],
    [
      "campus_embedding_provider_response_invalid",
      "Endpoint embedding Senopati mengembalikan respons yang tidak valid",
    ],
    [
      "campus_embedding_provider_timeout",
      "Endpoint embedding Senopati tidak merespons tepat waktu",
    ],
  ])("explains the safe semantic fallback reason %s", (reason, expected) => {
    const payload = {
      phase: "knowledge_retrieval",
      strategyRequested: "hybrid",
      strategyUsed: "lexical",
      fallbackReason: reason,
      providerError: "private raw provider response",
    };
    const projected = projectRunActivityPayload("agent.action", payload);
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload,
    });

    expect(projected.fallbackReason).toBe(reason);
    expect(activity.summary).toContain(expected);
    expect(JSON.stringify([projected, activity])).not.toContain(
      "private raw provider response",
    );
  });

  it("shows Senopati's selected tools and the actual tool identifiers", () => {
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload: {
        mode: "prompt_optimization",
        phase: "decision",
        provider: "campus_gateway",
        model: "senopati-optimizer",
        turn: 2,
        selectedTools: ["search_knowledge", "get_graph_evidence"],
        summary: "private planning text",
      },
    });

    expect(activity.title).toBe("Senopati memilih tool");
    expect(activity.summary).toContain("Mencari sumber pengetahuan");
    expect(activity.selectedToolNames).toEqual([
      "search_knowledge",
      "get_graph_evidence",
    ]);
    expect(activity.provider).toBe("Senopati");
    expect(JSON.stringify(activity)).not.toContain("private planning text");
  });

  it("explains a saved draft without suggesting that the active prompt changed", () => {
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload: {
        phase: "draft_saved",
        draftVersionId: "private-version-id",
        summary: "private optimizer text",
      },
    });

    expect(activity).toMatchObject({
      title: "Draft prompt disimpan",
      summary:
        "Perubahan disimpan sebagai draft; prompt aktif tetap tidak berubah.",
      details: [],
    });
    expect(JSON.stringify(activity)).not.toMatch(
      /private-version-id|private optimizer text/,
    );
  });

  it("does not show a generic empty detail when an unrecognized phase is recorded", () => {
    const activity = describeRunActivity({
      eventType: "agent.action",
      payload: {
        phase: "future_internal_phase",
        selectedTools: ["search_knowledge"],
        summary: "private planning text",
      },
    });

    expect(activity.title).toBe("Aktivitas agen tercatat");
    expect(activity.summary).toBe(
      "Agen menyiapkan Mencari sumber pengetahuan untuk langkah berikutnya.",
    );
    expect(activity.details).toContainEqual({
      label: "Tahap",
      value: "future_internal_phase",
    });
    expect(JSON.stringify(activity)).not.toContain("private planning text");
  });

  it.each([
    ["lexical", "pencarian leksikal"],
    ["hybrid", "pencarian hibrida"],
    ["graph", "GraphRAG"],
  ] as const)(
    "describes %s retrieval with only its recorded result count",
    (strategy, label) => {
      const started = describeRunActivity({
        eventType: "tool.started",
        payload: {
          toolName: "search_knowledge",
          retrievalStrategy: strategy,
          argumentsSummary: {
            sourceCount: 2,
            queryCharacters: 140,
            query: "private query",
            sourceIds: ["private-source-id"],
          },
        },
      });
      const completed = describeRunActivity({
        eventType: "tool.completed",
        payload: {
          toolName: "search_knowledge",
          retrievalStrategy: strategy,
          resultSummary: { resultCount: 3, truncated: false },
        },
      });

      expect(started.title).toContain(label);
      expect(started.toolName).toBe("search_knowledge");
      expect(started.toolState).toBe("started");
      expect(started.summary).toContain("2 sumber dipilih");
      expect(completed.toolState).toBe("completed");
      expect(completed.summary).toBe("Hasil memuat 3 item.");
      expect(JSON.stringify([started, completed])).not.toContain(
        "private query",
      );
      expect(JSON.stringify([started, completed])).not.toContain(
        "private-source-id",
      );
    },
  );

  it("shows verified-memory counts and clipping without exposing query or memory content", () => {
    const started = describeRunActivity({
      eventType: "tool.started",
      payload: {
        toolName: "search_verified_memory",
        argumentsSummary: {
          queryCharacters: 42,
          query: "private search query",
          candidatePrompt: "private candidate prompt",
        },
      },
    });
    const completed = describeRunActivity({
      eventType: "tool.completed",
      payload: {
        toolName: "search_verified_memory",
        resultSummary: {
          available: true,
          reason: "context_budget_exceeded",
          resultCount: 0,
          truncated: true,
          query: "private search query",
          candidatePrompt: "private candidate prompt",
          privateGoldLabel: "private gold label",
        },
      },
    });
    const projection = projectRunActivityPayload("tool.completed", {
      toolName: "search_verified_memory",
      resultSummary: {
        available: false,
        reason: "frozen_sources_stale",
        resultCount: 0,
        truncated: false,
        query: "private search query",
        candidatePrompt: "private candidate prompt",
        privateGoldLabel: "private gold label",
      },
    });

    expect(started).toMatchObject({
      title: "Mencari memori terverifikasi",
      toolName: "search_verified_memory",
      toolState: "started",
      summary: expect.stringContaining("42 karakter"),
    });
    expect(completed).toMatchObject({
      title: "Mencari memori terverifikasi",
      toolState: "completed",
      summary:
        "Memori terverifikasi tidak masuk ke konteks karena batas ukuran tercapai.",
      details: expect.arrayContaining([
        { label: "Memori ditemukan", value: "0" },
        { label: "Alasan", value: "batas ukuran konteks tercapai" },
        { label: "Batas konteks", value: "hasil dipotong" },
      ]),
    });
    expect(projection).toEqual({
      toolName: "search_verified_memory",
      resultSummary: {
        resultCount: 0,
        truncated: false,
        available: false,
        reason: "frozen_sources_stale",
      },
    });
    expect(JSON.stringify([started, completed, projection])).not.toMatch(
      /private search query|private candidate prompt|private gold label/,
    );
  });

  it("projects legacy Campus graph-build tool metadata safely", () => {
    const started = describeRunActivity(
      {
        eventType: "tool.started",
        payload: {
          tool: "campus_graph_extraction",
          phase: "repair",
          attemptNumber: 2,
          chunkId: "private-chunk-id",
          documentVersionId: "private-version-id",
        },
      },
      { provider: "campus_gateway", purpose: "graph_indexing" },
    );
    const failed = describeRunActivity(
      {
        eventType: "tool.completed",
        payload: {
          tool: "campus_graph_extraction",
          phase: "repair",
          status: "failed",
          responseModel: "qwen3:14b",
          errorCode: "PROVIDER_TIMEOUT",
          remoteOutcomeUnknown: true,
          usageRef: "private-usage-id",
        },
      },
      { provider: "campus_gateway", purpose: "graph_indexing" },
    );

    expect(started).toMatchObject({
      title: "Mengekstrak graf sumber",
      toolName: "campus_graph_extraction",
      toolState: "started",
      provider: "Senopati",
    });
    expect(started.details).toContainEqual({ label: "Tahap", value: "repair" });
    expect(started.details).toContainEqual({ label: "Percobaan", value: "2" });
    expect(failed).toMatchObject({
      toolName: "campus_graph_extraction",
      toolState: "failed",
      model: "qwen3:14b",
      summary: "Ekstraksi graf gagal; hasil remote belum dapat dipastikan.",
    });
    expect(JSON.stringify([started, failed])).not.toMatch(
      /private-chunk-id|private-version-id|private-usage-id/,
    );
  });

  it("reports a completed agent tool failure without exposing its error text", () => {
    const activity = describeRunActivity({
      eventType: "tool.completed",
      payload: {
        toolName: "get_graph_status",
        resultSummary: {
          executionStatus: "failed",
          error: "credential=/private/provider/token",
        },
      },
    });

    expect(activity.title).toBe("Memeriksa status GraphRAG");
    expect(activity.summary).toBe(
      "Tool gagal saat dijalankan; detail kegagalan tidak dicatat.",
    );
    expect(JSON.stringify(activity)).not.toContain("credential");
    expect(JSON.stringify(activity)).not.toContain("/private/provider/token");
  });

  it("shows reported, estimated, and unavailable usage without inventing values", () => {
    const activity = describeRunActivity({
      eventType: "usage.snapshot",
      payload: {
        provider: "codex_app_server",
        purpose: "target",
        responseModel: "gpt-6-codex",
        usage: {
          inputTokens: { status: "reported", value: 1200 },
          outputTokens: { status: "estimated", value: 47 },
          cacheReadTokens: { status: "unknown", value: null },
          cacheWriteTokens: { status: "unknown", value: null },
          completeness: "partial",
          reason: "private provider payload",
        },
      },
    });

    expect(activity.title).toBe("Usage tercatat");
    expect(activity.summary).toBe(
      "Input: 1.200 dilaporkan token · output: 47 estimasi token.",
    );
    expect(activity.details).toContainEqual({
      label: "Cache dibaca",
      value: "tidak tersedia token",
    });
    expect(activity.provider).toBe("Codex");
    expect(activity.model).toBe("gpt-6-codex");
    expect(JSON.stringify(activity)).not.toContain("private provider payload");
  });

  it("handles usage events with no metrics honestly", () => {
    const activity = describeRunActivity({
      eventType: "usage.snapshot",
      payload: { provider: "campus_gateway" },
    });

    expect(activity.summary).toBe(
      "Input: tidak tersedia token · output: tidak tersedia token.",
    );
  });

  it("distinguishes queued, running, completed, incomplete, and no-change outcomes", () => {
    expect(
      describeRunActivity({
        eventType: "run.enqueue",
        payload: { status: "queued" },
      }).title,
    ).toBe("Menunggu giliran");
    expect(
      describeRunActivity({
        eventType: "run.status",
        payload: { status: "running" },
      }).title,
    ).toBe("Run mulai diproses");
    expect(
      describeRunActivity({
        eventType: "run.completed",
        payload: {
          status: "succeeded",
          mode: "prompt_optimization",
          result: {
            status: "no_change_recommended",
            candidate: { outcome: "no_change_recommended", prompt: "secret" },
          },
        },
      }).title,
    ).toBe("Tidak ada perubahan prompt yang direkomendasikan");
    expect(
      describeRunActivity({
        eventType: "run.completed",
        payload: {
          status: "succeeded",
          result: { status: "incomplete" },
        },
      }).title,
    ).toBe("Hasil optimasi belum lengkap");
    expect(
      describeRunActivity({
        eventType: "run.completed",
        payload: {
          status: "succeeded",
          result: {
            status: "candidate_ready",
            latestRevisionOutcome: "candidate_rejected",
            candidateOutcome: "candidate_ready",
          },
        },
      }).title,
    ).toBe("Kandidat prompt ditolak oleh pemeriksaan");
    expect(
      describeRunActivity(
        {
          eventType: "run.completed",
          payload: { status: "succeeded", text: "private answer" },
          timestamp: "2026-10-17T05:00:00.000Z",
        },
        { provider: "codex_app_server", model: "gpt-6-codex" },
      ),
    ).toMatchObject({
      title: "Jawaban diterima",
      provider: "Codex",
      model: "gpt-6-codex",
    });
  });

  it("keeps cancellation and unknown remote outcomes explicit", () => {
    expect(
      describeRunActivity({
        eventType: "run.failed",
        payload: {
          status: "interrupted_unknown",
          remoteOutcomeKnown: false,
        },
      }),
    ).toMatchObject({
      title: "Run terhenti; hasil provider belum diketahui",
      summary: "Koneksi berakhir sebelum hasil remote dapat dipastikan.",
    });
    expect(
      describeRunActivity({
        eventType: "run.failed",
        payload: { status: "canceled", remoteOutcomeKnown: false },
      }).summary,
    ).toBe("Run lokal berhenti; hasil remote belum dapat dipastikan.");
    expect(
      describeRunActivity({
        eventType: "run.status",
        payload: { status: "canceled", remoteOutcomeMayBeUnknown: true },
      }),
    ).toMatchObject({
      title: "Run dibatalkan",
      summary: "Run lokal berhenti; hasil remote belum dapat dipastikan.",
    });
  });

  it("explains a Senopati request that stopped before response headers", () => {
    const payload = {
      status: "interrupted_unknown",
      remoteOutcomeUnknown: true,
      errorCode: "PROVIDER_TIMEOUT",
      providerDiagnostics: {
        phase: "request_headers",
        elapsedMs: 61_080,
        transportCode: "ECONNRESET",
        request: "private raw request",
        credential: "private test credential",
      },
    };

    const projected = projectRunActivityPayload("run.failed", payload);
    const activity = describeRunActivity({
      eventType: "run.failed",
      payload,
    });

    expect(projected.providerDiagnostics).toEqual({
      phase: "request_headers",
      elapsedMs: 61_080,
      transportCode: "ECONNRESET",
    });
    expect(activity).toMatchObject({
      title: "Run terhenti; hasil provider belum diketahui",
      summary:
        "Koneksi berakhir sebelum hasil remote dapat dipastikan. Request ke gateway Senopati terputus sebelum header respons HTTP diterima setelah 61.1 detik (ECONNRESET). Gateway mungkin sudah menerima request; periksa status Run sebelum mengirim ulang.",
      details: expect.arrayContaining([
        { label: "Durasi request", value: "61,1 detik" },
        { label: "Tahap request", value: "Menunggu header respons" },
        { label: "Transport", value: "ECONNRESET" },
      ]),
    });
    expect(JSON.stringify([projected, activity])).not.toMatch(
      /private raw request|private test credential/,
    );
  });

  it("explains an HTTP response and keeps only safe provider diagnostics", () => {
    const payload = {
      status: "interrupted_unknown",
      remoteOutcomeUnknown: true,
      errorCode: "PROVIDER_HTTP_ERROR",
      providerDiagnostics: {
        phase: "response_headers",
        elapsedMs: 56_102,
        responseStatus: 504,
        responseBody: "private response body",
        apiKey: "private test credential",
      },
    };

    const projected = projectRunActivityPayload("run.failed", payload);
    const activity = describeRunActivity({
      eventType: "run.failed",
      payload,
    });

    expect(projected.providerDiagnostics).toEqual({
      phase: "response_headers",
      elapsedMs: 56_102,
      responseStatus: 504,
    });
    expect(activity).toMatchObject({
      title: "Run terhenti; hasil provider belum diketahui",
      summary:
        "Koneksi berakhir sebelum hasil remote dapat dipastikan. Gateway Senopati mengembalikan HTTP 504 setelah 56.1 detik. Hasil pemrosesan request belum diketahui; periksa status Run sebelum mengirim ulang.",
      details: expect.arrayContaining([
        { label: "Respons gateway", value: "HTTP 504" },
        { label: "Durasi request", value: "56,1 detik" },
        { label: "Tahap request", value: "Respons HTTP diterima" },
      ]),
    });
    expect(JSON.stringify([projected, activity])).not.toMatch(
      /private response body|private test credential/,
    );
  });

  it("keeps unknown and incomplete legacy fields generic and private", () => {
    const activity = describeRunActivity({
      sequence: 9,
      eventType: "authorization=Bearer hidden-value",
      payload: {
        prompt: "private prompt",
        apiKey: "sk-live-secret",
        path: "/home/person/private.txt",
        summary: "private reasoning",
      },
    });

    expect(activity.title).toBe("Peristiwa run belum dikenali");
    expect(activity.summary).toBe(
      "Jenis aktivitas ini belum dikenali. Isi payload tidak ditampilkan.",
    );
    expect(JSON.stringify(activity)).not.toMatch(
      /private prompt|sk-live-secret|\/home\/person|private reasoning|hidden-value/,
    );
  });

  it("keeps missing tool names honest instead of guessing", () => {
    const activity = describeRunActivity({
      eventType: "tool.started",
      payload: { argumentsSummary: { sourceCount: 2 } },
    });

    expect(activity.title).toBe("Tool mulai dijalankan");
    expect(activity.summary).toBe("Nama tool tidak tersedia pada event ini.");
    expect(activity.toolName).toBeUndefined();
  });

  it("projects Monitoring payloads through an allowlist", () => {
    const projected = projectRunActivityPayload("tool.started", {
      toolName: "search_knowledge",
      retrievalStrategy: "graph",
      argumentsSummary: {
        sourceCount: 2,
        queryCharacters: 12,
        query: "don't send this",
        path: "/private/file",
      },
      summary: "generated reasoning",
      token: "sk-secret",
      providerPayload: { prompt: "private" },
    });

    expect(projected).toEqual({
      retrievalStrategy: "graph",
      toolName: "search_knowledge",
      argumentsSummary: { sourceCount: 2 },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /don't send this|private\/file|generated reasoning|sk-secret|providerPayload/,
    );
  });
});
