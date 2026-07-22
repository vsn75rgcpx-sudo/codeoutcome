import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SessionDatabase } from "../packages/database/src/index.js";

export const DEMO_NOW = "2026-07-21T12:00:00.000Z";
export const DEMO_ROOT = "/codeoutcome-demo";

export interface DemoDatabaseSummary {
  databaseFile: string;
  repositories: number;
  sessions: number;
  trackingRuns: number;
  gitSnapshots: number;
  gitFileStats: number;
  testRuns: number;
  quickCheck: string;
  logicalFingerprint: string;
}

const repositories = [
  { id: 1, name: "Atlas CLI", slug: "atlas-cli" },
  { id: 2, name: "Beacon API", slug: "beacon-api" },
  { id: 3, name: "Cedar Notes", slug: "cedar-notes" },
  { id: 4, name: "Drift Worker", slug: "drift-worker" },
] as const;

const sessions = [
  [
    "01",
    "claude-code",
    "claude-sonnet-demo",
    "2026-07-14T09:00:00.000Z",
    1,
    126_400n,
    12_900n,
    72_000n,
    "verified",
  ],
  [
    "02",
    "codex",
    "gpt-5.5-demo",
    "2026-07-15T10:15:00.000Z",
    2,
    248_900n,
    18_200n,
    196_608n,
    "verified",
  ],
  [
    "03",
    "claude-code",
    "claude-opus-demo",
    "2026-07-16T08:30:00.000Z",
    3,
    92_300n,
    8_100n,
    51_200n,
    "verified",
  ],
  [
    "04",
    "codex",
    "gpt-5.6-sol-demo",
    "2026-07-16T13:20:00.000Z",
    4,
    412_800n,
    25_400n,
    358_400n,
    "verified",
  ],
  [
    "05",
    "claude-code",
    "claude-sonnet-demo",
    "2026-07-17T07:45:00.000Z",
    1,
    178_200n,
    16_700n,
    110_592n,
    "verified",
  ],
  [
    "06",
    "codex",
    "gpt-5.5-demo",
    "2026-07-17T15:05:00.000Z",
    2,
    331_500n,
    21_300n,
    286_720n,
    "verified",
  ],
  [
    "07",
    "claude-code",
    "claude-opus-demo",
    "2026-07-18T09:40:00.000Z",
    3,
    205_600n,
    13_800n,
    143_360n,
    "verified",
  ],
  [
    "08",
    "codex",
    "gpt-5.6-sol-demo",
    "2026-07-18T16:10:00.000Z",
    4,
    518_700n,
    31_900n,
    471_040n,
    "verified",
  ],
  [
    "09",
    "claude-code",
    "claude-sonnet-demo",
    "2026-07-19T10:25:00.000Z",
    1,
    154_900n,
    14_100n,
    98_304n,
    "verified",
  ],
  [
    "10",
    "codex",
    "gpt-5.5-demo",
    "2026-07-19T14:50:00.000Z",
    2,
    287_300n,
    19_600n,
    245_760n,
    "warning",
  ],
  [
    "11",
    "claude-code",
    "claude-opus-demo",
    "2026-07-20T08:05:00.000Z",
    3,
    224_800n,
    17_500n,
    167_936n,
    "verified",
  ],
  [
    "12",
    "codex",
    "gpt-5.6-sol-demo",
    "2026-07-20T14:30:00.000Z",
    4,
    9_007_199_254_740_999n,
    42_700n,
    1_048_576n,
    "verified",
  ],
] as const;

const trackingRuns = [
  {
    id: "01",
    provider: "codex",
    repository: 4,
    session: "12",
    level: "high",
    confidence: 0.96,
    label: "Stabilize queue handoff",
    start: "2026-07-20T14:32:00.000Z",
    end: "2026-07-20T15:18:00.000Z",
    startDirty: 0,
    endDirty: 1,
    status: "completed",
    warnings: [],
  },
  {
    id: "02",
    provider: "claude-code",
    repository: 3,
    session: "11",
    level: "medium",
    confidence: 0.72,
    label: "Refine search indexing",
    start: "2026-07-20T08:08:00.000Z",
    end: "2026-07-20T08:42:00.000Z",
    startDirty: 1,
    endDirty: 1,
    status: "completed",
    warnings: ["baseline_dirty"],
  },
  {
    id: "03",
    provider: "codex",
    repository: 2,
    session: "10",
    level: "ambiguous",
    confidence: 0.48,
    label: "Review retry behavior",
    start: "2026-07-19T14:52:00.000Z",
    end: "2026-07-19T15:20:00.000Z",
    startDirty: 0,
    endDirty: 1,
    status: "completed",
    warnings: ["multiple_candidate_sessions"],
  },
  {
    id: "04",
    provider: "claude-code",
    repository: 1,
    session: null,
    level: null,
    confidence: null,
    label: "Inspect release command",
    start: "2026-07-19T10:28:00.000Z",
    end: "2026-07-19T10:47:00.000Z",
    startDirty: 0,
    endDirty: 1,
    status: "interrupted",
    warnings: ["no_linked_session"],
  },
  {
    id: "05",
    provider: "codex",
    repository: 4,
    session: "08",
    level: "high",
    confidence: 0.91,
    label: "Tighten worker shutdown",
    start: "2026-07-18T16:12:00.000Z",
    end: "2026-07-18T16:55:00.000Z",
    startDirty: 0,
    endDirty: 0,
    status: "completed",
    warnings: [],
  },
  {
    id: "06",
    provider: "claude-code",
    repository: 2,
    session: "07",
    level: "medium",
    confidence: 0.67,
    label: "Audit response metadata",
    start: "2026-07-18T09:43:00.000Z",
    end: "2026-07-18T10:09:00.000Z",
    startDirty: 0,
    endDirty: 1,
    status: "completed",
    warnings: [],
  },
] as const;

const testRuns = [
  {
    id: "01",
    tracking: "01",
    session: "12",
    repository: 4,
    at: "2026-07-20T14:36:00.000Z",
    stage: "baseline",
    framework: "vitest",
    status: "completed",
    outcome: "failed",
    total: 42,
    passed: 40,
    failed: 2,
    skipped: 0,
    parser: "parsed",
    exitCode: 1,
    truncated: 0,
  },
  {
    id: "02",
    tracking: "01",
    session: "12",
    repository: 4,
    at: "2026-07-20T15:14:00.000Z",
    stage: "final",
    framework: "vitest",
    status: "completed",
    outcome: "passed",
    total: 42,
    passed: 42,
    failed: 0,
    skipped: 0,
    parser: "parsed",
    exitCode: 0,
    truncated: 0,
  },
  {
    id: "03",
    tracking: "02",
    session: "11",
    repository: 3,
    at: "2026-07-20T08:12:00.000Z",
    stage: "baseline",
    framework: "pytest",
    status: "completed",
    outcome: "passed",
    total: 18,
    passed: 18,
    failed: 0,
    skipped: 0,
    parser: "parsed",
    exitCode: 0,
    truncated: 0,
  },
  {
    id: "04",
    tracking: "02",
    session: "11",
    repository: 3,
    at: "2026-07-20T08:39:00.000Z",
    stage: "final",
    framework: "pytest",
    status: "completed",
    outcome: "passed",
    total: 18,
    passed: 18,
    failed: 0,
    skipped: 0,
    parser: "parsed",
    exitCode: 0,
    truncated: 0,
  },
  {
    id: "05",
    tracking: "03",
    session: "10",
    repository: 2,
    at: "2026-07-19T15:03:00.000Z",
    stage: "intermediate",
    framework: "generic",
    status: "completed",
    outcome: "failed",
    total: null,
    passed: null,
    failed: null,
    skipped: null,
    parser: "exit_code_only",
    exitCode: 1,
    truncated: 0,
  },
  {
    id: "06",
    tracking: "04",
    session: null,
    repository: 1,
    at: "2026-07-19T10:42:00.000Z",
    stage: "final",
    framework: "jest",
    status: "completed",
    outcome: "failed",
    total: 64,
    passed: 61,
    failed: 3,
    skipped: 0,
    parser: "partially_parsed",
    exitCode: 1,
    truncated: 1,
  },
  {
    id: "07",
    tracking: "05",
    session: "08",
    repository: 4,
    at: "2026-07-18T16:18:00.000Z",
    stage: "baseline",
    framework: "cargo",
    status: "completed",
    outcome: "passed",
    total: 27,
    passed: 27,
    failed: 0,
    skipped: 0,
    parser: "parsed",
    exitCode: 0,
    truncated: 0,
  },
  {
    id: "08",
    tracking: "05",
    session: "08",
    repository: 4,
    at: "2026-07-18T16:50:00.000Z",
    stage: "final",
    framework: "cargo",
    status: "completed",
    outcome: "passed",
    total: 27,
    passed: 27,
    failed: 0,
    skipped: 0,
    parser: "parsed",
    exitCode: 0,
    truncated: 0,
  },
] as const;

function demoPath(repositoryId: number): string {
  const repository = repositories.find((item) => item.id === repositoryId);
  if (repository === undefined) throw new Error("Demo repository is missing");
  return `${DEMO_ROOT}/workspaces/${repository.slug}`;
}

function sessionId(short: string): string {
  return `demo-session-${short}`;
}

function trackingId(short: string): string {
  return `demo-tracking-${short}`;
}

function testId(short: string): string {
  return `demo-test-${short}`;
}

function logicalFingerprint(database: DatabaseSync): string {
  const tables = [
    "repositories",
    "sessions",
    "import_runs",
    "git_snapshots",
    "git_file_stats",
    "tracking_runs",
    "test_runs",
    "test_run_links",
  ];
  const hash = createHash("sha256");
  for (const table of tables) {
    hash.update(table);
    const query = database.prepare(`SELECT * FROM ${table} ORDER BY 1`);
    query.setReadBigInts(true);
    hash.update(
      JSON.stringify(query.all(), (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  }
  return hash.digest("hex");
}

function count(database: DatabaseSync, table: string): number {
  const value = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get()?.count;
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function seedDemoDatabase(databaseFile: string): DemoDatabaseSummary {
  const resolved = path.resolve(databaseFile);
  mkdirSync(path.dirname(resolved), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${resolved}${suffix}`, { force: true });
  }
  new SessionDatabase(resolved).close();
  const database = new DatabaseSync(resolved);
  database.exec("PRAGMA foreign_keys=ON");
  database
    .prepare("UPDATE schema_migrations SET applied_at = ?")
    .run("2026-07-01T00:00:00.000Z");

  const insertRepository = database.prepare(
    `INSERT INTO repositories
      (id, canonical_path, name, remote_url, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  );
  for (const repository of repositories) {
    insertRepository.run(
      repository.id,
      demoPath(repository.id),
      repository.name,
      "2026-07-14T00:00:00.000Z",
      DEMO_NOW,
    );
  }

  const insertSession = database.prepare(
    `INSERT INTO sessions (
      id, provider, provider_session_id, model, started_at, ended_at,
      working_directory, repository_id, repository_path, branch,
      input_tokens, output_tokens, cached_input_tokens, estimated_cost,
      source_file, source_file_hash, imported_at, accounting_method,
      accounting_status, accounting_version, uncached_input_tokens,
      last_usage_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, ?, NULL, ?, ?, ?, ?, ?,
      'demo-accounting-v1', ?, ?)`,
  );
  for (const [
    short,
    provider,
    model,
    startedAt,
    repositoryId,
    input,
    output,
    cache,
    status,
  ] of sessions) {
    const endedAt = new Date(
      new Date(startedAt).getTime() + (18 + Number(short)) * 60_000,
    ).toISOString();
    insertSession.run(
      sessionId(short),
      provider,
      `demo-provider-session-${short}`,
      model,
      startedAt,
      endedAt,
      demoPath(repositoryId),
      repositoryId,
      demoPath(repositoryId),
      input,
      output,
      cache,
      `${DEMO_ROOT}/provider-logs/session-${short}.jsonl`,
      `demo-source-hash-${short}`,
      DEMO_NOW,
      status === "warning" ? "ambiguous" : "cumulative_snapshot",
      status,
      input - cache,
      endedAt,
    );
  }

  const insertSnapshot = database.prepare(
    `INSERT INTO git_snapshots (
      id, repository_id, captured_at, trigger, privacy_mode, working_directory,
      head_commit, branch, is_detached_head, is_unborn_branch, is_dirty,
      staged_file_count, unstaged_file_count, untracked_file_count,
      conflicted_file_count, ahead_count, behind_count, git_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'main', 0, 0, ?, ?, ?, ?, ?, 0, 0,
      'git version demo')`,
  );
  const insertTracking = database.prepare(
    `INSERT INTO tracking_runs (
      id, provider, label, working_directory, repository_id, started_at,
      ended_at, status, start_snapshot_id, end_snapshot_id, linked_session_id,
      link_confidence, link_confidence_level, link_method, link_reasons_json,
      summary_json, warnings_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const run of trackingRuns) {
    const startId = `demo-snapshot-${run.id}-start`;
    const endId = `demo-snapshot-${run.id}-end`;
    const privacy = run.id === "06" ? "strict" : "git-metadata";
    insertSnapshot.run(
      startId,
      run.repository,
      run.start,
      "tracking_start",
      privacy,
      demoPath(run.repository),
      `${run.id.repeat(40).slice(0, 40)}`,
      run.startDirty,
      run.startDirty ? 1 : 0,
      run.startDirty ? 1 : 0,
      0,
      0,
    );
    const changed = run.id === "05" ? 0 : 1;
    insertSnapshot.run(
      endId,
      run.repository,
      run.end,
      "tracking_end",
      privacy,
      demoPath(run.repository),
      `${run.id.split("").reverse().join("").repeat(40).slice(0, 40)}`,
      run.endDirty,
      changed,
      changed,
      run.id === "03" ? 1 : 0,
      run.id === "04" ? 1 : 0,
    );
    const summary = {
      filesChanged: changed === 0 ? 0 : run.id === "01" ? 2 : 1,
      additions: changed === 0 ? 0 : run.id === "01" ? 21 : 6,
      deletions: changed === 0 ? 0 : run.id === "02" ? 4 : 2,
      binaryFiles: run.id === "02" ? 1 : 0,
      renamedFiles: run.id === "02" ? 1 : 0,
    };
    insertTracking.run(
      trackingId(run.id),
      run.provider,
      run.label,
      demoPath(run.repository),
      run.repository,
      run.start,
      run.end,
      run.status,
      startId,
      endId,
      run.session === null ? null : sessionId(run.session),
      run.confidence,
      run.level,
      run.session === null ? null : "automatic",
      JSON.stringify(
        run.session === null
          ? ["No linked session met the evidence threshold"]
          : ["Observed in the same repository and time window"],
      ),
      JSON.stringify(summary),
      JSON.stringify(run.warnings),
      run.start,
      run.end,
    );
  }

  const insertFile = database.prepare(
    `INSERT INTO git_file_stats (
      id, snapshot_id, relative_path, previous_path, change_type, area,
      additions, deletions, is_binary, content_fingerprint, path_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const fileRows = [
    ["01-a", "01", "src/queue.ts", null, "modified", "staged", 14, 2, 0],
    ["01-b", "01", "test/queue.test.ts", null, "added", "unstaged", 7, 0, 0],
    [
      "02-a",
      "02",
      "src/search-index.ts",
      "src/indexer.ts",
      "renamed",
      "staged",
      4,
      4,
      0,
    ],
    [
      "02-b",
      "02",
      "assets/search-fixture.bin",
      null,
      "modified",
      "unstaged",
      null,
      null,
      1,
    ],
    [
      "03-a",
      "03",
      "notes/retry-plan.md",
      null,
      "untracked",
      "untracked",
      6,
      0,
      0,
    ],
    ["04-a", "04", "src/release.ts", null, "unmerged", "conflicted", 3, 2, 0],
    ["06-a", "06", null, null, "modified", "unstaged", 6, 2, 0],
  ] as const;
  for (const [
    id,
    run,
    relative,
    previous,
    change,
    area,
    additions,
    deletions,
    binary,
  ] of fileRows) {
    insertFile.run(
      `demo-file-${id}`,
      `demo-snapshot-${run}-end`,
      relative,
      previous,
      change,
      area,
      additions,
      deletions,
      binary,
      `demo-path-fingerprint-${id}`,
    );
  }

  const insertTest = database.prepare(
    `INSERT INTO test_runs (
      id, tracking_run_id, session_id, repository_id, working_directory,
      started_at, ended_at, duration_ms, stage, framework, framework_version,
      executable, command_display, command_fingerprint, argument_count,
      exit_code, termination_signal, status, outcome, total_tests, passed_tests,
      failed_tests, skipped_tests, todo_tests, errored_tests, parser_status,
      parser_version, output_truncated, source, warnings_json, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1200, ?, ?, 'demo', ?, ?, ?, 2, ?, NULL,
      ?, ?, ?, ?, ?, ?, 0, 0, ?, 'demo-parser-v1', ?, 'wrapped_command', ?, ?, ?)`,
  );
  const insertTestLink = database.prepare(
    `INSERT INTO test_run_links (
      id, test_run_id, tracking_run_id, session_id, link_type, confidence,
      reasons_json, created_at
    ) VALUES (?, ?, ?, ?, 'auto', ?, ?, ?)`,
  );
  for (const test of testRuns) {
    const endedAt = new Date(new Date(test.at).getTime() + 1_200).toISOString();
    const executable =
      test.framework === "generic" ? "demo-check" : test.framework;
    const command = `${executable} run --demo`;
    insertTest.run(
      testId(test.id),
      trackingId(test.tracking),
      test.session === null ? null : sessionId(test.session),
      test.repository,
      demoPath(test.repository),
      test.at,
      endedAt,
      test.stage,
      test.framework,
      executable,
      command,
      `demo-command-fingerprint-${test.id}`,
      test.exitCode,
      test.status,
      test.outcome,
      test.total,
      test.passed,
      test.failed,
      test.skipped,
      test.parser,
      test.truncated,
      JSON.stringify(
        test.truncated ? ["Aggregate parser buffer truncated"] : [],
      ),
      test.at,
      endedAt,
    );
    insertTestLink.run(
      `demo-test-link-${test.id}`,
      testId(test.id),
      trackingId(test.tracking),
      test.session === null ? null : sessionId(test.session),
      test.session === null ? 0.6 : 0.95,
      JSON.stringify(["Demo association by repository and time window"]),
      endedAt,
    );
  }

  database
    .prepare(
      `INSERT INTO import_runs (
        provider, started_at, completed_at, scanned_files, imported_sessions,
        updated_sessions, skipped_sessions, malformed_files, status
      ) VALUES ('all', ?, ?, 12, 12, 0, 0, 0, 'completed')`,
    )
    .run("2026-07-21T10:00:00.000Z", "2026-07-21T10:00:02.000Z");

  const quick = database.prepare("PRAGMA quick_check").get();
  const quickCheck = String(Object.values(quick ?? {})[0] ?? "unknown");
  const summary = {
    databaseFile: resolved,
    repositories: count(database, "repositories"),
    sessions: count(database, "sessions"),
    trackingRuns: count(database, "tracking_runs"),
    gitSnapshots: count(database, "git_snapshots"),
    gitFileStats: count(database, "git_file_stats"),
    testRuns: count(database, "test_runs"),
    quickCheck,
    logicalFingerprint: logicalFingerprint(database),
  } satisfies DemoDatabaseSummary;
  database.exec("PRAGMA journal_mode=DELETE; VACUUM;");
  database.close();
  return summary;
}
