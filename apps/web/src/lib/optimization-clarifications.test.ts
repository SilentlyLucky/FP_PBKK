import { describe, expect, it } from "vitest";

import {
  decideClarificationAnswer,
  decideClarificationPromptVersionScope,
  derivePendingClarifications,
  type PendingClarificationEvent,
  type StoredClarificationEvent,
} from "./optimization-clarifications.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "22222222-2222-4222-8222-222222222222";
const promptId = "33333333-3333-4333-8333-333333333333";
const promptVersionId = "44444444-4444-4444-8444-444444444444";
const nextPromptVersionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const clarificationId = "55555555-5555-4555-8555-555555555555";
const answerId = "66666666-6666-4666-8666-666666666666";
const keyHash = "a".repeat(64);
const answerHash = "b".repeat(64);

function requestedEvent(
  overrides: Partial<StoredClarificationEvent> = {},
): StoredClarificationEvent {
  return {
    id: clarificationId,
    projectId,
    runId,
    sequence: 2,
    eventType: "optimization.clarification.requested",
    payload: {
      promptId,
      promptVersionId,
      question: "Untuk siapa prompt ini terutama digunakan?",
      reasonCode: "audience",
      choices: ["Mahasiswa", "Pengajar"],
      publicContext: "Audiens mengubah tingkat detail jawaban.",
    },
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

function answeredEvent(
  overrides: Partial<StoredClarificationEvent> = {},
): StoredClarificationEvent {
  return {
    id: answerId,
    projectId,
    runId,
    sequence: 3,
    eventType: "optimization.clarification.answered",
    payload: {
      clarificationId,
      answer: "Untuk mahasiswa tingkat awal.",
      promptId,
      promptVersionId,
      idempotencyKeyHash: keyHash,
      answerHash,
    },
    createdAt: "2026-10-15T00:01:00.000Z",
    ...overrides,
  };
}

function pendingEvent(
  event: StoredClarificationEvent,
  overrides: Partial<PendingClarificationEvent> = {},
): PendingClarificationEvent {
  return {
    ...event,
    runStatus: "queued",
    runPromptId: promptId,
    runPromptVersionId: promptVersionId,
    currentPromptVersionId: promptVersionId,
    promptDeletedAt: null,
    projectDeletedAt: null,
    ...overrides,
  };
}

describe("optimization clarification lifecycle", () => {
  it("recovers a pinned snapshot question and filters invalid prompt scopes", () => {
    const question = requestedEvent();
    const crossProject = requestedEvent({
      id: "77777777-7777-4777-8777-777777777777",
      projectId: otherProjectId,
      runId: "88888888-8888-4888-8888-888888888888",
    });
    const items = derivePendingClarifications(projectId, [
      pendingEvent(question, { currentPromptVersionId: nextPromptVersionId }),
      pendingEvent(
        requestedEvent({ id: "99999999-9999-4999-8999-999999999999" }),
        { runStatus: "succeeded" },
      ),
      pendingEvent(
        requestedEvent({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        { runPromptVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      ),
      pendingEvent(crossProject),
      pendingEvent(
        requestedEvent({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          payload: {
            ...(requestedEvent().payload as object),
            promptId: otherProjectId,
          },
        }),
      ),
      pendingEvent(
        requestedEvent({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
        { promptDeletedAt: "2026-10-15T00:00:00.000Z" },
      ),
      pendingEvent(
        requestedEvent({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
        { projectDeletedAt: "2026-10-15T00:00:00.000Z" },
      ),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: clarificationId,
      projectId,
      runId,
      promptId,
      promptVersionId,
      lifecycle: "awaiting_answer",
      question: "Untuk siapa prompt ini terutama digunakan?",
    });
    expect(items[0]).not.toHaveProperty("hiddenReasoning");
  });

  it("accepts the run's pinned version after the active prompt advances", () => {
    expect(
      decideClarificationPromptVersionScope({
        questionPromptId: promptId,
        questionPromptVersionId: promptVersionId,
        runPromptId: promptId,
        runPromptVersionId: promptVersionId,
        currentPromptVersionId: nextPromptVersionId,
        promptDeletedAt: null,
        projectDeletedAt: null,
      }),
    ).toBe("snapshot");
    expect(
      decideClarificationPromptVersionScope({
        questionPromptId: promptId,
        questionPromptVersionId: promptVersionId,
        runPromptId: promptId,
        runPromptVersionId: promptVersionId,
        currentPromptVersionId: nextPromptVersionId,
        promptDeletedAt: new Date(),
        projectDeletedAt: null,
      }),
    ).toBe("invalid");
  });

  it("accepts a fresh answer, replays the same key and rejects key reuse or stale scope", () => {
    const base = {
      events: [requestedEvent()],
      projectId,
      runId,
      runStatus: "queued",
      runPromptVersionId: promptVersionId,
      clarificationId,
      idempotencyKeyHash: keyHash,
      answerHash,
    };
    expect(decideClarificationAnswer(base).status).toBe("accept");
    expect(
      decideClarificationAnswer({
        ...base,
        events: [requestedEvent(), answeredEvent()],
      }).status,
    ).toBe("replay");
    expect(
      decideClarificationAnswer({
        ...base,
        answerHash: "c".repeat(64),
        events: [requestedEvent(), answeredEvent()],
      }).status,
    ).toBe("idempotency_conflict");
    expect(
      decideClarificationAnswer({
        ...base,
        events: [
          requestedEvent(),
          answeredEvent({
            payload: {
              ...(answeredEvent().payload as object),
              idempotencyKeyHash: "d".repeat(64),
            },
          }),
        ],
      }).status,
    ).toBe("stale");
    expect(
      decideClarificationAnswer({
        ...base,
        runPromptVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }).status,
    ).toBe("stale");
    expect(
      decideClarificationAnswer({
        ...base,
        events: [requestedEvent({ projectId: otherProjectId })],
      }).status,
    ).toBe("not_found");
  });
});
