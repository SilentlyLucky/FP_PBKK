import { describe, expect, it } from "vitest";

import {
  codexInstructionSourceEvidence,
  unconfirmedCodexToolControls,
} from "./restrictions.js";

const SCRATCH_DIRECTORY = "/tmp/promptlab-codex-scratch";

const RECOGNIZED_RESTRICTED_CONFIG = {
  config: {
    features: {
      shell_tool: false,
      unified_exec: false,
      multi_agent: false,
      apps: false,
    },
    web_search: "disabled",
    mcp_servers: {},
    approval_policy: "never",
    sandbox_mode: "read-only",
    project_doc_max_bytes: 0,
  },
};

describe("Codex config and instruction evidence contract", () => {
  it("accepts documented restrictions without requiring an unreported view_image setting", () => {
    expect(unconfirmedCodexToolControls(RECOGNIZED_RESTRICTED_CONFIG)).toEqual(
      [],
    );
  });

  it("still rejects missing documented runtime restrictions", () => {
    const config = RECOGNIZED_RESTRICTED_CONFIG.config;

    expect(
      unconfirmedCodexToolControls({
        config: {
          ...config,
          features: { ...config.features, multi_agent: true },
          project_doc_max_bytes: undefined,
        },
      }),
    ).toEqual(["features.multi_agent", "project_doc_max_bytes"]);
  });

  it("does not treat an unreported view_image setting as a required control", () => {
    const config = RECOGNIZED_RESTRICTED_CONFIG.config;

    expect(
      unconfirmedCodexToolControls({
        config: { ...config, tools: undefined },
      }),
    ).toEqual([]);
  });

  it("distinguishes unreported instruction sources from an empty report", () => {
    expect(codexInstructionSourceEvidence({}, SCRATCH_DIRECTORY)).toBe(
      "unreported",
    );
    expect(
      codexInstructionSourceEvidence(
        { instructionSources: [] },
        SCRATCH_DIRECTORY,
      ),
    ).toBe("reported-empty");
  });

  it("accepts only reported instruction sources scoped to the per-run scratch", () => {
    expect(
      codexInstructionSourceEvidence(
        {
          instructionSources: [
            `${SCRATCH_DIRECTORY}/AGENTS.md`,
            `${SCRATCH_DIRECTORY}/nested/AGENTS.md`,
          ],
        },
        SCRATCH_DIRECTORY,
      ),
    ).toBe("reported-scoped");
    expect(
      codexInstructionSourceEvidence(
        { instructionSources: ["/tmp/another-project/AGENTS.md"] },
        SCRATCH_DIRECTORY,
      ),
    ).toBe("external");
    expect(
      codexInstructionSourceEvidence(
        { instructionSources: [null] },
        SCRATCH_DIRECTORY,
      ),
    ).toBe("malformed");
  });
});
