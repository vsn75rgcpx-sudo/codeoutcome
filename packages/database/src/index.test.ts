import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  stableSessionId,
  type Provider,
  type Session,
  type UsageEvent,
} from "@agentledger/shared";

import {
  inspectDatabase,
  LATEST_MIGRATION_VERSION,
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
  const directory = await mkdtemp(path.join(tmpdir(), "agentledger-db-"));
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
      "import_runs",
      "repositories",
      "schema_migrations",
      "sessions",
      "source_files",
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
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-legacy-"));
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
