import {
  OptimizationClarificationAnsweredEventSchema,
  OptimizationClarificationRequestedEventSchema,
} from "@promptlab/contracts";

export interface WorkerClarificationEvent {
  id: string;
  projectId: string;
  runId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
}

export function shouldSkipQueuedRunForClarification(input: {
  projectId: string;
  runId: string;
  status: string;
  events: readonly WorkerClarificationEvent[];
}): boolean {
  if (input.status !== "queued") return false;
  const events = input.events.filter(
    (event) =>
      event.projectId === input.projectId && event.runId === input.runId,
  );
  const requests = new Map<
    string,
    ReturnType<typeof OptimizationClarificationRequestedEventSchema.parse>
  >();
  for (const event of events) {
    if (event.eventType !== "optimization.clarification.requested") continue;
    const parsed = OptimizationClarificationRequestedEventSchema.safeParse(
      event.payload,
    );
    if (parsed.success) requests.set(event.id, parsed.data);
  }
  const answered = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "optimization.clarification.answered") continue;
    const parsed = OptimizationClarificationAnsweredEventSchema.safeParse(
      event.payload,
    );
    if (!parsed.success) continue;
    const question = requests.get(parsed.data.clarificationId);
    if (
      question &&
      question.promptId === parsed.data.promptId &&
      question.promptVersionId === parsed.data.promptVersionId
    ) {
      answered.add(parsed.data.clarificationId);
    }
  }
  return [...requests.keys()].some((id) => !answered.has(id));
}

export function readClarificationContext(input: {
  projectId: string;
  runId: string;
  events: readonly WorkerClarificationEvent[];
}): Array<{ question: string; answer: string }> {
  const events = input.events
    .filter(
      (event) =>
        event.projectId === input.projectId && event.runId === input.runId,
    )
    .sort((left, right) => left.sequence - right.sequence);
  const questions = new Map<
    string,
    { promptId: string; promptVersionId: string; question: string }
  >();
  for (const event of events) {
    if (event.eventType !== "optimization.clarification.requested") continue;
    const parsed = OptimizationClarificationRequestedEventSchema.safeParse(
      event.payload,
    );
    if (parsed.success) {
      questions.set(event.id, {
        promptId: parsed.data.promptId,
        promptVersionId: parsed.data.promptVersionId,
        question: parsed.data.question,
      });
    }
  }
  return events.flatMap((event) => {
    if (event.eventType !== "optimization.clarification.answered") return [];
    const answer = OptimizationClarificationAnsweredEventSchema.safeParse(
      event.payload,
    );
    if (!answer.success) return [];
    const question = questions.get(answer.data.clarificationId);
    if (
      !question ||
      question.promptId !== answer.data.promptId ||
      question.promptVersionId !== answer.data.promptVersionId
    ) {
      return [];
    }
    return [{ question: question.question, answer: answer.data.answer }];
  });
}
