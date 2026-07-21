import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { SessionDatabase } from "@agentledger/database";
import type {
  GitPrivacyMode,
  TestFramework,
  TestRun,
} from "@agentledger/shared";

import {
  detectTestFrameworkWithReason,
  parseTestOutput,
  TEST_OUTPUT_PARSER_VERSION,
} from "./test-parsers.js";
import { associationLink, resolveTestAssociation } from "./test-tracking.js";

export const DEFAULT_TEST_OUTPUT_CAPTURE_LIMIT = 1024 * 1024;

export interface TestProcessOutcome {
  exitCode: number;
  signal: "SIGINT" | "SIGTERM" | null;
}

export interface TestProcessOptions {
  shell: false;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
}

export type TestProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: TestProcessOptions,
) => Promise<TestProcessOutcome>;

function signalExitCode(signal: "SIGINT" | "SIGTERM"): number {
  return signal === "SIGINT" ? 130 : 143;
}

export const defaultTestProcessRunner: TestProcessRunner = (
  executable,
  arguments_,
  options,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    let forwardedSignal: "SIGINT" | "SIGTERM" | null = null;
    let settled = false;
    const forward = (signal: "SIGINT" | "SIGTERM"): void => {
      forwardedSignal = signal;
      child.kill(signal);
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      options.stdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      options.stderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const normalizedSignal =
        signal === "SIGINT" || signal === "SIGTERM" ? signal : forwardedSignal;
      resolve({
        exitCode:
          code ??
          (normalizedSignal === null ? 1 : signalExitCode(normalizedSignal)),
        signal: normalizedSignal,
      });
    });
  });

class BoundedOutputCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(readonly limit: number) {}

  append(chunk: Buffer): void {
    const remaining = Math.max(0, this.limit - this.#bytes);
    if (remaining === 0) {
      this.#truncated = true;
      return;
    }
    const captured =
      chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.#chunks.push(captured);
    this.#bytes += captured.length;
    if (captured.length < chunk.length) this.#truncated = true;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
  }
}

const SENSITIVE_KEY =
  /(?:secret|token|password|passwd|api[-_]?key|cookie|authorization|credential|access[-_]?key)/i;

function displayArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,<>-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

export interface SafeTestCommand {
  executable: string;
  commandDisplay: string;
  commandFingerprint: string;
  containsSensitiveArguments: boolean;
  containsInlineCodeArguments: boolean;
}

export function safeTestCommand(
  executable: string,
  arguments_: readonly string[],
  privacyMode: GitPrivacyMode,
): SafeTestCommand {
  const executableName = path.basename(executable) || executable;
  const redacted: string[] = [];
  let redactNext = false;
  let redactNextCode = false;
  let containsSensitiveArguments = false;
  let containsInlineCodeArguments = false;
  for (const argument of arguments_) {
    if (redactNextCode) {
      redacted.push("<redacted-code>");
      containsInlineCodeArguments = true;
      redactNextCode = false;
      continue;
    }
    if (redactNext) {
      redacted.push("<redacted>");
      containsSensitiveArguments = true;
      redactNext = false;
      continue;
    }
    const authHeader = /^(authorization|cookie|x-api-key)\s*:/i.exec(argument);
    if (authHeader?.[1] !== undefined) {
      redacted.push(`${authHeader[1]}:<redacted>`);
      containsSensitiveArguments = true;
      continue;
    }
    if (/^(?:bearer|basic)\s+\S+/i.test(argument)) {
      redacted.push("<redacted-auth>");
      containsSensitiveArguments = true;
      continue;
    }
    if (
      /[?&](?:access_token|api_key|token|key|secret|password)=/i.test(argument)
    ) {
      redacted.push("<redacted-url>");
      containsSensitiveArguments = true;
      continue;
    }
    const headerAssignment =
      /^([^=]+)=(authorization|cookie|x-api-key)\s*:/i.exec(argument);
    if (headerAssignment?.[1] !== undefined) {
      redacted.push(`${headerAssignment[1]}=<redacted>`);
      containsSensitiveArguments = true;
      continue;
    }
    const codeAssignment = /^(--eval|--execute)=(.*)$/s.exec(argument);
    if (codeAssignment?.[1] !== undefined) {
      redacted.push(`${codeAssignment[1]}=<redacted-code>`);
      containsInlineCodeArguments = true;
      continue;
    }
    if (
      argument === "-c" ||
      argument === "-e" ||
      argument === "--eval" ||
      argument === "--execute"
    ) {
      redacted.push(argument);
      redactNextCode = true;
      containsInlineCodeArguments = true;
      continue;
    }
    const assignment = /^([^=]+)=(.*)$/s.exec(argument);
    if (assignment?.[1] !== undefined && SENSITIVE_KEY.test(assignment[1])) {
      redacted.push(`${assignment[1]}=<redacted>`);
      containsSensitiveArguments = true;
      continue;
    }
    if (/^-{1,2}/.test(argument) && SENSITIVE_KEY.test(argument)) {
      redacted.push(argument);
      redactNext = true;
      containsSensitiveArguments = true;
      continue;
    }
    redacted.push(argument);
  }
  const commandFingerprint = createHash("sha256")
    .update(executable)
    .update("\0")
    .update(arguments_.join("\0"))
    .digest("hex");
  return {
    executable: executableName,
    commandDisplay:
      privacyMode === "strict"
        ? executableName
        : [executableName, ...redacted.map(displayArgument)].join(" "),
    commandFingerprint,
    containsSensitiveArguments,
    containsInlineCodeArguments,
  };
}

export interface RunTestCommandOptions {
  database: SessionDatabase;
  executable: string;
  arguments: readonly string[];
  workingDirectory?: string;
  stage?: TestRun["stage"];
  framework?: "auto" | TestFramework;
  privacyMode?: GitPrivacyMode;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  processRunner?: TestProcessRunner;
  outputCaptureLimit?: number;
  writeStdout?: (chunk: Buffer) => void;
  writeStderr?: (chunk: Buffer) => void;
  onFinalizationError?: (error: unknown) => void;
}

export interface RunTestCommandResult {
  exitCode: number;
  testRun: TestRun;
  finalizationError: unknown | null;
}

function elapsed(startedAt: string, endedAt: string): number {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : 0;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "UNKNOWN";
}

export async function runTestCommand(
  options: RunTestCommandOptions,
): Promise<RunTestCommandResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const privacyMode = options.privacyMode ?? "git-metadata";
  const environment = options.environment ?? process.env;
  const association = await resolveTestAssociation({
    database: options.database,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    environment,
    now: startedAt,
  });
  const command = safeTestCommand(
    options.executable,
    options.arguments,
    privacyMode,
  );
  const requestedFramework = options.framework;
  const detection =
    requestedFramework === undefined || requestedFramework === "auto"
      ? detectTestFrameworkWithReason(options.executable, options.arguments)
      : {
          framework: requestedFramework,
          reason: "framework_selected_explicitly",
        };
  const framework = detection.framework;
  const warnings = [
    ...association.warnings,
    `framework_detection:${detection.reason}`,
  ];
  if (command.containsSensitiveArguments) {
    warnings.push("sensitive_command_arguments_redacted");
  }
  if (command.containsInlineCodeArguments) {
    warnings.push("inline_code_argument_redacted");
  }
  const id = randomUUID();
  const initial: TestRun = {
    id,
    trackingRunId: association.trackingRunId,
    sessionId: association.sessionId,
    repositoryId: association.repositoryId,
    workingDirectory: association.workingDirectory,
    startedAt,
    endedAt: null,
    durationMs: null,
    stage: options.stage ?? "unspecified",
    framework,
    frameworkVersion: null,
    executable: command.executable,
    commandDisplay: command.commandDisplay,
    commandFingerprint: command.commandFingerprint,
    argumentCount: options.arguments.length,
    exitCode: null,
    terminationSignal: null,
    status: "running",
    outcome: "unknown",
    totalTests: null,
    passedTests: null,
    failedTests: null,
    skippedTests: null,
    todoTests: null,
    erroredTests: null,
    parserStatus: "unsupported",
    parserVersion: TEST_OUTPUT_PARSER_VERSION,
    outputTruncated: false,
    source: "wrapped_command",
    warnings,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  let stored = options.database.createTestRun(initial, {
    link: associationLink(id, association, startedAt),
  });
  const capture = new BoundedOutputCapture(
    Math.max(
      1,
      options.outputCaptureLimit ?? DEFAULT_TEST_OUTPUT_CAPTURE_LIMIT,
    ),
  );
  const writeStdout =
    options.writeStdout ?? ((chunk: Buffer) => process.stdout.write(chunk));
  const writeStderr =
    options.writeStderr ?? ((chunk: Buffer) => process.stderr.write(chunk));
  let processOutcome: TestProcessOutcome | null = null;
  let processError: unknown;
  try {
    processOutcome = await (options.processRunner ?? defaultTestProcessRunner)(
      options.executable,
      options.arguments,
      {
        shell: false,
        cwd: association.workingDirectory,
        env: environment,
        stdout: (chunk) => {
          writeStdout(chunk);
          capture.append(chunk);
        },
        stderr: (chunk) => {
          writeStderr(chunk);
          capture.append(chunk);
        },
      },
    );
  } catch (error) {
    processError = error;
  }

  const endedAt = now().toISOString();
  const durationMs = elapsed(startedAt, endedAt);
  const fallbackExitCode = 127;
  const returnedExitCode = processOutcome?.exitCode ?? fallbackExitCode;
  let finalizationError: unknown | null = null;
  try {
    if (processOutcome === null) {
      stored = options.database.completeTestRun(id, {
        endedAt,
        durationMs,
        exitCode: null,
        terminationSignal: null,
        status: "failed_to_start",
        outcome: "unknown",
        totalTests: null,
        passedTests: null,
        failedTests: null,
        skippedTests: null,
        todoTests: null,
        erroredTests: null,
        parserStatus: "unsupported",
        parserVersion: TEST_OUTPUT_PARSER_VERSION,
        outputTruncated: capture.truncated,
        warnings: [
          ...warnings,
          `test_process_failed_to_start:${errorCode(processError)}`,
        ],
        updatedAt: endedAt,
      });
    } else if (processOutcome.signal !== null) {
      stored = options.database.completeTestRun(id, {
        endedAt,
        durationMs,
        exitCode: processOutcome.exitCode,
        terminationSignal: processOutcome.signal,
        status: "interrupted",
        outcome: "interrupted",
        totalTests: null,
        passedTests: null,
        failedTests: null,
        skippedTests: null,
        todoTests: null,
        erroredTests: null,
        parserStatus: "unsupported",
        parserVersion: TEST_OUTPUT_PARSER_VERSION,
        outputTruncated: capture.truncated,
        warnings: [...warnings, "test_process_interrupted"],
        updatedAt: endedAt,
      });
    } else {
      const parsed = parseTestOutput(
        framework,
        capture.text(),
        processOutcome.exitCode,
      );
      stored = options.database.completeTestRun(id, {
        endedAt,
        durationMs,
        exitCode: processOutcome.exitCode,
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
        parserVersion: parsed.parserVersion,
        outputTruncated: capture.truncated,
        warnings: [...warnings, ...parsed.warnings],
        updatedAt: endedAt,
      });
    }
  } catch (error) {
    finalizationError = error;
    options.onFinalizationError?.(error);
  }
  return { exitCode: returnedExitCode, testRun: stored, finalizationError };
}
