import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  SessionDatabase,
  SaveTestReportResult,
} from "@codeoutcome/database";
import {
  asRecord,
  type GitPrivacyMode,
  type TestCountSummary,
  type TestFramework,
  type TestOutcome,
  type TestParserStatus,
  type TestReportImport,
  type TestRun,
  type TestRunLink,
} from "@codeoutcome/shared";

import { resolveTestAssociation } from "./test-tracking.js";

export type TestReportFormat =
  "auto" | "junit" | "pytest-json" | "jest-json" | "vitest-json";

export const TEST_REPORT_PARSER_VERSION = "test-report-v1";
export const MAX_TEST_REPORT_BYTES = 10 * 1024 * 1024;

export class TestReportParseError extends Error {
  constructor(
    readonly code:
      | "unsupported_format"
      | "malformed_report"
      | "unsafe_xml"
      | "oversized_report",
    message: string,
  ) {
    super(message);
    this.name = "TestReportParseError";
  }
}

export interface ParsedTestReport extends TestCountSummary {
  format: Exclude<TestReportFormat, "auto">;
  framework: TestFramework;
  frameworkVersion: string | null;
  outcome: TestOutcome;
  parserStatus: TestParserStatus;
  warnings: string[];
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function outcome(counts: TestCountSummary): TestOutcome {
  if ((counts.erroredTests ?? 0) > 0) return "errored";
  if ((counts.failedTests ?? 0) > 0) return "failed";
  return counts.totalTests === null ? "unknown" : "passed";
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    const name = match[1];
    const value = match[2] ?? match[3];
    if (name !== undefined && value !== undefined) result[name] = value;
  }
  return result;
}

function junitCountsFromAttributes(
  values: Record<string, string>,
): TestCountSummary | null {
  const totalTests = nonnegativeInteger(values.tests);
  const failedTests = nonnegativeInteger(values.failures) ?? 0;
  const erroredTests = nonnegativeInteger(values.errors) ?? 0;
  const skippedTests =
    nonnegativeInteger(values.skipped) ??
    nonnegativeInteger(values.disabled) ??
    0;
  if (totalTests === null) return null;
  return {
    totalTests,
    passedTests: Math.max(
      0,
      totalTests - failedTests - erroredTests - skippedTests,
    ),
    failedTests,
    skippedTests,
    todoTests: null,
    erroredTests,
  };
}

function addCounts(
  left: TestCountSummary,
  right: TestCountSummary,
): TestCountSummary {
  const add = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    totalTests: add(left.totalTests, right.totalTests),
    passedTests: add(left.passedTests, right.passedTests),
    failedTests: add(left.failedTests, right.failedTests),
    skippedTests: add(left.skippedTests, right.skippedTests),
    todoTests: add(left.todoTests, right.todoTests),
    erroredTests: add(left.erroredTests, right.erroredTests),
  };
}

function parseJunitXml(buffer: Buffer): ParsedTestReport {
  const xml = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY|\bSYSTEM\b|\bPUBLIC\b/i.test(xml)) {
    throw new TestReportParseError(
      "unsafe_xml",
      "JUnit XML declarations, entities, and external identifiers are rejected",
    );
  }
  const trimmed = xml.replace(/^\uFEFF/, "").trim();
  const rootName = /<(testsuites|testsuite)\b/i
    .exec(trimmed)?.[1]
    ?.toLowerCase();
  if (
    rootName === undefined ||
    (rootName === "testsuites" && !/<\/testsuites>\s*$/i.test(trimmed)) ||
    (rootName === "testsuite" && !/<\/testsuite>\s*$/i.test(trimmed))
  ) {
    throw new TestReportParseError(
      "malformed_report",
      "Malformed JUnit XML report",
    );
  }
  const root = /<testsuites\b[^>]*>/i.exec(trimmed)?.[0];
  let counts =
    root === undefined ? null : junitCountsFromAttributes(attributes(root));
  if (counts === null) {
    counts = {
      totalTests: null,
      passedTests: null,
      failedTests: null,
      skippedTests: null,
      todoTests: null,
      erroredTests: null,
    };
    let found = false;
    let depth = 0;
    for (const match of trimmed.matchAll(/<\/?testsuite\b[^>]*>/gi)) {
      const tag = match[0];
      if (/^<\/testsuite/i.test(tag)) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      const selfClosing = /\/>\s*$/.test(tag);
      if (depth === 0) {
        const suite = junitCountsFromAttributes(attributes(tag));
        if (suite !== null) {
          counts = addCounts(counts, suite);
          found = true;
        }
      }
      if (!selfClosing) depth += 1;
    }
    if (!found) {
      throw new TestReportParseError(
        "malformed_report",
        "JUnit XML does not contain aggregate suite counts",
      );
    }
  }
  return {
    format: "junit",
    framework: "junit",
    frameworkVersion: null,
    ...counts,
    outcome: outcome(counts),
    parserStatus: "partially_parsed",
    warnings: [],
  };
}

function summaryCounts(summary: Record<string, unknown>): TestCountSummary {
  const passedTests = nonnegativeInteger(summary.passed);
  const failedTests = nonnegativeInteger(summary.failed);
  const skippedTests = nonnegativeInteger(summary.skipped);
  const todoTests = nonnegativeInteger(summary.todo);
  const erroredTests =
    nonnegativeInteger(summary.error) ?? nonnegativeInteger(summary.errors);
  const explicitTotal = nonnegativeInteger(summary.total);
  const values = [
    passedTests,
    failedTests,
    skippedTests,
    todoTests,
    erroredTests,
  ];
  const totalTests =
    explicitTotal ??
    (values.some((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null);
  return {
    totalTests,
    passedTests,
    failedTests,
    skippedTests,
    todoTests,
    erroredTests,
  };
}

function jestLikeCounts(record: Record<string, unknown>): TestCountSummary {
  return {
    totalTests: nonnegativeInteger(record.numTotalTests),
    passedTests: nonnegativeInteger(record.numPassedTests),
    failedTests: nonnegativeInteger(record.numFailedTests),
    skippedTests: nonnegativeInteger(record.numPendingTests),
    todoTests: nonnegativeInteger(record.numTodoTests),
    erroredTests: nonnegativeInteger(record.numRuntimeErrorTestSuites),
  };
}

function parsedJson(
  record: Record<string, unknown>,
  format: Exclude<TestReportFormat, "auto" | "junit">,
): ParsedTestReport {
  const framework: TestFramework =
    format === "pytest-json"
      ? "pytest"
      : format === "jest-json"
        ? "jest"
        : "vitest";
  const summary = asRecord(record.summary);
  const counts =
    format === "pytest-json" && summary !== undefined
      ? summaryCounts(summary)
      : jestLikeCounts(record);
  if (
    counts.totalTests === null &&
    Object.values(counts).every((value) => value === null)
  ) {
    throw new TestReportParseError(
      "malformed_report",
      `${format} does not contain aggregate test counts`,
    );
  }
  const version =
    typeof record.version === "string" && record.version.trim().length > 0
      ? record.version.trim()
      : null;
  return {
    format,
    framework,
    frameworkVersion: version,
    ...counts,
    outcome: outcome(counts),
    parserStatus: Object.values(counts).every((value) => value !== null)
      ? "parsed"
      : "partially_parsed",
    warnings: [],
  };
}

function resolveJsonFormat(
  record: Record<string, unknown>,
  requested: TestReportFormat,
  sourceFile: string,
): Exclude<TestReportFormat, "auto" | "junit"> {
  if (
    requested === "pytest-json" ||
    requested === "jest-json" ||
    requested === "vitest-json"
  ) {
    return requested;
  }
  if (asRecord(record.summary) !== undefined) return "pytest-json";
  if (typeof record.numTotalTests === "number") {
    return path.basename(sourceFile).toLowerCase().includes("vitest")
      ? "vitest-json"
      : "jest-json";
  }
  throw new TestReportParseError(
    "unsupported_format",
    "Unable to detect JSON test report format",
  );
}

export function parseTestReportBuffer(
  buffer: Buffer,
  requested: TestReportFormat,
  sourceFile = "report",
): ParsedTestReport {
  const looksXml = /^\s*(?:<\?xml[^>]*>\s*)?<testsuites?\b/i.test(
    buffer.toString("utf8", 0, 512),
  );
  if (requested === "junit" || (requested === "auto" && looksXml)) {
    const result = parseJunitXml(buffer);
    if (requested === "auto") {
      result.warnings.push("format_detection:testsuite_xml_root");
    }
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new TestReportParseError(
      "malformed_report",
      "Malformed JSON test report",
    );
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    throw new TestReportParseError(
      "malformed_report",
      "Test report root must be an object",
    );
  }
  const format = resolveJsonFormat(record, requested, sourceFile);
  const result = parsedJson(record, format);
  if (requested === "auto") {
    result.warnings.push(
      format === "pytest-json"
        ? "format_detection:pytest_summary_object"
        : format === "vitest-json"
          ? "format_detection:aggregate_fields_and_vitest_filename_hint"
          : "format_detection:aggregate_fields",
    );
  }
  return result;
}

export interface ImportTestReportOptions {
  database: SessionDatabase;
  sourceFile: string;
  format?: TestReportFormat;
  stage?: TestRun["stage"];
  trackingRunId?: string;
  sessionId?: string;
  workingDirectory?: string;
  privacyMode?: GitPrivacyMode;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  maximumBytes?: number;
}

export interface ImportTestReportResult extends SaveTestReportResult {
  sourceFile: string;
}

export async function importTestReport(
  options: ImportTestReportOptions,
): Promise<ImportTestReportResult> {
  const maximumBytes = options.maximumBytes ?? MAX_TEST_REPORT_BYTES;
  const metadata = await stat(options.sourceFile);
  if (!metadata.isFile()) {
    throw new TestReportParseError(
      "malformed_report",
      "Test report path is not a file",
    );
  }
  if (metadata.size > maximumBytes) {
    throw new TestReportParseError(
      "oversized_report",
      `Test report exceeds the ${maximumBytes} byte safety limit`,
    );
  }
  const canonicalPath = await realpath(options.sourceFile);
  const buffer = await readFile(canonicalPath);
  if (buffer.length > maximumBytes) {
    throw new TestReportParseError(
      "oversized_report",
      `Test report exceeds the ${maximumBytes} byte safety limit`,
    );
  }
  const parsed = parseTestReportBuffer(
    buffer,
    options.format ?? "auto",
    canonicalPath,
  );
  const importedAt = (options.now ?? (() => new Date()))().toISOString();
  const privacyMode = options.privacyMode ?? "git-metadata";
  const pathFingerprint = createHash("sha256")
    .update(canonicalPath)
    .digest("hex");
  const storedPath =
    privacyMode === "strict" ? `strict:${pathFingerprint}` : canonicalPath;
  const fileFingerprint = createHash("sha256").update(buffer).digest("hex");
  let association = await resolveTestAssociation({
    database: options.database,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    environment: options.environment,
    now: importedAt,
  });
  let linkType: TestRunLink["linkType"] = "auto";
  if (options.trackingRunId !== undefined) {
    const tracking = options.database.getTrackingRun(options.trackingRunId);
    if (tracking === null) throw new Error("Tracking run not found");
    association = {
      ...association,
      trackingRunId: tracking.id,
      sessionId: options.sessionId ?? tracking.linkedSessionId,
      repositoryId: tracking.repositoryId,
      state: "linked",
      confidence: 1,
      reasons: ["report manually linked to tracking run"],
    };
    linkType = "manual";
  }
  if (options.sessionId !== undefined) {
    if (!options.database.sessionExists(options.sessionId))
      throw new Error("Session not found");
    association = {
      ...association,
      sessionId: options.sessionId,
      state: "linked",
      confidence: 1,
      reasons: ["report manually linked to session"],
    };
    linkType = "manual";
  }
  const id = randomUUID();
  const commandFingerprint = createHash("sha256")
    .update(parsed.format)
    .update("\0")
    .update(pathFingerprint)
    .digest("hex");
  const shownPath = path.relative(association.workingDirectory, canonicalPath);
  const run: TestRun = {
    id,
    trackingRunId: association.trackingRunId,
    sessionId: association.sessionId,
    repositoryId: association.repositoryId,
    workingDirectory: association.workingDirectory,
    startedAt: importedAt,
    endedAt: importedAt,
    durationMs: null,
    stage: options.stage ?? "unspecified",
    framework: parsed.framework,
    frameworkVersion: parsed.frameworkVersion,
    executable: "report-import",
    commandDisplay:
      privacyMode === "strict" ? "report-import" : `report-import ${shownPath}`,
    commandFingerprint,
    argumentCount: 1,
    exitCode: null,
    terminationSignal: null,
    status: "completed",
    outcome: parsed.outcome,
    totalTests: parsed.totalTests,
    passedTests: parsed.passedTests,
    failedTests: parsed.failedTests,
    skippedTests: parsed.skippedTests,
    todoTests: parsed.todoTests,
    erroredTests: parsed.erroredTests,
    parserStatus: parsed.parserStatus,
    parserVersion: TEST_REPORT_PARSER_VERSION,
    outputTruncated: false,
    source: "imported_report",
    warnings: [...association.warnings, ...parsed.warnings],
    createdAt: importedAt,
    updatedAt: importedAt,
  };
  const reportImport: TestReportImport = {
    id: randomUUID(),
    testRunId: id,
    format: parsed.format,
    canonicalPath: storedPath,
    fileFingerprint,
    fileSize: buffer.length,
    importedAt,
    parserVersion: TEST_REPORT_PARSER_VERSION,
    status: "imported",
    warning: null,
  };
  const link: Omit<TestRunLink, "id"> | undefined =
    association.trackingRunId === null && association.sessionId === null
      ? undefined
      : {
          testRunId: id,
          trackingRunId: association.trackingRunId,
          sessionId: association.sessionId,
          linkType,
          confidence: association.confidence,
          reasons: association.reasons,
          createdAt: importedAt,
        };
  const result = options.database.saveTestReport(run, reportImport, { link });
  return {
    ...result,
    sourceFile: privacyMode === "strict" ? "<redacted>" : canonicalPath,
  };
}
