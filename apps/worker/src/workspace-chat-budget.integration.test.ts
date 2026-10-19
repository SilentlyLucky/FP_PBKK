import { describe, expect, it } from "vitest";

import { AgentBudgetSchema } from "@promptlab/contracts";
import { WORKSPACE_CHAT_BUDGET } from "@promptlab/agent";
import { AgentBudgetLedger } from "@promptlab/tools";

describe("Workspace chat budget contract and ledger", () => {
  it("accepts and enforces all five decision turns required by the chat flow", () => {
    const parsed = AgentBudgetSchema.parse(WORKSPACE_CHAT_BUDGET);
    expect(parsed.maxDecisionTurns).toBe(5);

    const now = Date.now();
    const ledger = new AgentBudgetLedger(parsed, now);
    for (let turn = 0; turn < parsed.maxDecisionTurns; turn += 1) {
      ledger.beginDecisionTurn(now + turn);
    }

    expect(ledger.decisionTurnCount).toBe(5);
    expect(() => ledger.beginDecisionTurn(now + 6)).toThrow(
      "Decision-turn budget exhausted",
    );
  });
});
