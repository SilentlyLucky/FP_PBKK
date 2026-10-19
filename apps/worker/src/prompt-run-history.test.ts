import { describe, expect, it } from "vitest";

import { summarizePromptRunHistory } from "./prompt-run-history.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "22222222-2222-4222-8222-222222222222";

describe("prompt optimization feedback history", () => {
  it("remembers only scoped explicit quality choices and notes without inventing scores", () => {
    const history = summarizePromptRunHistory({
      projectId,
      runIds: [runId],
      events: [
        {
          projectId,
          runId,
          sequence: 4,
          eventType: "run.completed",
          payload: {
            mode: "prompt_optimization",
            result: {
              candidate: {
                caseResults: [{ answer: "Jawaban kandidat sebelumnya." }],
              },
            },
          },
        },
        {
          projectId,
          runId,
          sequence: 5,
          eventType: "optimization.vote",
          payload: {
            candidateId: "candidate-1",
            decision: "candidate_better",
            note: "Pertahankan istilah teknis.",
          },
        },
        {
          projectId: otherProjectId,
          runId,
          sequence: 6,
          eventType: "optimization.vote",
          payload: {
            candidateId: "candidate-2",
            decision: "original_better",
            note: "Tidak relevan ke proyek ini.",
          },
        },
        {
          projectId,
          runId: "99999999-9999-4999-8999-999999999999",
          sequence: 7,
          eventType: "optimization.vote",
          payload: {
            candidateId: "candidate-3",
            decision: "equal",
            note: "Run lain.",
          },
        },
      ],
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.summary).toContain("candidate_better");
    expect(history[0]?.summary).toContain("Pertahankan istilah teknis.");
    expect(history[0]?.summary).toContain("Jawaban kandidat sebelumnya.");
    expect(history[0]?.summary).not.toContain("Tidak relevan ke proyek ini");
    expect(history[0]?.summary).not.toMatch(/score|qualityScore|nilai\s*:/i);
  });
});
