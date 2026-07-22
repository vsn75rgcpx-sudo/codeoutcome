import path from "node:path";

import type {
  TestCountSummary,
  TestFramework,
  TestOutcome,
  TestParserStatus,
} from "@codeoutcome/shared";

export const TEST_OUTPUT_PARSER_VERSION = "test-output-v1";

export interface ParsedTestOutput extends TestCountSummary {
  framework: TestFramework;
  frameworkVersion: string | null;
  outcome: TestOutcome;
  parserStatus: TestParserStatus;
  parserVersion: string;
  warnings: string[];
}

const EMPTY_COUNTS: TestCountSummary = {
  totalTests: null,
  passedTests: null,
  failedTests: null,
  skippedTests: null,
  todoTests: null,
  erroredTests: null,
};

function executableName(executable: string): string {
  return path.basename(executable).toLowerCase();
}

export interface TestFrameworkDetection {
  framework: TestFramework;
  reason: string;
}

export function detectTestFrameworkWithReason(
  executable: string,
  arguments_: readonly string[],
): TestFrameworkDetection {
  const name = executableName(executable);
  if (name === "pytest" || name === "py.test" || name.startsWith("pytest")) {
    return { framework: "pytest", reason: "pytest_executable_basename" };
  }
  if (name === "jest") {
    return { framework: "jest", reason: "jest_executable_basename" };
  }
  if (arguments_.some((value) => /(^|\/)jest(?:\.js)?$/i.test(value))) {
    return { framework: "jest", reason: "jest_explicit_argument_marker" };
  }
  if (name === "vitest") {
    return { framework: "vitest", reason: "vitest_executable_basename" };
  }
  if (arguments_.some((value) => /(^|\/)vitest(?:\.m?js)?$/i.test(value))) {
    return { framework: "vitest", reason: "vitest_explicit_argument_marker" };
  }
  if (name === "go" && arguments_[0] === "test") {
    return { framework: "go", reason: "go_test_subcommand" };
  }
  if (name === "cargo" && arguments_[0] === "test") {
    return { framework: "cargo", reason: "cargo_test_subcommand" };
  }
  if (
    (name === "pnpm" || name === "npm" || name === "npx" || name === "node") &&
    arguments_.some((value) => value.toLowerCase().includes("vitest"))
  ) {
    return { framework: "vitest", reason: "vitest_package_runner_argument" };
  }
  if (
    (name === "pnpm" || name === "npm" || name === "npx" || name === "node") &&
    arguments_.some((value) => value.toLowerCase().includes("jest"))
  ) {
    return { framework: "jest", reason: "jest_package_runner_argument" };
  }
  return { framework: "generic", reason: "no_supported_framework_evidence" };
}

export function detectTestFramework(
  executable: string,
  arguments_: readonly string[],
): TestFramework {
  return detectTestFrameworkWithReason(executable, arguments_).framework;
}

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function numberBefore(label: string, value: string): number | null {
  const match = new RegExp(`(\\d+)\\s+${label}`, "i").exec(value);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function countSummaryLine(value: string): TestCountSummary | null {
  const passedTests = numberBefore("passed", value);
  const failedTests = numberBefore("failed", value);
  const skipped = numberBefore("skipped", value);
  const ignored = numberBefore("ignored", value);
  const todoTests = numberBefore("todo", value);
  const errors = numberBefore("errors?", value);
  const xfailed = numberBefore("xfailed", value);
  const skippedTests =
    skipped === null && ignored === null && xfailed === null
      ? null
      : (skipped ?? 0) + (ignored ?? 0) + (xfailed ?? 0);
  const erroredTests = errors;
  if (
    passedTests === null &&
    failedTests === null &&
    skippedTests === null &&
    todoTests === null &&
    erroredTests === null
  ) {
    return null;
  }
  const known = [
    passedTests,
    failedTests,
    skippedTests,
    todoTests,
    erroredTests,
  ];
  const totalTests = known.every((count) => count === null)
    ? null
    : known.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  return {
    totalTests,
    passedTests,
    failedTests,
    skippedTests,
    todoTests,
    erroredTests,
  };
}

function outcomeFromCounts(
  counts: TestCountSummary,
  exitCode: number,
): TestOutcome {
  if ((counts.erroredTests ?? 0) > 0) return "errored";
  if ((counts.failedTests ?? 0) > 0) return "failed";
  return exitCode === 0 ? "passed" : "errored";
}

function parsed(
  framework: TestFramework,
  frameworkVersion: string | null,
  counts: TestCountSummary,
  exitCode: number,
): ParsedTestOutput {
  const values = Object.values(counts);
  const parserStatus = values.every((value) => value !== null)
    ? "parsed"
    : "partially_parsed";
  return {
    framework,
    frameworkVersion,
    ...counts,
    outcome: outcomeFromCounts(counts, exitCode),
    parserStatus,
    parserVersion: TEST_OUTPUT_PARSER_VERSION,
    warnings: [],
  };
}

function fallback(
  framework: TestFramework,
  exitCode: number,
  warning?: string,
): ParsedTestOutput {
  return {
    framework,
    frameworkVersion: null,
    ...EMPTY_COUNTS,
    outcome: exitCode === 0 ? "passed" : "errored",
    parserStatus: "exit_code_only",
    parserVersion: TEST_OUTPUT_PARSER_VERSION,
    warnings: warning === undefined ? [] : [warning],
  };
}

function parsePytest(output: string, exitCode: number): ParsedTestOutput {
  const lines = output.split(/\r?\n/).reverse();
  const line = lines.find((candidate) =>
    /\b(?:passed|failed|skipped|xfailed|errors?)\b/i.test(candidate),
  );
  const counts = line === undefined ? null : countSummaryLine(line);
  if (counts === null)
    return fallback("pytest", exitCode, "pytest_summary_not_found");
  counts.passedTests ??= 0;
  counts.failedTests ??= 0;
  counts.skippedTests ??= 0;
  counts.todoTests ??= 0;
  counts.erroredTests ??= 0;
  const version = /pytest[- ]([0-9]+(?:\.[0-9]+)+)/i.exec(output)?.[1] ?? null;
  return parsed("pytest", version, counts, exitCode);
}

function parseJest(output: string, exitCode: number): ParsedTestOutput {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => /^\s*Tests:\s*/i.test(candidate));
  if (line === undefined)
    return fallback("jest", exitCode, "jest_summary_not_found");
  const passedTests = numberBefore("passed", line);
  const failedTests = numberBefore("failed", line);
  const skippedTests = numberBefore("skipped", line);
  const todoTests = numberBefore("todo", line);
  const totalTests = /(?:Tests:\s*)?.*?(\d+)\s+total\b/i.exec(line)?.[1];
  const counts: TestCountSummary = {
    totalTests: totalTests === undefined ? null : Number(totalTests),
    passedTests: passedTests ?? 0,
    failedTests: failedTests ?? 0,
    skippedTests: skippedTests ?? 0,
    todoTests: todoTests ?? 0,
    erroredTests: 0,
  };
  const version =
    /Jest(?: v| )([0-9]+(?:\.[0-9]+)+)/i.exec(output)?.[1] ?? null;
  return parsed("jest", version, counts, exitCode);
}

function parseVitest(output: string, exitCode: number): ParsedTestOutput {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => /^\s*Tests\s+/i.test(candidate));
  const counts = line === undefined ? null : countSummaryLine(line);
  if (counts === null)
    return fallback("vitest", exitCode, "vitest_summary_not_found");
  counts.passedTests ??= 0;
  counts.failedTests ??= 0;
  counts.skippedTests ??= 0;
  counts.todoTests ??= 0;
  counts.erroredTests ??= 0;
  const parenthesizedTotal = /\((\d+)\)\s*$/.exec(line ?? "")?.[1];
  if (parenthesizedTotal !== undefined)
    counts.totalTests = Number(parenthesizedTotal);
  const version =
    /Vitest(?: v|\/)([0-9]+(?:\.[0-9]+)+)/i.exec(output)?.[1] ?? null;
  return parsed("vitest", version, counts, exitCode);
}

function parseGo(output: string, exitCode: number): ParsedTestOutput {
  const passedTests = (output.match(/^--- PASS:/gm) ?? []).length;
  const failedTests = (output.match(/^--- FAIL:/gm) ?? []).length;
  const skippedTests = (output.match(/^--- SKIP:/gm) ?? []).length;
  const totalTests = passedTests + failedTests + skippedTests;
  if (totalTests === 0)
    return fallback("go", exitCode, "go_test_case_summary_not_found");
  return parsed(
    "go",
    null,
    {
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      todoTests: 0,
      erroredTests: 0,
    },
    exitCode,
  );
}

function parseCargo(output: string, exitCode: number): ParsedTestOutput {
  const matches = [
    ...output.matchAll(
      /test result:\s+\w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;/gi,
    ),
  ];
  if (matches.length === 0)
    return fallback("cargo", exitCode, "cargo_summary_not_found");
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  for (const match of matches) {
    passedTests += Number(match[1] ?? 0);
    failedTests += Number(match[2] ?? 0);
    skippedTests += Number(match[3] ?? 0);
  }
  return parsed(
    "cargo",
    null,
    {
      totalTests: passedTests + failedTests + skippedTests,
      passedTests,
      failedTests,
      skippedTests,
      todoTests: 0,
      erroredTests: 0,
    },
    exitCode,
  );
}

export function parseTestOutput(
  framework: TestFramework,
  capturedOutput: string,
  exitCode: number,
): ParsedTestOutput {
  const output = stripAnsi(capturedOutput);
  switch (framework) {
    case "pytest":
      return parsePytest(output, exitCode);
    case "jest":
      return parseJest(output, exitCode);
    case "vitest":
      return parseVitest(output, exitCode);
    case "go":
      return parseGo(output, exitCode);
    case "cargo":
      return parseCargo(output, exitCode);
    case "junit":
      return fallback("junit", exitCode, "junit_requires_report_import");
    case "generic":
      return fallback("generic", exitCode);
  }
}
