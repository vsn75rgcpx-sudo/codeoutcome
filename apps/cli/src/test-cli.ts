import path from "node:path";

import {
  compareSessionTests,
  compareTestRuns,
  compareTrackingRunTests,
  importTestReport,
  manualLinkTestRun,
  readCodeOutcomeConfig,
  runTestCommand,
  unlinkTestRun,
  type TestProcessRunner,
  type TestReportFormat,
} from "@codeoutcome/core";
import { SessionDatabase } from "@codeoutcome/database";
import {
  redactHomePath,
  type TestComparison,
  type TestFramework,
  type TestOutcome,
  type TestRun,
  type TestStage,
} from "@codeoutcome/shared";

export interface TestCliContext {
  io: { stdout(message: string): void; stderr(message: string): void };
  databaseFile: string;
  dataDirectory: string;
  userHome: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  testProcessRunner?: TestProcessRunner;
}

interface ParsedFlags {
  booleans: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

function parseFlags(
  arguments_: readonly string[],
  booleanFlags: readonly string[],
  valueFlags: readonly string[],
): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const allowedBooleans = new Set(booleanFlags);
  const allowedValues = new Set(valueFlags);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (allowedBooleans.has(argument)) {
      booleans.add(argument);
      continue;
    }
    if (!allowedValues.has(argument))
      throw new Error(`Unknown option: ${argument}`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }
  return { booleans, values, positional };
}

async function withDatabase<T>(
  databaseFile: string,
  action: (database: SessionDatabase) => Promise<T> | T,
): Promise<T> {
  const database = new SessionDatabase(databaseFile);
  try {
    return await action(database);
  } finally {
    database.close();
  }
}

function testStage(value: string | undefined): TestStage {
  if (value === undefined) return "unspecified";
  if (value === "baseline" || value === "intermediate" || value === "final")
    return value;
  throw new Error("--stage must be baseline, intermediate, or final");
}

function framework(
  value: string | undefined,
  allowAuto: true,
): "auto" | TestFramework;
function framework(
  value: string | undefined,
  allowAuto: false,
): TestFramework | undefined;
function framework(
  value: string | undefined,
  allowAuto: boolean,
): "auto" | TestFramework | undefined {
  if (value === undefined) return allowAuto ? "auto" : undefined;
  if (allowAuto && value === "auto") return "auto";
  if (
    value === "pytest" ||
    value === "jest" ||
    value === "vitest" ||
    value === "junit" ||
    value === "go" ||
    value === "cargo" ||
    value === "generic"
  ) {
    return value;
  }
  throw new Error("Unsupported test framework");
}

function reportFormat(value: string | undefined): TestReportFormat {
  if (
    value === undefined ||
    value === "auto" ||
    value === "junit" ||
    value === "pytest-json" ||
    value === "jest-json" ||
    value === "vitest-json"
  ) {
    return value ?? "auto";
  }
  throw new Error("Unsupported report format");
}

function outcome(value: string | undefined): TestOutcome | undefined {
  if (value === undefined) return undefined;
  if (
    value === "passed" ||
    value === "failed" ||
    value === "errored" ||
    value === "interrupted" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error("Unsupported test outcome");
}

function since(value: string | undefined, now: Date): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)(h|d|w)$/.exec(value);
  if (match === null) throw new Error("--since must look like 24h, 7d, or 4w");
  const quantity = Number(match[1]);
  const multiplier =
    match[2] === "h" ? 3_600_000 : match[2] === "d" ? 86_400_000 : 604_800_000;
  return new Date(now.getTime() - quantity * multiplier).toISOString();
}

function limit(value: string | undefined): number {
  if (value === undefined) return 20;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("--limit must be an integer between 1 and 10000");
  }
  return parsed;
}

function safeRun(run: TestRun, home: string): TestRun {
  return {
    ...run,
    workingDirectory:
      redactHomePath(run.workingDirectory, home) ?? run.workingDirectory,
    commandDisplay: run.commandDisplay.split(home).join("~"),
  };
}

function count(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function testRunText(run: TestRun): string {
  return [
    `Test run: ${run.id}`,
    `Started: ${run.startedAt}`,
    `Stage: ${run.stage}`,
    `Framework: ${run.framework}${run.frameworkVersion === null ? "" : ` ${run.frameworkVersion}`}`,
    `Status/outcome: ${run.status}/${run.outcome}`,
    `Command: ${run.commandDisplay}`,
    `Exit/signal: ${run.exitCode ?? "unavailable"}/${run.terminationSignal ?? "none"}`,
    `Duration: ${run.durationMs === null ? "unavailable" : `${run.durationMs}ms`}`,
    `Total/passed/failed/skipped/todo/errored: ${count(run.totalTests)}/${count(run.passedTests)}/${count(run.failedTests)}/${count(run.skippedTests)}/${count(run.todoTests)}/${count(run.erroredTests)}`,
    `Parser: ${run.parserStatus} (${run.parserVersion})`,
    `Tracking run: ${run.trackingRunId ?? "standalone"}`,
    `Session: ${run.sessionId ?? "none"}`,
    `Output truncated: ${run.outputTruncated ? "yes" : "no"}`,
    `Warnings: ${run.warnings.join("; ") || "—"}`,
    "Test results recorded during an AI coding session; passing tests do not prove code correctness.",
  ].join("\n");
}

function safeComparison(
  comparison: TestComparison,
  home: string,
): TestComparison {
  return {
    ...comparison,
    baseline:
      comparison.baseline === null ? null : safeRun(comparison.baseline, home),
    final: comparison.final === null ? null : safeRun(comparison.final, home),
  };
}

function comparisonText(comparison: TestComparison): string {
  return [
    `Baseline: ${comparison.baseline?.id ?? "unavailable"} (${comparison.baselineSelection})`,
    `Baseline time/framework/outcome: ${comparison.baseline?.startedAt ?? "unavailable"}/${comparison.baseline?.framework ?? "unavailable"}/${comparison.baseline?.outcome ?? "unavailable"}`,
    `Final: ${comparison.final?.id ?? "unavailable"} (${comparison.finalSelection})`,
    `Final time/framework/outcome: ${comparison.final?.startedAt ?? "unavailable"}/${comparison.final?.framework ?? "unavailable"}/${comparison.final?.outcome ?? "unavailable"}`,
    `Same command: ${comparison.sameCommand === null ? "unknown" : comparison.sameCommand ? "yes" : "no"}`,
    `Total/passed/failed/skipped delta: ${count(comparison.totalTestDelta)}/${count(comparison.passedTestDelta)}/${count(comparison.failedTestDelta)}/${count(comparison.skippedTestDelta)}`,
    `Duration delta: ${count(comparison.durationDeltaMs)}ms`,
    `Comparability: ${comparison.comparability}`,
    `Confidence: ${comparison.comparisonConfidence ?? "unavailable"}`,
    `Warnings: ${comparison.warnings.join("; ") || "—"}`,
    "This comparison describes recorded test results and makes no causal Provider claim.",
  ].join("\n");
}

async function runWrappedCommand(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const separator = arguments_.indexOf("--");
  let wrapperArguments: readonly string[];
  let command: readonly string[];
  if (separator >= 0) {
    wrapperArguments = arguments_.slice(0, separator);
    command = arguments_.slice(separator + 1);
  } else {
    let commandStart = 0;
    while (commandStart < arguments_.length) {
      const argument = arguments_[commandStart];
      if (argument === "--json") {
        commandStart += 1;
        continue;
      }
      if (argument === "--stage" || argument === "--framework") {
        commandStart += 2;
        continue;
      }
      break;
    }
    wrapperArguments = arguments_.slice(0, commandStart);
    command = arguments_.slice(commandStart);
  }
  if (command[0] === undefined || command[0].trim().length === 0)
    throw new Error(
      "test run requires an executable, for example `codeoutcome test pnpm test`",
    );
  const parsed = parseFlags(
    wrapperArguments,
    ["--json"],
    ["--stage", "--framework"],
  );
  if (parsed.positional.length > 0)
    throw new Error("Unexpected test run argument before `--`");
  const json = parsed.booleans.has("--json");
  const config = await readCodeOutcomeConfig(context.dataDirectory);
  return withDatabase(context.databaseFile, async (database) => {
    const result = await runTestCommand({
      database,
      executable: command[0]!,
      arguments: command.slice(1),
      workingDirectory: context.workingDirectory,
      stage: testStage(parsed.values.get("--stage")),
      framework: framework(parsed.values.get("--framework"), true),
      privacyMode: config.privacy,
      environment: context.environment,
      now: context.now,
      processRunner: context.testProcessRunner,
      writeStdout: json
        ? (chunk) => process.stderr.write(chunk)
        : (chunk) => process.stdout.write(chunk),
      writeStderr: (chunk) => process.stderr.write(chunk),
      onFinalizationError: (error) => {
        const message =
          error instanceof Error
            ? error.message.split("\n")[0]
            : "unknown error";
        context.io.stderr(
          `WARN: Test exited, but CodeOutcome finalization failed: ${message?.split(context.userHome).join("~")}`,
        );
      },
    });
    const safe = safeRun(result.testRun, context.userHome);
    context.io.stdout(json ? JSON.stringify(safe, null, 2) : testRunText(safe));
    return result.exitCode;
  });
}

async function runImport(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    ["--json"],
    ["--file", "--format", "--tracking-run", "--session", "--stage"],
  );
  const fileOption = parsed.values.get("--file");
  if (fileOption !== undefined && parsed.positional.length > 0) {
    throw new Error(
      "test import accepts either --file or one report path, not both",
    );
  }
  const sourceFile = fileOption ?? parsed.positional[0];
  if (sourceFile === undefined || parsed.positional.length > 1) {
    throw new Error("test import requires --file <path> or one report path");
  }
  const config = await readCodeOutcomeConfig(context.dataDirectory);
  return withDatabase(context.databaseFile, async (database) => {
    const result = await importTestReport({
      database,
      sourceFile: path.resolve(context.workingDirectory, sourceFile),
      format: reportFormat(parsed.values.get("--format")),
      stage: testStage(parsed.values.get("--stage")),
      trackingRunId: parsed.values.get("--tracking-run"),
      sessionId: parsed.values.get("--session"),
      workingDirectory: context.workingDirectory,
      privacyMode: config.privacy,
      environment: context.environment,
      now: context.now,
    });
    const safe = safeRun(result.testRun, context.userHome);
    const shownPath = result.reportImport.canonicalPath.startsWith("strict:")
      ? "<redacted>"
      : (redactHomePath(result.sourceFile, context.userHome) ??
        result.sourceFile);
    const output = {
      kind: result.kind,
      sourceFile: shownPath,
      testRun: safe,
      reportImport: {
        ...result.reportImport,
        canonicalPath: result.reportImport.canonicalPath.startsWith("strict:")
          ? "<redacted>"
          : (redactHomePath(
              result.reportImport.canonicalPath,
              context.userHome,
            ) ?? result.reportImport.canonicalPath),
      },
    };
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(output, null, 2)
        : `${result.kind}: ${shownPath}\n${testRunText(safe)}`,
    );
    return 0;
  });
}

async function runList(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    ["--json"],
    [
      "--since",
      "--framework",
      "--tracking-run",
      "--session",
      "--outcome",
      "--limit",
    ],
  );
  if (parsed.positional.length > 0)
    throw new Error("Unexpected test list argument");
  return withDatabase(context.databaseFile, (database) => {
    const runs = database
      .listTestRuns({
        since: since(parsed.values.get("--since"), context.now()),
        framework: framework(parsed.values.get("--framework"), false),
        trackingRunId: parsed.values.get("--tracking-run"),
        sessionId: parsed.values.get("--session"),
        outcome: outcome(parsed.values.get("--outcome")),
        limit: limit(parsed.values.get("--limit")),
      })
      .map((run) => safeRun(run, context.userHome));
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(runs, null, 2)
        : runs.length === 0
          ? "No recorded test runs."
          : runs
              .map(
                (run) =>
                  `${run.id}  ${run.startedAt}  ${run.stage}  ${run.framework}  ${run.outcome}  ${count(run.passedTests)}/${count(run.failedTests)}`,
              )
              .join("\n"),
    );
    return 0;
  });
}

async function runShow(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(arguments_, ["--json"], []);
  const id = parsed.positional[0];
  if (id === undefined || parsed.positional.length !== 1)
    throw new Error("test show requires an ID");
  return withDatabase(context.databaseFile, (database) => {
    const run = database.getTestRun(id);
    if (run === null) throw new Error("Test run not found");
    const safe = safeRun(run, context.userHome);
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(
            { ...safe, linkHistory: database.listTestRunLinks(id) },
            null,
            2,
          )
        : testRunText(safe),
    );
    return 0;
  });
}

async function runCompare(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    ["--json"],
    ["--tracking-run", "--session"],
  );
  return withDatabase(context.databaseFile, (database) => {
    let comparison: TestComparison;
    const trackingRunId = parsed.values.get("--tracking-run");
    const sessionId = parsed.values.get("--session");
    if (trackingRunId !== undefined) {
      if (sessionId !== undefined || parsed.positional.length > 0) {
        throw new Error(
          "Choose IDs, --tracking-run, or --session for test compare",
        );
      }
      comparison = compareTrackingRunTests(database, trackingRunId);
    } else if (sessionId !== undefined) {
      if (parsed.positional.length > 0) {
        throw new Error(
          "Choose IDs, --tracking-run, or --session for test compare",
        );
      }
      comparison = compareSessionTests(database, sessionId);
    } else {
      if (parsed.positional.length !== 2) {
        throw new Error(
          "test compare requires two IDs, --tracking-run, or --session",
        );
      }
      const baseline = database.getTestRun(parsed.positional[0]!);
      const final = database.getTestRun(parsed.positional[1]!);
      if (baseline === null || final === null)
        throw new Error("Test run not found");
      comparison = compareTestRuns(baseline, final);
    }
    const safe = safeComparison(comparison, context.userHome);
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(safe, null, 2)
        : comparisonText(safe),
    );
    return comparison.comparability === "not_comparable" ? 1 : 0;
  });
}

async function runLink(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    ["--json"],
    ["--tracking-run", "--session"],
  );
  const id = parsed.positional[0];
  if (id === undefined || parsed.positional.length !== 1)
    throw new Error("test link requires an ID");
  return withDatabase(context.databaseFile, (database) => {
    const run = manualLinkTestRun(database, id, {
      trackingRunId: parsed.values.get("--tracking-run"),
      sessionId: parsed.values.get("--session"),
      now: context.now,
    });
    const safe = safeRun(run, context.userHome);
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(safe, null, 2)
        : testRunText(safe),
    );
    return 0;
  });
}

async function runUnlink(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(arguments_, ["--json"], []);
  const id = parsed.positional[0];
  if (id === undefined || parsed.positional.length !== 1)
    throw new Error("test unlink requires an ID");
  return withDatabase(context.databaseFile, (database) => {
    const run = unlinkTestRun(database, id, context.now);
    const safe = safeRun(run, context.userHome);
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(safe, null, 2)
        : testRunText(safe),
    );
    return 0;
  });
}

async function runRecovery(
  subcommand: "recover" | "abandon",
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    subcommand === "recover" ? ["--json", "--list"] : ["--json"],
    [],
  );
  return withDatabase(context.databaseFile, (database) => {
    if (subcommand === "recover" && parsed.booleans.has("--list")) {
      if (parsed.positional.length > 0)
        throw new Error("test recover --list takes no ID");
      const runs = database
        .listTestRuns({ status: "running", limit: 10_000 })
        .map((run) => safeRun(run, context.userHome));
      context.io.stdout(
        parsed.booleans.has("--json")
          ? JSON.stringify(runs, null, 2)
          : runs
              .map(
                (run) => `${run.id}  ${run.startedAt}  ${run.commandDisplay}`,
              )
              .join("\n") || "No running test runs.",
      );
      return 0;
    }
    const id = parsed.positional[0];
    if (id === undefined || parsed.positional.length !== 1) {
      throw new Error(`test ${subcommand} requires an ID`);
    }
    const run = database.recoverTestRun(
      id,
      subcommand,
      context.now().toISOString(),
    );
    const safe = safeRun(run, context.userHome);
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(safe, null, 2)
        : testRunText(safe),
    );
    return 0;
  });
}

async function deleteTests(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    ["--json", "--dry-run", "--yes"],
    ["--before", "--tracking-run"],
  );
  if (parsed.positional.length > 0)
    throw new Error("Unexpected delete-tests argument");
  let before: string | undefined;
  const beforeValue = parsed.values.get("--before");
  if (beforeValue !== undefined) {
    const parsedDate = new Date(beforeValue);
    if (Number.isNaN(parsedDate.getTime()))
      throw new Error("--before must be a valid date");
    before = parsedDate.toISOString();
  }
  const dryRun = parsed.booleans.has("--dry-run");
  if (!dryRun && !parsed.booleans.has("--yes")) {
    context.io.stderr(
      "Refusing to delete test metadata without explicit confirmation. Re-run with --yes or inspect with --dry-run.",
    );
    return 2;
  }
  return withDatabase(context.databaseFile, (database) => {
    const query = {
      before,
      trackingRunId: parsed.values.get("--tracking-run"),
    };
    const matched = database.countTestRuns(query);
    const deleted = dryRun ? 0 : database.deleteTestRuns(query);
    const result = { dryRun, matched, deleted, originalReportsDeleted: 0 };
    context.io.stdout(
      parsed.booleans.has("--json")
        ? JSON.stringify(result, null, 2)
        : `${dryRun ? "Would delete" : "Deleted"} ${dryRun ? matched : deleted} test run(s); original reports were not deleted.`,
    );
    return 0;
  });
}

export async function runTestCli(
  arguments_: readonly string[],
  context: TestCliContext,
): Promise<number | null> {
  const [command, subcommand, ...rest] = arguments_;
  if (command === "test") {
    switch (subcommand) {
      case "--help":
      case "-h":
      case "help":
        context.io.stdout(TEST_HELP);
        return 0;
      case "run":
        return runWrappedCommand(rest, context);
      case "import":
        return runImport(rest, context);
      case "list":
        return runList(rest, context);
      case "show":
        return runShow(rest, context);
      case "compare":
        return runCompare(rest, context);
      case "link":
        return runLink(rest, context);
      case "unlink":
        return runUnlink(rest, context);
      case "recover":
      case "abandon":
        return runRecovery(subcommand, rest, context);
      default:
        return runWrappedCommand([subcommand ?? "", ...rest], context);
    }
  }
  if (command === "data" && subcommand === "delete-tests") {
    return deleteTests(rest, context);
  }
  return null;
}

export const TEST_HELP = `  codeoutcome test <executable> [args...]
  codeoutcome test run [--stage baseline|intermediate|final] [--framework auto|pytest|jest|vitest|go|cargo|generic] [--json] [--] <executable> [args...]
  codeoutcome test import --file <report> [--format auto|junit|pytest-json|jest-json|vitest-json] [--tracking-run id] [--session id] [--stage baseline|intermediate|final] [--json]
  codeoutcome test list [--since 7d] [--framework name] [--tracking-run id] [--session id] [--outcome name] [--limit 20] [--json]
  codeoutcome test show <test-run-id> [--json]
  codeoutcome test compare <baseline-id> <final-id> [--json]
  codeoutcome test compare --tracking-run <id> [--json]
  codeoutcome test compare --session <id> [--json]
  codeoutcome test link <test-run-id> [--tracking-run id] [--session id] [--json]
  codeoutcome test unlink <test-run-id> [--json]
  codeoutcome test recover <test-run-id>|--list [--json]
  codeoutcome test abandon <test-run-id> [--json]
  codeoutcome data delete-tests [--before date] [--tracking-run id] [--dry-run|--yes] [--json]`;
