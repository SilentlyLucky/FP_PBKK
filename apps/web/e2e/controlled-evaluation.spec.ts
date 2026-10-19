import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type Page, type Route } from "@playwright/test";
import type { ControlledEvaluationRequest } from "@promptlab/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const promptId = "22222222-2222-4222-8222-222222222222";
const baselineVersionId = "33333333-3333-4333-8333-333333333333";
const candidateVersionId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const modelId = "gpt-5.6-codex";
const sourceId = "77777777-7777-4777-8777-777777777777";
const sourceVersionId = "88888888-8888-4888-8888-888888888888";
const snapshotId = "99999999-9999-4999-8999-999999999999";
const sourceChecksum = "a".repeat(64);
const baselineHash = "1".repeat(64);
const candidateHash = "2".repeat(64);
const contextHash = "3".repeat(64);
const requestHash = "4".repeat(64);
const answerHash = "5".repeat(64);
const pairConfigHash = "6".repeat(64);
const configurationHash = "7".repeat(64);
const manifestHash = "8".repeat(64);
const inputHash = "9".repeat(64);

const controlledMetadata = {
  mode: "controlled_evaluation" as const,
  format: "promptlab-controlled-evaluation-v1" as const,
  datasetName: "Controlled QA fixture",
  datasetVersion: "2026-10",
  promptId,
  baselinePromptVersionId: baselineVersionId,
  baselinePromptHash: baselineHash,
  candidatePromptVersionId: candidateVersionId,
  candidatePromptHash: candidateHash,
  cases: [
    {
      id: "case-development",
      split: "development" as const,
      input: "Summarize the policy for development.",
      label: "Development case",
      verification: undefined,
    },
    {
      id: "case-holdout",
      split: "holdout" as const,
      input: "Summarize the policy for holdout.",
      label: "Holdout case",
      verification: undefined,
    },
  ],
  arms: [
    {
      arm: "original" as const,
      provider: "codex_app_server" as const,
      requestedModel: modelId,
      reasoningEffort: "low",
      retrieval: {
        strategy: "lexical" as const,
        sourceIds: [],
        snapshotId: null,
      },
      sources: [],
    },
    {
      arm: "rag" as const,
      provider: "codex_app_server" as const,
      requestedModel: modelId,
      reasoningEffort: "low",
      retrieval: {
        strategy: "lexical" as const,
        sourceIds: [sourceId],
        snapshotId: null,
      },
      sources: [
        {
          documentId: sourceId,
          title: "QA policy source",
          documentVersionId: sourceVersionId,
          documentVersion: 7,
          checksum: sourceChecksum,
        },
      ],
    },
    {
      arm: "graphrag" as const,
      provider: "codex_app_server" as const,
      requestedModel: modelId,
      reasoningEffort: "low",
      retrieval: {
        strategy: "graph" as const,
        sourceIds: [sourceId],
        snapshotId,
      },
      sources: [
        {
          documentId: sourceId,
          title: "QA policy source",
          documentVersionId: sourceVersionId,
          documentVersion: 7,
          checksum: sourceChecksum,
        },
      ],
    },
  ],
};

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function usage(responseId: string) {
  const metric = (value: number) => ({
    status: "reported" as const,
    value,
    observedAt: "2026-10-15T01:00:00.000Z",
    method: "controlled-evaluation-fixture",
  });
  return {
    inputTokens: metric(20),
    outputTokens: metric(10),
    cacheReadTokens: metric(0),
    cacheWriteTokens: metric(0),
    completeness: "complete" as const,
    responseId,
    mapperVersion: "fixture-v1",
  };
}

function evidencePack(
  arm: ControlledEvaluationRequest["arms"][number],
  caseId: string,
) {
  const original = arm.arm === "original";
  const graphrag = arm.arm === "graphrag";
  return {
    caseId,
    requestedStrategy: original ? ("none" as const) : arm.retrieval.strategy,
    strategyUsed: original ? ("none" as const) : arm.retrieval.strategy,
    selectedSnapshotId: graphrag ? snapshotId : null,
    usedSnapshotId: graphrag ? snapshotId : null,
    fallbackReason: null,
    selectedSourceIds: [...arm.retrieval.sourceIds],
    sourceManifest: arm.sources.map(
      ({ documentId, documentVersionId, documentVersion, checksum }) => ({
        documentId,
        documentVersionId,
        documentVersion,
        checksum,
      }),
    ),
    contextText: original ? "" : `${arm.arm} context for ${caseId}.`,
    contextHash,
    evidence: [],
    graphPaths: [],
    estimatedContextTokens: original ? 0 : 8,
    contextBudgetTokens: 4_000,
    clipping: {},
  };
}

function answer(
  promptHash: string,
  responseId: string,
  text: string,
  latencyMs: number,
) {
  return {
    status: "succeeded" as const,
    promptHash,
    requestHash,
    contextHash,
    answerHash,
    responseId,
    responseModel: modelId,
    provider: "codex_app_server" as const,
    text,
    usage: usage(responseId),
    latencyMs,
    errorCode: null,
    verificationEvidence: null,
  };
}

function missingAnswer(promptHash: string) {
  return {
    status: "failed" as const,
    promptHash,
    requestHash,
    contextHash,
    answerHash: null,
    responseId: null,
    responseModel: null,
    provider: "codex_app_server" as const,
    text: null,
    usage: null,
    latencyMs: null,
    errorCode: "FIXTURE_ANSWER_UNAVAILABLE",
    verificationEvidence: null,
  };
}

function controlledReport(
  metadata: ControlledEvaluationRequest = controlledMetadata as ControlledEvaluationRequest,
  evidenceEligible = true,
) {
  const pairs = metadata.cases.flatMap((testCase) =>
    metadata.arms.map((arm) => {
      const splitName =
        testCase.split === "development" ? "Development" : "Holdout";
      const candidateMissing =
        !evidenceEligible && testCase.split === "holdout";
      return {
        arm: arm.arm,
        caseId: testCase.id,
        split: testCase.split,
        inputHash,
        contextHash,
        pairConfigHash,
        baseline: answer(
          metadata.baselinePromptHash,
          `response-${testCase.id}-baseline`,
          `${splitName} ${arm.arm} baseline answer.`,
          120,
        ),
        candidate: candidateMissing
          ? missingAnswer(metadata.candidatePromptHash)
          : answer(
              metadata.candidatePromptHash,
              `response-${testCase.id}-candidate`,
              `${splitName} ${arm.arm} candidate answer.`,
              110,
            ),
        judgment: candidateMissing
          ? ("inconclusive" as const)
          : testCase.split === "development"
            ? ("both_passed" as const)
            : ("subjective" as const),
      };
    }),
  );
  return {
    mode: "controlled_evaluation" as const,
    status: "complete" as const,
    runId,
    attemptId,
    configurationHash,
    baselinePromptHash: metadata.baselinePromptHash,
    candidatePromptHash: metadata.candidatePromptHash,
    expectedRequestCount: metadata.cases.length * metadata.arms.length * 2,
    optimizerLineage: {
      status: "not_used" as const,
      calls: 0 as const,
      overheadMs: null,
    },
    pairs,
    manifest: {
      format: "promptlab-controlled-evaluation-manifest-v1" as const,
      manifestHash,
      runId,
      attemptId,
      configurationHash,
      baselinePromptHash: metadata.baselinePromptHash,
      candidatePromptHash: metadata.candidatePromptHash,
      cases: metadata.cases.map((testCase) => ({
        caseId: testCase.id,
        split: testCase.split,
        inputHash,
        inputCharacters: testCase.input.length,
        labelHash: null,
        verificationHash: null,
      })),
      arms: metadata.arms.map((arm) => ({
        arm: arm.arm,
        configurationHash,
        requestedModel: arm.requestedModel,
        reasoningEffort: arm.reasoningEffort,
        retrieval: arm.retrieval,
        sources: arm.sources,
        evidencePacks: metadata.cases.map((testCase) =>
          evidencePack(arm, testCase.id),
        ),
      })),
      pairs,
    },
  };
}

type FixtureOptions = {
  evidenceEligible: boolean;
  allowCreate?: boolean;
  graphSnapshot?: "active" | "missing" | "mismatched";
};

async function installControlledFixtures(
  page: Page,
  {
    evidenceEligible,
    allowCreate = false,
    graphSnapshot = "active",
  }: FixtureOptions,
) {
  const unexpectedRequests: string[] = [];
  const promptMutationRequests: string[] = [];
  const eventRequests: Array<{ method: string; lastEventId: string | null }> =
    [];
  let runRequest: Record<string, unknown> | null = null;
  let markerRequest: Record<string, unknown> | null = null;
  let decisionRequest: Record<string, unknown> | null = null;
  let activeMetadata = controlledMetadata as ControlledEvaluationRequest;
  let report = controlledReport(activeMetadata, evidenceEligible);
  let experiment: Record<string, unknown> | null = allowCreate
    ? null
    : {
        experimentId: runId,
        runId,
        status: "succeeded",
        errorSummary: null,
        evidenceEligible,
        decisionVerified: evidenceEligible,
        createdAt: "2026-10-15T01:00:00.000Z",
        decision: null,
        decisionNote: null,
        decidedAt: null,
        mode: "controlled_evaluation",
        metadata: controlledMetadata,
      };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());

    if (url.pathname === "/api/projects" && method === "GET") {
      await respond(route, {
        projects: [
          {
            id: projectId,
            name: "Controlled QA project",
            objective: "Offline controlled evaluation fixture.",
          },
        ],
      });
      return;
    }

    if (url.pathname === "/api/providers" && method === "GET") {
      await respond(route, {
        providers: [
          {
            provider: "codex_app_server",
            role: "target",
            status: "verified",
            requestedModel: modelId,
            responseModel: modelId,
            endpointLabel: "Codex fixture",
            capabilities: {},
          },
        ],
        codexModels: [
          {
            id: modelId,
            displayName: "GPT-5.6 Codex fixture",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium"],
          },
        ],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/prompts` &&
      method === "GET"
    ) {
      await respond(route, {
        prompts: [
          {
            id: promptId,
            name: "Controlled prompt",
            currentVersionId: candidateVersionId,
            version: 2,
            text: "Candidate prompt text.",
          },
        ],
      });
      return;
    }

    if (
      url.pathname ===
        `/api/projects/${projectId}/prompts/${promptId}/versions` &&
      method === "GET"
    ) {
      await respond(route, {
        versions: [
          {
            id: candidateVersionId,
            version: 2,
            text: "Candidate prompt text.",
            createdAt: "2026-10-15T00:00:00.000Z",
          },
          {
            id: baselineVersionId,
            version: 1,
            text: "Baseline prompt text.",
            createdAt: "2026-10-14T00:00:00.000Z",
          },
        ],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/knowledge` &&
      method === "GET"
    ) {
      await respond(route, {
        sources: [
          {
            id: sourceId,
            displayName: "QA policy source",
            permission: "campus_indexer_allowed",
            version: 7,
            versionId: sourceVersionId,
            checksum: sourceChecksum,
            eligible: true,
            deleted: false,
          },
        ],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/graph/snapshots` &&
      method === "GET"
    ) {
      await respond(route, {
        activeSnapshot:
          graphSnapshot === "missing"
            ? null
            : {
                id: snapshotId,
                state: "active",
                current: true,
                sourceManifest: [
                  {
                    documentId: sourceId,
                    documentVersionId: sourceVersionId,
                    checksum:
                      graphSnapshot === "mismatched"
                        ? "b".repeat(64)
                        : sourceChecksum,
                  },
                ],
              },
        snapshots: [],
      });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/experiments` &&
      method === "GET"
    ) {
      await respond(route, { experiments: experiment ? [experiment] : [] });
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs` &&
      method === "POST" &&
      allowCreate
    ) {
      runRequest = request.postDataJSON() as Record<string, unknown>;
      await respond(route, { run: { id: runId, status: "succeeded" } }, 201);
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/experiments` &&
      method === "POST" &&
      allowCreate
    ) {
      markerRequest = request.postDataJSON() as Record<string, unknown>;
      activeMetadata = markerRequest.metadata as ControlledEvaluationRequest;
      report = controlledReport(activeMetadata, evidenceEligible);
      experiment = {
        experimentId: runId,
        runId,
        status: "succeeded",
        errorSummary: null,
        evidenceEligible,
        decisionVerified: evidenceEligible,
        createdAt: "2026-10-15T01:00:00.000Z",
        decision: null,
        decisionNote: null,
        decidedAt: null,
        mode: "controlled_evaluation",
        metadata: activeMetadata,
      };
      await respond(
        route,
        {
          experiment: { experimentId: runId, runId, metadata: activeMetadata },
        },
        201,
      );
      return;
    }

    if (
      url.pathname === `/api/projects/${projectId}/runs/${runId}/events` &&
      method === "GET"
    ) {
      eventRequests.push({
        method,
        lastEventId: request.headers()["last-event-id"] ?? null,
      });
      const event = {
        id: "77777777-7777-4777-8777-777777777777",
        sequence: 4,
        timestamp: "2026-10-15T01:00:04.000Z",
        eventType: "run.completed",
        payload: {
          status: "succeeded",
          mode: "controlled_evaluation",
          controlledEvaluation: report,
        },
      };
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        body: `id: 4\nevent: run.completed\ndata: ${JSON.stringify(event)}\n\n`,
      });
      return;
    }

    if (
      url.pathname ===
        `/api/projects/${projectId}/experiments/${runId}/decision` &&
      method === "POST"
    ) {
      if (!experiment) {
        unexpectedRequests.push(`${method} ${url.pathname}`);
        await respond(route, { error: "No controlled experiment exists" }, 404);
        return;
      }
      decisionRequest = request.postDataJSON() as Record<string, unknown>;
      experiment = {
        ...experiment,
        decision: decisionRequest.decision,
        decisionNote: decisionRequest.note,
        decisionVerified:
          decisionRequest.decision !== "accepted" || evidenceEligible,
        decidedAt: "2026-10-15T01:01:00.000Z",
      };
      await respond(route, {
        experimentId: runId,
        decision: decisionRequest.decision,
        note: decisionRequest.note,
        decidedAt: "2026-10-15T01:01:00.000Z",
        sequence: 5,
      });
      return;
    }

    if (url.pathname.startsWith(`/api/projects/${projectId}/prompts`)) {
      promptMutationRequests.push(`${method} ${url.pathname}`);
    }
    unexpectedRequests.push(`${method} ${url.pathname}`);
    await respond(
      route,
      { error: "Unexpected controlled fixture request" },
      501,
    );
  });

  return {
    getDecisionRequest: () => decisionRequest,
    getRunRequest: () => runRequest,
    getMarkerRequest: () => markerRequest,
    getEventRequests: () => eventRequests,
    getPromptMutationRequests: () => promptMutationRequests,
    getActivePromptVersionId: () => candidateVersionId,
    getUnexpectedRequests: () => unexpectedRequests,
  };
}

async function fillSetupWithoutChoosingSources(page: Page) {
  await page.goto("/experiments");
  await expect(
    page.getByRole("heading", { level: 1, name: "Pengujian" }),
  ).toBeVisible();
  await page.getByLabel("Nama dataset").fill("Snapshot gate dataset");
  await page.getByLabel("Versi dataset").fill("v1");
  await page.getByLabel("Prompt yang diuji").selectOption(promptId);
  await page
    .getByLabel("Versi baseline tersimpan")
    .selectOption(baselineVersionId);
  await page
    .getByLabel("Versi kandidat tersimpan")
    .selectOption(candidateVersionId);
  await page.getByLabel("Model Codex").selectOption(modelId);
  await page.getByLabel("Kedalaman berpikir").selectOption("low");
  await page.getByLabel("Kasus development dan holdout (JSON)").fill(
    JSON.stringify([
      { id: "case-development", split: "development", input: "Development" },
      { id: "case-holdout", split: "holdout", input: "Holdout" },
    ]),
  );
}

async function openControlledReport(page: Page, expectComplete = true) {
  await page.goto("/experiments");
  await expect(
    page.getByRole("heading", { level: 1, name: "Pengujian" }),
  ).toBeVisible();
  const developmentCase = page
    .locator("details")
    .filter({
      has: page.getByText("case-development", { exact: true }),
    })
    .first();
  await expect(developmentCase).toBeVisible();
  await developmentCase.locator("summary").first().click();
  const originalDevelopmentPair = developmentCase.locator("article").first();
  await expect(
    originalDevelopmentPair.getByText("Development original baseline answer."),
  ).toBeVisible();
  await expect(
    originalDevelopmentPair.getByText("Development original candidate answer."),
  ).toBeVisible();

  const holdoutCase = page
    .locator("details")
    .filter({
      has: page.getByText("case-holdout", { exact: true }),
    })
    .first();
  await expect(holdoutCase).toBeVisible();
  await holdoutCase.locator("summary").first().click();
  const originalHoldoutPair = holdoutCase.locator("article").first();
  await expect(
    originalHoldoutPair.getByText("Holdout original baseline answer."),
  ).toBeVisible();
  if (expectComplete) {
    await expect(
      originalHoldoutPair.getByText("Holdout original candidate answer."),
    ).toBeVisible();
  } else {
    await expect(
      originalHoldoutPair.getByText("Jawaban gagal", { exact: true }),
    ).toBeVisible();
    await expect(
      originalHoldoutPair.getByText("Jawaban tidak tersedia."),
    ).toBeVisible();
  }
  await expect(page.getByText(/development/i).first()).toBeVisible();
  await expect(page.getByText(/holdout/i).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ekspor laporan JSON" }),
  ).toBeVisible();
}

test.describe("controlled evaluation UI", () => {
  test("requires an active graph snapshot and a source version covered by it", async ({
    page,
  }) => {
    await installControlledFixtures(page, {
      evidenceEligible: true,
      allowCreate: true,
      graphSnapshot: "missing",
    });
    await fillSetupWithoutChoosingSources(page);
    await expect(
      page.getByText(
        "Aktifkan snapshot graph yang sesuai sebelum memulai A/R/G.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mulai evaluasi terkontrol" }),
    ).toBeDisabled();

    await page.unrouteAll({ behavior: "wait" });
    await installControlledFixtures(page, {
      evidenceEligible: true,
      allowCreate: true,
      graphSnapshot: "mismatched",
    });
    await fillSetupWithoutChoosingSources(page);
    await expect(
      page.getByText(
        "Tidak ada sumber aktif yang versinya tercakup pada snapshot GraphRAG.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mulai evaluasi terkontrol" }),
    ).toBeDisabled();
  });

  test("renders development and holdout evidence and records inconclusive", async ({
    page,
  }) => {
    const fixture = await installControlledFixtures(page, {
      evidenceEligible: false,
    });
    await openControlledReport(page, false);

    const decision = page
      .getByRole("region", { name: "Keputusan kandidat" })
      .getByRole("combobox");
    await expect(decision.locator('option[value="accepted"]')).toHaveAttribute(
      "disabled",
      "",
    );
    const saveDecision = page.getByRole("button", { name: "Simpan keputusan" });
    await expect(saveDecision).toBeDisabled();
    expect(fixture.getDecisionRequest()).toBeNull();

    await decision.selectOption("inconclusive");
    await page
      .getByLabel("Catatan keputusan (opsional)")
      .fill("Bukti belum lengkap untuk menerima kandidat.");
    await expect(saveDecision).toBeEnabled();
    await expect(decision).toHaveValue("inconclusive");
    await saveDecision.dispatchEvent("click");
    await expect
      .poll(() => fixture.getDecisionRequest())
      .toEqual({
        decision: "inconclusive",
        note: "Bukti belum lengkap untuk menerima kandidat.",
      });
    expect(fixture.getUnexpectedRequests()).toEqual([]);
  });

  test("enables acceptance only for an evidence-eligible controlled report", async ({
    page,
  }) => {
    const fixture = await installControlledFixtures(page, {
      evidenceEligible: true,
    });
    await openControlledReport(page);

    const decision = page
      .getByRole("region", { name: "Keputusan kandidat" })
      .getByRole("combobox");
    await expect(
      decision.locator('option[value="accepted"]'),
    ).not.toHaveAttribute("disabled");
    await decision.selectOption("accepted");
    await page
      .getByLabel("Catatan keputusan (opsional)")
      .fill("Kandidat lolos bukti pasangan.");
    const saveDecision = page.getByRole("button", {
      name: "Simpan keputusan",
    });
    await expect(decision).toHaveValue("accepted");
    await saveDecision.dispatchEvent("click");
    await expect
      .poll(() => fixture.getDecisionRequest())
      .toEqual({
        decision: "accepted",
        note: "Kandidat lolos bukti pasangan.",
      });
    await expect(
      page.getByText(
        "Keputusan tersimpan. Prompt aktif tidak berubah otomatis.",
      ),
    ).toBeVisible();
    expect(fixture.getActivePromptVersionId()).toBe(candidateVersionId);
    expect(fixture.getPromptMutationRequests()).toEqual([]);
    expect(fixture.getUnexpectedRequests()).toEqual([]);
  });

  test("submits the saved batch configuration and replays and exports its report", async ({
    page,
  }) => {
    const fixture = await installControlledFixtures(page, {
      evidenceEligible: true,
      allowCreate: true,
    });
    await page.goto("/experiments");
    await expect(
      page.getByRole("heading", { level: 1, name: "Pengujian" }),
    ).toBeVisible();
    await page.getByLabel("Nama dataset").fill("Acceptance dataset");
    await page.getByLabel("Versi dataset").fill("2026-10");
    await page.getByLabel("Prompt yang diuji").selectOption(promptId);
    const baselineVersion = page.getByLabel("Versi baseline tersimpan");
    const candidateVersion = page.getByLabel("Versi kandidat tersimpan");
    await expect(baselineVersion).toBeEnabled();
    await baselineVersion.selectOption(baselineVersionId);
    await candidateVersion.selectOption(candidateVersionId);
    await page.getByLabel("Model Codex").selectOption(modelId);
    await page.getByLabel("Kedalaman berpikir").selectOption("low");
    await expect(
      page.getByRole("checkbox", { name: /^Original/ }),
    ).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /^RAG/ })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /^GraphRAG/ }),
    ).toBeChecked();
    await expect(
      page.getByText("Sumber bersama untuk RAG dan GraphRAG", { exact: true }),
    ).toBeVisible();
    await page.getByRole("checkbox", { name: /QA policy source/ }).check();
    await page.getByLabel("Kasus development dan holdout (JSON)").fill(
      JSON.stringify([
        {
          id: "case-development",
          split: "development",
          input: "Summarize the policy for development.",
        },
        {
          id: "case-holdout",
          split: "holdout",
          input: "Summarize the policy for holdout.",
        },
      ]),
    );
    await expect(
      page.getByText(
        /2 kasus × 3 arm × baseline\/kandidat = 12 panggilan target/,
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Mulai evaluasi terkontrol" })
      .click();

    await expect.poll(() => fixture.getRunRequest()).not.toBeNull();
    await expect.poll(() => fixture.getMarkerRequest()).not.toBeNull();
    expect(fixture.getRunRequest()).toMatchObject({
      projectId,
      promptVersionId: baselineVersionId,
      provider: "codex_app_server",
      requestedModel: modelId,
      reasoningEffort: "low",
      purpose: "target",
      retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
      controlledEvaluation: {
        mode: "controlled_evaluation",
        format: "promptlab-controlled-evaluation-v1",
        datasetName: "Acceptance dataset",
        datasetVersion: "2026-10",
        promptId,
        baselinePromptVersionId: baselineVersionId,
        baselinePromptHash: createHash("sha256")
          .update("Baseline prompt text.")
          .digest("hex"),
        candidatePromptVersionId: candidateVersionId,
        candidatePromptHash: createHash("sha256")
          .update("Candidate prompt text.")
          .digest("hex"),
        cases: [
          {
            id: "case-development",
            split: "development",
            input: "Summarize the policy for development.",
          },
          {
            id: "case-holdout",
            split: "holdout",
            input: "Summarize the policy for holdout.",
          },
        ],
        arms: [
          {
            arm: "original",
            provider: "codex_app_server",
            requestedModel: modelId,
            reasoningEffort: "low",
            retrieval: { strategy: "lexical", sourceIds: [], snapshotId: null },
            sources: [],
          },
          {
            arm: "rag",
            provider: "codex_app_server",
            requestedModel: modelId,
            reasoningEffort: "low",
            retrieval: {
              strategy: "lexical",
              sourceIds: [sourceId],
              snapshotId: null,
            },
            sources: [
              {
                documentId: sourceId,
                title: "QA policy source",
                documentVersionId: sourceVersionId,
                documentVersion: 7,
                checksum: sourceChecksum,
              },
            ],
          },
          {
            arm: "graphrag",
            provider: "codex_app_server",
            requestedModel: modelId,
            reasoningEffort: "low",
            retrieval: {
              strategy: "graph",
              sourceIds: [sourceId],
              snapshotId,
            },
            sources: [
              {
                documentId: sourceId,
                title: "QA policy source",
                documentVersionId: sourceVersionId,
                documentVersion: 7,
                checksum: sourceChecksum,
              },
            ],
          },
        ],
      },
    });
    expect(fixture.getMarkerRequest()).toMatchObject({
      runId,
      metadata: {
        baselinePromptVersionId: baselineVersionId,
        candidatePromptVersionId: candidateVersionId,
        cases: [
          { id: "case-development", split: "development" },
          { id: "case-holdout", split: "holdout" },
        ],
      },
    });

    await openControlledReport(page);
    expect(fixture.getEventRequests().length).toBeGreaterThan(0);
    expect(
      fixture.getEventRequests().every(({ method }) => method === "GET"),
    ).toBe(true);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Ekspor laporan JSON" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(
      "controlled-evaluation-acceptance-dataset-2026-10.json",
    );
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
      report: { runId: string; expectedRequestCount: number };
      experiment: {
        frozen: {
          baselinePromptVersionId: string;
          candidatePromptVersionId: string;
        };
      };
    };
    expect(exported.report).toMatchObject({
      runId,
      expectedRequestCount: 12,
    });
    expect(exported.experiment.frozen).toMatchObject({
      baselinePromptVersionId: baselineVersionId,
      candidatePromptVersionId: candidateVersionId,
    });
    expect(fixture.getPromptMutationRequests()).toEqual([]);
    expect(fixture.getUnexpectedRequests()).toEqual([]);
  });
});
