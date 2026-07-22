import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ClaudeCodeAdapter } from "@codeoutcome/adapter-claude-code";
import { CodexAdapter } from "@codeoutcome/adapter-codex";
import {
  auditUsage,
  buildUsageReport,
  reconcileUsage,
  runImport,
  type ProviderProcessRunner,
  type TestProcessRunner,
  type CostSummary,
  type UsagePeriod,
  type UsageReport,
  type UsageAuditReport,
  type UsageReconciliationReport,
} from "@codeoutcome/core";
import {
  getCodeOutcomePaths,
  inspectDatabase,
  migrateLegacyDatabase,
  SessionDatabase,
  type CodeOutcomePaths,
  type LegacyMigrationResult,
} from "@codeoutcome/database";
import type { GitProcessRunner } from "@codeoutcome/git-tracker";
import {
  CODEOUTCOME_VERSION,
  redactHomePath,
  type Provider,
  type ProviderSelection,
  type ProviderFormatSupport,
  type Session,
  type SessionAdapter,
} from "@codeoutcome/shared";

import { PHASE3_HELP, runPhase3Cli } from "./tracking-cli.js";
import { runTestCli, TEST_HELP } from "./test-cli.js";
import { DASHBOARD_HELP, runDashboardCli } from "./dashboard-cli.js";

const execFileAsync = promisify(execFile);

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliOptions {
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
  platform?: NodeJS.Platform;
  adapters?: readonly SessionAdapter[];
  databaseFile?: string;
  now?: () => Date;
  io?: CliIo;
  workingDirectory?: string;
  gitRunner?: GitProcessRunner;
  processRunner?: ProviderProcessRunner;
  testProcessRunner?: TestProcessRunner;
  codexExecutable?: string;
  dashboardStaticRoot?: string;
  dashboardStarter?: Parameters<typeof runDashboardCli>[1]["startServer"];
  dashboardBrowserOpener?: Parameters<typeof runDashboardCli>[1]["openBrowser"];
}

type DoctorStatus = "PASS" | "WARN" | "FAIL";

interface DoctorCheck {
  check: string;
  status: DoctorStatus;
  detail: string;
  solution: string | null;
}

interface ParsedArguments {
  booleans: Set<string>;
  values: Map<string, string>;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

function configuredPath(
  environment: NodeJS.ProcessEnv,
  environmentName: string,
  legacyEnvironmentName: string,
  fallback: string,
): string {
  const current = environment[environmentName]?.trim();
  const legacy = environment[legacyEnvironmentName]?.trim();
  const configured =
    current !== undefined && current.length > 0 ? current : legacy;
  return configured === undefined || configured.length === 0
    ? fallback
    : path.resolve(configured);
}

const LEGACY_ENVIRONMENT_VARIABLES = [
  ["AGENTLEDGER_DATA_DIR", "CODEOUTCOME_DATA_DIR"],
  ["AGENTLEDGER_CLAUDE_LOG_DIR", "CODEOUTCOME_CLAUDE_LOG_DIR"],
  ["AGENTLEDGER_CODEX_LOG_DIR", "CODEOUTCOME_CODEX_LOG_DIR"],
  ["AGENTLEDGER_TRACKING_RUN_ID", "CODEOUTCOME_TRACKING_RUN_ID"],
] as const;

function warnForLegacyEnvironment(
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): void {
  for (const [legacyName, currentName] of LEGACY_ENVIRONMENT_VARIABLES) {
    const current = environment[currentName]?.trim();
    const legacy = environment[legacyName]?.trim();
    if (
      (current === undefined || current.length === 0) &&
      legacy !== undefined &&
      legacy.length > 0
    ) {
      io.stderr(
        `WARN: ${legacyName} is deprecated; use ${currentName} instead.`,
      );
    }
  }
}

function warnForLegacyDataLocation(
  paths: CodeOutcomePaths,
  userHome: string,
  io: CliIo,
): void {
  if (!paths.legacy) return;
  io.stderr(
    `WARN: Using legacy data location in compatibility mode (${redactHomePath(paths.databaseFile, userHome) ?? paths.databaseFile}). The database will not be moved or renamed automatically.`,
  );
}

function defaultAdapters(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): SessionAdapter[] {
  return [
    new ClaudeCodeAdapter(
      configuredPath(
        environment,
        "CODEOUTCOME_CLAUDE_LOG_DIR",
        "AGENTLEDGER_CLAUDE_LOG_DIR",
        path.join(userHome, ".claude", "projects"),
      ),
    ),
    new CodexAdapter(
      configuredPath(
        environment,
        "CODEOUTCOME_CODEX_LOG_DIR",
        "AGENTLEDGER_CODEX_LOG_DIR",
        path.join(userHome, ".codex", "sessions"),
      ),
    ),
  ];
}

function parseArguments(
  arguments_: readonly string[],
  booleanFlags: readonly string[],
  valueFlags: readonly string[],
): ParsedArguments {
  const allowedBooleans = new Set(booleanFlags);
  const allowedValues = new Set(valueFlags);
  const booleans = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const raw = arguments_[index];
    if (raw === undefined || !raw.startsWith("--")) {
      throw new Error(`Unexpected argument: ${raw ?? ""}`);
    }
    const equalsIndex = raw.indexOf("=");
    const flag = equalsIndex < 0 ? raw : raw.slice(0, equalsIndex);
    if (allowedBooleans.has(flag)) {
      if (equalsIndex >= 0) {
        throw new Error(`${flag} does not accept a value`);
      }
      booleans.add(flag);
      continue;
    }
    if (!allowedValues.has(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const inlineValue =
      equalsIndex < 0 ? undefined : raw.slice(equalsIndex + 1);
    const value = inlineValue ?? arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(flag, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return { booleans, values };
}

function parseProvider(
  value: string | undefined,
  allowAll: boolean,
): ProviderSelection {
  const provider = value ?? (allowAll ? "all" : undefined);
  if (provider === "all" && allowAll) {
    return provider;
  }
  if (provider === "claude-code" || provider === "codex") {
    return provider;
  }
  throw new Error(
    allowAll
      ? "--provider must be claude-code, codex, or all"
      : "--provider must be claude-code or codex",
  );
}

function selectedCliAdapters(
  adapters: readonly SessionAdapter[],
  provider: ProviderSelection,
): SessionAdapter[] {
  return adapters.filter(
    (adapter) => provider === "all" || adapter.provider === provider,
  );
}

function parseSince(value: string | undefined, now: Date): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)(h|d|w)$/.exec(value.trim());
  if (match === null) {
    throw new Error("--since must use a duration such as 24h, 7d, or 4w");
  }
  const quantity = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return new Date(now.getTime() - quantity * multiplier).toISOString();
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("--limit must be an integer between 1 and 10000");
  }
  return limit;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  return [
    format(headers),
    format(widths.map((width) => "-".repeat(width))),
    ...rows.map(format),
  ].join("\n");
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? (error.message.split("\n")[0] ?? error.name)
    : "unknown error";
}

async function commandVersion(command: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return (stdout || stderr).trim().split("\n")[0] ?? command;
  } catch {
    return null;
  }
}

function supportedNodeVersion(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version
    .split(".")
    .slice(0, 2)
    .map((part) => Number(part));
  return major > 22 || (major === 22 && minor >= 13);
}

async function writableDirectoryCheck(
  targetDirectory: string,
): Promise<boolean> {
  let candidate = targetDirectory;
  while (true) {
    try {
      const metadata = await stat(candidate);
      if (!metadata.isDirectory()) {
        return false;
      }
      await access(candidate, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return false;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return false;
      }
      candidate = parent;
    }
  }
}

function redacted(value: string, userHome: string): string {
  const lexicalRelative = path.relative(
    path.resolve(userHome),
    path.resolve(value),
  );
  if (
    lexicalRelative === "" ||
    (!lexicalRelative.startsWith("..") && !path.isAbsolute(lexicalRelative))
  ) {
    return lexicalRelative === "" ? "~" : path.join("~", lexicalRelative);
  }
  return redactHomePath(value, userHome) ?? value;
}

function redactText(value: string, userHome: string): string {
  return value.split(userHome).join("~");
}

async function inspectLogRoot(
  adapter: SessionAdapter,
  userHome: string,
): Promise<DoctorCheck> {
  const shownRoot = redacted(adapter.logRoot, userHome);
  try {
    const metadata = await stat(adapter.logRoot);
    if (!metadata.isDirectory()) {
      return {
        check: `${adapter.provider} logs`,
        status: "FAIL",
        detail: `Configured path is not a directory (${shownRoot})`,
        solution:
          "Set the matching CODEOUTCOME_*_LOG_DIR to a readable directory.",
      };
    }
    await access(adapter.logRoot, constants.R_OK | constants.X_OK);
    const files = await adapter.discoverSourceFiles();
    return files.length === 0
      ? {
          check: `${adapter.provider} logs`,
          status: "WARN",
          detail: `Directory is readable but contains no JSONL logs (${shownRoot})`,
          solution:
            adapter.provider === "codex"
              ? "Run Codex once, or set CODEOUTCOME_CODEX_LOG_DIR to the directory that contains its JSONL sessions."
              : "If you use Claude Code, run it once or set CODEOUTCOME_CLAUDE_LOG_DIR. Otherwise this warning can be ignored.",
        }
      : {
          check: `${adapter.provider} logs`,
          status: "PASS",
          detail: `${files.length} readable JSONL file(s) (${shownRoot})`,
          solution: null,
        };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        check: `${adapter.provider} logs`,
        status: "WARN",
        detail: `Log directory does not exist (${shownRoot})`,
        solution:
          adapter.provider === "codex"
            ? "Run Codex once, or set CODEOUTCOME_CODEX_LOG_DIR."
            : "Claude Code is optional. If you use it, run it once or set CODEOUTCOME_CLAUDE_LOG_DIR.",
      };
    }
    return {
      check: `${adapter.provider} logs`,
      status: "FAIL",
      detail: `Cannot read ${shownRoot}: ${redactText(safeError(error), userHome)}`,
      solution:
        "Grant read and directory traversal permission without changing log contents.",
    };
  }
}

async function doctorChecks(
  adapters: readonly SessionAdapter[],
  databaseFile: string,
  userHome: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [gitVersion, pnpmVersion] = await Promise.all([
    commandVersion("git"),
    commandVersion("pnpm"),
  ]);
  const nodeSupported = supportedNodeVersion();
  checks.push({
    check: "Node.js",
    status: nodeSupported ? "PASS" : "FAIL",
    detail: process.version,
    solution: nodeSupported
      ? null
      : "Install Node.js 22.13 or newer, then run `codeoutcome doctor` again.",
  });
  checks.push({
    check: "pnpm (source development)",
    status: pnpmVersion === null ? "WARN" : "PASS",
    detail: pnpmVersion ?? "Not installed; npm package users do not need pnpm",
    solution:
      pnpmVersion === null
        ? "Install pnpm only when building CodeOutcome from source."
        : null,
  });
  checks.push({
    check: "Git",
    status: gitVersion === null ? "FAIL" : "PASS",
    detail: gitVersion ?? "git command is unavailable",
    solution:
      gitVersion === null ? "Install Git and ensure it is on PATH." : null,
  });
  checks.push({
    check: "SQLite runtime",
    status: "PASS",
    detail: `Node built-in SQLite ${process.versions.sqlite ?? "available"}`,
    solution: null,
  });

  const inspection = inspectDatabase(databaseFile);
  checks.push({
    check: "SQLite database",
    status: inspection.ok ? "PASS" : "FAIL",
    detail: redactText(inspection.message, userHome),
    solution: inspection.ok
      ? null
      : "Check database file permissions and disk health; do not delete the file without a backup.",
  });
  checks.push({
    check: "Database migrations",
    status:
      !inspection.exists || inspection.pendingMigrations > 0 ? "WARN" : "PASS",
    detail: `schema ${inspection.currentMigrationVersion}/${inspection.latestMigrationVersion}; ${inspection.pendingMigrations} pending`,
    solution:
      !inspection.exists || inspection.pendingMigrations > 0
        ? "Run a writable command such as `codeoutcome git snapshot` or `codeoutcome import`; migrations are transactional."
        : null,
  });
  const dataDirectory = path.dirname(databaseFile);
  const writable = await writableDirectoryCheck(dataDirectory);
  checks.push({
    check: "Database directory",
    status: writable ? "PASS" : "FAIL",
    detail: writable
      ? `Writable (${redacted(dataDirectory, userHome)})`
      : `Not writable (${redacted(dataDirectory, userHome)})`,
    solution: writable
      ? null
      : "Choose a writable CODEOUTCOME_DATA_DIR or correct directory permissions.",
  });

  checks.push(
    ...(await Promise.all(
      adapters.map((adapter) => inspectLogRoot(adapter, userHome)),
    )),
  );
  for (const adapter of adapters) {
    const support = adapter.formatSupport ?? [];
    const fixtureOnly = support.some(
      (format) => format.validation === "synthetic-fixtures-only",
    );
    checks.push({
      check: `${adapter.provider} formats`,
      status: fixtureOnly ? "WARN" : "PASS",
      detail:
        support.length === 0
          ? adapter.supportedFormats.join("; ")
          : support
              .map((format) => `${format.id} (${format.validation})`)
              .join("; "),
      solution: fixtureOnly
        ? "Claude Code support is fixture-tested only in this release; review `codeoutcome formats --provider claude-code` before relying on its totals."
        : null,
    });
  }
  checks.push({
    check: "Test result formats",
    status: "PASS",
    detail:
      "wrapped pytest, Jest, Vitest, Go test, Cargo test, generic exit codes; JUnit XML, pytest JSON, Jest JSON, Vitest JSON reports",
    solution: null,
  });
  const latest = inspection.latestImportRun;
  checks.push({
    check: "Latest import",
    status:
      latest === null
        ? "WARN"
        : latest.status === "failed"
          ? "FAIL"
          : latest.status === "completed"
            ? "PASS"
            : "WARN",
    detail:
      latest === null
        ? "No completed import is recorded"
        : `${latest.status} at ${latest.completedAt ?? latest.startedAt}; scanned ${latest.scannedFiles}, imported ${latest.importedSessions}, updated ${latest.updatedSessions}`,
    solution:
      latest === null || latest.status !== "completed"
        ? "Review import warnings, then run `codeoutcome import` again."
        : null,
  });
  if (inspection.exists && inspection.pendingMigrations === 0) {
    const database = new SessionDatabase(databaseFile, { readOnly: true });
    try {
      const activeRuns = database.activeTrackingRunCount();
      checks.push({
        check: "Active tracking runs",
        status: activeRuns > 0 ? "WARN" : "PASS",
        detail:
          activeRuns > 0
            ? `${activeRuns} active tracking run(s) may require recovery`
            : "No stale active tracking runs",
        solution:
          activeRuns > 0
            ? "Run `codeoutcome track recover --list`, then recover or abandon the intended run."
            : null,
      });
      const runningTests = database.runningTestRunCount();
      checks.push({
        check: "Running test records",
        status: runningTests > 0 ? "WARN" : "PASS",
        detail:
          runningTests > 0
            ? `${runningTests} running test run(s) may require recovery`
            : "No stale running test runs",
        solution:
          runningTests > 0
            ? "Run `codeoutcome test recover --list`, then recover or abandon the intended test run."
            : null,
      });
    } finally {
      database.close();
    }
  }
  return checks;
}

async function runDoctorCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io" | "userHome">> & {
    adapters: readonly SessionAdapter[];
    databaseFile: string;
  },
): Promise<number> {
  const parsed = parseArguments(arguments_, ["--json"], ["--provider"]);
  const provider = parseProvider(parsed.values.get("--provider"), true);
  const adapters = selectedCliAdapters(context.adapters, provider);
  const checks = await doctorChecks(
    adapters,
    context.databaseFile,
    context.userHome,
  );
  const summary = {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
  const nextActions = checks
    .filter((check) => check.solution !== null)
    .map((check) => `${check.check}: ${check.solution}`);
  if (parsed.booleans.has("--json")) {
    context.io.stdout(
      JSON.stringify({ provider, summary, checks, nextActions }, null, 2),
    );
  } else {
    context.io.stdout(
      [
        table(
          ["CHECK", "STATUS", "DETAIL", "SOLUTION"],
          checks.map((check) => [
            check.check,
            check.status,
            check.detail,
            check.solution ?? "—",
          ]),
        ),
        `Summary: ${summary.pass} PASS, ${summary.warn} WARN, ${summary.fail} FAIL.`,
        summary.fail > 0
          ? "Resolve the FAIL items above, then run doctor again."
          : "Ready for the next step: `codeoutcome import --provider codex --dry-run`.",
      ].join("\n\n"),
    );
  }
  return checks.some((check) => check.status === "FAIL") ? 1 : 0;
}

function sanitizeSession(session: Session, userHome: string): Session {
  return {
    ...session,
    workingDirectory:
      session.workingDirectory === null
        ? null
        : redacted(session.workingDirectory, userHome),
    repositoryPath:
      session.repositoryPath === null
        ? null
        : redacted(session.repositoryPath, userHome),
    sourceFile: redacted(session.sourceFile, userHome),
  };
}

function duration(session: Session): string {
  if (session.startedAt === null || session.endedAt === null) {
    return "unknown";
  }
  const milliseconds = Math.max(
    0,
    new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime(),
  );
  if (!Number.isFinite(milliseconds)) {
    return "unknown";
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatCost(cost: number | null): string {
  return cost === null ? "unavailable" : `$${cost.toFixed(4)} est.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes < 1
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${mebibytes.toFixed(1)} MiB`;
}

async function runImportCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io" | "userHome" | "now">> & {
    adapters: readonly SessionAdapter[];
    databaseFile: string;
  },
): Promise<number> {
  const parsed = parseArguments(
    arguments_,
    ["--dry-run", "--json"],
    ["--provider", "--since"],
  );
  const provider = parseProvider(parsed.values.get("--provider"), true);
  const dryRun = parsed.booleans.has("--dry-run");
  const database = dryRun ? null : new SessionDatabase(context.databaseFile);
  try {
    const report = await runImport({
      adapters: context.adapters,
      database,
      provider,
      dryRun,
      since: parseSince(parsed.values.get("--since"), context.now()),
      now: context.now,
    });
    const safeReport = {
      ...report,
      warnings: report.warnings.map((warning) => ({
        ...warning,
        message: redactText(warning.message, context.userHome),
        sourceFile:
          warning.sourceFile === null
            ? null
            : redacted(warning.sourceFile, context.userHome),
      })),
    };
    if (parsed.booleans.has("--json")) {
      context.io.stdout(JSON.stringify(safeReport, null, 2));
    } else {
      context.io.stdout(
        table(
          [
            "STATUS",
            "SCANNED",
            "IMPORTED",
            "UPDATED",
            "SKIPPED",
            "MALFORMED",
            "EVENTS",
            "READ",
          ],
          [
            [
              `${report.status}${dryRun ? " (dry-run)" : ""}`,
              String(report.scannedFiles),
              String(report.importedSessions),
              String(report.updatedSessions),
              String(report.skippedSessions),
              String(report.malformedFiles),
              String(report.importedEvents),
              formatBytes(report.processedBytes),
            ],
          ],
        ),
      );
      for (const warning of safeReport.warnings) {
        context.io.stderr(
          `WARN [${warning.provider}]${warning.sourceFile === null ? "" : ` ${warning.sourceFile}`}: ${warning.message}`,
        );
      }
    }
    return report.status === "failed" ? 1 : 0;
  } finally {
    database?.close();
  }
}

function openExistingDatabase(databaseFile: string): SessionDatabase | null {
  const inspection = inspectDatabase(databaseFile);
  return inspection.exists &&
    inspection.ok &&
    inspection.pendingMigrations === 0
    ? new SessionDatabase(databaseFile, { readOnly: true })
    : null;
}

async function runSessionsCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io" | "userHome" | "now">> & {
    databaseFile: string;
  },
): Promise<number> {
  const parsed = parseArguments(
    arguments_,
    ["--json"],
    ["--provider", "--since", "--repo", "--limit"],
  );
  const providerValue = parsed.values.get("--provider");
  const provider =
    providerValue === undefined
      ? undefined
      : (parseProvider(providerValue, false) as Provider);
  const database = openExistingDatabase(context.databaseFile);
  const sessions =
    database?.listSessions({
      provider,
      since: parseSince(parsed.values.get("--since"), context.now()),
      repository: parsed.values.get("--repo"),
      limit: parseLimit(parsed.values.get("--limit"), 20),
    }) ?? [];
  database?.close();
  const safeSessions = sessions.map((session) =>
    sanitizeSession(session, context.userHome),
  );
  if (parsed.booleans.has("--json")) {
    context.io.stdout(JSON.stringify(safeSessions, null, 2));
  } else if (safeSessions.length === 0) {
    context.io.stdout(
      "No persisted sessions found. Run `codeoutcome import` first.",
    );
  } else {
    context.io.stdout(
      table(
        [
          "STARTED",
          "PROVIDER",
          "MODEL",
          "DURATION",
          "REPOSITORY",
          "BRANCH",
          "INPUT",
          "OUTPUT",
          "CACHE",
          "COST",
        ],
        safeSessions.map((session) => [
          session.startedAt?.slice(0, 19).replace("T", " ") ?? "unknown",
          session.provider,
          truncate(session.model, 24),
          duration(session),
          truncate(
            session.repositoryName ?? session.repositoryPath ?? "unknown",
            24,
          ),
          truncate(session.branch ?? "unknown", 18),
          session.inputTokens.toLocaleString("en-US"),
          session.outputTokens.toLocaleString("en-US"),
          session.cachedInputTokens.toLocaleString("en-US"),
          formatCost(session.estimatedCost),
        ]),
      ),
    );
  }
  return 0;
}

function shortSessionId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}…`;
}

function safeAuditReport(
  report: UsageAuditReport,
  userHome: string,
): UsageAuditReport {
  return {
    ...report,
    sessions: report.sessions.map((session) => ({
      ...session,
      sessionId: shortSessionId(session.sessionId),
      providerSessionId: shortSessionId(session.providerSessionId),
      sourceFiles: session.sourceFiles.map((sourceFile) =>
        redacted(sourceFile, userHome),
      ),
    })),
  };
}

async function runAuditUsageCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io" | "userHome">> & {
    databaseFile: string;
  },
): Promise<number> {
  const parsed = parseArguments(
    arguments_,
    ["--json"],
    ["--provider", "--session", "--top"],
  );
  const inspection = inspectDatabase(context.databaseFile);
  if (!inspection.exists) {
    context.io.stdout("No database found. Run `codeoutcome import` first.");
    return 0;
  }
  const providerValue = parsed.values.get("--provider");
  const provider =
    providerValue === undefined
      ? undefined
      : (parseProvider(providerValue, false) as Provider);
  const database = new SessionDatabase(context.databaseFile);
  try {
    const report = safeAuditReport(
      auditUsage(database, {
        provider,
        session: parsed.values.get("--session"),
        top: parseLimit(parsed.values.get("--top"), 20),
      }),
      context.userHome,
    );
    if (parsed.booleans.has("--json")) {
      context.io.stdout(JSON.stringify(report, null, 2));
    } else if (report.sessions.length === 0) {
      context.io.stdout("No matching sessions found.");
    } else {
      context.io.stdout(
        [
          `Checked ${report.checkedSessions} session(s); warnings ${report.warningSessions}; ambiguous ${report.ambiguousSessions}; invalid ${report.invalidSessions}.`,
          table(
            [
              "SESSION",
              "PROVIDER",
              "MODEL",
              "SOURCE",
              "SNAP",
              "INCR",
              "INFO",
              "CANON",
              "METHOD",
              "INPUT",
              "UNCACHED",
              "CACHE",
              "OUTPUT",
              "TOTAL",
              "MONO",
              "DUP",
              "I<C",
              "NEG",
              "MIX",
              "WARNINGS",
            ],
            report.sessions.map((session) => [
              session.sessionId,
              session.provider,
              truncate(session.model, 18),
              truncate(session.sourceFiles[0] ?? "unknown", 34),
              String(session.totalSnapshotCount),
              String(session.incrementalEventCount),
              String(session.informationalEventCount),
              String(session.canonicalEventCount),
              session.accountingMethod,
              session.inputTokens.toLocaleString("en-US"),
              session.uncachedInputTokens.toLocaleString("en-US"),
              session.cachedInputTokens.toLocaleString("en-US"),
              session.outputTokens.toLocaleString("en-US"),
              session.totalTokens.toLocaleString("en-US"),
              session.hasMonotonicityAnomaly ? "yes" : "no",
              session.hasDuplicateEvent ? "yes" : "no",
              session.hasInputLessThanCache ? "yes" : "no",
              session.hasNegativeValues ? "yes" : "no",
              session.hasMixedAccounting ? "yes" : "no",
              session.warnings.join(",") || "—",
            ]),
          ),
        ].join("\n\n"),
      );
    }
    return report.invalidSessions > 0 ? 1 : 0;
  } finally {
    database.close();
  }
}

function safeReconciliationReport(
  report: UsageReconciliationReport,
): UsageReconciliationReport {
  return {
    ...report,
    sessions: report.sessions.map((session) => ({
      ...session,
      sessionId: shortSessionId(session.sessionId),
    })),
  };
}

async function runReconcileUsageCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io">> & { databaseFile: string },
): Promise<number> {
  const parsed = parseArguments(
    arguments_,
    ["--dry-run", "--json"],
    ["--provider"],
  );
  const inspection = inspectDatabase(context.databaseFile);
  if (!inspection.exists) {
    context.io.stdout("No database found. Run `codeoutcome import` first.");
    return 0;
  }
  const providerValue = parsed.values.get("--provider");
  const provider =
    providerValue === undefined
      ? undefined
      : (parseProvider(providerValue, false) as Provider);
  const dryRun = parsed.booleans.has("--dry-run");
  const database = new SessionDatabase(context.databaseFile);
  try {
    const report = safeReconciliationReport(
      reconcileUsage(database, { provider, dryRun }),
    );
    if (parsed.booleans.has("--json")) {
      context.io.stdout(JSON.stringify(report, null, 2));
    } else {
      context.io.stdout(
        [
          table(
            [
              "MODE",
              "CHECKED",
              "MODIFIED",
              "WARN",
              "AMBIGUOUS",
              "BEFORE INPUT",
              "AFTER INPUT",
              "BEFORE OUTPUT",
              "AFTER OUTPUT",
              "BEFORE CACHE",
              "AFTER CACHE",
            ],
            [
              [
                dryRun ? "dry-run" : "applied",
                String(report.checkedSessions),
                String(report.modifiedSessions),
                String(report.warningSessions),
                String(report.ambiguousSessions),
                report.before.inputTokens.toLocaleString("en-US"),
                report.after.inputTokens.toLocaleString("en-US"),
                report.before.outputTokens.toLocaleString("en-US"),
                report.after.outputTokens.toLocaleString("en-US"),
                report.before.cachedInputTokens.toLocaleString("en-US"),
                report.after.cachedInputTokens.toLocaleString("en-US"),
              ],
            ],
          ),
          table(
            ["SESSION", "CHANGED", "METHOD", "STATUS", "WARNINGS"],
            report.sessions.map((session) => [
              session.sessionId,
              session.modified ? "yes" : "no",
              session.after.accountingMethod,
              session.after.accountingStatus,
              session.warnings.join(",") || "—",
            ]),
          ),
        ].join("\n\n"),
      );
    }
    return 0;
  } finally {
    database.close();
  }
}

function selectPeriod(parsed: ParsedArguments): UsagePeriod {
  const selected = ["--daily", "--weekly", "--monthly"].filter((flag) =>
    parsed.booleans.has(flag),
  );
  if (selected.length > 1) {
    throw new Error("Choose only one of --daily, --weekly, or --monthly");
  }
  return selected[0] === "--weekly"
    ? "weekly"
    : selected[0] === "--monthly"
      ? "monthly"
      : "daily";
}

function formatCostSummary(cost: CostSummary): string {
  return cost.amount === null
    ? "unavailable"
    : `$${cost.amount.toFixed(4)} ${cost.status}`;
}

function usageSection(
  title: string,
  buckets: UsageReport["byProvider"],
): string {
  return `${title}\n${table(
    [
      "GROUP",
      "SESSIONS",
      "INPUT",
      "UNCACHED INPUT",
      "CACHED INPUT*",
      "OUTPUT",
      "TOTAL**",
      "COST",
    ],
    buckets.map((bucket) => [
      bucket.key,
      bucket.sessions.toLocaleString("en-US"),
      bucket.inputTokens.toLocaleString("en-US"),
      bucket.uncachedInputTokens.toLocaleString("en-US"),
      bucket.cachedInputTokens.toLocaleString("en-US"),
      bucket.outputTokens.toLocaleString("en-US"),
      bucket.totalTokens.toLocaleString("en-US"),
      formatCostSummary(bucket.cost),
    ]),
  )}`;
}

async function runUsageCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io" | "now">> & {
    databaseFile: string;
  },
): Promise<number> {
  const parsed = parseArguments(
    arguments_,
    ["--json", "--daily", "--weekly", "--monthly"],
    ["--provider", "--since"],
  );
  const providerValue = parsed.values.get("--provider");
  const provider =
    providerValue === undefined
      ? undefined
      : (parseProvider(providerValue, false) as Provider);
  const database = openExistingDatabase(context.databaseFile);
  const sessions =
    database?.listSessions({
      provider,
      since: parseSince(parsed.values.get("--since"), context.now()),
    }) ?? [];
  database?.close();
  const report = buildUsageReport(sessions, selectPeriod(parsed));
  if (parsed.booleans.has("--json")) {
    context.io.stdout(JSON.stringify(report, null, 2));
  } else if (sessions.length === 0) {
    context.io.stdout(
      "No persisted usage found. Run `codeoutcome import` first.",
    );
  } else {
    context.io.stdout(
      [
        usageSection("TOTAL", [report.totals]),
        usageSection("BY PROVIDER", report.byProvider),
        usageSection("BY MODEL", report.byModel),
        usageSection(`BY ${report.period.toUpperCase()} PERIOD`, report.byDate),
        "* Cached Input is normally a subset of Input; it is not added again.",
        "** Total = Input + Output.",
        `Pricing: ${report.pricing.version}; updated ${report.pricing.updatedAt}; ${report.pricing.source}`,
      ].join("\n\n"),
    );
  }
  return 0;
}

function declaredFormatSupport(
  adapter: SessionAdapter,
): ProviderFormatSupport[] {
  return adapter.formatSupport === undefined
    ? adapter.supportedFormats.map((description, index) => ({
        id: `${adapter.provider}-format-${index + 1}`,
        description,
        validation: "synthetic-fixtures-only" as const,
        recordMarkers: [],
        limitations: ["Structured compatibility metadata is unavailable"],
      }))
    : [...adapter.formatSupport];
}

async function runFormatsCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io">> & {
    adapters: readonly SessionAdapter[];
    databaseFile: string;
  },
): Promise<number> {
  const parsed = parseArguments(arguments_, ["--json"], ["--provider"]);
  const provider = parseProvider(parsed.values.get("--provider"), true);
  const adapters = selectedCliAdapters(context.adapters, provider);
  const database = openExistingDatabase(context.databaseFile);
  const importedFormats = database?.listSourceFormatCounts() ?? [];
  database?.close();
  const formats = adapters.flatMap((adapter) =>
    declaredFormatSupport(adapter).map((format) => ({
      provider: adapter.provider,
      ...format,
      importedFiles:
        importedFormats.find(
          (count) =>
            count.provider === adapter.provider && count.format === format.id,
        )?.files ?? 0,
    })),
  );
  if (parsed.booleans.has("--json")) {
    context.io.stdout(
      JSON.stringify(
        {
          provider,
          formats,
          unknownImportedFormats: importedFormats.filter(
            (count) =>
              !formats.some(
                (format) =>
                  format.provider === count.provider &&
                  format.id === count.format,
              ),
          ),
          note: "Support describes recognized metadata fields, not a stable Provider API guarantee.",
        },
        null,
        2,
      ),
    );
  } else {
    context.io.stdout(
      [
        table(
          ["PROVIDER", "FORMAT", "VALIDATION", "IMPORTED", "DESCRIPTION"],
          formats.map((format) => [
            format.provider,
            format.id,
            format.validation,
            String(format.importedFiles),
            format.description,
          ]),
        ),
        ...formats.map(
          (format) =>
            `${format.provider}/${format.id}\n  Markers: ${format.recordMarkers.join(", ") || "—"}\n  Limits: ${format.limitations.join("; ") || "—"}`,
        ),
        "Support describes recognized metadata fields, not a stable Provider API guarantee.",
      ].join("\n\n"),
    );
  }
  return 0;
}

function runFeedbackCommand(
  arguments_: readonly string[],
  context: Required<Pick<CliOptions, "io">>,
): number {
  const parsed = parseArguments(arguments_, ["--json"], []);
  const feedback = {
    sent: false,
    automaticCollection: false,
    includesMachineIdentifiers: false,
    questions: {
      install: "Did installation succeed? yes/no",
      import: "Did your selected Provider import succeed? yes/no",
      clarity: "Was the first useful result obvious? 1-5",
      returnIntent: "Would you open CodeOutcome again tomorrow? yes/no/maybe",
      blocker: "What was the first confusing or failing step?",
    },
    publicSubmission: {
      url: "https://github.com/vsn75rgcpx-sudo/codeoutcome/issues/new?template=first_user_feedback.yml",
      identityNotice:
        "GitHub shows the submitting account; this transport is not anonymous.",
    },
    privacyReminder:
      "Do not include Provider logs, databases, prompts, source code, credentials, session IDs, or full paths.",
  } as const;
  if (parsed.booleans.has("--json")) {
    context.io.stdout(JSON.stringify(feedback, null, 2));
  } else {
    context.io.stdout(
      [
        "Optional local feedback card — nothing has been sent.",
        "Copy only the answers you choose; this template contains no machine identifiers:",
        ...Object.values(feedback.questions).map((question) => `- ${question}`),
        "",
        `Optional public submission: ${feedback.publicSubmission.url}`,
        feedback.publicSubmission.identityNotice,
        feedback.privacyReminder,
      ].join("\n"),
    );
  }
  return 0;
}

async function runLegacyMigrationCommand(
  arguments_: readonly string[],
  context: Required<
    Pick<CliOptions, "environment" | "io" | "now" | "platform" | "userHome">
  >,
): Promise<number> {
  const parsed = parseArguments(arguments_, ["--dry-run", "--json"], []);
  let result: LegacyMigrationResult;
  try {
    result = await migrateLegacyDatabase({
      environment: context.environment,
      userHome: context.userHome,
      platform: context.platform,
      dryRun: parsed.booleans.has("--dry-run"),
      now: context.now,
    });
  } catch (error) {
    throw new Error(redactText(safeError(error), context.userHome));
  }
  const safe = {
    ...result,
    legacyDataDirectory: redacted(result.legacyDataDirectory, context.userHome),
    legacyDatabaseFile: redacted(result.legacyDatabaseFile, context.userHome),
    currentDataDirectory: redacted(
      result.currentDataDirectory,
      context.userHome,
    ),
    currentDatabaseFile: redacted(result.currentDatabaseFile, context.userHome),
    backupFile:
      result.backupFile === null
        ? null
        : redacted(result.backupFile, context.userHome),
    reasons: result.reasons.map((reason) =>
      redactText(reason, context.userHome),
    ),
  };
  if (parsed.booleans.has("--json")) {
    context.io.stdout(JSON.stringify(safe, null, 2));
  } else {
    context.io.stdout(
      [
        `Mode: ${result.dryRun ? "dry-run" : "apply"}`,
        `Legacy database: ${safe.legacyDatabaseFile}`,
        `CodeOutcome database: ${safe.currentDatabaseFile}`,
        `Can migrate: ${result.canMigrate ? "yes" : "no"}`,
        `Migrated: ${result.migrated ? "yes" : "no"}`,
        `Backup: ${safe.backupFile ?? "not created"}`,
        `Schema: ${result.legacyMigrationVersion} → ${result.targetMigrationVersion}`,
        `Notes: ${safe.reasons.join("; ") || (result.dryRun ? "Preview passed; rerun without --dry-run to create a verified copy." : "Migration completed; the legacy database was retained.")}`,
      ].join("\n"),
    );
  }
  return result.canMigrate && (result.dryRun || result.migrated) ? 0 : 1;
}

function help(): string {
  return `CodeOutcome — local-first AI session, Git, and test result accounting

Usage:
  codeoutcome --version
  codeoutcome doctor [--provider claude-code|codex|all] [--json]
  codeoutcome import [--provider claude-code|codex|all] [--dry-run] [--since 7d] [--json]
  codeoutcome audit-usage [--provider claude-code|codex] [--session id] [--top 20] [--json]
  codeoutcome reconcile-usage [--provider claude-code|codex] [--dry-run] [--json]
  codeoutcome sessions [--provider claude-code|codex] [--since 7d] [--repo name-or-path] [--limit 20] [--json]
  codeoutcome usage [--daily|--weekly|--monthly] [--provider claude-code|codex] [--since 30d] [--json]
  codeoutcome formats [--provider claude-code|codex|all] [--json]
  codeoutcome feedback [--json]
  codeoutcome data migrate-legacy [--dry-run] [--json]
${PHASE3_HELP}
${TEST_HELP}
${DASHBOARD_HELP}

CodeOutcome reads source logs without modifying them and never stores prompt,
response, source, or raw test output bodies.`;
}

export async function runCli(
  arguments_: readonly string[],
  options: CliOptions = {},
): Promise<number> {
  const environment = options.environment ?? process.env;
  const userHome = options.userHome ?? homedir();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const io = options.io ?? defaultIo;
  if (arguments_[0] === "--version" || arguments_[0] === "-V") {
    if (arguments_.length !== 1) {
      throw new Error("--version does not accept additional arguments");
    }
    io.stdout(CODEOUTCOME_VERSION);
    return 0;
  }
  const [earlyCommand = "help", ...earlyArguments] = arguments_;
  if (
    earlyCommand === "help" ||
    earlyCommand === "--help" ||
    earlyCommand === "-h"
  ) {
    io.stdout(help());
    return 0;
  }
  if (earlyCommand === "feedback") {
    return runFeedbackCommand(earlyArguments, { io });
  }
  warnForLegacyEnvironment(environment, io);
  const adapters = options.adapters ?? defaultAdapters(environment, userHome);
  const resolvedPaths =
    options.databaseFile === undefined
      ? getCodeOutcomePaths(environment, userHome, platform)
      : null;
  if (resolvedPaths !== null) {
    warnForLegacyDataLocation(resolvedPaths, userHome, io);
  }
  const databaseFile = options.databaseFile ?? resolvedPaths?.databaseFile;
  if (databaseFile === undefined) {
    throw new Error("CodeOutcome database path could not be resolved");
  }
  const dashboardResult = await runDashboardCli(arguments_, {
    io,
    databaseFile,
    dataDirectory: path.dirname(databaseFile),
    userHome,
    platform,
    environment,
    now,
    staticRoot: options.dashboardStaticRoot,
    startServer: options.dashboardStarter,
    openBrowser: options.dashboardBrowserOpener,
  });
  if (dashboardResult !== null) return dashboardResult;
  const testResult = await runTestCli(arguments_, {
    io,
    databaseFile,
    dataDirectory: path.dirname(databaseFile),
    userHome,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    environment,
    now,
    testProcessRunner: options.testProcessRunner,
  });
  if (testResult !== null) return testResult;
  const phase3Result = await runPhase3Cli(arguments_, {
    io,
    databaseFile,
    dataDirectory: path.dirname(databaseFile),
    userHome,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    now,
    adapters,
    gitRunner: options.gitRunner,
    processRunner: options.processRunner,
    codexExecutable: options.codexExecutable ?? "codex",
    environment,
  });
  if (phase3Result !== null) return phase3Result;
  const [command = "help", ...commandArguments] = arguments_;

  switch (command) {
    case "doctor":
      return runDoctorCommand(commandArguments, {
        adapters,
        databaseFile,
        io,
        userHome,
      });
    case "import":
      return runImportCommand(commandArguments, {
        adapters,
        databaseFile,
        io,
        userHome,
        now,
      });
    case "audit-usage":
      return runAuditUsageCommand(commandArguments, {
        databaseFile,
        io,
        userHome,
      });
    case "reconcile-usage":
      return runReconcileUsageCommand(commandArguments, {
        databaseFile,
        io,
      });
    case "sessions":
      return runSessionsCommand(commandArguments, {
        databaseFile,
        io,
        userHome,
        now,
      });
    case "usage":
      return runUsageCommand(commandArguments, {
        databaseFile,
        io,
        now,
      });
    case "formats":
      return runFormatsCommand(commandArguments, {
        adapters,
        databaseFile,
        io,
      });
    case "feedback":
      return runFeedbackCommand(commandArguments, { io });
    case "data":
      if (commandArguments[0] !== "migrate-legacy") {
        throw new Error("data requires migrate-legacy or delete-tests");
      }
      return runLegacyMigrationCommand(commandArguments.slice(1), {
        environment,
        io,
        now,
        platform,
        userHome,
      });
    case "help":
    case "--help":
    case "-h":
      io.stdout(help());
      return 0;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
