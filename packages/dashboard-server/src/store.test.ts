import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SessionDatabase } from "@codeoutcome/database";
import { afterEach, describe, expect, it } from "vitest";

import { DashboardDataError, DashboardStore } from "./store.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codeoutcome-dashboard-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function seed(databaseFile: string): void {
  new SessionDatabase(databaseFile).close();
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys=ON");
  database
    .prepare(
      `INSERT INTO repositories
       (id, canonical_path, name, remote_url, first_seen_at, last_seen_at)
       VALUES (1, ?, 'synthetic-repo', NULL, ?, ?)`,
    )
    .run(
      "/private/synthetic-repo",
      "2026-07-01T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z",
    );
  const insertSession = database.prepare(
    `INSERT INTO sessions (
      id, provider, provider_session_id, model, started_at, ended_at,
      working_directory, repository_id, repository_path, branch,
      input_tokens, output_tokens, cached_input_tokens, estimated_cost,
      source_file, source_file_hash, imported_at, accounting_method,
      accounting_status, accounting_version, uncached_input_tokens,
      last_usage_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'main', ?, ?, ?, NULL, ?, ?, ?,
      'cumulative_snapshot', 'verified', 'fixture-v1', ?, ?)`,
  );
  insertSession.run(
    "session-1",
    "codex",
    "provider-1",
    "gpt-fixture",
    "2026-07-20T10:00:00.000Z",
    "2026-07-20T10:10:00.000Z",
    "/private/synthetic-repo",
    "/private/synthetic-repo",
    9_007_199_254_740_999n,
    7n,
    1_000n,
    "/private/provider/session.jsonl",
    "hash-1",
    "2026-07-20T10:11:00.000Z",
    9_007_199_254_739_999n,
    "2026-07-20T10:09:00.000Z",
  );
  insertSession.run(
    "session-2",
    "claude-code",
    "provider-2",
    "claude-fixture",
    "2026-07-19T10:00:00.000Z",
    "2026-07-19T10:03:00.000Z",
    "/private/synthetic-repo",
    "/private/synthetic-repo",
    10n,
    5n,
    2n,
    "/private/provider/claude.jsonl",
    "hash-2",
    "2026-07-19T10:04:00.000Z",
    8n,
    "2026-07-19T10:02:00.000Z",
  );
  const snapshot = database.prepare(
    `INSERT INTO git_snapshots (
      id, repository_id, captured_at, trigger, privacy_mode,
      working_directory, head_commit, branch, is_detached_head,
      is_unborn_branch, is_dirty, staged_file_count, unstaged_file_count,
      untracked_file_count, conflicted_file_count, ahead_count, behind_count,
      git_version
    ) VALUES (?, 1, ?, ?, 'git-metadata', '/private/synthetic-repo', ?, 'main',
      0, 0, ?, ?, ?, ?, 0, 0, 0, 'git fixture')`,
  );
  snapshot.run(
    "snapshot-start",
    "2026-07-20T10:00:00.000Z",
    "tracking_start",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    0,
    0,
    0,
    0,
  );
  snapshot.run(
    "snapshot-end",
    "2026-07-20T10:12:00.000Z",
    "tracking_end",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    1,
    0,
    2,
    0,
  );
  database
    .prepare(
      `INSERT INTO git_file_stats (
        id, snapshot_id, relative_path, previous_path, change_type, area,
        additions, deletions, is_binary, content_fingerprint, path_fingerprint
      ) VALUES ('file-1', 'snapshot-end', 'src/redacted.ts', NULL, 'modified',
        'unstaged', 4, 1, 0, NULL, 'path-hash')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO tracking_runs (
        id, provider, label, working_directory, repository_id, started_at,
        ended_at, status, start_snapshot_id, end_snapshot_id,
        linked_session_id, link_confidence, link_confidence_level, link_method,
        link_reasons_json, summary_json, warnings_json, created_at, updated_at
      ) VALUES ('tracking-1', 'codex', 'synthetic tracking',
        '/private/synthetic-repo', 1, '2026-07-20T10:00:00.000Z',
        '2026-07-20T10:12:00.000Z', 'completed', 'snapshot-start',
        'snapshot-end', 'session-1', 0.9, 'high', 'automatic',
        '["fixture association"]',
        '{"filesChanged":1,"additions":4,"deletions":1}', '[]',
        '2026-07-20T10:00:00.000Z', '2026-07-20T10:12:00.000Z')`,
    )
    .run();
  const testRun = database.prepare(
    `INSERT INTO test_runs (
      id, tracking_run_id, session_id, repository_id, working_directory,
      started_at, ended_at, duration_ms, stage, framework, framework_version,
      executable, command_display, command_fingerprint, argument_count,
      exit_code, termination_signal, status, outcome, total_tests, passed_tests,
      failed_tests, skipped_tests, todo_tests, errored_tests, parser_status,
      parser_version, output_truncated, source, warnings_json, created_at, updated_at
    ) VALUES (?, 'tracking-1', 'session-1', 1, '/private/synthetic-repo', ?, ?,
      1000, ?, 'pytest', '9.0', 'pytest', ?, 'same-fingerprint', 1, ?, NULL,
      'completed', ?, 1, ?, ?, 0, 0, 0, 'parsed', 'fixture-parser', 0,
      'wrapped_command', '[]', ?, ?)`,
  );
  testRun.run(
    "test-baseline",
    "2026-07-20T10:02:00.000Z",
    "2026-07-20T10:02:01.000Z",
    "baseline",
    "pytest --password secret-value",
    1,
    "failed",
    0,
    1,
    "2026-07-20T10:02:00.000Z",
    "2026-07-20T10:02:01.000Z",
  );
  testRun.run(
    "test-final",
    "2026-07-20T10:09:00.000Z",
    "2026-07-20T10:09:01.000Z",
    "final",
    "pytest -q",
    0,
    "passed",
    1,
    0,
    "2026-07-20T10:09:00.000Z",
    "2026-07-20T10:09:01.000Z",
  );
  database
    .prepare(
      `INSERT INTO test_run_links
       (id, test_run_id, tracking_run_id, session_id, link_type, confidence,
        reasons_json, created_at)
       VALUES ('test-link', 'test-final', 'tracking-1', 'session-1', 'auto',
        1, '["fixture auto link"]', '2026-07-20T10:09:01.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO import_runs
       (provider, started_at, completed_at, scanned_files, imported_sessions,
        updated_sessions, skipped_sessions, malformed_files, status)
       VALUES ('all', '2026-07-20T10:15:00.000Z', '2026-07-20T10:15:02.000Z',
        2, 2, 0, 0, 0, 'completed')`,
    )
    .run();
  database.close();
}

function store(
  databaseFile: string,
  privacyMode: "git-metadata" | "strict" = "git-metadata",
): DashboardStore {
  return new DashboardStore({
    databaseFile,
    privacyMode,
    userHome: "/private",
    claudeLogDirectory: "/missing/claude",
    codexLogDirectory: "/missing/codex",
    version: "fixture",
    now: () => new Date("2026-07-21T00:00:00.000Z"),
  });
}

describe("read-only dashboard store", () => {
  it("uses query_only and preserves exact large Token accounting", async () => {
    const directory = await temporaryDirectory();
    const databaseFile = path.join(directory, "dashboard.sqlite");
    seed(databaseFile);
    const before = createHash("sha256")
      .update(await readFile(databaseFile))
      .digest("hex");
    const dashboard = store(databaseFile);
    expect(dashboard.status).toBe("ready");
    expect(dashboard.queryOnly).toBe(true);
    expect(dashboard.foreignKeys).toBe(true);
    const overview = dashboard.overview("all");
    expect(overview.totals.inputTokens).toBe("9007199254741009");
    expect(overview.totals.cachedInputTokens).toBe("1002");
    expect(overview.totals.outputTokens).toBe("12");
    expect(overview.totals.totalTokens).toBe("9007199254741021");
    expect(overview.totals.failingToPassingComparisons).toBe(1);
    expect(overview.pricing.label).toBe("Pricing unavailable");
    dashboard.close();
    const after = createHash("sha256")
      .update(await readFile(databaseFile))
      .digest("hex");
    expect(after).toBe(before);
  });

  it("paginates sessions, tracking runs, and test runs with filters", async () => {
    const directory = await temporaryDirectory();
    const databaseFile = path.join(directory, "dashboard.sqlite");
    seed(databaseFile);
    const dashboard = store(databaseFile);
    const sessions = dashboard.sessions({
      page: 1,
      pageSize: 1,
      provider: "codex",
      sort: "startedAt",
      order: "desc",
    });
    expect(sessions.pagination).toMatchObject({ totalItems: 1, pageSize: 1 });
    expect(sessions.items[0]).toMatchObject({
      id: "session-1",
      linkedTrackingRunCount: 1,
    });
    const tracking = dashboard.trackingRuns({
      page: 1,
      pageSize: 25,
      hasGitChanges: true,
      hasTests: true,
      testChange: "improved",
      sort: "startedAt",
      order: "desc",
    });
    expect(tracking.items[0]).toMatchObject({
      id: "tracking-1",
      filesChanged: 1,
      testRuns: 2,
    });
    const tests = dashboard.testRuns({
      page: 1,
      pageSize: 1,
      framework: "pytest",
      sort: "startedAt",
      order: "asc",
    });
    expect(tests.pagination.totalItems).toBe(2);
    expect(tests.items[0]?.stage).toBe("baseline");
    expect(dashboard.filters()).toMatchObject({
      providers: ["claude-code", "codex"],
      frameworks: ["pytest"],
    });
    dashboard.close();
  });

  it("builds details, timeline, and comparison without content fields", async () => {
    const directory = await temporaryDirectory();
    const databaseFile = path.join(directory, "dashboard.sqlite");
    seed(databaseFile);
    const dashboard = store(databaseFile);
    const session = dashboard.session("session-1");
    expect(session).toMatchObject({
      model: "gpt-fixture",
      accountingStatus: "verified",
    });
    expect(JSON.stringify(session)).not.toContain("source_file");
    const tracking = dashboard.trackingRun("tracking-1");
    expect(tracking?.comparison).toMatchObject({
      baselineOutcome: "failed",
      finalOutcome: "passed",
      comparability: "comparable",
      failedDelta: -1,
    });
    expect(tracking?.timeline.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "tracking_started",
        "session_started",
        "test_baseline",
        "test_final",
        "git_snapshot",
        "tracking_completed",
      ]),
    );
    const test = dashboard.testRun("test-final");
    expect(test).toMatchObject({
      commandDisplay: "pytest -q",
      commandFingerprintShort: "same-fingerp",
    });
    expect(JSON.stringify(test)).not.toMatch(
      /stdout|stderr|stack|prompt|diff/i,
    );
    dashboard.close();
  });

  it("enforces strict path and command redaction", async () => {
    const directory = await temporaryDirectory();
    const databaseFile = path.join(directory, "dashboard.sqlite");
    seed(databaseFile);
    const dashboard = store(databaseFile, "strict");
    expect(dashboard.filters().repositories[0]).toMatchObject({
      name: "synthetic-repo",
      path: null,
    });
    expect(dashboard.testRun("test-baseline")?.commandDisplay).toBe("pytest");
    expect(dashboard.diagnostics().database.path).toBe("<redacted>");
    expect(dashboard.diagnostics().providerLogs[0]?.path).toBe("<redacted>");
    expect(JSON.stringify(dashboard.overview("all"))).not.toContain(
      "/private/",
    );
    dashboard.close();
  });

  it("reports missing and outdated databases without creating or migrating them", async () => {
    const directory = await temporaryDirectory();
    const missing = path.join(directory, "missing.sqlite");
    const missingStore = store(missing);
    expect(missingStore.status).toBe("missing");
    expect(() => missingStore.overview("all")).toThrowError(DashboardDataError);
    expect(await readFile(missing).catch(() => null)).toBeNull();

    const outdatedFile = path.join(directory, "outdated.sqlite");
    const outdated = new DatabaseSync(outdatedFile);
    outdated.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (4);",
    );
    outdated.close();
    const outdatedStore = store(outdatedFile);
    expect(outdatedStore.status).toBe("outdated");
    expect(outdatedStore.schemaVersion).toBe(4);
    expect(outdatedStore.diagnostics().database.status).toBe("outdated");
    outdatedStore.close();
  });

  it("uses indexed plans and never plans a raw usage_events listing", async () => {
    const directory = await temporaryDirectory();
    const databaseFile = path.join(directory, "dashboard.sqlite");
    seed(databaseFile);
    const dashboard = store(databaseFile);
    const plans = dashboard.explainCriticalQueries();
    const combined = JSON.stringify(plans);
    expect(combined).not.toContain("usage_events");
    expect(combined).toContain("sessions_started_at_idx");
    expect(combined).toContain("tracking_runs_started_at_idx");
    expect(combined).toContain("test_runs_started_at_idx");
    dashboard.close();
  });
});
