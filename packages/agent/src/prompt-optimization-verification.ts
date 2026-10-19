import type {
  PromptOptimizationTestCase,
  PromptOptimizationVerification,
} from "@promptlab/contracts";
import { PromptOptimizationVerificationSchema } from "@promptlab/contracts";

import { runPythonCandidateIsolated } from "./python-candidate-sandbox.js";

export type OptimizationVerificationEvidence =
  | {
      kind: "divisibility";
      status: "passed" | "failed" | "unavailable" | "invalid_fixture";
      expected: { count: string; sum: string };
      reference: { count: string; sum: string };
      actual: { count: string | null; sum: string | null } | null;
      reasonCode: string | null;
    }
  | {
      kind: "python_tests";
      status: "passed" | "failed" | "unavailable" | "invalid_fixture";
      execution: {
        status: "passed" | "failed" | "unavailable";
        reasonCode: string | null;
      };
      limitations: ["complexity_not_proved_by_behavioral_tests"];
      fixtures: Array<{
        id: string;
        expectedOutput: string;
        referenceOutput: string;
        expectedMatchesReference: boolean;
        actualOutput: string | null;
        status: "passed" | "failed" | "unavailable" | "invalid_fixture";
        reasonCode: string | null;
      }>;
    };

type DivisibilityVerification = Extract<
  PromptOptimizationVerification,
  { kind: "divisibility" }
>;
type PythonTestsVerification = Extract<
  PromptOptimizationVerification,
  { kind: "python_tests" }
>;

/** Verifies structured results locally and runs Python only in the isolated sandbox. */
export async function verifyOptimizationCase(
  answer: string | null,
  verification: PromptOptimizationTestCase["verification"],
): Promise<OptimizationVerificationEvidence | null> {
  if (!verification) return null;
  if (verification.kind === "divisibility") {
    return Promise.resolve(verifyDivisibility(answer, verification));
  }
  return verifyPythonFixtures(answer, verification);
}

/**
 * Checks persisted verification evidence without re-running a candidate.
 * The response hash is bound separately by the evaluation manifest.
 */
export function isOptimizationVerificationEvidenceConsistent(input: {
  answer: string;
  verification: unknown;
  evidence: unknown;
  requirePass: boolean;
}): boolean {
  const parsed = PromptOptimizationVerificationSchema.safeParse(
    input.verification,
  );
  if (!parsed.success) return false;

  if (parsed.data.kind === "divisibility") {
    const expected = verifyDivisibility(input.answer, parsed.data);
    return (
      canonicalJson(expected) === canonicalJson(input.evidence) &&
      (!input.requirePass || expected.status === "passed")
    );
  }

  const evidence = asRecord(input.evidence);
  if (
    !evidence ||
    evidence.kind !== "python_tests" ||
    !Array.isArray(evidence.fixtures) ||
    !Array.isArray(evidence.limitations) ||
    evidence.limitations.length !== 1 ||
    evidence.limitations[0] !==
      "complexity_not_proved_by_behavioral_tests"
  ) {
    return false;
  }
  const execution = asRecord(evidence.execution);
  if (
    !execution ||
    !["passed", "failed", "unavailable"].includes(
      String(execution.status),
    ) ||
    (execution.reasonCode !== null &&
      typeof execution.reasonCode !== "string")
  ) {
    return false;
  }

  const expectedFixtures = parsed.data.tests.map((test) => {
    const referenceOutput = countPathsReference(
      test.n,
      test.blocked.map(({ row, column }) => [row, column] as const),
    );
    return {
      id: test.id,
      expectedOutput: test.expectedOutput,
      referenceOutput,
      expectedMatchesReference: test.expectedOutput === referenceOutput,
    };
  });
  if (
    evidence.fixtures.length !== expectedFixtures.length ||
    new Set(
      evidence.fixtures.flatMap((fixture) => {
        const item = asRecord(fixture);
        return typeof item?.id === "string" ? [item.id] : [];
      }),
    ).size !== expectedFixtures.length
  ) {
    return false;
  }

  let hasInvalidFixture = false;
  let allFixturesPassed = true;
  for (const expected of expectedFixtures) {
    const fixture = evidence.fixtures
      .map(asRecord)
      .find((item) => item?.id === expected.id);
    if (
      !fixture ||
      fixture.expectedOutput !== expected.expectedOutput ||
      fixture.referenceOutput !== expected.referenceOutput ||
      fixture.expectedMatchesReference !== expected.expectedMatchesReference
    ) {
      return false;
    }
    if (!expected.expectedMatchesReference) {
      if (
        fixture.status !== "invalid_fixture" ||
        fixture.actualOutput !== null ||
        fixture.reasonCode !== "expected_values_do_not_match_exact_reference"
      ) {
        return false;
      }
      hasInvalidFixture = true;
      allFixturesPassed = false;
      continue;
    }
    if (execution.status === "unavailable") {
      if (
        fixture.status !== "unavailable" ||
        fixture.actualOutput !== null ||
        fixture.reasonCode !== execution.reasonCode
      ) {
        return false;
      }
      allFixturesPassed = false;
      continue;
    }
    if (execution.status === "failed" && fixture.actualOutput === null) {
      if (
        fixture.status !== "failed" ||
        typeof fixture.reasonCode !== "string" ||
        ![
          "candidate_answer_missing",
          "candidate_code_ambiguous",
          "candidate_execution_error",
          "candidate_execution_timeout",
          "sandbox_output_limit",
        ].includes(fixture.reasonCode)
      ) {
        return false;
      }
      allFixturesPassed = false;
      continue;
    }
    if (typeof fixture.actualOutput !== "string") return false;
    const passed = fixture.actualOutput === expected.expectedOutput;
    if (
      fixture.status !== (passed ? "passed" : "failed") ||
      fixture.reasonCode !==
        (passed ? null : "candidate_output_does_not_match_expected") ||
      (passed && execution.status !== "passed")
    ) {
      return false;
    }
    if (!passed) allFixturesPassed = false;
  }

  const expectedStatus = hasInvalidFixture
    ? "invalid_fixture"
    : execution.status === "unavailable"
      ? "unavailable"
      : allFixturesPassed
        ? "passed"
        : "failed";
  return (
    evidence.status === expectedStatus &&
    (!input.requirePass || expectedStatus === "passed")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function verifyDivisibility(
  answer: string | null,
  verification: DivisibilityVerification,
): OptimizationVerificationEvidence {
  const reference = exactDivisibilityTotals(verification);
  const expected = {
    count: verification.expected.count,
    sum: verification.expected.sum,
  };
  const actual = readCountAndSum(answer);
  if (expected.count !== reference.count || expected.sum !== reference.sum) {
    return {
      kind: "divisibility",
      status: "invalid_fixture",
      expected,
      reference,
      actual,
      reasonCode: "expected_values_do_not_match_exact_reference",
    };
  }
  if (answer === null) {
    return {
      kind: "divisibility",
      status: "unavailable",
      expected,
      reference,
      actual: null,
      reasonCode: "target_answer_missing",
    };
  }
  if (actual === null) {
    return {
      kind: "divisibility",
      status: "failed",
      expected,
      reference,
      actual: null,
      reasonCode: "answer_must_be_a_json_object_with_exact_count_and_sum",
    };
  }
  const passed = actual.count === expected.count && actual.sum === expected.sum;
  return {
    kind: "divisibility",
    status: passed ? "passed" : "failed",
    expected,
    reference,
    actual,
    reasonCode: passed ? null : "answer_does_not_match_expected_values",
  };
}

function exactDivisibilityTotals(input: DivisibilityVerification): {
  count: string;
  sum: string;
} {
  const lower = BigInt(input.startInclusive);
  const upper = BigInt(input.endInclusive);
  const includeTerms = inclusionTerms(input.includeDivisors, false);
  const excludeTerms = inclusionTerms(input.excludeDivisors, true);
  let count = 0n;
  let sum = 0n;

  for (const include of includeTerms) {
    for (const exclude of excludeTerms) {
      const divisor = leastCommonMultiple(include.divisor, exclude.divisor);
      const coefficient = include.coefficient * exclude.coefficient;
      const totals = multiplesInRange(divisor, lower, upper);
      count += BigInt(coefficient) * totals.count;
      sum += BigInt(coefficient) * totals.sum;
    }
  }

  return { count: count.toString(), sum: sum.toString() };
}

type InclusionTerm = { divisor: bigint; coefficient: 1 | -1 };

function inclusionTerms(
  divisors: readonly number[],
  includeEmpty: boolean,
): InclusionTerm[] {
  const terms: InclusionTerm[] = includeEmpty
    ? [{ divisor: 1n, coefficient: 1 }]
    : [];
  const maskLimit = 1 << divisors.length;
  for (let mask = 1; mask < maskLimit; mask += 1) {
    const members: bigint[] = [];
    for (let index = 0; index < divisors.length; index += 1) {
      if ((mask & (1 << index)) !== 0) members.push(BigInt(divisors[index]!));
    }
    const size = members.length;
    // Union expansion uses (-1)^(size + 1); the exclusion complement uses
    // (-1)^size, including the empty subset above.
    const coefficient = includeEmpty
      ? size % 2 === 0
        ? 1
        : -1
      : size % 2 === 1
        ? 1
        : -1;
    terms.push({
      divisor: members.reduce(leastCommonMultiple, 1n),
      coefficient,
    });
  }
  return terms;
}

function multiplesInRange(
  divisor: bigint,
  lower: bigint,
  upper: bigint,
): { count: bigint; sum: bigint } {
  const last = upper / divisor;
  const beforeFirst = (lower - 1n) / divisor;
  const count = last - beforeFirst;
  const sum =
    divisor *
    ((last * (last + 1n)) / 2n - (beforeFirst * (beforeFirst + 1n)) / 2n);
  return { count, sum };
}

function leastCommonMultiple(left: bigint, right: bigint): bigint {
  return (left / greatestCommonDivisor(left, right)) * right;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function readCountAndSum(
  answer: string | null,
): { count: string | null; sum: string | null } | null {
  if (answer === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    count: exactNonnegativeInteger(record.count),
    sum: exactNonnegativeInteger(record.sum),
  };
}

function exactNonnegativeInteger(value: unknown): string | null {
  if (typeof value === "string") {
    return /^(0|[1-9]\d{0,99})$/u.test(value) ? value : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }
  return null;
}

async function verifyPythonFixtures(
  answer: string | null,
  verification: PythonTestsVerification,
): Promise<OptimizationVerificationEvidence> {
  const fixtures = verification.tests.map((fixture) => {
    const referenceOutput = countPathsReference(
      fixture.n,
      fixture.blocked.map(({ row, column }) => [row, column] as const),
    );
    return {
      id: fixture.id,
      expectedOutput: fixture.expectedOutput,
      referenceOutput,
      expectedMatchesReference: fixture.expectedOutput === referenceOutput,
    };
  });
  const execution = await runPythonCandidateIsolated({
    answer,
    fixtures: verification.tests.map((fixture, index) => ({
      ...fixture,
      expectedMatchesReference: fixtures[index]!.expectedMatchesReference,
    })),
  });
  const executionById = new Map(
    execution.fixtures.map((fixture) => [fixture.id, fixture]),
  );
  const checkedFixtures = fixtures.map((fixture) => {
    const run = executionById.get(fixture.id);
    const status: "passed" | "failed" | "unavailable" | "invalid_fixture" = !fixture.expectedMatchesReference
      ? "invalid_fixture"
      : execution.status === "unavailable"
        ? "unavailable"
        : !run || run.reasonCode !== null || run.actualOutput === null
          ? "failed"
          : run.actualOutput === fixture.expectedOutput
            ? "passed"
            : "failed";
    return {
      ...fixture,
      actualOutput:
        fixture.expectedMatchesReference && run?.reasonCode === null
          ? run.actualOutput
          : null,
      status,
      reasonCode: !fixture.expectedMatchesReference
        ? "expected_values_do_not_match_exact_reference"
        : (run?.reasonCode ??
          (status === "failed" && run?.actualOutput !== fixture.expectedOutput
            ? "candidate_output_does_not_match_expected"
            : status === "unavailable"
              ? execution.reasonCode
              : null)),
    };
  });
  const hasInvalidFixture = checkedFixtures.some(
    (fixture) => fixture.status === "invalid_fixture",
  );
  const status: "passed" | "failed" | "unavailable" | "invalid_fixture" = hasInvalidFixture
    ? "invalid_fixture"
    : execution.status === "unavailable"
      ? "unavailable"
      : checkedFixtures.every((fixture) => fixture.status === "passed")
        ? "passed"
        : "failed";
  return {
    kind: "python_tests",
    status,
    execution: {
      status: execution.status,
      reasonCode: execution.reasonCode,
    },
    limitations: ["complexity_not_proved_by_behavioral_tests"],
    fixtures: checkedFixtures,
  };
}

function countPathsReference(
  n: number,
  blockedCoordinates: readonly (readonly [number, number])[],
): string {
  const blocked = new Set(
    blockedCoordinates.map(([row, column]) => row * n + column),
  );
  if (blocked.has(0) || blocked.has(n * n - 1)) return "0";

  const paths = Array.from({ length: n }, () => 0n);
  paths[0] = 1n;
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      const index = row * n + column;
      if (blocked.has(index)) paths[column] = 0n;
      else if (column > 0) paths[column] = paths[column]! + paths[column - 1]!;
    }
  }
  return paths[n - 1]!.toString();
}
