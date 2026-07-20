#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ClaudeCodeAdapter } from "@agentledger/adapter-claude-code";
import { CodexAdapter } from "@agentledger/adapter-codex";
import { collectSessions } from "@agentledger/core";
import {
  getAgentLedgerPaths,
  inspectDatabase,
  SessionDatabase,
} from "@agentledger/database";
import { enrichSessionsWithGit } from "@agentledger/git-tracker";
import type { Provider, Session, SessionAdapter } from "@agentledger/shared";

const execFileAsync = promisify(execFile);

interface DoctorCheck {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

interface UsageGroup {
  provider: Provider;
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCost: number;
  hasEstimatedCost: boolean;
}

function configuredPath(environmentName: string, fallback: string): string {
  const configured = process.env[environmentName]?.trim();
  return configured === undefined || configured.length === 0
    ? fallback
    : path.resolve(configured);
}

function adapters(): SessionAdapter[] {
  const userHome = homedir();
  return [
    new ClaudeCodeAdapter(
      configuredPath(
        "AGENTLEDGER_CLAUDE_LOG_DIR",
        path.join(userHome, ".claude", "projects"),
      ),
    ),
    new CodexAdapter(
      configuredPath(
        "AGENTLEDGER_CODEX_LOG_DIR",
        path.join(userHome, ".codex", "sessions"),
      ),
    ),
  ];
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  console.log(format(headers));
  console.log(format(widths.map((width) => "-".repeat(width))));
  for (const row of rows) {
    console.log(format(row));
  }
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

async function inspectLogRoot(adapter: SessionAdapter): Promise<DoctorCheck> {
  try {
    const metadata = await stat(adapter.logRoot);
    if (!metadata.isDirectory()) {
      return {
        label: `${adapter.provider} logs`,
        status: "fail",
        detail: `not a directory (${adapter.logRoot})`,
      };
    }
    await access(adapter.logRoot, constants.R_OK | constants.X_OK);
    const sourceFiles = await adapter.discoverSourceFiles();
    return {
      label: `${adapter.provider} logs`,
      status: "ok",
      detail: `${sourceFiles.length} readable JSONL file(s) (${adapter.logRoot})`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        label: `${adapter.provider} logs`,
        status: "warn",
        detail: `path not found; install or run ${adapter.provider} first (${adapter.logRoot})`,
      };
    }
    return {
      label: `${adapter.provider} logs`,
      status: "fail",
      detail:
        error instanceof Error ? error.message : "permission check failed",
    };
  }
}

async function runDoctor(): Promise<void> {
  const checks: DoctorCheck[] = [];
  const gitVersion = await commandVersion("git");
  checks.push({
    label: "Git",
    status: gitVersion === null ? "fail" : "ok",
    detail: gitVersion ?? "git command is unavailable",
  });

  const logChecks = await Promise.all(adapters().map(inspectLogRoot));
  checks.push(...logChecks);

  const { databaseFile } = getAgentLedgerPaths();
  const database = inspectDatabase(databaseFile);
  checks.push({
    label: "Database",
    status: database.ok ? "ok" : "fail",
    detail: database.message,
  });

  const failedPermissions = checks.filter(
    (check) => check.status === "fail" && check.label !== "Git",
  );
  checks.push({
    label: "Permissions",
    status: failedPermissions.length === 0 ? "ok" : "fail",
    detail:
      failedPermissions.length === 0
        ? "log reads and AgentLedger data writes are permitted"
        : `${failedPermissions.length} path check(s) failed`,
  });

  printTable(
    ["CHECK", "STATUS", "DETAIL"],
    checks.map((check) => [
      check.label,
      check.status.toUpperCase(),
      check.detail,
    ]),
  );

  if (checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }
}

async function scanAndLoad(): Promise<{
  sessions: Session[];
  warningCount: number;
}> {
  const collection = await collectSessions(adapters());
  const enriched = await enrichSessionsWithGit(collection.sessions);
  const { databaseFile } = getAgentLedgerPaths();
  const database = new SessionDatabase(databaseFile);
  try {
    database.upsertSessions(enriched);
    return {
      sessions: database.listSessions(),
      warningCount: collection.warnings.length,
    };
  } finally {
    database.close();
  }
}

async function runSessions(json: boolean): Promise<void> {
  const { sessions, warningCount } = await scanAndLoad();
  if (json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(
      "No sessions found. Run `agentledger doctor` to check log paths.",
    );
  } else {
    printTable(
      ["STARTED", "PROVIDER", "MODEL", "BRANCH", "INPUT", "OUTPUT"],
      sessions.map((session) => [
        session.startedAt?.slice(0, 19).replace("T", " ") ?? "unknown",
        session.provider,
        truncate(session.model, 28),
        truncate(session.branch ?? "unknown", 24),
        session.inputTokens.toLocaleString("en-US"),
        session.outputTokens.toLocaleString("en-US"),
      ]),
    );
  }

  if (warningCount > 0) {
    console.error(
      `Warning: ${warningCount} source file(s) could not be parsed or discovered.`,
    );
  }
}

function aggregateUsage(sessions: readonly Session[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const session of sessions) {
    const key = `${session.provider}\u0000${session.model}`;
    const group = groups.get(key) ?? {
      provider: session.provider,
      model: session.model,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      estimatedCost: 0,
      hasEstimatedCost: false,
    };
    group.sessions += 1;
    group.inputTokens += session.inputTokens;
    group.outputTokens += session.outputTokens;
    group.cachedInputTokens += session.cachedInputTokens;
    if (session.estimatedCost !== null) {
      group.estimatedCost += session.estimatedCost;
      group.hasEstimatedCost = true;
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) =>
    left.provider === right.provider
      ? left.model.localeCompare(right.model)
      : left.provider.localeCompare(right.provider),
  );
}

async function runUsage(json: boolean): Promise<void> {
  const { sessions, warningCount } = await scanAndLoad();
  const groups = aggregateUsage(sessions);
  if (json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }

  if (groups.length === 0) {
    console.log("No usage found. Run `agentledger doctor` to check log paths.");
  } else {
    printTable(
      ["PROVIDER", "MODEL", "SESSIONS", "INPUT", "CACHED", "OUTPUT", "COST"],
      groups.map((group) => [
        group.provider,
        truncate(group.model, 28),
        group.sessions.toLocaleString("en-US"),
        group.inputTokens.toLocaleString("en-US"),
        group.cachedInputTokens.toLocaleString("en-US"),
        group.outputTokens.toLocaleString("en-US"),
        group.hasEstimatedCost
          ? `$${group.estimatedCost.toFixed(4)}`
          : "unknown",
      ]),
    );
  }

  if (warningCount > 0) {
    console.error(`Warning: ${warningCount} source file(s) were skipped.`);
  }
}

function printHelp(): void {
  console.log(`AgentLedger — local-first coding session review

Usage:
  agentledger doctor          Check log paths, Git, database, and permissions
  agentledger sessions        Scan and list session metadata
  agentledger sessions --json Emit session metadata as JSON
  agentledger usage           Aggregate token usage by provider and model
  agentledger usage --json    Emit usage aggregates as JSON

AgentLedger never writes to Claude Code or Codex log directories.`);
}

async function main(): Promise<void> {
  const [command = "help", ...arguments_] = process.argv.slice(2);
  const json = arguments_.includes("--json");

  switch (command) {
    case "doctor":
      await runDoctor();
      break;
    case "sessions":
      await runSessions(json);
      break;
    case "usage":
      await runUsage(json);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 1;
});
