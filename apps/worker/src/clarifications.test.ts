import { describe, expect, it } from "vitest";

import {
  readClarificationContext,
  shouldSkipQueuedRunForClarification,
  type WorkerClarificationEvent,
} from "./clarifications.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const promptId = "33333333-3333-4333-8333-333333333333";
const promptVersionId = "44444444-4444-4444-8444-444444444444";
const clarificationId = "55555555-5555-4555-8555-555555555555";

const requested: WorkerClarificationEvent = {
  id: clarificationId,
  projectId,
  runId,
  sequence: 5,
  eventType: "optimization.clarification.requested",
  payload: {
    promptId,
    promptVersionId,
    question: "Untuk siapa prompt ini terutama digunakan?",
    reasonCode: "audience",
    choices: ["Mahasiswa", "Pengajar"],
    publicContext: "Audiens mengubah tingkat detail jawaban.",
  },
};

const answered: WorkerClarificationEvent = {
  id: "66666666-6666-4666-8666-666666666666",
  projectId,
  runId,
  sequence: 6,
  eventType: "optimization.clarification.answered",
  payload: {
    clarificationId,
    answer: "Untuk mahasiswa tingkat awal.",
    promptId,
    promptVersionId,
    idempotencyKeyHash: "a".repeat(64),
    answerHash: "b".repeat(64),
  },
};

describe("worker clarification guards", () => {
  it("parks a queued run until its exact prompt-version question is answered", () => {
    expect(
      shouldSkipQueuedRunForClarification({
        projectId,
        runId,
        status: "queued",
        events: [requested],
      }),
    ).toBe(true);
    expect(
      shouldSkipQueuedRunForClarification({
        projectId,
        runId,
        status: "queued",
        events: [requested, answered],
      }),
    ).toBe(false);
    expect(
      shouldSkipQueuedRunForClarification({
        projectId,
        runId,
        status: "running",
        events: [requested],
      }),
    ).toBe(false);
  });

  it("loads accepted answers only from the same project, run, and prompt version", () => {
    expect(
      readClarificationContext({
        projectId,
        runId,
        events: [requested, answered],
      }),
    ).toEqual([
      {
        question: "Untuk siapa prompt ini terutama digunakan?",
        answer: "Untuk mahasiswa tingkat awal.",
      },
    ]);
    expect(
      readClarificationContext({
        projectId,
        runId,
        events: [
          requested,
          {
            ...answered,
            payload: {
              ...(answered.payload as Record<string, unknown>),
              promptVersionId: "77777777-7777-4777-8777-777777777777",
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});
