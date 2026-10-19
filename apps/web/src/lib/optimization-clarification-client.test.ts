import { describe, expect, it } from "vitest";

import {
  newestClarification,
  optimizationRunStorageKey,
  parseProjectClarifications,
  readStoredOptimizationRun,
  writeStoredOptimizationRun,
  type StoredOptimizationRun,
} from "./optimization-clarification-client.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "22222222-2222-4222-8222-222222222222";
const promptId = "33333333-3333-4333-8333-333333333333";
const promptVersionId = "44444444-4444-4444-8444-444444444444";
const clarificationId = "55555555-5555-4555-8555-555555555555";

function clarification(overrides: Record<string, unknown> = {}) {
  return {
    id: clarificationId,
    projectId,
    runId,
    promptId,
    promptVersionId,
    question: "Untuk siapa prompt ini terutama digunakan?",
    reasonCode: "audience",
    choices: ["Mahasiswa", "Pengajar"],
    publicContext: "Audiens mengubah tingkat detail jawaban.",
    createdAt: "2026-10-15T00:00:00.000Z",
    lifecycle: "awaiting_answer",
    ...overrides,
  };
}

describe("optimization clarification recovery", () => {
  it("restores only the active run saved for the requested project", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const run: StoredOptimizationRun = {
      projectId,
      promptId,
      promptVersionId,
      runId,
      status: "queued",
      baselinePrompt: "Jawab dengan ringkas dan akurat.",
      objective: "Gunakan bahasa untuk mahasiswa baru.",
    };

    expect(writeStoredOptimizationRun(storage, run)).toBe(true);
    expect(store.has(optimizationRunStorageKey(projectId))).toBe(true);
    expect(readStoredOptimizationRun(storage, projectId)).toEqual(run);
    expect(readStoredOptimizationRun(storage, otherProjectId)).toBeNull();
  });

  it("rejects malformed or oversized saved prompt snapshots", () => {
    const malformed = {
      projectId,
      promptId,
      promptVersionId,
      runId,
      status: "queued",
      baselinePrompt: "x".repeat(100_001),
      objective: null,
    };
    expect(readStoredOptimizationRun).toBeDefined();
    expect(JSON.stringify(malformed).length > 150_000).toBe(false);
    const store = new Map([
      [optimizationRunStorageKey(projectId), JSON.stringify(malformed)],
    ]);
    expect(
      readStoredOptimizationRun(
        {
          getItem: (key) => store.get(key) ?? null,
          setItem: () => undefined,
        },
        projectId,
      ),
    ).toBeNull();
  });

  it("parses only safe pending questions owned by the requested project", () => {
    const questions = parseProjectClarifications(
      {
        clarifications: [
          clarification(),
          clarification({ projectId: otherProjectId }),
          clarification({ hiddenReasoning: "must never reach the UI" }),
          { ...clarification(), promptVersionId: "not-an-id" },
        ],
      },
      projectId,
    );

    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      projectId,
      runId,
      promptId,
      promptVersionId,
      lifecycle: "awaiting_answer",
    });
    expect(questions[0]).not.toHaveProperty("hiddenReasoning");
  });

  it("recovers the newest pending question when no local run snapshot remains", () => {
    const older = clarification({
      id: "66666666-6666-4666-8666-666666666666",
      createdAt: "2026-10-14T00:00:00.000Z",
    });
    const newer = clarification({
      id: "77777777-7777-4777-8777-777777777777",
      createdAt: "2026-10-15T00:00:00.000Z",
    });
    const questions = parseProjectClarifications(
      { clarifications: [newer, older] },
      projectId,
    );
    expect(newestClarification(questions)?.id).toBe(newer.id);
  });
});
