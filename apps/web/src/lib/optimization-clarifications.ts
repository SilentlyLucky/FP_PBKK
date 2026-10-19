import {
  OptimizationClarificationAnsweredEventSchema,
  OptimizationClarificationRequestedEventSchema,
  OptimizationClarificationSchema,
} from "@promptlab/contracts";

export interface StoredClarificationEvent {
  id: string;
  projectId: string;
  runId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: Date | string;
}

export interface PendingClarificationEvent extends StoredClarificationEvent {
  runStatus: string;
  runPromptId: string | null;
  runPromptVersionId: string | null;
  currentPromptVersionId: string | null;
  promptDeletedAt: Date | string | null;
  projectDeletedAt: Date | string | null;
}

export function decideClarificationPromptVersionScope(input: {
  questionPromptId: string;
  questionPromptVersionId: string;
  runPromptId: string | null;
  runPromptVersionId: string | null;
  currentPromptVersionId: string | null;
  promptDeletedAt: Date | string | null;
  projectDeletedAt: Date | string | null;
}): "active" | "snapshot" | "invalid" {
  if (
    input.promptDeletedAt !== null ||
    input.projectDeletedAt !== null ||
    input.questionPromptId !== input.runPromptId ||
    input.questionPromptVersionId !== input.runPromptVersionId
  ) {
    return "invalid";
  }

  return input.currentPromptVersionId === input.questionPromptVersionId
    ? "active"
    : "snapshot";
}

export function derivePendingClarifications(
  projectId: string,
  events: readonly PendingClarificationEvent[],
) {
  const grouped = new Map<string, PendingClarificationEvent[]>();
  for (const event of events) {
    if (event.projectId !== projectId || event.runStatus !== "queued") continue;
    const groupKey = `${event.projectId}:${event.runId}`;
    const group = grouped.get(groupKey) ?? [];
    group.push(event);
    grouped.set(groupKey, group);
  }

  const pending = [];
  for (const runEvents of grouped.values()) {
    const runId = runEvents[0]!.runId;
    const ordered = [...runEvents].sort(
      (left, right) => left.sequence - right.sequence,
    );
    const answeredIds = new Set<string>();
    for (const event of ordered) {
      if (event.eventType !== "optimization.clarification.answered") continue;
      const answer = OptimizationClarificationAnsweredEventSchema.safeParse(
        event.payload,
      );
      if (answer.success) answeredIds.add(answer.data.clarificationId);
    }

    const requests = ordered.flatMap((event) => {
      if (event.eventType !== "optimization.clarification.requested") return [];
      const question = OptimizationClarificationRequestedEventSchema.safeParse(
        event.payload,
      );
      if (!question.success || answeredIds.has(event.id)) return [];
      const promptVersionScope = decideClarificationPromptVersionScope({
        questionPromptId: question.data.promptId,
        questionPromptVersionId: question.data.promptVersionId,
        runPromptId: event.runPromptId,
        runPromptVersionId: event.runPromptVersionId,
        currentPromptVersionId: event.currentPromptVersionId,
        promptDeletedAt: event.promptDeletedAt,
        projectDeletedAt: event.projectDeletedAt,
      });
      if (promptVersionScope === "invalid") return [];
      return [{ event, question: question.data }];
    });

    // A run can wait on one answer at a time. If storage is inconsistent, do
    // not expose an ambiguous question that could not safely resume the run.
    if (requests.length !== 1) continue;
    const { event, question } = requests[0]!;
    const createdAt =
      event.createdAt instanceof Date
        ? event.createdAt.toISOString()
        : event.createdAt;
    const parsed = OptimizationClarificationSchema.safeParse({
      id: event.id,
      projectId: event.projectId,
      runId,
      promptId: question.promptId,
      promptVersionId: question.promptVersionId,
      question: question.question,
      reasonCode: question.reasonCode,
      choices: question.choices,
      publicContext: question.publicContext,
      createdAt,
      lifecycle: "awaiting_answer",
    });
    if (parsed.success) pending.push(parsed.data);
  }
  return pending;
}

export type ClarificationAnswerDecision =
  | { status: "replay" }
  | { status: "idempotency_conflict" }
  | { status: "not_found" }
  | { status: "stale" }
  | {
      status: "accept";
      question: ReturnType<
        typeof OptimizationClarificationRequestedEventSchema.parse
      >;
    };

export function decideClarificationAnswer(input: {
  events: readonly StoredClarificationEvent[];
  projectId: string;
  runId: string;
  runStatus: string;
  runPromptVersionId: string | null;
  clarificationId: string;
  idempotencyKeyHash: string;
  answerHash: string;
}): ClarificationAnswerDecision {
  const scoped = input.events.filter(
    (event) =>
      event.projectId === input.projectId && event.runId === input.runId,
  );
  const ordered = [...scoped].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const answers = ordered.flatMap((event) => {
    if (event.eventType !== "optimization.clarification.answered") return [];
    const answer = OptimizationClarificationAnsweredEventSchema.safeParse(
      event.payload,
    );
    return answer.success ? [{ event, answer: answer.data }] : [];
  });

  const reusedKey = answers.find(
    ({ answer }) => answer.idempotencyKeyHash === input.idempotencyKeyHash,
  );
  if (reusedKey) {
    return reusedKey.answer.clarificationId === input.clarificationId &&
      reusedKey.answer.answerHash === input.answerHash
      ? { status: "replay" }
      : { status: "idempotency_conflict" };
  }

  const request = ordered.find(
    (event) =>
      event.id === input.clarificationId &&
      event.eventType === "optimization.clarification.requested",
  );
  if (!request) return { status: "not_found" };
  const question = OptimizationClarificationRequestedEventSchema.safeParse(
    request.payload,
  );
  if (
    !question.success ||
    question.data.promptVersionId !== input.runPromptVersionId
  ) {
    return { status: "stale" };
  }
  if (
    input.runStatus !== "queued" ||
    answers.some(
      ({ answer }) => answer.clarificationId === input.clarificationId,
    )
  ) {
    return { status: "stale" };
  }

  const unansweredRequests = ordered.filter((event) => {
    if (event.eventType !== "optimization.clarification.requested")
      return false;
    const parsed = OptimizationClarificationRequestedEventSchema.safeParse(
      event.payload,
    );
    return (
      parsed.success &&
      parsed.data.promptVersionId === input.runPromptVersionId &&
      !answers.some(({ answer }) => answer.clarificationId === event.id)
    );
  });
  if (
    unansweredRequests.length !== 1 ||
    unansweredRequests[0]?.id !== input.clarificationId
  ) {
    return { status: "stale" };
  }
  return { status: "accept", question: question.data };
}
