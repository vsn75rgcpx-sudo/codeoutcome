import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  stableSessionId,
  type Provider,
  type Session,
  type UsageEvent,
} from "@codeoutcome/shared";

import {
  backupDatabase,
  getCodeOutcomePaths,
  getLegacyMigrationPaths,
  inspectDatabase,
  LATEST_MIGRATION_VERSION,
  migrateLegacyDatabase,
  SessionDatabase,
  type SourceImportInput,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDatabase(): Promise<{
  directory: string;
  databaseFile: string;
  database: SessionDatabase;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "codeoutcome-db-"));
  temporaryDirectories.push(directory);
  const databaseFile = path.join(directory, "session.sqlite");
  return {
    directory,
    databaseFile,
    database: new SessionDatabase(databaseFile),
  };
}

function sessionFixture(
  provider: Provider,
  providerSessionId: string,
  startedAt: string,
  sourceFile: string,
): Session {
  return {
    id: stableSessionId(provider, providerSessionId),
    provider,
    providerSessionId,
    model: `${provider}-test-model`,
    startedAt,
    endedAt: new Date(new Date(startedAt).getTime() + 60_000).toISOString(),
    workingDirectory: "/redacted/project",
    repositoryPath: "/redacted/project",
    repositoryName: "project",
    remoteUrl: null,
    branch: "main",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    estimatedCost: null,
    accountingMethod: "unavailable",
    accountingStatus: "warning",
    accountingVersion: "test",
    lastUsageEventAt: null,
    sourceFile,
    sourceFileHash: "fixture-hash",
    importedAt: "2026-03-01T00:00:00.000Z",
  };
}

function sourceImport(
  session: Session,
  repositoryPath: string,
): SourceImportInput {
  const event: UsageEvent = {
    id: `event-${session.providerSessionId}`,
    sessionId: session.id,
    eventTime: session.startedAt,
    eventType: session.provider === "codex" ? "cumulative" : "incremental",
    accountingRole:
      session.provider === "codex" ? "cumulative_snapshot" : "incremental",
    isCanonical: false,
    providerEventId: null,
    snapshotSequence: 0,
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 3,
    reasoningOutputTokens: 1,
    reportedTotalTokens: 12,
    hasNegativeValues: false,
    estimatedCost: null,
    sourceFile: session.sourceFile,
    sourceOffset: 0,
  };
  return {
    session,
    usageEvents: [event],
    repository: {
      canonicalPath: repositoryPath,
      name: path.basename(repositoryPath),
      remoteUrl: null,
    },
    fileSize: 100,
    fileMtimeMs: 1,
    processedBytes: 100,
    processedHash: "processed-hash",
    sourceFileHash: "fixture-hash",
    format: "fixture-v1",
    malformedLines: 0,
    truncated: false,
    resetSource: true,
    importedAt: "2026-03-01T00:00:00.000Z",
  };
}

describe("SessionDatabase migrations and queries", () => {
  it("applies all migrations and creates the required tables", async () => {
    const { database, databaseFile } = await temporaryDatabase();

    expect(database.migrationVersion()).toBe(LATEST_MIGRATION_VERSION);
    expect(database.tableNames()).toEqual([
      "git_file_stats",
      "git_snapshots",
      "import_runs",
      "repositories",
      "schema_migrations",
      "session_git_links",
      "sessions",
      "source_files",
      "test_report_imports",
      "test_run_events",
      "test_run_links",
      "test_runs",
      "tracking_runs",
      "usage_events",
    ]);
    database.close();

    const inspection = inspectDatabase(databaseFile);
    expect(inspection).toMatchObject({
      ok: true,
      currentMigrationVersion: LATEST_MIGRATION_VERSION,
      pendingMigrations: 0,
    });

    const schema = new DatabaseSync(databaseFile, { readOnly: true });
    const sessionColumns = schema
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => (row as { name?: unknown }).name);
    const eventColumns = schema
      .prepare("PRAGMA table_info(usage_events)")
      .all()
      .map((row) => (row as { name?: unknown }).name);
    const trackingColumns = schema
      .prepare("PRAGMA table_info(tracking_runs)")
      .all()
      .map((row) => (row as { name?: unknown }).name);
    const testRunColumns = schema
      .prepare("PRAGMA table_info(test_runs)")
      .all()
      .map((row) => (row as { name?: unknown }).name);
    expect(sessionColumns).toEqual(
      expect.arrayContaining([
        "accounting_method",
        "accounting_status",
        "accounting_version",
        "uncached_input_tokens",
        "last_usage_event_at",
      ]),
    );
    expect(eventColumns).toEqual(
      expect.arrayContaining([
        "accounting_role",
        "is_canonical",
        "provider_event_id",
        "snapshot_sequence",
        "reasoning_output_tokens",
        "reported_total_tokens",
      ]),
    );
    expect(trackingColumns).toEqual(
      expect.arrayContaining([
        "start_snapshot_id",
        "end_snapshot_id",
        "linked_session_id",
        "link_confidence",
        "link_reasons_json",
      ]),
    );
    expect(testRunColumns).toEqual(
      expect.arrayContaining([
        "tracking_run_id",
        "session_id",
        "command_fingerprint",
        "parser_status",
        "output_truncated",
        "warnings_json",
      ]),
    );
    expect(
      schema
        .prepare("SELECT name FROM schema_migrations WHERE version = 5")
        .get(),
    ).toMatchObject({ name: "test_run_tracking" });
    schema.close();

    const repeatedMigration = new SessionDatabase(databaseFile);
    expect(repeatedMigration.migrationVersion()).toBe(LATEST_MIGRATION_VERSION);
    repeatedMigration.close();

    const firstReader = new SessionDatabase(databaseFile, { readOnly: true });
    const secondReader = new SessionDatabase(databaseFile, { readOnly: true });
    expect(firstReader.listSessions()).toEqual([]);
    expect(secondReader.listSessions()).toEqual([]);
    expect(() =>
      firstReader.startImportRun("all", "2026-01-01T00:00:00.000Z"),
    ).toThrow("read-only database");
    firstReader.close();
    secondReader.close();
  });

  it("deduplicates repositories by canonical path", async () => {
    const { database, directory } = await temporaryDatabase();
    const repositoryPath = path.join(directory, "project");

    database.upsertRepository(
      { canonicalPath: repositoryPath, name: "project", remoteUrl: null },
      "2026-01-01T00:00:00.000Z",
    );
    database.upsertRepository(
      {
        canonicalPath: path.join(repositoryPath, "."),
        name: "renamed",
        remoteUrl: null,
      },
      "2026-02-01T00:00:00.000Z",
    );

    expect(database.repositoryCount()).toBe(1);
    database.close();
  });

  it("creates a consistent SQLite API backup without changing the source", async () => {
    const { database, databaseFile, directory } = await temporaryDatabase();
    database.close();
    const backupFile = path.join(directory, "backups", "fixture.sqlite");
    await backupDatabase(databaseFile, backupFile);
    await expect(access(backupFile)).resolves.toBeUndefined();
    expect((await stat(backupFile)).mode & 0o777).toBe(0o600);
    const backup = new SessionDatabase(backupFile, { readOnly: true });
    expect(backup.migrationVersion()).toBe(LATEST_MIGRATION_VERSION);
    expect(backup.quickCheck()).toBe("ok");
    backup.close();
  });

  it("creates a consistent backup on Node versions without the backup API", async () => {
    const { database, databaseFile, directory } = await temporaryDatabase();
    database.close();
    const backupFile = path.join(
      directory,
      "backups",
      "portable-fixture.sqlite",
    );
    await backupDatabase(databaseFile, backupFile, {
      forcePortableBackup: true,
    });
    await expect(access(backupFile)).resolves.toBeUndefined();
    const backup = new SessionDatabase(backupFile, { readOnly: true });
    expect(backup.migrationVersion()).toBe(LATEST_MIGRATION_VERSION);
    expect(backup.quickCheck()).toBe("ok");
    backup.close();
  });

  it("filters sessions by provider, date range, and repository", async () => {
    const { database, directory } = await temporaryDatabase();
    const repositoryPath = path.join(directory, "project");
    const codex = sessionFixture(
      "codex",
      "codex-filter",
      "2026-01-01T00:00:00.000Z",
      path.join(directory, "codex.jsonl"),
    );
    const claude = sessionFixture(
      "claude-code",
      "claude-filter",
      "2026-02-01T00:00:00.000Z",
      path.join(directory, "claude.jsonl"),
    );
    database.applySourceImport(sourceImport(codex, repositoryPath));
    database.applySourceImport(sourceImport(claude, repositoryPath));

    expect(
      database.listSessions({ provider: "codex" }).map((item) => item.id),
    ).toEqual([codex.id]);
    expect(
      database
        .listSessions({ since: "2026-01-15T00:00:00.000Z" })
        .map((item) => item.id),
    ).toEqual([claude.id]);
    expect(database.listSessions({ repository: "project" })).toHaveLength(2);
    database.close();
  });
});

describe("legacy migration", () => {
  it("preserves phase-one session metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codeoutcome-legacy-"));
    temporaryDirectories.push(directory);
    const databaseFile = path.join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
        started_at TEXT, ended_at TEXT, working_directory TEXT,
        repository_path TEXT, branch TEXT, input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
        estimated_cost REAL, source_file TEXT NOT NULL
      );
      INSERT INTO sessions VALUES (
        'legacy-provider-id', 'codex', 'legacy-model', NULL, NULL, NULL,
        NULL, NULL, 5, 2, 1, NULL, '/redacted/legacy.jsonl'
      );
    `);
    legacy.close();

    const database = new SessionDatabase(databaseFile);
    expect(database.listSessions()[0]).toMatchObject({
      providerSessionId: "legacy-provider-id",
      provider: "codex",
      model: "legacy-model",
      inputTokens: 5,
    });
    expect(database.migrationVersion()).toBe(LATEST_MIGRATION_VERSION);
    database.close();
  });
});

describe("CodeOutcome data path compatibility", () => {
  it("uses the new macOS data location for a new installation", async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "codeoutcome-home-"));
    temporaryDirectories.push(userHome);

    expect(getCodeOutcomePaths({}, userHome, "darwin")).toEqual({
      dataDirectory: path.join(
        userHome,
        "Library",
        "Application Support",
        "CodeOutcome",
      ),
      databaseFile: path.join(
        userHome,
        "Library",
        "Application Support",
        "CodeOutcome",
        "codeoutcome.sqlite",
      ),
      source: "current-default",
      legacy: false,
    });
  });

  it("discovers a legacy database until the new database exists", async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "codeoutcome-home-"));
    temporaryDirectories.push(userHome);
    const legacyDirectory = path.join(
      userHome,
      "Library",
      "Application Support",
      "AgentLedger",
    );
    await mkdir(legacyDirectory, { recursive: true });
    const legacyDatabase = new DatabaseSync(
      path.join(legacyDirectory, "agentledger.sqlite"),
    );
    legacyDatabase.close();

    expect(getCodeOutcomePaths({}, userHome, "darwin")).toMatchObject({
      dataDirectory: legacyDirectory,
      source: "legacy-default",
      legacy: true,
    });

    await mkdir(
      path.join(userHome, "Library", "Application Support", "CodeOutcome"),
      { recursive: true },
    );
    expect(getCodeOutcomePaths({}, userHome, "darwin")).toMatchObject({
      source: "legacy-default",
      legacy: true,
    });
    new SessionDatabase(
      path.join(
        userHome,
        "Library",
        "Application Support",
        "CodeOutcome",
        "codeoutcome.sqlite",
      ),
    ).close();
    expect(getCodeOutcomePaths({}, userHome, "darwin")).toMatchObject({
      source: "current-default",
      legacy: false,
    });
  });

  it("supports the legacy data environment variable without changing names", () => {
    expect(
      getCodeOutcomePaths(
        { AGENTLEDGER_DATA_DIR: "/redacted/legacy-data" },
        "/redacted/home",
        "darwin",
      ),
    ).toEqual({
      dataDirectory: "/redacted/legacy-data",
      databaseFile: "/redacted/legacy-data/agentledger.sqlite",
      source: "legacy-environment",
      legacy: true,
    });
  });

  it("previews and explicitly migrates legacy data without changing the original", async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "codeoutcome-home-"));
    temporaryDirectories.push(userHome);
    const paths = getLegacyMigrationPaths({}, userHome, "darwin");
    const legacy = new SessionDatabase(paths.legacyDatabaseFile);
    const session = sessionFixture(
      "codex",
      "legacy-migration-session",
      "2026-07-01T00:00:00.000Z",
      path.join(userHome, "redacted-session.jsonl"),
    );
    legacy.applySourceImport(
      sourceImport(session, path.join(userHome, "repo")),
    );
    legacy.close();

    const preview = await migrateLegacyDatabase({
      environment: {},
      userHome,
      platform: "darwin",
      dryRun: true,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(preview).toMatchObject({
      dryRun: true,
      canMigrate: true,
      migrated: false,
      backupFile: null,
    });
    expect(inspectDatabase(paths.currentDatabaseFile).exists).toBe(false);

    const result = await migrateLegacyDatabase({
      environment: {},
      userHome,
      platform: "darwin",
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(result.canMigrate).toBe(true);
    expect(result.migrated).toBe(true);
    expect(result.backupFile).not.toBeNull();
    await expect(access(result.backupFile!)).resolves.toBeUndefined();
    expect(inspectDatabase(paths.legacyDatabaseFile)).toMatchObject({
      exists: true,
      ok: true,
    });
    expect(inspectDatabase(paths.currentDatabaseFile)).toMatchObject({
      exists: true,
      ok: true,
      pendingMigrations: 0,
    });
    const current = new SessionDatabase(paths.currentDatabaseFile, {
      readOnly: true,
    });
    expect(current.getSession(session.id)?.providerSessionId).toBe(
      "legacy-migration-session",
    );
    current.close();
  });

  it("refuses legacy migration when the destination already exists", async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "codeoutcome-home-"));
    temporaryDirectories.push(userHome);
    const paths = getLegacyMigrationPaths({}, userHome, "darwin");
    new SessionDatabase(paths.legacyDatabaseFile).close();
    new SessionDatabase(paths.currentDatabaseFile).close();

    const result = await migrateLegacyDatabase({
      environment: {},
      userHome,
      platform: "darwin",
    });
    expect(result.canMigrate).toBe(false);
    expect(result.migrated).toBe(false);
    expect(result.reasons).toContain(
      "CodeOutcome destination database already exists",
    );
  });
});
