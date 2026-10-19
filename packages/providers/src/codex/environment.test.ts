import { describe, expect, it } from "vitest";

import { createCodexCliEnvironment } from "./environment.js";

describe("createCodexCliEnvironment", () => {
  it("keeps runtime and official Codex home paths while excluding provider credentials and routes", () => {
    const result = createCodexCliEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/home/tester/.codex",
      PROMPTLAB_CAMPUS_API_KEY: "never-copy",
      PROMPTLAB_CAMPUS_MODEL: "qwen3:14b",
      OPENAI_API_KEY: "never-copy",
      OPENAI_BASE_URL: "https://custom-provider.invalid/v1",
      ANTHROPIC_API_KEY: "never-copy",
      HTTPS_PROXY: "https://proxy.invalid",
      NODE_OPTIONS: "--require custom-provider.js",
    });

    expect(result).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/home/tester/.codex",
    });
  });
});
