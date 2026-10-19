import { afterEach, describe, expect, it } from "vitest";
import { PromptOptimizationVerificationSchema } from "@promptlab/contracts";

import { runPythonCandidateIsolated } from "./python-candidate-sandbox.js";
import { verifyOptimizationCase } from "./prompt-optimization-verification.js";

const fixture = {
  id: "single-cell",
  n: 1,
  blocked: [],
  expectedOutput: "1",
  expectedMatchesReference: true,
};
const fixtureInput = {
  id: fixture.id,
  n: fixture.n,
  blocked: fixture.blocked,
  expectedOutput: fixture.expectedOutput,
};

const originalProbeSecret = process.env.OPTIMIZATION_SANDBOX_PROBE_SECRET;

afterEach(() => {
  if (originalProbeSecret === undefined) {
    delete process.env.OPTIMIZATION_SANDBOX_PROBE_SECRET;
  } else {
    process.env.OPTIMIZATION_SANDBOX_PROBE_SECRET = originalProbeSecret;
  }
});

describe("isolated Python candidate execution", () => {
  it("executes a correct candidate and denies host environment, files, and network", async () => {
    process.env.OPTIMIZATION_SANDBOX_PROBE_SECRET = "must-not-be-forwarded";
    const projectFile = `${process.cwd()}/.local/optimization-feature-contract.json`;
    const answer = [
      "import os",
      "import socket",
      "def count_paths(n, blocked):",
      "    assert os.getenv('OPTIMIZATION_SANDBOX_PROBE_SECRET') is None",
      `    for path in (${JSON.stringify(projectFile)}, '/home/lenovo/.codex/RTK.md'):` ,
      "        try:",
      "            open(path).read()",
      "        except OSError:",
      "            pass",
      "        else:",
      "            raise RuntimeError('host file is visible')",
      "    connection = socket.socket()",
      "    connection.settimeout(0.2)",
      "    try:",
      "        connection.connect(('1.1.1.1', 53))",
      "    except OSError:",
      "        pass",
      "    else:",
      "        raise RuntimeError('network is available')",
      "    finally:",
      "        connection.close()",
      "    print('x' * 1000000)",
      "    print('y' * 1000000, file=__import__('sys').stderr)",
      "    return 1",
    ].join("\n");

    const result = await runPythonCandidateIsolated({
      answer,
      fixtures: [fixture],
    });

    expect(result).toMatchObject({
      status: "passed",
      reasonCode: null,
      fixtures: [{ id: "single-cell", actualOutput: "1", reasonCode: null }],
    });
  });

  it("marks a wrong candidate output as a deterministic failure", async () => {
    const verification = PromptOptimizationVerificationSchema.parse({
      kind: "python_tests",
      tests: [fixtureInput],
    });
    const result = await verifyOptimizationCase(
      "def count_paths(n, blocked):\n    return 0",
      verification,
    );

    expect(result).toMatchObject({
      kind: "python_tests",
      status: "failed",
      fixtures: [
        {
          id: "single-cell",
          actualOutput: "0",
          status: "failed",
          reasonCode: "candidate_output_does_not_match_expected",
        },
      ],
    });
  });

  it("kills an infinite loop at the per-case wall limit", async () => {
    const result = await runPythonCandidateIsolated({
      answer: "def count_paths(n, blocked):\n    while True:\n        pass",
      fixtures: [fixture],
    });

    expect(result).toMatchObject({
      status: "failed",
      reasonCode: "candidate_execution_timeout",
      fixtures: [
        {
          id: "single-cell",
          reasonCode: "candidate_execution_timeout",
        },
      ],
    });
  }, 12_000);

  it("limits candidate process creation", async () => {
    const answer = [
      "import os",
      "def count_paths(n, blocked):",
      "    children = []",
      "    for _ in range(200):",
      "        try:",
      "            child = os.fork()",
      "        except OSError:",
      "            break",
      "        if child == 0:",
      "            os._exit(0)",
      "        children.append(child)",
      "    for child in children:",
      "        os.waitpid(child, 0)",
      "    return len(children)",
    ].join("\n");
    const result = await runPythonCandidateIsolated({
      answer,
      fixtures: [fixture],
    });
    const count = Number(result.fixtures[0]?.actualOutput);

    expect(result.status).toBe("passed");
    expect(count).toBe(0);
  }, 12_000);

  it("bounds writes to the candidate result channel", async () => {
    const answer = [
      "import os",
      "def count_paths(n, blocked):",
      "    while True:",
      "        os.write(3, b'x' * 4096)",
    ].join("\n");
    const result = await runPythonCandidateIsolated({
      answer,
      fixtures: [fixture],
    });

    expect(result).toMatchObject({
      status: "failed",
      reasonCode: "candidate_execution_error",
      fixtures: [
        {
          id: "single-cell",
          actualOutput: null,
          reasonCode: "candidate_execution_error",
        },
      ],
    });
  }, 12_000);
});
