import type { DatabaseSync } from "node:sqlite";

import { stableSessionId, type Provider } from "@agentledger/shared";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

interface LegacySessionRow {
  provider: unknown;
  id: unknown;
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

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_usage_accounting",
    sql: `
      CREATE TABLE repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        remote_url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex')),
        provider_session_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT,
        ended_at TEXT,
        working_directory TEXT,
        repository_id INTEGER REFERENCES repositories(id) ON DELETE SET NULL,
        repository_path TEXT,
        branch TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
        estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
        source_file TEXT NOT NULL,
        source_file_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE (provider, provider_session_id),
        UNIQUE (provider, source_file)
      );

      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_time TEXT,
        event_type TEXT NOT NULL CHECK (event_type IN ('incremental', 'cumulative')),
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
        estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
        source_file TEXT NOT NULL,
        source_offset INTEGER NOT NULL CHECK (source_offset >= 0),
        UNIQUE (source_file, source_offset, event_type)
      );

      CREATE TABLE import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex', 'all')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        scanned_files INTEGER NOT NULL DEFAULT 0,
        imported_sessions INTEGER NOT NULL DEFAULT 0,
        updated_sessions INTEGER NOT NULL DEFAULT 0,
        skipped_sessions INTEGER NOT NULL DEFAULT 0,
        malformed_files INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed'))
      );

      CREATE INDEX sessions_started_at_idx ON sessions(started_at);
      CREATE INDEX sessions_provider_idx ON sessions(provider);
      CREATE INDEX sessions_repository_id_idx ON sessions(repository_id);
      CREATE INDEX usage_events_session_id_idx ON usage_events(session_id);
      CREATE INDEX usage_events_event_time_idx ON usage_events(event_time);
      CREATE INDEX import_runs_started_at_idx ON import_runs(started_at);
    `,
  },
  {
    version: 2,
    name: "incremental_source_checkpoints",
    sql: `
      CREATE TABLE source_files (
        source_file TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex')),
        provider_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        file_mtime_ms INTEGER NOT NULL CHECK (file_mtime_ms >= 0),
        processed_bytes INTEGER NOT NULL CHECK (processed_bytes >= 0),
        processed_hash TEXT NOT NULL,
        source_file_hash TEXT NOT NULL,
        format TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT,
        ended_at TEXT,
        working_directory TEXT,
        repository_path TEXT,
        branch TEXT,
        malformed_lines INTEGER NOT NULL DEFAULT 0 CHECK (malformed_lines >= 0),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        last_imported_at TEXT NOT NULL,
        UNIQUE (provider, source_file)
      );

      CREATE INDEX source_files_session_id_idx ON source_files(session_id);
      CREATE INDEX source_files_provider_idx ON source_files(provider);
    `,
  },
] as const;

export const LATEST_MIGRATION_VERSION =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName) !== undefined
  );
}

function columnNames(database: DatabaseSync, tableName: string): Set<string> {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter((name) => name.length > 0),
  );
}

function prepareLegacySchema(database: DatabaseSync): boolean {
  if (!tableExists(database, "sessions")) {
    return false;
  }
  const columns = columnNames(database, "sessions");
  if (columns.has("provider_session_id")) {
    return false;
  }
  database.exec("ALTER TABLE sessions RENAME TO sessions_phase1_legacy;");
  return true;
}

function providerFrom(value: unknown): Provider | undefined {
  return value === "claude-code" || value === "codex" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function migrateLegacySessions(database: DatabaseSync): void {
  if (!tableExists(database, "sessions_phase1_legacy")) {
    return;
  }
  const rows = database
    .prepare("SELECT * FROM sessions_phase1_legacy")
    .all() as unknown as LegacySessionRow[];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, provider, provider_session_id, model, started_at, ended_at,
      working_directory, repository_path, branch, input_tokens,
      output_tokens, cached_input_tokens, estimated_cost, source_file,
      source_file_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
  `);
  const importedAt = new Date().toISOString();
  for (const row of rows) {
    const provider = providerFrom(row.provider);
    const providerSessionId = stringOrNull(row.id);
    const sourceFile = stringOrNull(row.source_file);
    if (
      provider === undefined ||
      providerSessionId === null ||
      sourceFile === null
    ) {
      continue;
    }
    insert.run(
      stableSessionId(provider, providerSessionId),
      provider,
      providerSessionId,
      stringOrNull(row.model) ?? "unknown",
      stringOrNull(row.started_at),
      stringOrNull(row.ended_at),
      stringOrNull(row.working_directory),
      stringOrNull(row.repository_path),
      stringOrNull(row.branch),
      nonnegativeNumber(row.input_tokens),
      nonnegativeNumber(row.output_tokens),
      nonnegativeNumber(row.cached_input_tokens),
      row.estimated_cost === null
        ? null
        : nonnegativeNumber(row.estimated_cost),
      sourceFile,
      importedAt,
    );
  }
  database.exec("DROP TABLE sessions_phase1_legacy;");
}

export function runMigrations(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF;");
  const legacyPrepared = prepareLegacySchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version?: unknown }>;
  const applied = new Set(
    appliedRows
      .map((row) =>
        typeof row.version === "number" ? row.version : Number.NaN,
      )
      .filter(Number.isFinite),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  if (legacyPrepared || tableExists(database, "sessions_phase1_legacy")) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      migrateLegacySessions(database);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  database.exec(`PRAGMA user_version = ${LATEST_MIGRATION_VERSION};`);
  database.exec("PRAGMA foreign_keys = ON;");
}

export function readAppliedMigrationVersion(database: DatabaseSync): number {
  if (!tableExists(database, "schema_migrations")) {
    return 0;
  }
  const row = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    )
    .get() as { version?: unknown } | undefined;
  return typeof row?.version === "number" ? row.version : 0;
}
