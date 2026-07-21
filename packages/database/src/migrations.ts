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

export const REPARSE_REQUIRED_CHECKPOINT = "phase-2.5-reparse-required";

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
  {
    version: 3,
    name: "canonical_token_accounting",
    sql: `
      ALTER TABLE sessions ADD COLUMN accounting_method TEXT NOT NULL
        DEFAULT 'unavailable'
        CHECK (accounting_method IN (
          'cumulative_snapshot', 'incremental_events', 'ambiguous', 'unavailable'
        ));
      ALTER TABLE sessions ADD COLUMN accounting_status TEXT NOT NULL
        DEFAULT 'warning'
        CHECK (accounting_status IN ('verified', 'warning', 'invalid'));
      ALTER TABLE sessions ADD COLUMN accounting_version TEXT NOT NULL
        DEFAULT 'legacy-v2-pending-reconciliation';
      ALTER TABLE sessions ADD COLUMN uncached_input_tokens INTEGER NOT NULL
        DEFAULT 0 CHECK (uncached_input_tokens >= 0);
      ALTER TABLE sessions ADD COLUMN last_usage_event_at TEXT;

      ALTER TABLE usage_events ADD COLUMN accounting_role TEXT NOT NULL
        DEFAULT 'informational'
        CHECK (accounting_role IN (
          'cumulative_snapshot', 'incremental', 'informational'
        ));
      ALTER TABLE usage_events ADD COLUMN is_canonical INTEGER NOT NULL
        DEFAULT 0 CHECK (is_canonical IN (0, 1));
      ALTER TABLE usage_events ADD COLUMN provider_event_id TEXT;
      ALTER TABLE usage_events ADD COLUMN snapshot_sequence INTEGER
        CHECK (snapshot_sequence IS NULL OR snapshot_sequence >= 0);
      ALTER TABLE usage_events ADD COLUMN reasoning_output_tokens INTEGER NOT NULL
        DEFAULT 0 CHECK (reasoning_output_tokens >= 0);
      ALTER TABLE usage_events ADD COLUMN reported_total_tokens INTEGER
        CHECK (reported_total_tokens IS NULL OR reported_total_tokens >= 0);
      ALTER TABLE usage_events ADD COLUMN has_negative_values INTEGER NOT NULL
        DEFAULT 0 CHECK (has_negative_values IN (0, 1));

      UPDATE usage_events SET
        accounting_role = CASE
          WHEN event_type = 'cumulative' THEN 'cumulative_snapshot'
          ELSE 'incremental'
        END,
        snapshot_sequence = source_offset;

      UPDATE sessions SET
        accounting_method = CASE
          WHEN EXISTS (
            SELECT 1 FROM usage_events u
            WHERE u.session_id = sessions.id AND u.event_type = 'cumulative'
          ) THEN 'cumulative_snapshot'
          WHEN EXISTS (
            SELECT 1 FROM usage_events u WHERE u.session_id = sessions.id
          ) THEN 'incremental_events'
          ELSE 'unavailable'
        END,
        accounting_status = 'warning',
        accounting_version = 'legacy-v2-pending-reconciliation',
        uncached_input_tokens = MAX(input_tokens - cached_input_tokens, 0),
        last_usage_event_at = (
          SELECT MAX(u.event_time) FROM usage_events u
          WHERE u.session_id = sessions.id
        );

      CREATE INDEX usage_events_accounting_role_idx
        ON usage_events(session_id, accounting_role);
      CREATE INDEX usage_events_canonical_idx
        ON usage_events(session_id, is_canonical);
      CREATE INDEX usage_events_provider_event_id_idx
        ON usage_events(provider_event_id)
        WHERE provider_event_id IS NOT NULL;

      -- The v2 parser discarded paired last_token_usage payloads. Force one
      -- safe full-source rebuild on the next import so v3 audit metadata is
      -- complete, while preserving current rows until that import succeeds.
      UPDATE source_files SET processed_hash = '${REPARSE_REQUIRED_CHECKPOINT}';
    `,
  },
  {
    version: 4,
    name: "local_git_session_tracking",
    sql: `
      CREATE TABLE git_snapshots (
        id TEXT PRIMARY KEY,
        repository_id INTEGER NOT NULL
          REFERENCES repositories(id) ON DELETE RESTRICT,
        captured_at TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN (
          'tracking_start', 'tracking_end', 'manual', 'recovery'
        )),
        privacy_mode TEXT NOT NULL CHECK (privacy_mode IN (
          'git-metadata', 'strict'
        )),
        working_directory TEXT NOT NULL,
        head_commit TEXT,
        branch TEXT,
        is_detached_head INTEGER NOT NULL CHECK (is_detached_head IN (0, 1)),
        is_unborn_branch INTEGER NOT NULL CHECK (is_unborn_branch IN (0, 1)),
        is_dirty INTEGER NOT NULL CHECK (is_dirty IN (0, 1)),
        staged_file_count INTEGER NOT NULL CHECK (staged_file_count >= 0),
        unstaged_file_count INTEGER NOT NULL CHECK (unstaged_file_count >= 0),
        untracked_file_count INTEGER NOT NULL CHECK (untracked_file_count >= 0),
        conflicted_file_count INTEGER NOT NULL CHECK (conflicted_file_count >= 0),
        ahead_count INTEGER CHECK (ahead_count IS NULL OR ahead_count >= 0),
        behind_count INTEGER CHECK (behind_count IS NULL OR behind_count >= 0),
        git_version TEXT NOT NULL
      );

      CREATE TABLE git_file_stats (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL
          REFERENCES git_snapshots(id) ON DELETE CASCADE,
        relative_path TEXT,
        previous_path TEXT,
        change_type TEXT NOT NULL CHECK (change_type IN (
          'added', 'modified', 'deleted', 'renamed', 'copied',
          'unmerged', 'untracked', 'unknown'
        )),
        area TEXT NOT NULL CHECK (area IN (
          'staged', 'unstaged', 'untracked', 'conflicted'
        )),
        additions INTEGER CHECK (additions IS NULL OR additions >= 0),
        deletions INTEGER CHECK (deletions IS NULL OR deletions >= 0),
        is_binary INTEGER NOT NULL CHECK (is_binary IN (0, 1)),
        content_fingerprint TEXT,
        path_fingerprint TEXT NOT NULL,
        UNIQUE (snapshot_id, area, path_fingerprint, change_type)
      );

      CREATE TABLE tracking_runs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex')),
        label TEXT,
        working_directory TEXT NOT NULL,
        repository_id INTEGER NOT NULL
          REFERENCES repositories(id) ON DELETE RESTRICT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'active', 'completed', 'interrupted', 'failed', 'abandoned'
        )),
        start_snapshot_id TEXT NOT NULL UNIQUE
          REFERENCES git_snapshots(id) ON DELETE RESTRICT,
        end_snapshot_id TEXT UNIQUE
          REFERENCES git_snapshots(id) ON DELETE RESTRICT,
        linked_session_id TEXT
          REFERENCES sessions(id) ON DELETE SET NULL,
        link_confidence REAL CHECK (
          link_confidence IS NULL OR
          (link_confidence >= 0 AND link_confidence <= 1)
        ),
        link_confidence_level TEXT CHECK (
          link_confidence_level IS NULL OR link_confidence_level IN (
            'high', 'medium', 'low', 'ambiguous'
          )
        ),
        link_method TEXT CHECK (
          link_method IS NULL OR link_method IN ('automatic', 'manual')
        ),
        link_reasons_json TEXT NOT NULL DEFAULT '[]',
        summary_json TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE session_git_links (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tracking_run_id TEXT NOT NULL
          REFERENCES tracking_runs(id) ON DELETE CASCADE,
        repository_id INTEGER NOT NULL
          REFERENCES repositories(id) ON DELETE RESTRICT,
        confidence_score REAL NOT NULL CHECK (
          confidence_score >= 0 AND confidence_score <= 1
        ),
        confidence_level TEXT NOT NULL CHECK (confidence_level IN (
          'high', 'medium', 'low', 'ambiguous'
        )),
        method TEXT NOT NULL CHECK (method IN ('automatic', 'manual')),
        reasons_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        unlinked_at TEXT,
        unlink_reason TEXT
      );

      CREATE UNIQUE INDEX tracking_runs_one_active_directory_idx
        ON tracking_runs(working_directory) WHERE status = 'active';
      CREATE INDEX tracking_runs_started_at_idx ON tracking_runs(started_at);
      CREATE INDEX tracking_runs_status_idx ON tracking_runs(status);
      CREATE INDEX git_snapshots_repository_idx
        ON git_snapshots(repository_id, captured_at);
      CREATE INDEX git_file_stats_snapshot_idx ON git_file_stats(snapshot_id);
      CREATE INDEX session_git_links_session_idx ON session_git_links(session_id);
      CREATE UNIQUE INDEX session_git_links_one_active_run_idx
        ON session_git_links(tracking_run_id) WHERE unlinked_at IS NULL;
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
