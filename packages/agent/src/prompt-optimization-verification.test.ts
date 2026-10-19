import { describe, expect, it } from "vitest";

import { PromptOptimizationVerificationSchema } from "@promptlab/contracts";

import { verifyOptimizationCase } from "./prompt-optimization-verification.js";

describe("bounded deterministic optimization verification", () => {
  it("checks an independently supplied divisibility result with exact arithmetic", async () => {
    const verification = PromptOptimizationVerificationSchema.parse({
      kind: "divisibility",
      startInclusive: 1,
      endInclusive: 1_000,
      includeDivisors: [3, 5],
      excludeDivisors: [7],
      expected: { count: "401", sum: "200995" },
    });

    expect(
      await verifyOptimizationCase(
        JSON.stringify({ count: 401, sum: "200995" }),
        verification,
      ),
    ).toEqual({
      kind: "divisibility",
      status: "passed",
      expected: { count: "401", sum: "200995" },
      reference: { count: "401", sum: "200995" },
      actual: { count: "401", sum: "200995" },
      reasonCode: null,
    });
  });

  it("distinguishes a wrong answer from a wrong expected fixture", async () => {
    const verification = PromptOptimizationVerificationSchema.parse({
      kind: "divisibility",
      startInclusive: 1,
      endInclusive: 1_000,
      includeDivisors: [3, 5],
      excludeDivisors: [7],
      expected: { count: "401", sum: "200994" },
    });

    expect(
      await verifyOptimizationCase(
        JSON.stringify({ count: 401, sum: "200994" }),
        verification,
      ),
    ).toMatchObject({
      kind: "divisibility",
      status: "invalid_fixture",
      reference: { count: "401", sum: "200995" },
      reasonCode: "expected_values_do_not_match_exact_reference",
    });

    const correctFixture = PromptOptimizationVerificationSchema.parse({
      kind: "divisibility",
      startInclusive: 1,
      endInclusive: 1_000,
      includeDivisors: [3, 5],
      excludeDivisors: [7],
      expected: { count: "401", sum: "200995" },
    });
    expect(
      await verifyOptimizationCase('{"count":401,"sum":"89773"}', correctFixture),
    ).toMatchObject({
      kind: "divisibility",
      status: "failed",
      actual: { count: "401", sum: "89773" },
      reasonCode: "answer_does_not_match_expected_values",
    });
  });

  it("reports prose answers as unverified instead of inventing a parse", async () => {
    const verification = PromptOptimizationVerificationSchema.parse({
      kind: "divisibility",
      startInclusive: 1,
      endInclusive: 1_000,
      includeDivisors: [3, 5],
      excludeDivisors: [7],
      expected: { count: "401", sum: "200995" },
    });

    expect(
      await verifyOptimizationCase(
        "There are 401 values and their sum is 200995.",
        verification,
      ),
    ).toMatchObject({
      kind: "divisibility",
      status: "failed",
      actual: null,
      reasonCode: "answer_must_be_a_json_object_with_exact_count_and_sum",
    });
  });

  it("executes the candidate against independent count_paths fixtures", async () => {
    const verification = PromptOptimizationVerificationSchema.parse({
      kind: "python_tests",
      tests: [
        { id: "unit-grid", n: 1, blocked: [], expectedOutput: "1" },
        {
          id: "blocked-start",
          n: 2,
          blocked: [{ row: 0, column: 0 }],
          expectedOutput: "0",
        },
        {
          id: "blocked-center",
          n: 3,
          blocked: [{ row: 1, column: 1 }],
          expectedOutput: "2",
        },
        {
          id: "empty-35-grid",
          n: 35,
          blocked: [],
          expectedOutput: "28453041475240576740",
        },
      ],
    });

    expect(
      await verifyOptimizationCase(
        "def count_paths(n, blocked):\n    assert isinstance(blocked, set)\n    if (0, 0) in blocked or (n - 1, n - 1) in blocked:\n        return 0\n    paths = [0] * n\n    paths[0] = 1\n    for row in range(n):\n        for column in range(n):\n            if (row, column) in blocked:\n                paths[column] = 0\n            elif column:\n                paths[column] += paths[column - 1]\n    return paths[-1]",
        verification,
      ),
    ).toMatchObject({
      kind: "python_tests",
      status: "passed",
      execution: {
        status: "passed",
        reasonCode: null,
      },
      fixtures: [
        {
          id: "unit-grid",
          expectedOutput: "1",
          referenceOutput: "1",
          expectedMatchesReference: true,
          actualOutput: "1",
          status: "passed",
        },
        {
          id: "blocked-start",
          expectedOutput: "0",
          referenceOutput: "0",
          expectedMatchesReference: true,
          actualOutput: "0",
          status: "passed",
        },
        {
          id: "blocked-center",
          expectedOutput: "2",
          referenceOutput: "2",
          expectedMatchesReference: true,
          actualOutput: "2",
          status: "passed",
        },
        {
          id: "empty-35-grid",
          expectedOutput: "28453041475240576740",
          referenceOutput: "28453041475240576740",
          expectedMatchesReference: true,
          actualOutput: "28453041475240576740",
          status: "passed",
        },
      ],
    });
  });

  it("preserves invalid-fixture disagreement even when candidate code runs", async () => {
    const verification = PromptOptimizationVerificationSchema.parse({
      kind: "python_tests",
      tests: [
        { id: "valid", n: 1, blocked: [], expectedOutput: "1" },
        { id: "wrong-reference", n: 2, blocked: [], expectedOutput: "3" },
      ],
    });
    const evidence = await verifyOptimizationCase(
      "def count_paths(n, blocked):\n    return 1",
      verification,
    );

    expect(evidence).toMatchObject({
      kind: "python_tests",
      status: "invalid_fixture",
      fixtures: [
        { id: "valid", status: "passed", actualOutput: "1" },
        {
          id: "wrong-reference",
          status: "invalid_fixture",
          expectedMatchesReference: false,
          actualOutput: null,
          reasonCode: "expected_values_do_not_match_exact_reference",
        },
      ],
    });
  });

  it("rejects unbounded or inconsistent verification fixtures", () => {
    expect(
      PromptOptimizationVerificationSchema.safeParse({
        kind: "divisibility",
        startInclusive: 1,
        endInclusive: 1_000,
        includeDivisors: [3, 3],
        excludeDivisors: [],
        expected: { count: "401", sum: "200995" },
      }).success,
    ).toBe(false);
    expect(
      PromptOptimizationVerificationSchema.safeParse({
        kind: "python_tests",
        tests: [
          {
            id: "outside-grid",
            n: 2,
            blocked: [{ row: 2, column: 0 }],
            expectedOutput: "0",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
