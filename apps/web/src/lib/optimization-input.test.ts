import { describe, expect, it } from "vitest";

import { buildOptimizationTestCases } from "./optimization-input.js";

describe("optimization test case inputs", () => {
  it("builds one bounded divisibility case with independent expected totals", () => {
    const result = buildOptimizationTestCases("Hitung nilai", {
      kind: "divisibility",
      startInclusive: "1",
      endInclusive: "100",
      includeDivisors: "3, 5",
      excludeDivisors: "7",
      expectedCount: "41",
      expectedSum: "2133",
    });

    expect(result.error).toBeNull();
    expect(result.cases).toEqual([
      {
        id: "user-example-1",
        input: "Hitung nilai",
        verification: {
          kind: "divisibility",
          startInclusive: 1,
          endInclusive: 100,
          includeDivisors: [3, 5],
          excludeDivisors: [7],
          expected: { count: "41", sum: "2133" },
        },
      },
    ]);
  });

  it("rejects missing inputs, duplicate divisors, and out-of-grid fixtures", () => {
    expect(
      buildOptimizationTestCases("", {
        kind: "python_tests",
        n: "3",
        blocked: "0, 1",
        expectedOutput: "2",
      }).error,
    ).toMatch(/contoh uji/u);

    expect(
      buildOptimizationTestCases("Hitung", {
        kind: "divisibility",
        startInclusive: "1",
        endInclusive: "10",
        includeDivisors: "2, 2",
        excludeDivisors: "",
        expectedCount: "5",
        expectedSum: "30",
      }).error,
    ).toMatch(/rentang/u);

    expect(
      buildOptimizationTestCases("Hitung jalur", {
        kind: "python_tests",
        n: "3",
        blocked: "0, 1\n3, 0",
        expectedOutput: "2",
      }).error,
    ).toMatch(/ukuran grid/u);
  });

  it("keeps the test list empty when the model should create examples", () => {
    expect(buildOptimizationTestCases("", { kind: "none" })).toEqual({
      cases: [],
      error: null,
    });
  });
});
