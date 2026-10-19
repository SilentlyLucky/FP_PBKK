export type OptimizationVerificationInput =
  | { kind: "none" }
  | {
      kind: "divisibility";
      startInclusive: string;
      endInclusive: string;
      includeDivisors: string;
      excludeDivisors: string;
      expectedCount: string;
      expectedSum: string;
    }
  | {
      kind: "python_tests";
      n: string;
      blocked: string;
      expectedOutput: string;
    };

export interface OptimizationTestCaseInput {
  id: string;
  input: string;
  verification?:
    | {
        kind: "divisibility";
        startInclusive: number;
        endInclusive: number;
        includeDivisors: number[];
        excludeDivisors: number[];
        expected: { count: string; sum: string };
      }
    | {
        kind: "python_tests";
        tests: Array<{
          id: string;
          n: number;
          blocked: Array<{ row: number; column: number }>;
          expectedOutput: string;
        }>;
      };
}

export function buildOptimizationTestCases(
  rawInput: string,
  verification: OptimizationVerificationInput,
): { cases: OptimizationTestCaseInput[]; error: string | null } {
  const input = rawInput.trim();
  if (!input && verification.kind !== "none") {
    return {
      cases: [],
      error: "Masukkan contoh uji sebelum menambahkan pemeriksaan hasil.",
    };
  }
  if (!input) return { cases: [], error: null };
  const testCase: OptimizationTestCaseInput = {
    id: "user-example-1",
    input,
  };

  if (verification.kind === "divisibility") {
    const startInclusive = parseBoundedInteger(
      verification.startInclusive,
      1,
      1_000_000_000_000,
    );
    const endInclusive = parseBoundedInteger(
      verification.endInclusive,
      1,
      1_000_000_000_000,
    );
    const includeDivisors = parseDivisors(verification.includeDivisors, true);
    const excludeDivisors = parseDivisors(verification.excludeDivisors, false);
    const expectedCount = parseDecimalInteger(verification.expectedCount);
    const expectedSum = parseDecimalInteger(verification.expectedSum);
    if (
      startInclusive === null ||
      endInclusive === null ||
      endInclusive < startInclusive ||
      includeDivisors === null ||
      excludeDivisors === null ||
      expectedCount === null ||
      expectedSum === null
    ) {
      return {
        cases: [],
        error:
          "Periksa rentang, pembagi unik (1–5), dan nilai count serta sum desimal yang diharapkan.",
      };
    }
    testCase.verification = {
      kind: "divisibility",
      startInclusive,
      endInclusive,
      includeDivisors,
      excludeDivisors,
      expected: { count: expectedCount, sum: expectedSum },
    };
  }

  if (verification.kind === "python_tests") {
    const n = parseBoundedInteger(verification.n, 1, 35);
    const expectedOutput = parseDecimalInteger(verification.expectedOutput);
    const blocked = parseBlockedCells(verification.blocked, n);
    if (n === null || expectedOutput === null || blocked === null) {
      return {
        cases: [],
        error:
          "Periksa ukuran grid (1–35), koordinat unik di dalam grid, dan output desimal yang diharapkan.",
      };
    }
    testCase.verification = {
      kind: "python_tests",
      tests: [{ id: "fixture-1", n, blocked, expectedOutput }],
    };
  }

  return { cases: [testCase], error: null };
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseDecimalInteger(value: string): string | null {
  const normalized = value.trim();
  return /^(0|[1-9]\d{0,99})$/u.test(normalized) ? normalized : null;
}

function parseDivisors(value: string, required: boolean): number[] | null {
  if (!value.trim()) return required ? null : [];
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  const values = parts.map((part) => parseBoundedInteger(part, 1, 1_000_000));
  if (
    values.some((part) => part === null) ||
    values.length > 5 ||
    new Set(values).size !== values.length
  ) {
    return null;
  }
  return values as number[];
}

function parseBlockedCells(
  value: string,
  gridSize: number | null,
): Array<{ row: number; column: number }> | null {
  if (gridSize === null) return null;
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > gridSize * gridSize) return null;
  const blocked = lines.map((line) => {
    const match = /^(\d+)\s*,\s*(\d+)$/u.exec(line);
    if (!match) return null;
    const row = Number(match[1]);
    const column = Number(match[2]);
    if (
      !Number.isSafeInteger(row) ||
      !Number.isSafeInteger(column) ||
      row >= gridSize ||
      column >= gridSize
    ) {
      return null;
    }
    return { row, column };
  });
  if (blocked.some((cell) => cell === null)) return null;
  const cells = blocked as Array<{ row: number; column: number }>;
  const identities = cells.map(({ row, column }) => `${row},${column}`);
  return new Set(identities).size === identities.length ? cells : null;
}
