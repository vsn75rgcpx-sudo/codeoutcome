import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Provider, Session } from "@agentledger/shared";

export interface AgentLedgerPaths {
  dataDirectory: string;
  databaseFile: string;
}

export interface DatabaseInspection {
  ok: boolean;
  message: string;
}

interface SessionRow {
  id: unknown;
  provider: unknown;
  model: unknown;
  started_at: unknown;
  ended_at: unknown;
  working_directory: unknown;
  repository_path: unknown;
  branch: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cached_input_tokens: unknown;
  estimated_cost: unknown;
  source_file: unknown;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function providerFrom(value: unknown): Provider {
  return value === "claude-code" ? "claude-code" : "codex";
}

export function getAgentLedgerPaths(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): AgentLedgerPaths {
  const configured = environment.AGENTLEDGER_DATA_DIR?.trim();
  const dataDirectory =
    configured !== undefined && configured.length > 0
      ? path.resolve(configured)
      : path.join(userHome, ".agentledger");

  return {
    dataDirectory,
    databaseFile: path.join(dataDirectory, "agentledger.sqlite"),
  };
}

export function inspectDatabase(databaseFile: string): DatabaseInspection {
  if (!existsSync(databaseFile)) {
    let existingParent = path.dirname(databaseFile);
    while (!existsSync(existingParent)) {
      const next = path.dirname(existingParent);
      if (next === existingParent) {
        return { ok: false, message: "no accessible parent directory" };
      }
      existingParent = next;
    }

    try {
      accessSync(existingParent, constants.W_OK | constants.X_OK);
      return {
        ok: true,
        message: `ready; database will be created on first scan (${databaseFile})`,
      };
    } catch {
      return {
        ok: false,
        message: `parent directory is not writable (${existingParent})`,
      };
    }
  }

  try {
    accessSync(databaseFile, constants.R_OK | constants.W_OK);
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const row = database.prepare("PRAGMA quick_check").get() as
        Record<string, unknown> | undefined;
      const result = row === undefined ? undefined : Object.values(row)[0];
      if (result !== "ok") {
        return {
          ok: false,
          message: `SQLite quick check returned ${String(result)}`,
        };
      }
    } finally {
      database.close();
    }
    return {
      ok: true,
      message: `readable, writable, and valid (${databaseFile})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { ok: false, message };
  }
}

export class SessionDatabase {
  readonly #database: DatabaseSync;

  constructor(readonly databaseFile: string) {
    mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databaseFile);
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        provider TEXT NOT NULL,
        id TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        working_directory TEXT,
        repository_path TEXT,
        branch TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL,
        source_file TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, id)
      );
    `);
  }

  upsertSessions(sessions: readonly Session[]): void {
    const statement = this.#database.prepare(`
      INSERT INTO sessions (
        provider, id, model, started_at, ended_at, working_directory,
        repository_path, branch, input_tokens, output_tokens,
        cached_input_tokens, estimated_cost, source_file
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, id) DO UPDATE SET
        model = excluded.model,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        working_directory = excluded.working_directory,
        repository_path = excluded.repository_path,
        branch = excluded.branch,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        estimated_cost = excluded.estimated_cost,
        source_file = excluded.source_file,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const session of sessions) {
        statement.run(
          session.provider,
          session.id,
          session.model,
          session.startedAt,
          session.endedAt,
          session.workingDirectory,
          session.repositoryPath,
          session.branch,
          session.inputTokens,
          session.outputTokens,
          session.cachedInputTokens,
          session.estimatedCost,
          session.sourceFile,
        );
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listSessions(): Session[] {
    const rows = this.#database
      .prepare(
        `SELECT provider, id, model, started_at, ended_at,
          working_directory, repository_path, branch, input_tokens,
          output_tokens, cached_input_tokens, estimated_cost, source_file
        FROM sessions
        ORDER BY COALESCE(started_at, ended_at, '') DESC`,
      )
      .all() as unknown as SessionRow[];

    return rows.map((row) => ({
      id: nullableString(row.id) ?? "unknown-session",
      provider: providerFrom(row.provider),
      model: nullableString(row.model) ?? "unknown",
      startedAt: nullableString(row.started_at),
      endedAt: nullableString(row.ended_at),
      workingDirectory: nullableString(row.working_directory),
      repositoryPath: nullableString(row.repository_path),
      branch: nullableString(row.branch),
      inputTokens: safeNumber(row.input_tokens),
      outputTokens: safeNumber(row.output_tokens),
      cachedInputTokens: safeNumber(row.cached_input_tokens),
      estimatedCost:
        row.estimated_cost === null ? null : safeNumber(row.estimated_cost),
      sourceFile: nullableString(row.source_file) ?? "unknown",
    }));
  }

  close(): void {
    this.#database.close();
  }
}
