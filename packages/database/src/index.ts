import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Provider,
  ProviderSelection,
  Session,
  UsageEvent,
  UsageEventType,
} from "@agentledger/shared";

import {
  LATEST_MIGRATION_VERSION,
  readAppliedMigrationVersion,
  runMigrations,
} from "./migrations.js";

export { LATEST_MIGRATION_VERSION } from "./migrations.js";

export interface AgentLedgerPaths {
  dataDirectory: string;
  databaseFile: string;
}

export interface ImportRunSummary {
  scannedFiles: number;
  importedSessions: number;
  updatedSessions: number;
  skippedSessions: number;
  malformedFiles: number;
}

export type ImportRunStatus = "running" | "completed" | "partial" | "failed";

export interface ImportRun extends ImportRunSummary {
  id: number;
  provider: ProviderSelection;
  startedAt: string;
  completedAt: string | null;
  status: ImportRunStatus;
}

export interface DatabaseInspection {
  ok: boolean;
  exists: boolean;
  message: string;
  currentMigrationVersion: number;
  latestMigrationVersion: number;
  pendingMigrations: number;
  latestImportRun: ImportRun | null;
}

export interface SourceFileState {
  sourceFile: string;
  provider: Provider;
  providerSessionId: string;
  sessionId: string;
  fileSize: number;
  fileMtimeMs: number;
  processedBytes: number;
  processedHash: string;
  sourceFileHash: string;
  format: string;
  model: string;
  startedAt: string | null;
  endedAt: string | null;
  workingDirectory: string | null;
  repositoryPath: string | null;
  branch: string | null;
  malformedLines: number;
  truncated: boolean;
  lastImportedAt: string;
}

export interface RepositoryInput {
  canonicalPath: string;
  name: string;
  remoteUrl: string | null;
}

export interface SourceImportInput {
  session: Session;
  usageEvents: readonly UsageEvent[];
  repository: RepositoryInput | null;
  fileSize: number;
  fileMtimeMs: number;
  processedBytes: number;
  processedHash: string;
  sourceFileHash: string;
  format: string;
  malformedLines: number;
  truncated: boolean;
  resetSource: boolean;
  importedAt: string;
}

export interface SourceImportResult {
  kind: "inserted" | "updated";
  affectedSessionIds: string[];
}

export interface SessionQuery {
  provider?: Provider;
  since?: string;
  repository?: string;
  limit?: number;
}

interface SessionRow {
  id: unknown;
  provider: unknown;
  provider_session_id: unknown;
  model: unknown;
  started_at: unknown;
  ended_at: unknown;
  working_directory: unknown;
  repository_path: unknown;
  repository_name: unknown;
  remote_url: unknown;
  branch: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cached_input_tokens: unknown;
  estimated_cost: unknown;
  source_file: unknown;
  source_file_hash: unknown;
  imported_at: unknown;
}

interface UsageEventRow {
  id: unknown;
  session_id: unknown;
  event_time: unknown;
  event_type: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cached_input_tokens: unknown;
  estimated_cost: unknown;
  source_file: unknown;
  source_offset: unknown;
}

interface ImportRunRow {
  id: unknown;
  provider: unknown;
  started_at: unknown;
  completed_at: unknown;
  scanned_files: unknown;
  imported_sessions: unknown;
  updated_sessions: unknown;
  skipped_sessions: unknown;
  malformed_files: unknown;
  status: unknown;
}

interface SourceFileRow {
  source_file: unknown;
  provider: unknown;
  provider_session_id: unknown;
  session_id: unknown;
  file_size: unknown;
  file_mtime_ms: unknown;
  processed_bytes: unknown;
  processed_hash: unknown;
  source_file_hash: unknown;
  format: unknown;
  model: unknown;
  started_at: unknown;
  ended_at: unknown;
  working_directory: unknown;
  repository_path: unknown;
  branch: unknown;
  malformed_lines: unknown;
  truncated: unknown;
  last_imported_at: unknown;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, fallback: string): string {
  return nullableString(value) ?? fallback;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function providerFrom(value: unknown): Provider {
  if (value === "claude-code" || value === "codex") {
    return value;
  }
  throw new Error(`Unsupported provider stored in database: ${String(value)}`);
}

function providerSelectionFrom(value: unknown): ProviderSelection {
  return value === "all" ? "all" : providerFrom(value);
}

function importStatusFrom(value: unknown): ImportRunStatus {
  if (
    value === "running" ||
    value === "completed" ||
    value === "partial" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported import status stored in database: ${String(value)}`,
  );
}

function usageEventTypeFrom(value: unknown): UsageEventType {
  if (value === "incremental" || value === "cumulative") {
    return value;
  }
  throw new Error(`Unsupported usage event type: ${String(value)}`);
}

function minTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function maxTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function importRunFromRow(row: ImportRunRow): ImportRun {
  return {
    id: safeNumber(row.id),
    provider: providerSelectionFrom(row.provider),
    startedAt: requiredString(row.started_at, ""),
    completedAt: nullableString(row.completed_at),
    scannedFiles: safeNumber(row.scanned_files),
    importedSessions: safeNumber(row.imported_sessions),
    updatedSessions: safeNumber(row.updated_sessions),
    skippedSessions: safeNumber(row.skipped_sessions),
    malformedFiles: safeNumber(row.malformed_files),
    status: importStatusFrom(row.status),
  };
}

export function getAgentLedgerPaths(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  platform = process.platform,
): AgentLedgerPaths {
  const configured = environment.AGENTLEDGER_DATA_DIR?.trim();
  let dataDirectory: string;
  if (configured !== undefined && configured.length > 0) {
    dataDirectory = path.resolve(configured);
  } else if (platform === "darwin") {
    dataDirectory = path.join(
      userHome,
      "Library",
      "Application Support",
      "AgentLedger",
    );
  } else {
    const xdgDataHome = environment.XDG_DATA_HOME?.trim();
    dataDirectory =
      xdgDataHome !== undefined && xdgDataHome.length > 0
        ? path.join(path.resolve(xdgDataHome), "agentledger")
        : path.join(userHome, ".local", "share", "agentledger");
  }

  return {
    dataDirectory,
    databaseFile: path.join(dataDirectory, "agentledger.sqlite"),
  };
}

function findWritableParent(databaseFile: string): string | null {
  let existingParent = path.dirname(databaseFile);
  while (!existsSync(existingParent)) {
    const next = path.dirname(existingParent);
    if (next === existingParent) {
      return null;
    }
    existingParent = next;
  }
  try {
    accessSync(existingParent, constants.W_OK | constants.X_OK);
    return existingParent;
  } catch {
    return null;
  }
}

function latestImportRunReadOnly(database: DatabaseSync): ImportRun | null {
  const table = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'import_runs'",
    )
    .get();
  if (table === undefined) {
    return null;
  }
  const row = database
    .prepare("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1")
    .get() as ImportRunRow | undefined;
  return row === undefined ? null : importRunFromRow(row);
}

export function inspectDatabase(databaseFile: string): DatabaseInspection {
  if (!existsSync(databaseFile)) {
    const writableParent = findWritableParent(databaseFile);
    return {
      ok: writableParent !== null,
      exists: false,
      message:
        writableParent === null
          ? `database parent is not writable (${path.dirname(databaseFile)})`
          : `ready; database will be created on first import (${databaseFile})`,
      currentMigrationVersion: 0,
      latestMigrationVersion: LATEST_MIGRATION_VERSION,
      pendingMigrations: LATEST_MIGRATION_VERSION,
      latestImportRun: null,
    };
  }

  try {
    accessSync(databaseFile, constants.R_OK | constants.W_OK);
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      const row = database.prepare("PRAGMA quick_check").get() as
        Record<string, unknown> | undefined;
      const result = row === undefined ? undefined : Object.values(row)[0];
      const currentMigrationVersion = readAppliedMigrationVersion(database);
      const pendingMigrations = Math.max(
        0,
        LATEST_MIGRATION_VERSION - currentMigrationVersion,
      );
      return {
        ok: result === "ok",
        exists: true,
        message:
          result === "ok"
            ? `SQLite integrity check passed (${databaseFile})`
            : `SQLite quick check returned ${String(result)}`,
        currentMigrationVersion,
        latestMigrationVersion: LATEST_MIGRATION_VERSION,
        pendingMigrations,
        latestImportRun: latestImportRunReadOnly(database),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      ok: false,
      exists: true,
      message:
        error instanceof Error ? error.message : "unknown database error",
      currentMigrationVersion: 0,
      latestMigrationVersion: LATEST_MIGRATION_VERSION,
      pendingMigrations: LATEST_MIGRATION_VERSION,
      latestImportRun: null,
    };
  }
}

export class SessionDatabase {
  readonly #database: DatabaseSync;
  readonly #readOnly: boolean;

  constructor(
    readonly databaseFile: string,
    options: { readOnly?: boolean } = {},
  ) {
    this.#readOnly = options.readOnly ?? false;
    if (!this.#readOnly) {
      mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(databaseFile, {
      readOnly: this.#readOnly,
    });
    this.#database.exec("PRAGMA foreign_keys = ON;");
    if (!this.#readOnly) {
      this.#database.exec("PRAGMA journal_mode = WAL;");
      runMigrations(this.#database);
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
  }

  #assertWritable(operation: string): void {
    if (this.#readOnly) {
      throw new Error(`${operation} is unavailable on a read-only database`);
    }
  }

  migrationVersion(): number {
    return readAppliedMigrationVersion(this.#database);
  }

  startImportRun(provider: ProviderSelection, startedAt: string): number {
    this.#assertWritable("startImportRun");
    const result = this.#database
      .prepare(
        "INSERT INTO import_runs (provider, started_at, status) VALUES (?, ?, 'running')",
      )
      .run(provider, startedAt);
    return Number(result.lastInsertRowid);
  }

  finishImportRun(
    id: number,
    completedAt: string,
    summary: ImportRunSummary,
    status: Exclude<ImportRunStatus, "running">,
  ): void {
    this.#assertWritable("finishImportRun");
    this.#database
      .prepare(
        `
        UPDATE import_runs SET
          completed_at = ?, scanned_files = ?, imported_sessions = ?,
          updated_sessions = ?, skipped_sessions = ?, malformed_files = ?,
          status = ?
        WHERE id = ?
      `,
      )
      .run(
        completedAt,
        summary.scannedFiles,
        summary.importedSessions,
        summary.updatedSessions,
        summary.skippedSessions,
        summary.malformedFiles,
        status,
        id,
      );
  }

  latestImportRun(): ImportRun | null {
    return latestImportRunReadOnly(this.#database);
  }

  getSourceFileState(sourceFile: string): SourceFileState | null {
    const row = this.#database
      .prepare("SELECT * FROM source_files WHERE source_file = ?")
      .get(sourceFile) as SourceFileRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      sourceFile: requiredString(row.source_file, sourceFile),
      provider: providerFrom(row.provider),
      providerSessionId: requiredString(row.provider_session_id, ""),
      sessionId: requiredString(row.session_id, ""),
      fileSize: safeNumber(row.file_size),
      fileMtimeMs: safeNumber(row.file_mtime_ms),
      processedBytes: safeNumber(row.processed_bytes),
      processedHash: requiredString(row.processed_hash, ""),
      sourceFileHash: requiredString(row.source_file_hash, ""),
      format: requiredString(row.format, "unknown"),
      model: requiredString(row.model, "unknown"),
      startedAt: nullableString(row.started_at),
      endedAt: nullableString(row.ended_at),
      workingDirectory: nullableString(row.working_directory),
      repositoryPath: nullableString(row.repository_path),
      branch: nullableString(row.branch),
      malformedLines: safeNumber(row.malformed_lines),
      truncated: safeNumber(row.truncated) === 1,
      lastImportedAt: requiredString(row.last_imported_at, ""),
    };
  }

  sessionExists(sessionId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
        .get(sessionId) !== undefined
    );
  }

  upsertRepository(repository: RepositoryInput, seenAt: string): number {
    this.#assertWritable("upsertRepository");
    const canonicalPath = path.resolve(repository.canonicalPath);
    this.#database
      .prepare(
        `
        INSERT INTO repositories (
          canonical_path, name, remote_url, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(canonical_path) DO UPDATE SET
          name = excluded.name,
          remote_url = COALESCE(excluded.remote_url, repositories.remote_url),
          last_seen_at = excluded.last_seen_at
      `,
      )
      .run(
        canonicalPath,
        repository.name,
        repository.remoteUrl,
        seenAt,
        seenAt,
      );
    const row = this.#database
      .prepare("SELECT id FROM repositories WHERE canonical_path = ?")
      .get(canonicalPath) as { id?: unknown } | undefined;
    if (typeof row?.id !== "number") {
      throw new Error(`Repository upsert failed for ${canonicalPath}`);
    }
    return row.id;
  }

  repositoryCount(): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM repositories")
      .get() as { count?: unknown } | undefined;
    return safeNumber(row?.count);
  }

  #detachChangedSource(state: SourceFileState, newSessionId: string): string[] {
    if (state.sessionId === newSessionId) {
      return [];
    }
    this.#database
      .prepare("DELETE FROM usage_events WHERE source_file = ?")
      .run(state.sourceFile);
    this.#database
      .prepare("DELETE FROM source_files WHERE source_file = ?")
      .run(state.sourceFile);

    const replacement = this.#database
      .prepare(
        "SELECT source_file, source_file_hash FROM source_files WHERE session_id = ? ORDER BY source_file LIMIT 1",
      )
      .get(state.sessionId) as
      { source_file?: unknown; source_file_hash?: unknown } | undefined;
    if (replacement === undefined) {
      this.#database
        .prepare("DELETE FROM sessions WHERE id = ?")
        .run(state.sessionId);
    } else {
      this.#database
        .prepare(
          "UPDATE sessions SET source_file = ?, source_file_hash = ? WHERE id = ?",
        )
        .run(
          requiredString(replacement.source_file, ""),
          requiredString(replacement.source_file_hash, ""),
          state.sessionId,
        );
    }
    return [state.sessionId];
  }

  applySourceImport(input: SourceImportInput): SourceImportResult {
    this.#assertWritable("applySourceImport");
    const existed = this.sessionExists(input.session.id);
    const oldState = this.getSourceFileState(input.session.sourceFile);
    const affectedSessionIds = new Set<string>([input.session.id]);

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (oldState !== null) {
        for (const sessionId of this.#detachChangedSource(
          oldState,
          input.session.id,
        )) {
          affectedSessionIds.add(sessionId);
        }
      }
      if (input.resetSource) {
        this.#database
          .prepare("DELETE FROM usage_events WHERE source_file = ?")
          .run(input.session.sourceFile);
      }

      const repositoryId =
        input.repository === null
          ? null
          : this.upsertRepository(input.repository, input.importedAt);
      this.#database
        .prepare(
          `
          INSERT INTO sessions (
            id, provider, provider_session_id, model, started_at, ended_at,
            working_directory, repository_id, repository_path, branch,
            input_tokens, output_tokens, cached_input_tokens, estimated_cost,
            source_file, source_file_hash, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            model = CASE
              WHEN excluded.model = 'unknown' THEN sessions.model
              ELSE excluded.model
            END,
            started_at = CASE
              WHEN sessions.started_at IS NULL THEN excluded.started_at
              WHEN excluded.started_at IS NULL THEN sessions.started_at
              WHEN excluded.started_at < sessions.started_at THEN excluded.started_at
              ELSE sessions.started_at
            END,
            ended_at = CASE
              WHEN sessions.ended_at IS NULL THEN excluded.ended_at
              WHEN excluded.ended_at IS NULL THEN sessions.ended_at
              WHEN excluded.ended_at > sessions.ended_at THEN excluded.ended_at
              ELSE sessions.ended_at
            END,
            working_directory = COALESCE(excluded.working_directory, sessions.working_directory),
            repository_id = COALESCE(excluded.repository_id, sessions.repository_id),
            repository_path = COALESCE(excluded.repository_path, sessions.repository_path),
            branch = COALESCE(excluded.branch, sessions.branch),
            source_file_hash = CASE
              WHEN sessions.source_file = excluded.source_file THEN excluded.source_file_hash
              ELSE sessions.source_file_hash
            END
        `,
        )
        .run(
          input.session.id,
          input.session.provider,
          input.session.providerSessionId,
          input.session.model,
          input.session.startedAt,
          input.session.endedAt,
          input.session.workingDirectory,
          repositoryId,
          input.session.repositoryPath,
          input.session.branch,
          input.session.sourceFile,
          input.sourceFileHash,
          input.importedAt,
        );

      const insertEvent = this.#database.prepare(`
        INSERT INTO usage_events (
          id, session_id, event_time, event_type, input_tokens,
          output_tokens, cached_input_tokens, estimated_cost,
          source_file, source_offset
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);
      for (const event of input.usageEvents) {
        insertEvent.run(
          event.id,
          event.sessionId,
          event.eventTime,
          event.eventType,
          event.inputTokens,
          event.outputTokens,
          event.cachedInputTokens,
          event.estimatedCost,
          event.sourceFile,
          event.sourceOffset,
        );
      }

      const mergedState: SourceFileState =
        oldState !== null &&
        !input.resetSource &&
        oldState.sessionId === input.session.id
          ? {
              ...oldState,
              fileSize: input.fileSize,
              fileMtimeMs: input.fileMtimeMs,
              processedBytes: input.processedBytes,
              processedHash: input.processedHash,
              sourceFileHash: input.sourceFileHash,
              format: input.format,
              model:
                input.session.model === "unknown"
                  ? oldState.model
                  : input.session.model,
              startedAt: minTimestamp(
                oldState.startedAt,
                input.session.startedAt,
              ),
              endedAt: maxTimestamp(oldState.endedAt, input.session.endedAt),
              workingDirectory:
                input.session.workingDirectory ?? oldState.workingDirectory,
              repositoryPath:
                input.session.repositoryPath ?? oldState.repositoryPath,
              branch: input.session.branch ?? oldState.branch,
              malformedLines: oldState.malformedLines + input.malformedLines,
              truncated: input.truncated,
              lastImportedAt: input.importedAt,
            }
          : {
              sourceFile: input.session.sourceFile,
              provider: input.session.provider,
              providerSessionId: input.session.providerSessionId,
              sessionId: input.session.id,
              fileSize: input.fileSize,
              fileMtimeMs: input.fileMtimeMs,
              processedBytes: input.processedBytes,
              processedHash: input.processedHash,
              sourceFileHash: input.sourceFileHash,
              format: input.format,
              model: input.session.model,
              startedAt: input.session.startedAt,
              endedAt: input.session.endedAt,
              workingDirectory: input.session.workingDirectory,
              repositoryPath: input.session.repositoryPath,
              branch: input.session.branch,
              malformedLines: input.malformedLines,
              truncated: input.truncated,
              lastImportedAt: input.importedAt,
            };

      this.#database
        .prepare(
          `
          INSERT INTO source_files (
            source_file, provider, provider_session_id, session_id, file_size,
            file_mtime_ms, processed_bytes, processed_hash, source_file_hash,
            format, model, started_at, ended_at, working_directory,
            repository_path, branch, malformed_lines, truncated, last_imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_file) DO UPDATE SET
            provider = excluded.provider,
            provider_session_id = excluded.provider_session_id,
            session_id = excluded.session_id,
            file_size = excluded.file_size,
            file_mtime_ms = excluded.file_mtime_ms,
            processed_bytes = excluded.processed_bytes,
            processed_hash = excluded.processed_hash,
            source_file_hash = excluded.source_file_hash,
            format = excluded.format,
            model = excluded.model,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            working_directory = excluded.working_directory,
            repository_path = excluded.repository_path,
            branch = excluded.branch,
            malformed_lines = excluded.malformed_lines,
            truncated = excluded.truncated,
            last_imported_at = excluded.last_imported_at
        `,
        )
        .run(
          mergedState.sourceFile,
          mergedState.provider,
          mergedState.providerSessionId,
          mergedState.sessionId,
          mergedState.fileSize,
          mergedState.fileMtimeMs,
          mergedState.processedBytes,
          mergedState.processedHash,
          mergedState.sourceFileHash,
          mergedState.format,
          mergedState.model,
          mergedState.startedAt,
          mergedState.endedAt,
          mergedState.workingDirectory,
          mergedState.repositoryPath,
          mergedState.branch,
          mergedState.malformedLines,
          mergedState.truncated ? 1 : 0,
          mergedState.lastImportedAt,
        );

      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }

    return {
      kind: existed ? "updated" : "inserted",
      affectedSessionIds: [...affectedSessionIds],
    };
  }

  getUsageEvents(sessionId: string): UsageEvent[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM usage_events WHERE session_id = ? ORDER BY event_time, source_file, source_offset",
      )
      .all(sessionId) as unknown as UsageEventRow[];
    return rows.map((row) => ({
      id: requiredString(row.id, ""),
      sessionId: requiredString(row.session_id, sessionId),
      eventTime: nullableString(row.event_time),
      eventType: usageEventTypeFrom(row.event_type),
      inputTokens: safeNumber(row.input_tokens),
      outputTokens: safeNumber(row.output_tokens),
      cachedInputTokens: safeNumber(row.cached_input_tokens),
      estimatedCost:
        row.estimated_cost === null ? null : safeNumber(row.estimated_cost),
      sourceFile: requiredString(row.source_file, ""),
      sourceOffset: safeNumber(row.source_offset),
    }));
  }

  updateSessionUsage(
    sessionId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      estimatedCost: number | null;
    },
  ): void {
    this.#assertWritable("updateSessionUsage");
    this.#database
      .prepare(
        `
        UPDATE sessions SET
          input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
          estimated_cost = ?
        WHERE id = ?
      `,
      )
      .run(
        usage.inputTokens,
        usage.outputTokens,
        usage.cachedInputTokens,
        usage.estimatedCost,
        sessionId,
      );
  }

  listSessions(query: SessionQuery = {}): Session[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.provider !== undefined) {
      conditions.push("s.provider = ?");
      parameters.push(query.provider);
    }
    if (query.since !== undefined) {
      conditions.push("COALESCE(s.started_at, s.ended_at, s.imported_at) >= ?");
      parameters.push(query.since);
    }
    if (query.repository !== undefined) {
      conditions.push(
        "(r.name LIKE ? COLLATE NOCASE OR r.canonical_path LIKE ? COLLATE NOCASE)",
      );
      const pattern = `%${query.repository}%`;
      parameters.push(pattern, pattern);
    }
    const limit =
      query.limit === undefined
        ? undefined
        : Math.max(1, Math.min(10_000, Math.trunc(query.limit)));
    if (limit !== undefined) {
      parameters.push(limit);
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const limitClause = limit === undefined ? "" : "LIMIT ?";
    const rows = this.#database
      .prepare(
        `
        SELECT s.*, r.name AS repository_name, r.remote_url AS remote_url
        FROM sessions s
        LEFT JOIN repositories r ON r.id = s.repository_id
        ${where}
        ORDER BY COALESCE(s.started_at, s.ended_at, s.imported_at) DESC
        ${limitClause}
      `,
      )
      .all(...parameters) as unknown as SessionRow[];

    return rows.map((row) => ({
      id: requiredString(row.id, "unknown-session"),
      provider: providerFrom(row.provider),
      providerSessionId: requiredString(row.provider_session_id, "unknown"),
      model: requiredString(row.model, "unknown"),
      startedAt: nullableString(row.started_at),
      endedAt: nullableString(row.ended_at),
      workingDirectory: nullableString(row.working_directory),
      repositoryPath: nullableString(row.repository_path),
      repositoryName: nullableString(row.repository_name),
      remoteUrl: nullableString(row.remote_url),
      branch: nullableString(row.branch),
      inputTokens: safeNumber(row.input_tokens),
      outputTokens: safeNumber(row.output_tokens),
      cachedInputTokens: safeNumber(row.cached_input_tokens),
      estimatedCost:
        row.estimated_cost === null ? null : safeNumber(row.estimated_cost),
      sourceFile: requiredString(row.source_file, "unknown"),
      sourceFileHash: requiredString(row.source_file_hash, ""),
      importedAt: nullableString(row.imported_at),
    }));
  }

  usageEventCount(): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM usage_events")
      .get() as { count?: unknown } | undefined;
    return safeNumber(row?.count);
  }

  tableNames(): string[] {
    const rows = this.#database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name?: unknown }>;
    return rows
      .map((row) => nullableString(row.name))
      .filter((name): name is string => name !== null);
  }

  close(): void {
    this.#database.close();
  }
}
