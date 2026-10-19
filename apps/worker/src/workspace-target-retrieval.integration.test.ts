import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import {
  GRAPH_RETRIEVAL_HARD_BOUNDS,
  captureWorkspaceSourceManifest,
  createDatabaseClient,
  createKnowledgeSource,
  isWorkspaceSourceManifestCurrent,
  replaceKnowledgeSource,
  retrieveKnowledgeContext,
  schema,
  setKnowledgeSourcePermission,
  type DatabaseClient,
  type RetrievalRequest,
} from "@promptlab/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildWorkspaceEvidenceTargetContext,
  buildWorkspaceTargetInput,
  createWorkspaceTargetEvidencePack,
} from "./workspace-graph-context.ts";
import {
  ensureWorkspaceTargetSourceRetrieval,
  resolveWorkspaceTargetRetrievalSourceIds,
  retrieveWorkspaceTargetSourceContext,
  workspaceTargetRetrievalSatisfiesTargetPreparation,
} from "./workspace-target-retrieval.ts";

const databaseUrl = process.env.PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL;
const integrationRequested =
  process.env.PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS === "1" &&
  Boolean(databaseUrl);

const originalTask =
  "Seseorang membeli barang fisik reguler, bukan produk digital atau paket Enterprise, di luar masa promo 5 hari kalender lalu. Apakah ia masih memenuhi syarat refund, dan berapa jendela refund dalam hari? Jawab persis satu objek JSON dengan field eligible (boolean) dan refundWindowDays (integer), tanpa teks lain.";
const sourceText =
  "# Refund policy\n\nFor ordinary non-Enterprise purchases of physical products bought outside a sale, refund requests are accepted up to 7 calendar days after purchase. Digital products are excluded.\n";
const storedSourceText = sourceText.replace(/\n/gu, "\r\n");
const sourceTextSha256 =
  "adbc9930f17b99b16eaee29d010a1255ad47eb6c9ec31ec83d6fc487ffd8873f";
const sourceVersionChecksum =
  "f77903f1c7ef66b00878681acccf05e67a0c9c6e44ed9a2e895396203a6f5929";
const originalTaskSha256 =
  "500bc497ca685332ae6d345dc6ef1b53d2bbf694651be804024dd2574b171f4b";
const plannerQueryFile =
  process.env.PROMPTLAB_WORKSPACE_RETRIEVAL_PLANNER_QUERY_FILE;
const plannerSearchQuery = plannerQueryFile
  ? readFileSync(plannerQueryFile, "utf8")
  : "Return a concise output schema without extra explanation.";

describe.skipIf(!integrationRequested)(
  "Workspace selected-source retrieval integration",
  () => {
    let client: DatabaseClient | undefined;
    const projectIds: string[] = [];

    beforeAll(async () => {
      const target = new URL(databaseUrl!);
      if (
        !["127.0.0.1", "localhost"].includes(target.hostname) ||
        !/^\d+$/u.test(target.port) ||
        Number(target.port) < 1 ||
        Number(target.port) > 65_535 ||
        !/^\/promptlab_knowledge_test_[a-f0-9]{32}$/iu.test(target.pathname)
      ) {
        throw new Error(
          "Workspace retrieval integration requires a UUID-named disposable database on a loopback port.",
        );
      }
      client = createDatabaseClient(databaseUrl!);
      const requiredTables = [
        "chunks",
        "document_versions",
        "documents",
        "graph_query_traces",
        "projects",
      ];
      const tables = await client.pool.query<{ tablename: string }>(
        `select tablename from pg_tables
         where schemaname = 'public' and tablename = any($1::text[])`,
        [requiredTables],
      );
      const presentTables = new Set(tables.rows.map((row) => row.tablename));
      const missingTables = requiredTables.filter(
        (table) => !presentTables.has(table),
      );
      if (missingTables.length) {
        throw new Error(
          `Disposable Workspace retrieval database is missing migrated tables: ${missingTables.join(", ")}.`,
        );
      }
    }, 15_000);

    afterAll(async () => {
      if (client) {
        for (const projectId of projectIds) {
          await client.db
            .delete(schema.projects)
            .where(eq(schema.projects.id, projectId));
        }
        await client.pool.end();
      }
    });

    async function createProject(): Promise<string> {
      if (!client) throw new Error("Database setup did not complete.");
      const suffix = randomUUID();
      const [project] = await client.db
        .insert(schema.projects)
        .values({
          ownerId: `workspace-retrieval-${suffix}`,
          name: `workspace-retrieval-${suffix}`,
        })
        .returning({ id: schema.projects.id });
      if (!project) throw new Error("Project setup failed.");
      projectIds.push(project.id);
      return project.id;
    }

    async function createSource(
      projectId: string,
      displayName: string,
      content: string,
    ) {
      if (!client) throw new Error("Database setup did not complete.");
      return createKnowledgeSource(client.db, {
        projectId,
        displayName,
        content,
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
    }

    async function captureManifest(projectId: string, sourceId: string) {
      if (!client) throw new Error("Database setup did not complete.");
      const result = await captureWorkspaceSourceManifest(
        client.db,
        projectId,
        [sourceId],
      );
      if (!result.ok) throw new Error("SOURCE_MANIFEST_CAPTURE_FAILED");
      return result.manifest;
    }

    function retrievalInput(input: {
      projectId: string;
      sourceId: string;
      sourceManifest: Awaited<ReturnType<typeof captureManifest>>;
      task?: string;
      retrieve?: (
        db: NonNullable<typeof client>["db"],
        request: RetrievalRequest,
      ) => ReturnType<typeof retrieveKnowledgeContext>;
    }) {
      if (!client) throw new Error("Database setup did not complete.");
      return {
        db: client.db,
        projectId: input.projectId,
        sourceIds: [input.sourceId],
        sourceManifest: input.sourceManifest,
        requestedStrategy: "lexical" as const,
        originalTask: input.task ?? originalTask,
        maxEstimatedContextTokens:
          GRAPH_RETRIEVAL_HARD_BOUNDS.maxEstimatedContextTokens,
        ...(input.retrieve ? { retrieve: input.retrieve } : {}),
      };
    }

    it("builds no-change target evidence from the exact selected source after task-term retrieval", async () => {
      if (!client) throw new Error("Database setup did not complete.");
      const projectId = await createProject();
      const otherProjectId = await createProject();
      const selected = await createSource(
        projectId,
        "selected-sixth-source.txt",
        storedSourceText,
      );
      const sameProjectDistractor = await createSource(
        projectId,
        "unselected-distractor.txt",
        storedSourceText,
      );
      const otherProjectSource = await createSource(
        otherProjectId,
        "other-project-source.txt",
        storedSourceText,
      );
      const sourceManifest = await captureManifest(
        projectId,
        selected.sourceId,
      );
      const requests: RetrievalRequest[] = [];
      const attempts = await retrieveWorkspaceTargetSourceContext({
        ...retrievalInput({
          projectId,
          sourceId: selected.sourceId,
          sourceManifest,
          retrieve: async (db, request) => {
            requests.push(request);
            return retrieveKnowledgeContext(db, request);
          },
        }),
      });
      const evidencePacks = attempts.map((attempt) =>
        createWorkspaceTargetEvidencePack(
          attempt.retrieval,
          "lexical",
          attempt.fallbackReason,
        ),
      );
      const targetContext = buildWorkspaceEvidenceTargetContext({
        prompt: originalTask,
        requestedStrategy: "lexical",
        sourceIds: [selected.sourceId],
        graphSnapshotId: null,
        evidencePacks,
      });
      const targetInput = buildWorkspaceTargetInput({
        targetContext,
        sourceIds: [selected.sourceId],
        sourceManifest,
      });
      const targetEvidence = targetInput.artifact.evidencePacks.flatMap(
        (pack) => pack.evidence,
      );
      const exactEvidence = targetEvidence[0];
      const fallback = attempts[1]?.retrieval;
      const retrievalRunIds = await client.db
        .select({ id: schema.graphQueryTraces.id })
        .from(schema.graphQueryTraces)
        .where(eq(schema.graphQueryTraces.projectId, projectId));

      expect(selected.checksum).toBe(sourceVersionChecksum);
      expect(createHash("sha256").update(sourceText).digest("hex")).toBe(
        sourceTextSha256,
      );
      expect(createHash("sha256").update(storedSourceText).digest("hex")).toBe(
        sourceVersionChecksum,
      );
      expect(selected.version).toBe(1);
      expect(selected.chunkCount).toBe(1);
      expect(sameProjectDistractor.sourceId).not.toBe(selected.sourceId);
      expect(otherProjectSource.sourceId).not.toBe(selected.sourceId);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.query === originalTask)).toBe(
        true,
      );
      expect(
        requests.every(
          (request) =>
            request.strategy === "lexical" &&
            request.sourceIds?.length === 1 &&
            request.sourceIds[0] === selected.sourceId,
        ),
      ).toBe(true);
      expect(requests[0]?.lexicalQueryMode).toBeUndefined();
      expect(requests[1]?.lexicalQueryMode).toBe("task_terms");
      expect(
        attempts.map((attempt) => attempt.retrieval.evidence.length),
      ).toEqual([0, 1]);
      expect(attempts[1]?.fallbackReason).toBe(
        "lexical_all_prompt_terms_no_match_task_terms_retry",
      );
      expect(attempts[0]?.retrieval.clipping.lexicalHits).toBe(0);
      expect(fallback?.clipping.lexicalQueryMode).toBe("task_terms");
      expect(fallback?.estimatedContextTokens).toBeLessThanOrEqual(
        GRAPH_RETRIEVAL_HARD_BOUNDS.maxEstimatedContextTokens,
      );
      expect(targetContext.status).toBe("evidence_included");
      expect(targetContext.fallbackReason).toBe(
        "lexical_all_prompt_terms_no_match_task_terms_retry",
      );
      expect(targetInput.text.includes(storedSourceText)).toBe(true);
      expect(targetInput.artifact.evidenceStatus).toBe("evidence_included");
      expect(targetInput.artifact.sourceIds).toEqual([selected.sourceId]);
      expect(
        JSON.stringify(targetInput.artifact.sourceManifest) ===
          JSON.stringify(sourceManifest.sources),
      ).toBe(true);
      expect(targetInput.artifact.targetInput).toBe(targetInput.text);
      expect(targetEvidence).toHaveLength(1);
      expect(
        exactEvidence?.documentId === selected.sourceId &&
          exactEvidence.documentId !== sameProjectDistractor.sourceId &&
          exactEvidence.documentId !== otherProjectSource.sourceId,
      ).toBe(true);
      expect(
        exactEvidence?.quote === storedSourceText &&
          exactEvidence.sourceChecksum === selected.checksum &&
          exactEvidence.documentVersionId ===
            sourceManifest.sources[0]?.documentVersionId &&
          exactEvidence.documentVersion ===
            sourceManifest.sources[0]?.documentVersion &&
          exactEvidence.chunkId === fallback?.evidence[0]?.chunkId &&
          exactEvidence.evidenceId === fallback?.evidence[0]?.id &&
          exactEvidence.traceId === fallback?.traceId,
      ).toBe(true);
      expect(targetInput.artifact.traceIds).toEqual(
        attempts.map((attempt) => attempt.retrieval.traceId),
      );
      expect(retrievalRunIds).toHaveLength(2);
      expect(originalTask.length).toBe(312);
      expect(sourceText.length).toBe(197);
      expect(createHash("sha256").update(originalTask).digest("hex")).toBe(
        originalTaskSha256,
      );
    }, 30_000);

    it.each(["Berapa 2+2?", "Menurut dokumen, berapa 2+2?"])(
      "retrieves numeric evidence only from the selected source for %s",
      async (task) => {
        if (!client) throw new Error("Database setup did not complete.");
        const projectId = await createProject();
        const selectedText =
          "# Catatan aritmetika\n\nDokumen ini menyatakan bahwa 2 + 2 = 5.\n";
        const selected = await createSource(
          projectId,
          "selected-arithmetic-source.txt",
          selectedText,
        );
        const unselected = await createSource(
          projectId,
          "unselected-arithmetic-source.txt",
          "2 + 2 = 4.",
        );
        const sourceManifest = await captureManifest(
          projectId,
          selected.sourceId,
        );
        const requests: RetrievalRequest[] = [];
        const attempts = await retrieveWorkspaceTargetSourceContext({
          ...retrievalInput({
            projectId,
            sourceId: selected.sourceId,
            sourceManifest,
            task,
            retrieve: async (db, request) => {
              requests.push(request);
              return retrieveKnowledgeContext(db, request);
            },
          }),
        });

        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.lexicalQueryMode)).toEqual([
          undefined,
          "task_terms",
        ]);
        expect(
          requests.every(
            (request) =>
              request.query === task &&
              request.sourceIds?.length === 1 &&
              request.sourceIds[0] === selected.sourceId,
          ),
        ).toBe(true);
        expect(
          attempts.map((attempt) => attempt.retrieval.evidence.length),
        ).toEqual([0, 1]);
        expect(attempts[1]?.retrieval.evidence[0]).toMatchObject({
          documentId: selected.sourceId,
          chunkContent: expect.stringContaining("2 + 2 = 5"),
        });
        expect(attempts[1]?.retrieval.evidence[0]?.documentId).not.toBe(
          unselected.sourceId,
        );
      },
    );

    it("retries the original task after an empty planner search before no-change target preparation", async () => {
      if (!client) throw new Error("Database setup did not complete.");
      const projectId = await createProject();
      const selected = await createSource(
        projectId,
        "planner-search-selected-source.txt",
        storedSourceText,
      );
      const sourceManifest = await captureManifest(
        projectId,
        selected.sourceId,
      );
      const requests: RetrievalRequest[] = [];
      const retrieve = async (
        db: DatabaseClient["db"],
        request: RetrievalRequest,
      ) => {
        requests.push(request);
        return retrieveKnowledgeContext(db, request);
      };
      const retrievalInput = (
        query: string,
        sourceIds = [selected.sourceId],
      ) => ({
        db: client!.db,
        projectId,
        sourceIds,
        sourceManifest,
        requestedStrategy: "lexical" as const,
        originalTask: query,
        maxEstimatedContextTokens:
          GRAPH_RETRIEVAL_HARD_BOUNDS.maxEstimatedContextTokens,
        retrieve,
      });

      expect(plannerSearchQuery).not.toBe(originalTask);
      const plannerAttempts = await retrieveWorkspaceTargetSourceContext(
        retrievalInput(plannerSearchQuery),
      );
      const plannerEvidenceCount = plannerAttempts.reduce(
        (count, attempt) => count + attempt.retrieval.evidence.length,
        0,
      );
      expect(
        plannerAttempts.map((attempt) => attempt.retrieval.evidence.length),
      ).toEqual([0, 0]);
      expect(
        requests.map((request) => request.query === plannerSearchQuery),
      ).toEqual([true, true]);
      expect(
        requests.every(
          (request) =>
            request.strategy === "lexical" &&
            request.sourceIds?.length === 1 &&
            request.sourceIds[0] === selected.sourceId,
        ),
      ).toBe(true);
      expect(
        plannerAttempts.map(
          (attempt) => attempt.retrieval.clipping.lexicalQueryMode,
        ),
      ).toEqual(["all_prompt_terms", "task_terms"]);

      const retrievalCompleted =
        workspaceTargetRetrievalSatisfiesTargetPreparation({
          requestedStrategy: "lexical",
          retrievalQuery: plannerSearchQuery,
          originalTask,
          selectedSourceIds: [selected.sourceId],
          retrievedSourceIds: [selected.sourceId],
          evidenceCount: plannerEvidenceCount,
        });
      expect(retrievalCompleted).toBe(false);

      const evidencePacks = plannerAttempts.map((attempt) =>
        createWorkspaceTargetEvidencePack(
          attempt.retrieval,
          "lexical",
          attempt.fallbackReason,
        ),
      );
      const targetPreparationCalls: Array<{
        query: string;
        sourceIds: string[];
      }> = [];
      let originalTaskAttempts: Awaited<
        ReturnType<typeof retrieveWorkspaceTargetSourceContext>
      > = [];
      const handlers = {
        search_knowledge: async (args: {
          query: string;
          limit: number;
          sourceIds?: string[] | undefined;
        }) => {
          const sourceIds = resolveWorkspaceTargetRetrievalSourceIds(
            args.sourceIds,
            [selected.sourceId],
          );
          targetPreparationCalls.push({ query: args.query, sourceIds });
          originalTaskAttempts = await retrieveWorkspaceTargetSourceContext(
            retrievalInput(args.query, sourceIds),
          );
          for (const attempt of originalTaskAttempts) {
            evidencePacks.push(
              createWorkspaceTargetEvidencePack(
                attempt.retrieval,
                "lexical",
                attempt.fallbackReason,
              ),
            );
          }
          return {
            resultCount: originalTaskAttempts.reduce(
              (count, attempt) => count + attempt.retrieval.evidence.length,
              0,
            ),
          };
        },
      };
      const context = {
        projectId,
        signal: new AbortController().signal,
      } as never;
      await ensureWorkspaceTargetSourceRetrieval({
        requestedStrategy: "lexical",
        sourceIds: [selected.sourceId],
        retrievalCompleted,
        originalTask,
        handlers,
        context,
      });

      const targetInput = buildWorkspaceTargetInput({
        targetContext: buildWorkspaceEvidenceTargetContext({
          prompt: originalTask,
          requestedStrategy: "lexical",
          sourceIds: [selected.sourceId],
          graphSnapshotId: null,
          evidencePacks,
        }),
        sourceIds: [selected.sourceId],
        sourceManifest,
      });
      const targetEvidence = targetInput.artifact.evidencePacks.flatMap(
        (pack) => pack.evidence,
      );
      const expectedEvidence = originalTaskAttempts[1]?.retrieval.evidence[0];
      const traces = await client.db
        .select({ id: schema.graphQueryTraces.id })
        .from(schema.graphQueryTraces)
        .where(eq(schema.graphQueryTraces.projectId, projectId));

      expect(targetPreparationCalls).toHaveLength(1);
      expect(targetPreparationCalls[0]?.query === originalTask).toBe(true);
      expect(targetPreparationCalls[0]?.sourceIds).toEqual([selected.sourceId]);
      expect(requests).toHaveLength(4);
      expect(
        requests.slice(2).every((request) => request.query === originalTask),
      ).toBe(true);
      expect(
        requests
          .slice(2)
          .every(
            (request) =>
              request.sourceIds?.length === 1 &&
              request.sourceIds[0] === selected.sourceId,
          ),
      ).toBe(true);
      expect(
        originalTaskAttempts.map(
          (attempt) => attempt.retrieval.evidence.length,
        ),
      ).toEqual([0, 1]);
      expect(targetInput.text.includes(storedSourceText)).toBe(true);
      expect(targetInput.artifact.evidenceStatus).toBe("evidence_included");
      expect(targetInput.artifact.sourceIds).toEqual([selected.sourceId]);
      expect(targetInput.artifact.sourceManifest).toEqual(
        sourceManifest.sources,
      );
      expect(targetInput.artifact.targetInput).toBe(targetInput.text);
      expect(targetInput.artifact.traceIds).toEqual([
        ...plannerAttempts.map((attempt) => attempt.retrieval.traceId),
        ...originalTaskAttempts.map((attempt) => attempt.retrieval.traceId),
      ]);
      expect(targetEvidence).toHaveLength(1);
      expect(
        targetEvidence[0]?.quote === storedSourceText &&
          targetEvidence[0]?.sourceChecksum === selected.checksum &&
          targetEvidence[0]?.documentVersionId ===
            sourceManifest.sources[0]?.documentVersionId &&
          targetEvidence[0]?.documentVersion ===
            sourceManifest.sources[0]?.documentVersion &&
          targetEvidence[0]?.chunkId === expectedEvidence?.chunkId &&
          targetEvidence[0]?.evidenceId === expectedEvidence?.id &&
          targetEvidence[0]?.traceId ===
            originalTaskAttempts[1]?.retrieval.traceId,
      ).toBe(true);
      expect(traces).toHaveLength(4);
      const successfulRetrievalCompleted =
        workspaceTargetRetrievalSatisfiesTargetPreparation({
          requestedStrategy: "lexical",
          retrievalQuery: originalTask,
          originalTask,
          selectedSourceIds: [selected.sourceId],
          retrievedSourceIds: [selected.sourceId],
          evidenceCount: originalTaskAttempts.reduce(
            (count, attempt) => count + attempt.retrieval.evidence.length,
            0,
          ),
        });
      await ensureWorkspaceTargetSourceRetrieval({
        requestedStrategy: "lexical",
        sourceIds: [selected.sourceId],
        retrievalCompleted: successfulRetrievalCompleted,
        originalTask,
        handlers,
        context,
      });
      expect(targetPreparationCalls).toHaveLength(1);
      expect(requests).toHaveLength(4);
      expect(selected.checksum).toBe(sourceVersionChecksum);
      expect(createHash("sha256").update(sourceText).digest("hex")).toBe(
        sourceTextSha256,
      );
      expect(createHash("sha256").update(originalTask).digest("hex")).toBe(
        originalTaskSha256,
      );
    }, 30_000);

    it("keeps a true no-match honest and leaves an empty selection empty", async () => {
      if (!client) throw new Error("Database setup did not complete.");
      const projectId = await createProject();
      const source = await createSource(
        projectId,
        "unrelated-source.txt",
        "The satellite completes one orbit every ninety six minutes.",
      );
      const sourceManifest = await captureManifest(projectId, source.sourceId);
      const unrelatedTask =
        "What refund eligibility applies to this membership? Return exact JSON.";
      const noMatchAttempts = await retrieveWorkspaceTargetSourceContext(
        retrievalInput({
          projectId,
          sourceId: source.sourceId,
          sourceManifest,
          task: unrelatedTask,
        }),
      );
      const noMatchTarget = buildWorkspaceTargetInput({
        targetContext: buildWorkspaceEvidenceTargetContext({
          prompt: unrelatedTask,
          requestedStrategy: "lexical",
          sourceIds: [source.sourceId],
          graphSnapshotId: null,
          evidencePacks: noMatchAttempts.map((attempt) =>
            createWorkspaceTargetEvidencePack(
              attempt.retrieval,
              "lexical",
              attempt.fallbackReason,
            ),
          ),
        }),
        sourceIds: [source.sourceId],
        sourceManifest,
      });

      const emptyRequests: RetrievalRequest[] = [];
      const emptyAttempts = await retrieveWorkspaceTargetSourceContext({
        ...retrievalInput({
          projectId,
          sourceId: source.sourceId,
          sourceManifest,
          retrieve: async (db, request) => {
            emptyRequests.push(request);
            return retrieveKnowledgeContext(db, request);
          },
        }),
        sourceIds: [],
        sourceManifest: { ...sourceManifest, sources: [] },
      });
      const emptyTarget = buildWorkspaceTargetInput({
        targetContext: buildWorkspaceEvidenceTargetContext({
          prompt: unrelatedTask,
          requestedStrategy: "lexical",
          sourceIds: [],
          graphSnapshotId: null,
          evidencePacks: [],
        }),
        sourceIds: [],
        sourceManifest: { ...sourceManifest, sources: [] },
      });
      let emptySelectionSearchCalled = false;
      await ensureWorkspaceTargetSourceRetrieval({
        requestedStrategy: "lexical",
        sourceIds: [],
        retrievalCompleted: false,
        originalTask: unrelatedTask,
        handlers: {
          search_knowledge: async () => {
            emptySelectionSearchCalled = true;
            return {};
          },
        },
        context: { projectId, signal: new AbortController().signal } as never,
      });

      expect(
        noMatchAttempts.map((attempt) => attempt.retrieval.evidence.length),
      ).toEqual([0, 0]);
      expect(
        workspaceTargetRetrievalSatisfiesTargetPreparation({
          requestedStrategy: "lexical",
          retrievalQuery: unrelatedTask,
          originalTask: unrelatedTask,
          selectedSourceIds: [source.sourceId],
          retrievedSourceIds: [source.sourceId],
          evidenceCount: 0,
        }),
      ).toBe(true);
      let noMatchTargetPreparationSearchCalled = false;
      await ensureWorkspaceTargetSourceRetrieval({
        requestedStrategy: "lexical",
        sourceIds: [source.sourceId],
        retrievalCompleted: true,
        originalTask: unrelatedTask,
        handlers: {
          search_knowledge: async () => {
            noMatchTargetPreparationSearchCalled = true;
            return {};
          },
        },
        context: { projectId, signal: new AbortController().signal } as never,
      });
      expect(noMatchTargetPreparationSearchCalled).toBe(false);
      expect(noMatchTarget.artifact.evidenceStatus).toBe("no_evidence_found");
      expect(
        noMatchTarget.artifact.evidencePacks.flatMap((p) => p.evidence),
      ).toHaveLength(0);
      expect(noMatchTarget.text.includes("no evidence within its limits")).toBe(
        true,
      );
      expect(noMatchTarget.text.includes("satellite completes")).toBe(false);
      expect(emptyAttempts).toEqual([]);
      expect(emptyRequests).toHaveLength(0);
      expect(emptySelectionSearchCalled).toBe(false);
      expect(emptyTarget.artifact.evidenceStatus).toBe("not_requested");
      expect(emptyTarget.artifact.sourceIds).toEqual([]);
      expect(emptyTarget.artifact.sourceManifest).toEqual([]);
    }, 30_000);

    it("blocks stale and revoked manifests before retrieval", async () => {
      if (!client) throw new Error("Database setup did not complete.");
      const staleProjectId = await createProject();
      const staleSource = await createSource(
        staleProjectId,
        "stale-source.txt",
        "The original selected source version.",
      );
      const staleManifest = await captureManifest(
        staleProjectId,
        staleSource.sourceId,
      );
      await replaceKnowledgeSource(client.db, {
        projectId: staleProjectId,
        sourceId: staleSource.sourceId,
        displayName: "stale-source.txt",
        content: "A revised selected source version.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const staleRequests: RetrievalRequest[] = [];
      await expect(
        retrieveWorkspaceTargetSourceContext({
          ...retrievalInput({
            projectId: staleProjectId,
            sourceId: staleSource.sourceId,
            sourceManifest: staleManifest,
            retrieve: async (db, request) => {
              staleRequests.push(request);
              return retrieveKnowledgeContext(db, request);
            },
          }),
        }),
      ).rejects.toThrow("WORKSPACE_SOURCE_MANIFEST_CHANGED");

      const revokedProjectId = await createProject();
      const revokedSource = await createSource(
        revokedProjectId,
        "revoked-source.txt",
        "The source permission is revoked before retrieval.",
      );
      const revokedManifest = await captureManifest(
        revokedProjectId,
        revokedSource.sourceId,
      );
      await setKnowledgeSourcePermission(
        client.db,
        revokedProjectId,
        revokedSource.sourceId,
        "local_only",
      );
      const revokedRequests: RetrievalRequest[] = [];
      await expect(
        retrieveWorkspaceTargetSourceContext({
          ...retrievalInput({
            projectId: revokedProjectId,
            sourceId: revokedSource.sourceId,
            sourceManifest: revokedManifest,
            retrieve: async (db, request) => {
              revokedRequests.push(request);
              return retrieveKnowledgeContext(db, request);
            },
          }),
        }),
      ).rejects.toThrow("WORKSPACE_SOURCE_MANIFEST_CHANGED");

      expect(staleRequests).toHaveLength(0);
      expect(revokedRequests).toHaveLength(0);
    }, 30_000);

    it("rechecks permission after retrieval before returning target evidence", async () => {
      if (!client) throw new Error("Database setup did not complete.");
      const projectId = await createProject();
      const source = await createSource(
        projectId,
        "permission-race-source.txt",
        storedSourceText,
      );
      const sourceManifest = await captureManifest(projectId, source.sourceId);
      let targetArtifactBuilt = false;
      const requests: RetrievalRequest[] = [];

      await expect(
        retrieveWorkspaceTargetSourceContext({
          ...retrievalInput({
            projectId,
            sourceId: source.sourceId,
            sourceManifest,
            retrieve: async (db, request) => {
              requests.push(request);
              const result = await retrieveKnowledgeContext(db, request);
              await setKnowledgeSourcePermission(
                db,
                projectId,
                source.sourceId,
                "local_only",
              );
              return result;
            },
          }),
        }).then((attempts) => {
          targetArtifactBuilt = attempts.length > 0;
        }),
      ).rejects.toThrow("WORKSPACE_SOURCE_MANIFEST_CHANGED");

      expect(requests).toHaveLength(1);
      expect(targetArtifactBuilt).toBe(false);
      expect(
        await isWorkspaceSourceManifestCurrent(
          client.db,
          projectId,
          sourceManifest,
        ),
      ).toBe(false);
    }, 30_000);
  },
);
