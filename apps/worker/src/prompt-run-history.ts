export interface PromptRunHistoryEvent {
  projectId: string;
  runId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown> | null;
}

export function summarizePromptRunHistory(input: {
  projectId: string;
  runIds: readonly string[];
  events: readonly PromptRunHistoryEvent[];
}): Array<{ id: string; summary: string }> {
  const allowedRunIds = new Set(input.runIds);
  const events = input.events
    .filter(
      (event) =>
        event.projectId === input.projectId && allowedRunIds.has(event.runId),
    )
    .sort((left, right) => left.sequence - right.sequence);
  const completionByRunId = new Map<string, Record<string, unknown>>();
  const votesByRunId = new Map<string, PromptRunHistoryEvent[]>();
  for (const event of events) {
    if (event.eventType === "run.completed" && event.payload) {
      completionByRunId.set(event.runId, event.payload);
    } else if (event.eventType === "optimization.vote" && event.payload) {
      const votes = votesByRunId.get(event.runId) ?? [];
      votes.push(event);
      votesByRunId.set(event.runId, votes);
    }
  }

  return input.runIds.flatMap((id) => {
    const payload = completionByRunId.get(id);
    const result = record(payload?.result);
    const candidate = record(result?.candidate);
    const caseResults = Array.isArray(candidate?.caseResults)
      ? candidate.caseResults
      : Array.isArray(result?.caseResults)
        ? result.caseResults
        : [];
    const answerSummaries = caseResults.flatMap((item) => {
      const answer = record(item)?.answer;
      return typeof answer === "string" && answer.trim()
        ? [answer.trim().slice(0, 1_200)]
        : [];
    });
    const legacyText =
      payload?.mode !== "prompt_optimization" &&
      typeof payload?.text === "string"
        ? payload.text.trim()
        : "";
    const voteSummaries = latestVotes(votesByRunId.get(id) ?? []).map(
      ({ candidateId, decision, note }) =>
        `Umpan balik eksplisit pengguna untuk kandidat ${candidateId}: ${decision}.${note ? ` Catatan pengguna: ${note}` : ""}`,
    );
    const summary = [
      ...voteSummaries,
      ...answerSummaries,
      ...(legacyText ? [legacyText.slice(0, 1_200)] : []),
    ]
      .slice(0, 8)
      .join("\n\n");
    return summary ? [{ id, summary: summary.slice(0, 4_000) }] : [];
  });
}

function latestVotes(events: readonly PromptRunHistoryEvent[]) {
  const byCandidate = new Map<
    string,
    { candidateId: string; decision: string; note: string }
  >();
  for (const event of events) {
    const payload = event.payload;
    if (
      !payload ||
      typeof payload.candidateId !== "string" ||
      typeof payload.decision !== "string" ||
      !["original_better", "candidate_better", "equal"].includes(
        payload.decision,
      ) ||
      typeof payload.note !== "string"
    ) {
      continue;
    }
    byCandidate.set(payload.candidateId, {
      candidateId: payload.candidateId,
      decision: payload.decision,
      note: payload.note.trim().slice(0, 500),
    });
  }
  return [...byCandidate.values()];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
