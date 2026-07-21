import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { selectTestComparison } from "@agentledger/core";
import { LATEST_MIGRATION_VERSION } from "@agentledger/database";
import {
  redactHomePath,
  type DashboardActivity,
  type DashboardDiagnostics,
  type DashboardDistribution,
  type DashboardFilters,
  type DashboardGitAreaSummary,
  type DashboardGitSnapshot,
  type DashboardOverview,
  type DashboardPagination,
  type DashboardRange,
  type DashboardSessionDetail,
  type DashboardSessionListItem,
  type DashboardTestComparison,
  type DashboardTestRunDetail,
  type DashboardTestRunListItem,
  type DashboardTimelineEvent,
  type DashboardTokenTrend,
  type DashboardTrackingRunDetail,
  type DashboardTrackingRunListItem,
  type GitPrivacyMode,
  type Provider,
  type TestFramework,
  type TestOutcome,
  type TestParserStatus,
  type TestRun,
  type TestStage,
  type TrackingRunStatus,
} from "@agentledger/shared";

type Row = Record<string, unknown>;

export type DashboardDatabaseStatus =
  "ready" | "missing" | "locked" | "outdated" | "error";

export class DashboardDataError extends Error {
  constructor(
    readonly code:
      | "database_missing"
      | "database_locked"
      | "schema_outdated"
      | "database_error",
    message: string,
    readonly suggestion: string,
    readonly httpStatus = 503,
  ) {
    super(message);
    this.name = "DashboardDataError";
  }
}

export interface DashboardStoreOptions {
  databaseFile: string;
  privacyMode: GitPrivacyMode;
  userHome: string;
  claudeLogDirectory: string;
  codexLogDirectory: string;
  version: string;
  now?: () => Date;
}

export interface PageQuery {
  page: number;
  pageSize: number;
  since?: string;
  until?: string;
  search?: string;
}

export interface SessionPageQuery extends PageQuery {
  provider?: Provider;
  model?: string;
  repository?: string;
  accountingStatus?: string;
  sort:
    | "startedAt"
    | "provider"
    | "model"
    | "repository"
    | "inputTokens"
    | "outputTokens"
    | "totalTokens";
  order: "asc" | "desc";
}

export interface TrackingPageQuery extends PageQuery {
  provider?: Provider;
  repository?: string;
  status?: TrackingRunStatus;
  confidence?: string;
  hasGitChanges?: boolean;
  hasTests?: boolean;
  testChange?: "improved" | "regressed" | "unchanged";
  sort:
    | "startedAt"
    | "provider"
    | "repository"
    | "filesChanged"
    | "additions"
    | "deletions"
    | "status";
  order: "asc" | "desc";
}

export interface TestPageQuery extends PageQuery {
  framework?: TestFramework;
  outcome?: TestOutcome;
  stage?: TestStage;
  parserStatus?: TestParserStatus;
  trackingRunId?: string;
  sessionId?: string;
  sort:
    | "startedAt"
    | "framework"
    | "outcome"
    | "stage"
    | "duration"
    | "failedTests";
  order: "asc" | "desc";
}

function statement(database: DatabaseSync, sql: string): StatementSync {
  const prepared = database.prepare(sql);
  prepared.setReadBigInts(true);
  return prepared;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, fallback = "unknown"): string {
  return stringValue(value) ?? fallback;
}

function integer(value: unknown): number {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function token(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return "0";
}

function booleanValue(value: unknown): boolean {
  return integer(value) === 1;
}

function jsonStrings(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function durationMs(
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (startedAt === null || endedAt === null) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : null;
}

function pagination(
  page: number,
  pageSize: number,
  totalItems: number,
): DashboardPagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
  };
}

function shortHead(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}

function safeProvider(value: unknown): Provider {
  return value === "claude-code" ? value : "codex";
}

function safeOutcome(value: unknown): TestOutcome {
  return value === "passed" ||
    value === "failed" ||
    value === "errored" ||
    value === "interrupted"
    ? value
    : "unknown";
}

function safeFramework(value: unknown): TestFramework {
  return value === "pytest" ||
    value === "jest" ||
    value === "vitest" ||
    value === "junit" ||
    value === "go" ||
    value === "cargo"
    ? value
    : "generic";
}

function safeStage(value: unknown): TestStage {
  return value === "baseline" || value === "intermediate" || value === "final"
    ? value
    : "unspecified";
}

function safeParserStatus(value: unknown): TestParserStatus {
  return value === "parsed" ||
    value === "partially_parsed" ||
    value === "exit_code_only" ||
    value === "malformed"
    ? value
    : "unsupported";
}

function safeTrackingStatus(value: unknown): TrackingRunStatus {
  return value === "active" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "abandoned"
    ? value
    : "completed";
}

function safeTestStatus(value: unknown): TestRun["status"] {
  return value === "running" ||
    value === "interrupted" ||
    value === "failed_to_start" ||
    value === "abandoned"
    ? value
    : "completed";
}

function testListItem(row: Row): DashboardTestRunListItem {
  return {
    id: requiredString(row.id),
    startedAt: requiredString(row.started_at),
    endedAt: stringValue(row.ended_at),
    durationMs: nullableInteger(row.duration_ms),
    stage: safeStage(row.stage),
    framework: safeFramework(row.framework),
    outcome: safeOutcome(row.outcome),
    passedTests: nullableInteger(row.passed_tests),
    failedTests: nullableInteger(row.failed_tests),
    skippedTests: nullableInteger(row.skipped_tests),
    parserStatus: safeParserStatus(row.parser_status),
    trackingRunId: stringValue(row.tracking_run_id),
    sessionId: stringValue(row.session_id),
    outputTruncated: booleanValue(row.output_truncated),
    status: requiredString(row.status),
  };
}

function testRunDomain(row: Row): TestRun {
  const item = testListItem(row);
  return {
    ...item,
    status: safeTestStatus(row.status),
    repositoryId: nullableInteger(row.repository_id),
    workingDirectory: requiredString(row.working_directory, "<redacted>"),
    frameworkVersion: stringValue(row.framework_version),
    executable: requiredString(row.executable),
    commandDisplay: requiredString(row.command_display),
    commandFingerprint: requiredString(row.command_fingerprint),
    argumentCount: integer(row.argument_count),
    exitCode: nullableInteger(row.exit_code),
    terminationSignal:
      row.termination_signal === "SIGINT" ||
      row.termination_signal === "SIGTERM"
        ? row.termination_signal
        : null,
    totalTests: nullableInteger(row.total_tests),
    todoTests: nullableInteger(row.todo_tests),
    erroredTests: nullableInteger(row.errored_tests),
    parserVersion: requiredString(row.parser_version),
    source:
      row.source === "imported_report" || row.source === "manual"
        ? row.source
        : "wrapped_command",
    warnings: jsonStrings(row.warnings_json),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function comparisonView(
  runs: readonly TestRun[],
): DashboardTestComparison | null {
  if (runs.length === 0) return null;
  const comparison = selectTestComparison(runs);
  return {
    baselineTestRunId: comparison.baseline?.id ?? null,
    finalTestRunId: comparison.final?.id ?? null,
    baselineSelection: comparison.baselineSelection,
    finalSelection: comparison.finalSelection,
    baselineOutcome: comparison.baseline?.outcome ?? null,
    finalOutcome: comparison.final?.outcome ?? null,
    totalDelta: comparison.totalTestDelta,
    passedDelta: comparison.passedTestDelta,
    failedDelta: comparison.failedTestDelta,
    skippedDelta: comparison.skippedTestDelta,
    durationDeltaMs: comparison.durationDeltaMs,
    comparability: comparison.comparability,
    confidence: comparison.comparisonConfidence,
    warnings: comparison.warnings,
  };
}

export class DashboardStore {
  readonly #options: DashboardStoreOptions;
  readonly #database: DatabaseSync | null;
  readonly status: DashboardDatabaseStatus;
  readonly schemaVersion: number | null;
  readonly queryOnly: boolean;
  readonly foreignKeys: boolean;

  constructor(options: DashboardStoreOptions) {
    this.#options = options;
    let database: DatabaseSync | null = null;
    let status: DashboardDatabaseStatus = "missing";
    let schemaVersion: number | null = null;
    let queryOnly = false;
    let foreignKeys = false;
    if (existsSync(options.databaseFile)) {
      try {
        database = new DatabaseSync(options.databaseFile, { readOnly: true });
        database.exec(
          "PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA query_only=ON;",
        );
        const versionRow = statement(
          database,
          "SELECT MAX(version) AS version FROM schema_migrations",
        ).get() as Row | undefined;
        schemaVersion = nullableInteger(versionRow?.version) ?? 0;
        const queryOnlyRow = statement(
          database,
          "PRAGMA query_only",
        ).get() as Row;
        const foreignKeyRow = statement(
          database,
          "PRAGMA foreign_keys",
        ).get() as Row;
        queryOnly = booleanValue(queryOnlyRow.query_only);
        foreignKeys = booleanValue(foreignKeyRow.foreign_keys);
        status =
          schemaVersion < LATEST_MIGRATION_VERSION ? "outdated" : "ready";
      } catch (error) {
        database?.close();
        database = null;
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        status =
          code.includes("BUSY") || code.includes("LOCKED") ? "locked" : "error";
      }
    }
    this.#database = database;
    this.status = status;
    this.schemaVersion = schemaVersion;
    this.queryOnly = queryOnly;
    this.foreignKeys = foreignKeys;
  }

  #ready(): DatabaseSync {
    if (this.status === "missing") {
      throw new DashboardDataError(
        "database_missing",
        "The AgentLedger database does not exist yet.",
        "Run: agentledger import --provider codex",
      );
    }
    if (this.status === "outdated") {
      throw new DashboardDataError(
        "schema_outdated",
        "The AgentLedger database schema is older than this dashboard supports.",
        "Run: agentledger doctor, then a normal CLI command to apply migrations",
      );
    }
    if (this.status === "locked") {
      throw new DashboardDataError(
        "database_locked",
        "The AgentLedger database is currently locked.",
        "Close the conflicting process and refresh the dashboard",
      );
    }
    if (this.status !== "ready" || this.#database === null) {
      throw new DashboardDataError(
        "database_error",
        "The AgentLedger database could not be read.",
        "Run: agentledger doctor",
      );
    }
    return this.#database;
  }

  #all(sql: string, ...parameters: Array<string | number | bigint>): Row[] {
    return statement(this.#ready(), sql).all(...parameters) as Row[];
  }

  #get(
    sql: string,
    ...parameters: Array<string | number | bigint>
  ): Row | null {
    return (
      (statement(this.#ready(), sql).get(...parameters) as Row | undefined) ??
      null
    );
  }

  #repository(value: unknown): string | null {
    const name = stringValue(value);
    return name === null || name.length === 0 ? null : name;
  }

  #session(row: Row): DashboardSessionListItem {
    const startedAt = stringValue(row.started_at);
    const endedAt = stringValue(row.ended_at);
    return {
      id: requiredString(row.id),
      startedAt,
      endedAt,
      durationMs: durationMs(startedAt, endedAt),
      provider: safeProvider(row.provider),
      model: requiredString(row.model),
      repository: this.#repository(row.repository_name),
      branch: stringValue(row.branch),
      inputTokens: token(row.input_tokens),
      cachedInputTokens: token(row.cached_input_tokens),
      uncachedInputTokens: token(row.uncached_input_tokens),
      outputTokens: token(row.output_tokens),
      totalTokens: token(row.total_tokens),
      accountingMethod:
        row.accounting_method === "cumulative_snapshot" ||
        row.accounting_method === "incremental_events" ||
        row.accounting_method === "ambiguous"
          ? row.accounting_method
          : "unavailable",
      accountingStatus:
        row.accounting_status === "verified" ||
        row.accounting_status === "invalid"
          ? row.accounting_status
          : "warning",
      linkedTrackingRunCount: integer(row.tracking_count),
    };
  }

  latestImport(): DashboardOverview["latestImport"] {
    const row = this.#get(
      `SELECT provider, status, started_at, completed_at
       FROM import_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    return row === null
      ? null
      : {
          provider: requiredString(row.provider),
          status: requiredString(row.status),
          startedAt: requiredString(row.started_at),
          completedAt: stringValue(row.completed_at),
        };
  }

  overview(range: DashboardRange): DashboardOverview {
    const database = this.#ready();
    const now = (this.#options.now ?? (() => new Date()))();
    const since =
      range === "all"
        ? null
        : new Date(
            now.getTime() - (range === "7d" ? 7 : 30) * 86_400_000,
          ).toISOString();
    const periodWhere = since === null ? "" : "WHERE started_at >= ?";
    const parameters = since === null ? [] : [since];
    const totals = statement(
      database,
      `SELECT COUNT(*) AS sessions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
       FROM sessions ${periodWhere}`,
    ).get(...parameters) as Row;
    const sevenDays = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const sessionsLast7 = this.#get(
      "SELECT COUNT(*) AS count FROM sessions WHERE started_at >= ?",
      sevenDays,
    );
    const tracking = this.#get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN summary_json IS NOT NULL AND
          CAST(json_extract(summary_json, '$.filesChanged') AS INTEGER) > 0
          THEN 1 ELSE 0 END) AS changed_runs,
        SUM(CASE WHEN summary_json IS NOT NULL AND
          json_type(summary_json, '$.filesChanged') IS NOT NULL
          THEN CAST(json_extract(summary_json, '$.filesChanged') AS INTEGER)
          ELSE NULL END) AS changed_files,
        SUM(CASE WHEN linked_session_id IS NULL OR link_confidence_level = 'ambiguous'
          THEN 1 ELSE 0 END) AS unlinked
       FROM tracking_runs ${periodWhere}`,
      ...parameters,
    );
    const tests = this.#get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'passed' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN outcome IN ('failed', 'errored') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN outcome IN ('unknown', 'interrupted') THEN 1 ELSE 0 END) AS unknown,
        SUM(CASE WHEN tracking_run_id IS NULL AND session_id IS NULL THEN 1 ELSE 0 END) AS unlinked
       FROM test_runs ${periodWhere}`,
      ...parameters,
    );
    const comparisonRows = this.#all(
      `SELECT * FROM test_runs
       WHERE status <> 'running' AND tracking_run_id IS NOT NULL
         ${since === null ? "" : "AND started_at >= ?"}
       ORDER BY tracking_run_id, started_at, id`,
      ...parameters,
    );
    const groups = new Map<string, TestRun[]>();
    for (const row of comparisonRows) {
      const trackingRunId = stringValue(row.tracking_run_id);
      if (trackingRunId === null) continue;
      const group = groups.get(trackingRunId) ?? [];
      group.push(testRunDomain(row));
      groups.set(trackingRunId, group);
    }
    let failingToPassing = 0;
    for (const runs of groups.values()) {
      const comparison = comparisonView(runs);
      if (
        comparison !== null &&
        comparison.comparability !== "not_comparable" &&
        (comparison.baselineOutcome === "failed" ||
          comparison.baselineOutcome === "errored") &&
        comparison.finalOutcome === "passed"
      ) {
        failingToPassing += 1;
      }
    }
    const providerDistribution = this.#distribution(
      `SELECT provider AS key, provider AS label, COUNT(*) AS count
       FROM sessions ${periodWhere} GROUP BY provider ORDER BY count DESC`,
      parameters,
    );
    const modelDistribution = this.#distribution(
      `SELECT model AS key, model AS label, COUNT(*) AS count
       FROM sessions ${periodWhere} GROUP BY model ORDER BY count DESC, model LIMIT 20`,
      parameters,
    );
    const testOutcomeDistribution = this.#distribution(
      `SELECT outcome AS key, outcome AS label, COUNT(*) AS count
       FROM test_runs ${periodWhere} GROUP BY outcome ORDER BY count DESC`,
      parameters,
    );
    const trendRows = this.#all(
      `SELECT substr(started_at, 1, 10) AS date, COUNT(*) AS sessions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
       FROM sessions ${periodWhere}
       GROUP BY substr(started_at, 1, 10) ORDER BY date`,
      ...parameters,
    );
    const tokenTrend: DashboardTokenTrend[] = trendRows.map((row) => ({
      date: requiredString(row.date),
      sessions: integer(row.sessions),
      inputTokens: token(row.input_tokens),
      cachedInputTokens: token(row.cached_input_tokens),
      uncachedInputTokens: token(row.uncached_input_tokens),
      outputTokens: token(row.output_tokens),
      totalTokens: token(row.total_tokens),
    }));
    return {
      range,
      latestImport: this.latestImport(),
      totals: {
        sessions: integer(totals.sessions),
        sessionsLast7Days: integer(sessionsLast7?.count),
        inputTokens: token(totals.input_tokens),
        cachedInputTokens: token(totals.cached_input_tokens),
        uncachedInputTokens: token(totals.uncached_input_tokens),
        outputTokens: token(totals.output_tokens),
        totalTokens: token(totals.total_tokens),
        trackingRuns: integer(tracking?.total),
        trackingRunsWithGitChanges: integer(tracking?.changed_runs),
        observedChangedFiles:
          tracking?.changed_files === null ||
          tracking?.changed_files === undefined
            ? null
            : integer(tracking.changed_files),
        testRuns: integer(tests?.total),
        passedTestRuns: integer(tests?.passed),
        failedTestRuns: integer(tests?.failed),
        unknownTestRuns: integer(tests?.unknown),
        failingToPassingComparisons:
          groups.size === 0 ? null : failingToPassing,
        unlinkedOrAmbiguousRecords:
          integer(tracking?.unlinked) + integer(tests?.unlinked),
      },
      pricing: { status: "unavailable", label: "Pricing unavailable" },
      providerDistribution,
      modelDistribution,
      testOutcomeDistribution,
      tokenTrend,
      recentActivity: this.#recentActivity(since),
    };
  }

  #distribution(
    sql: string,
    parameters: readonly string[],
  ): DashboardDistribution[] {
    return this.#all(sql, ...parameters).map((row) => ({
      key: requiredString(row.key),
      label: requiredString(row.label),
      count: integer(row.count),
    }));
  }

  #recentActivity(since: string | null): DashboardActivity[] {
    const condition = since === null ? "" : "WHERE activity_at >= ?";
    const rows = this.#all(
      `SELECT * FROM (
        SELECT id, COALESCE(ended_at, started_at) AS activity_at, 'session' AS type,
          provider || ' session' AS title, model AS summary,
          accounting_status AS status, '/sessions/' || id AS href FROM sessions
        UNION ALL
        SELECT id, COALESCE(ended_at, started_at), 'tracking',
          COALESCE(label, provider || ' tracking run'), provider, status,
          '/tracking-runs/' || id FROM tracking_runs
        UNION ALL
        SELECT id, COALESCE(ended_at, started_at), 'test',
          framework || ' test run', stage || ' · ' || outcome, status,
          '/test-runs/' || id FROM test_runs
      ) ${condition} ORDER BY activity_at DESC LIMIT 20`,
      ...(since === null ? [] : [since]),
    );
    return rows.map((row) => ({
      id: requiredString(row.id),
      at: requiredString(row.activity_at),
      type:
        row.type === "tracking" || row.type === "test" ? row.type : "session",
      title: requiredString(row.title),
      summary: requiredString(row.summary),
      status: requiredString(row.status),
      href: stringValue(row.href),
    }));
  }

  sessions(query: SessionPageQuery): {
    items: DashboardSessionListItem[];
    pagination: DashboardPagination;
  } {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.since !== undefined) {
      conditions.push("s.started_at >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push("s.started_at <= ?");
      parameters.push(query.until);
    }
    if (query.provider !== undefined) {
      conditions.push("s.provider = ?");
      parameters.push(query.provider);
    }
    if (query.model !== undefined) {
      conditions.push("s.model = ?");
      parameters.push(query.model);
    }
    if (query.repository !== undefined) {
      conditions.push("(r.name = ? OR r.canonical_path = ?)");
      parameters.push(query.repository, query.repository);
    }
    if (query.accountingStatus !== undefined) {
      conditions.push("s.accounting_status = ?");
      parameters.push(query.accountingStatus);
    }
    if (query.search !== undefined) {
      conditions.push(
        "(lower(s.model) LIKE ? OR lower(s.provider) LIKE ? OR lower(COALESCE(r.name, '')) LIKE ? OR lower(COALESCE(s.branch, '')) LIKE ?)",
      );
      const search = `%${query.search.toLowerCase()}%`;
      parameters.push(search, search, search, search);
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const total = this.#get(
      `SELECT COUNT(*) AS count FROM sessions s LEFT JOIN repositories r ON r.id = s.repository_id ${where}`,
      ...parameters,
    );
    const sortColumns: Record<SessionPageQuery["sort"], string> = {
      startedAt: "s.started_at",
      provider: "s.provider",
      model: "s.model",
      repository: "r.name",
      inputTokens: "s.input_tokens",
      outputTokens: "s.output_tokens",
      totalTokens: "s.input_tokens + s.output_tokens",
    };
    const offset = (query.page - 1) * query.pageSize;
    const rows = this.#all(
      `SELECT s.*, r.name AS repository_name,
        s.input_tokens + s.output_tokens AS total_tokens,
        (SELECT COUNT(*) FROM tracking_runs tr WHERE tr.linked_session_id = s.id) AS tracking_count
       FROM sessions s LEFT JOIN repositories r ON r.id = s.repository_id
       ${where} ORDER BY ${sortColumns[query.sort]} ${query.order.toUpperCase()}, s.id
       LIMIT ? OFFSET ?`,
      ...parameters,
      query.pageSize,
      offset,
    );
    const totalItems = integer(total?.count);
    return {
      items: rows.map((row) => this.#session(row)),
      pagination: pagination(query.page, query.pageSize, totalItems),
    };
  }

  session(id: string): DashboardSessionDetail | null {
    const row = this.#get(
      `SELECT s.*, r.name AS repository_name,
        s.input_tokens + s.output_tokens AS total_tokens,
        (SELECT COUNT(*) FROM tracking_runs tr WHERE tr.linked_session_id = s.id) AS tracking_count
       FROM sessions s LEFT JOIN repositories r ON r.id = s.repository_id WHERE s.id = ?`,
      id,
    );
    if (row === null) return null;
    const base = this.#session(row);
    const trackingRows = this.#all(
      `${TRACKING_SELECT} WHERE tr.linked_session_id = ? ORDER BY tr.started_at DESC`,
      id,
    );
    const tests = this.#all(
      "SELECT * FROM test_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 200",
      id,
    ).map(testListItem);
    const warnings =
      base.accountingStatus === "verified"
        ? []
        : [`accounting_${base.accountingStatus}:${base.accountingMethod}`];
    return {
      ...base,
      lastUsageEventAt: stringValue(row.last_usage_event_at),
      accountingVersion: requiredString(row.accounting_version),
      trackingRuns: trackingRows.map((item) => this.#tracking(item)),
      testRuns: tests,
      warnings,
    };
  }

  #tracking(row: Row): DashboardTrackingRunListItem {
    const summary = jsonObject(row.summary_json);
    const filesChanged = nullableInteger(summary.filesChanged);
    const additions = nullableInteger(summary.additions);
    const deletions = nullableInteger(summary.deletions);
    const startedAt = requiredString(row.started_at);
    const endedAt = stringValue(row.ended_at);
    return {
      id: requiredString(row.id),
      label: stringValue(row.label),
      provider: safeProvider(row.provider),
      startedAt,
      endedAt,
      durationMs: durationMs(startedAt, endedAt),
      repository: requiredString(row.repository_name),
      branch: stringValue(row.start_branch),
      startHead: shortHead(stringValue(row.start_head)),
      endHead: shortHead(stringValue(row.end_head)),
      startDirty: booleanValue(row.start_dirty),
      endDirty: row.end_dirty === null ? null : booleanValue(row.end_dirty),
      filesChanged,
      additions,
      deletions,
      testRuns: integer(row.test_count),
      baselineOutcome:
        row.baseline_outcome === null
          ? null
          : safeOutcome(row.baseline_outcome),
      finalOutcome:
        row.final_outcome === null ? null : safeOutcome(row.final_outcome),
      linkConfidence:
        typeof row.link_confidence === "number" ? row.link_confidence : null,
      linkConfidenceLevel: stringValue(row.link_confidence_level),
      status: safeTrackingStatus(row.status),
      warnings: jsonStrings(row.warnings_json),
      hasGitChanges: filesChanged === null ? null : filesChanged > 0,
      linkedSessionId: stringValue(row.linked_session_id),
    };
  }

  trackingRuns(query: TrackingPageQuery): {
    items: DashboardTrackingRunListItem[];
    pagination: DashboardPagination;
  } {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.since !== undefined) {
      conditions.push("tr.started_at >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push("tr.started_at <= ?");
      parameters.push(query.until);
    }
    if (query.provider !== undefined) {
      conditions.push("tr.provider = ?");
      parameters.push(query.provider);
    }
    if (query.repository !== undefined) {
      conditions.push("(r.name = ? OR r.canonical_path = ?)");
      parameters.push(query.repository, query.repository);
    }
    if (query.status !== undefined) {
      conditions.push("tr.status = ?");
      parameters.push(query.status);
    }
    if (query.confidence !== undefined) {
      conditions.push("COALESCE(tr.link_confidence_level, 'unlinked') = ?");
      parameters.push(query.confidence);
    }
    if (query.hasGitChanges !== undefined) {
      conditions.push(
        `${query.hasGitChanges ? "" : "NOT "}(tr.summary_json IS NOT NULL AND CAST(json_extract(tr.summary_json, '$.filesChanged') AS INTEGER) > 0)`,
      );
    }
    if (query.hasTests !== undefined) {
      conditions.push(
        `${query.hasTests ? "" : "NOT "}EXISTS (SELECT 1 FROM test_runs tx WHERE tx.tracking_run_id = tr.id)`,
      );
    }
    if (query.search !== undefined) {
      conditions.push(
        "(lower(COALESCE(tr.label, '')) LIKE ? OR lower(r.name) LIKE ?)",
      );
      const search = `%${query.search.toLowerCase()}%`;
      parameters.push(search, search);
    }
    if (query.testChange !== undefined) {
      const baseline = TRACKING_BASELINE_OUTCOME;
      const final = TRACKING_FINAL_OUTCOME;
      conditions.push(
        query.testChange === "improved"
          ? `((${baseline}) IN ('failed', 'errored') AND (${final}) = 'passed')`
          : query.testChange === "regressed"
            ? `((${baseline}) = 'passed' AND (${final}) IN ('failed', 'errored'))`
            : `((${baseline}) = (${final}))`,
      );
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const total = this.#get(
      `SELECT COUNT(*) AS count FROM tracking_runs tr JOIN repositories r ON r.id = tr.repository_id ${where}`,
      ...parameters,
    );
    const sortColumns: Record<TrackingPageQuery["sort"], string> = {
      startedAt: "tr.started_at",
      provider: "tr.provider",
      repository: "r.name",
      filesChanged:
        "CAST(json_extract(tr.summary_json, '$.filesChanged') AS INTEGER)",
      additions:
        "CAST(json_extract(tr.summary_json, '$.additions') AS INTEGER)",
      deletions:
        "CAST(json_extract(tr.summary_json, '$.deletions') AS INTEGER)",
      status: "tr.status",
    };
    const rows = this.#all(
      `${TRACKING_SELECT} ${where}
       ORDER BY ${sortColumns[query.sort]} ${query.order.toUpperCase()}, tr.id
       LIMIT ? OFFSET ?`,
      ...parameters,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    );
    const totalItems = integer(total?.count);
    return {
      items: rows.map((row) => this.#tracking(row)),
      pagination: pagination(query.page, query.pageSize, totalItems),
    };
  }

  trackingRun(id: string): DashboardTrackingRunDetail | null {
    const row = this.#get(`${TRACKING_SELECT} WHERE tr.id = ?`, id);
    if (row === null) return null;
    const base = this.#tracking(row);
    const startSnapshot = this.#snapshot(requiredString(row.start_snapshot_id));
    if (startSnapshot === null) return null;
    const endSnapshotId = stringValue(row.end_snapshot_id);
    const endSnapshot =
      endSnapshotId === null ? null : this.#snapshot(endSnapshotId);
    const snapshotId = endSnapshotId ?? requiredString(row.start_snapshot_id);
    const gitAreas: DashboardGitAreaSummary[] = this.#all(
      `SELECT area, change_type, COUNT(*) AS files,
        CASE WHEN SUM(additions IS NULL) > 0 THEN NULL ELSE SUM(additions) END AS additions,
        CASE WHEN SUM(deletions IS NULL) > 0 THEN NULL ELSE SUM(deletions) END AS deletions,
        SUM(is_binary) AS binary_files
       FROM git_file_stats WHERE snapshot_id = ? GROUP BY area, change_type
       ORDER BY area, change_type`,
      snapshotId,
    ).map((area) => ({
      area: requiredString(area.area),
      changeType: requiredString(area.change_type),
      files: integer(area.files),
      additions: nullableInteger(area.additions),
      deletions: nullableInteger(area.deletions),
      binaryFiles: integer(area.binary_files),
    }));
    const testRows = this.#all(
      "SELECT * FROM test_runs WHERE tracking_run_id = ? ORDER BY started_at, id",
      id,
    );
    const comparison = comparisonView(testRows.map(testRunDomain));
    const linkedSessionId = stringValue(row.linked_session_id);
    const linkedSession =
      linkedSessionId === null ? null : this.#sessionById(linkedSessionId);
    const timeline = this.#timeline(
      row,
      startSnapshot,
      endSnapshot,
      testRows,
      linkedSession,
    );
    return {
      ...base,
      startSnapshot,
      endSnapshot,
      gitAreas,
      timeline,
      comparison,
      linkedSession,
      reasons: jsonStrings(row.link_reasons_json),
      tokenSummary:
        linkedSession === null
          ? null
          : {
              inputTokens: linkedSession.inputTokens,
              cachedInputTokens: linkedSession.cachedInputTokens,
              outputTokens: linkedSession.outputTokens,
              totalTokens: linkedSession.totalTokens,
            },
    };
  }

  #snapshot(id: string): DashboardGitSnapshot | null {
    const row = this.#get("SELECT * FROM git_snapshots WHERE id = ?", id);
    return row === null
      ? null
      : {
          id: requiredString(row.id),
          capturedAt: requiredString(row.captured_at),
          trigger: requiredString(row.trigger),
          headCommit: shortHead(stringValue(row.head_commit)),
          branch: stringValue(row.branch),
          dirty: booleanValue(row.is_dirty),
          stagedFiles: integer(row.staged_file_count),
          unstagedFiles: integer(row.unstaged_file_count),
          untrackedFiles: integer(row.untracked_file_count),
          conflictedFiles: integer(row.conflicted_file_count),
        };
  }

  #sessionById(id: string): DashboardSessionListItem | null {
    const row = this.#get(
      `SELECT s.*, r.name AS repository_name,
        s.input_tokens + s.output_tokens AS total_tokens,
        (SELECT COUNT(*) FROM tracking_runs tr WHERE tr.linked_session_id = s.id) AS tracking_count
       FROM sessions s LEFT JOIN repositories r ON r.id = s.repository_id WHERE s.id = ?`,
      id,
    );
    return row === null ? null : this.#session(row);
  }

  #timeline(
    tracking: Row,
    start: DashboardGitSnapshot,
    end: DashboardGitSnapshot | null,
    tests: readonly Row[],
    session: DashboardSessionListItem | null,
  ): DashboardTimelineEvent[] {
    const events: DashboardTimelineEvent[] = [
      {
        id: `tracking-start:${requiredString(tracking.id)}`,
        at: requiredString(tracking.started_at),
        type: "tracking_started",
        summary: "Tracking started",
        status: "observed",
        href: null,
      },
      {
        id: `snapshot:${start.id}`,
        at: start.capturedAt,
        type: "git_snapshot",
        summary: `Start Git snapshot · ${start.headCommit ?? "unborn"}`,
        status: start.dirty ? "dirty" : "clean",
        href: null,
      },
    ];
    for (const row of tests) {
      const item = testListItem(row);
      events.push({
        id: `test:${item.id}`,
        at: item.startedAt,
        type: `test_${item.stage}`,
        summary: `${item.framework} · ${item.outcome}`,
        status: item.status,
        href: `/test-runs/${item.id}`,
      });
    }
    if (session?.startedAt !== null && session?.startedAt !== undefined) {
      events.push({
        id: `session-start:${session.id}`,
        at: session.startedAt,
        type: "session_started",
        summary: `${session.provider} session started`,
        status: "linked",
        href: `/sessions/${session.id}`,
      });
    }
    if (session?.endedAt !== null && session?.endedAt !== undefined) {
      events.push({
        id: `session-end:${session.id}`,
        at: session.endedAt,
        type: "session_ended",
        summary: `${session.provider} session ended`,
        status: "linked",
        href: `/sessions/${session.id}`,
      });
    }
    if (end !== null) {
      events.push({
        id: `snapshot:${end.id}`,
        at: end.capturedAt,
        type: "git_snapshot",
        summary: `End Git snapshot · ${end.headCommit ?? "unborn"}`,
        status: end.dirty ? "dirty" : "clean",
        href: null,
      });
    }
    const endedAt = stringValue(tracking.ended_at);
    if (endedAt !== null) {
      const status = safeTrackingStatus(tracking.status);
      events.push({
        id: `tracking-end:${requiredString(tracking.id)}`,
        at: endedAt,
        type:
          status === "abandoned"
            ? "tracking_abandoned"
            : end?.trigger === "recovery"
              ? "tracking_recovered"
              : "tracking_completed",
        summary: `Tracking ${status}`,
        status,
        href: null,
      });
    }
    return events.sort(
      (left, right) =>
        left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
  }

  testRuns(query: TestPageQuery): {
    items: DashboardTestRunListItem[];
    pagination: DashboardPagination;
  } {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (column: string, value: string | undefined): void => {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        parameters.push(value);
      }
    };
    if (query.since !== undefined) {
      conditions.push("started_at >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push("started_at <= ?");
      parameters.push(query.until);
    }
    add("framework", query.framework);
    add("outcome", query.outcome);
    add("stage", query.stage);
    add("parser_status", query.parserStatus);
    add("tracking_run_id", query.trackingRunId);
    add("session_id", query.sessionId);
    if (query.search !== undefined) {
      conditions.push(
        "(lower(framework) LIKE ? OR lower(stage) LIKE ? OR lower(outcome) LIKE ?)",
      );
      const search = `%${query.search.toLowerCase()}%`;
      parameters.push(search, search, search);
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const total = this.#get(
      `SELECT COUNT(*) AS count FROM test_runs ${where}`,
      ...parameters,
    );
    const sortColumns: Record<TestPageQuery["sort"], string> = {
      startedAt: "started_at",
      framework: "framework",
      outcome: "outcome",
      stage: "stage",
      duration: "duration_ms",
      failedTests: "failed_tests",
    };
    const rows = this.#all(
      `SELECT * FROM test_runs ${where}
       ORDER BY ${sortColumns[query.sort]} ${query.order.toUpperCase()}, id
       LIMIT ? OFFSET ?`,
      ...parameters,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    );
    const totalItems = integer(total?.count);
    return {
      items: rows.map(testListItem),
      pagination: pagination(query.page, query.pageSize, totalItems),
    };
  }

  testRun(id: string): DashboardTestRunDetail | null {
    const row = this.#get("SELECT * FROM test_runs WHERE id = ?", id);
    if (row === null) return null;
    const base = testListItem(row);
    const commandDisplay =
      this.#options.privacyMode === "strict"
        ? path.basename(requiredString(row.executable))
        : requiredString(row.command_display)
            .split(this.#options.userHome)
            .join("~");
    const links = this.#all(
      "SELECT * FROM test_run_links WHERE test_run_id = ? ORDER BY created_at, id",
      id,
    );
    return {
      ...base,
      frameworkVersion: stringValue(row.framework_version),
      exitCode: nullableInteger(row.exit_code),
      terminationSignal: stringValue(row.termination_signal),
      totalTests: nullableInteger(row.total_tests),
      todoTests: nullableInteger(row.todo_tests),
      erroredTests: nullableInteger(row.errored_tests),
      parserVersion: requiredString(row.parser_version),
      commandDisplay,
      commandFingerprintShort: requiredString(row.command_fingerprint).slice(
        0,
        12,
      ),
      source: requiredString(row.source),
      warnings: jsonStrings(row.warnings_json),
      linkHistory: links.map((link) => ({
        linkType: requiredString(link.link_type),
        trackingRunId: stringValue(link.tracking_run_id),
        sessionId: stringValue(link.session_id),
        confidence:
          typeof link.confidence === "number" ? link.confidence : null,
        reasons: jsonStrings(link.reasons_json),
        createdAt: requiredString(link.created_at),
      })),
    };
  }

  filters(): DashboardFilters {
    const strings = (table: string, column: string): string[] =>
      this.#all(
        `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column}`,
      )
        .map((row) => stringValue(row.value))
        .filter((value): value is string => value !== null);
    const repositories = this.#all(
      "SELECT id, name, canonical_path FROM repositories ORDER BY name",
    ).map((row) => ({
      id: integer(row.id),
      name: requiredString(row.name),
      path:
        this.#options.privacyMode === "strict"
          ? null
          : redactHomePath(
              stringValue(row.canonical_path),
              this.#options.userHome,
            ),
    }));
    return {
      providers: strings("sessions", "provider"),
      models: strings("sessions", "model"),
      repositories,
      accountingStatuses: strings("sessions", "accounting_status"),
      frameworks: strings("test_runs", "framework"),
      outcomes: strings("test_runs", "outcome"),
      stages: strings("test_runs", "stage"),
      parserStatuses: strings("test_runs", "parser_status"),
      trackingStatuses: strings("tracking_runs", "status"),
      confidenceLevels: strings("tracking_runs", "link_confidence_level"),
    };
  }

  diagnostics(): DashboardDiagnostics {
    let quickCheck: string | null = null;
    let accountingWarningCount: number | null = null;
    let ambiguousSessionCount: number | null = null;
    let activeTrackingRunCount: number | null = null;
    let runningTestRunCount: number | null = null;
    let latestImport: DashboardOverview["latestImport"] = null;
    if (this.status === "ready") {
      const quick = this.#get("PRAGMA quick_check");
      quickCheck = quick === null ? null : stringValue(Object.values(quick)[0]);
      accountingWarningCount = integer(
        this.#get(
          "SELECT COUNT(*) AS count FROM sessions WHERE accounting_status <> 'verified'",
        )?.count,
      );
      ambiguousSessionCount = integer(
        this.#get(
          "SELECT COUNT(*) AS count FROM sessions WHERE accounting_method = 'ambiguous'",
        )?.count,
      );
      activeTrackingRunCount = integer(
        this.#get(
          "SELECT COUNT(*) AS count FROM tracking_runs WHERE status = 'active'",
        )?.count,
      );
      runningTestRunCount = integer(
        this.#get(
          "SELECT COUNT(*) AS count FROM test_runs WHERE status = 'running'",
        )?.count,
      );
      latestImport = this.latestImport();
    }
    const providerLogs = [
      {
        provider: "claude-code" as const,
        path: this.#options.claudeLogDirectory,
      },
      { provider: "codex" as const, path: this.#options.codexLogDirectory },
    ].map((entry) => {
      let readable = false;
      try {
        accessSync(entry.path, constants.R_OK);
        readable = true;
      } catch {
        readable = false;
      }
      return {
        provider: entry.provider,
        status: readable ? ("PASS" as const) : ("WARN" as const),
        path:
          this.#options.privacyMode === "strict"
            ? "<redacted>"
            : (redactHomePath(entry.path, this.#options.userHome) ??
              entry.path),
        readable,
      };
    });
    return {
      database: {
        status: this.status,
        path:
          this.#options.privacyMode === "strict"
            ? "<redacted>"
            : (redactHomePath(
                this.#options.databaseFile,
                this.#options.userHome,
              ) ?? this.#options.databaseFile),
        schemaVersion: this.schemaVersion,
        latestMigration: LATEST_MIGRATION_VERSION,
        foreignKeys: this.foreignKeys,
        queryOnly: this.queryOnly,
        quickCheck,
      },
      providerLogs,
      latestImport,
      accountingWarningCount,
      ambiguousSessionCount,
      activeTrackingRunCount,
      runningTestRunCount,
      privacyMode: this.#options.privacyMode,
      version: this.#options.version,
      suggestions: [
        "Run: agentledger doctor",
        "Run: agentledger import --provider codex",
      ],
    };
  }

  explainCriticalQueries(): Record<string, string[]> {
    const explain = (sql: string): string[] =>
      this.#all(`EXPLAIN QUERY PLAN ${sql}`).map((row) =>
        requiredString(row.detail),
      );
    return {
      sessionTrend: explain(
        "SELECT substr(started_at, 1, 10), SUM(input_tokens + output_tokens) FROM sessions WHERE started_at >= '2000-01-01T00:00:00.000Z' GROUP BY substr(started_at, 1, 10)",
      ),
      sessions: explain(
        "SELECT id FROM sessions WHERE started_at >= '2000-01-01T00:00:00.000Z' ORDER BY started_at DESC LIMIT 50",
      ),
      trackingRuns: explain(
        "SELECT id FROM tracking_runs WHERE started_at >= '2000-01-01T00:00:00.000Z' ORDER BY started_at DESC LIMIT 50",
      ),
      testRuns: explain(
        "SELECT id FROM test_runs WHERE started_at >= '2000-01-01T00:00:00.000Z' ORDER BY started_at DESC LIMIT 50",
      ),
    };
  }

  close(): void {
    this.#database?.close();
  }
}

const TRACKING_BASELINE_OUTCOME = `COALESCE(
  (SELECT outcome FROM test_runs tb WHERE tb.tracking_run_id = tr.id AND tb.stage = 'baseline' AND tb.status <> 'running' ORDER BY tb.started_at, tb.id LIMIT 1),
  (SELECT outcome FROM test_runs tb WHERE tb.tracking_run_id = tr.id AND tb.status <> 'running' ORDER BY tb.started_at, tb.id LIMIT 1)
)`;

const TRACKING_FINAL_OUTCOME = `COALESCE(
  (SELECT outcome FROM test_runs tf WHERE tf.tracking_run_id = tr.id AND tf.stage = 'final' AND tf.status <> 'running' ORDER BY tf.started_at DESC, tf.id DESC LIMIT 1),
  (SELECT outcome FROM test_runs tf WHERE tf.tracking_run_id = tr.id AND tf.status <> 'running' ORDER BY tf.started_at DESC, tf.id DESC LIMIT 1)
)`;

const TRACKING_SELECT = `SELECT tr.*, r.name AS repository_name,
  ss.branch AS start_branch, ss.head_commit AS start_head,
  ss.is_dirty AS start_dirty, es.head_commit AS end_head,
  es.is_dirty AS end_dirty,
  (SELECT COUNT(*) FROM test_runs tx WHERE tx.tracking_run_id = tr.id) AS test_count,
  (${TRACKING_BASELINE_OUTCOME}) AS baseline_outcome,
  (${TRACKING_FINAL_OUTCOME}) AS final_outcome
 FROM tracking_runs tr JOIN repositories r ON r.id = tr.repository_id
 JOIN git_snapshots ss ON ss.id = tr.start_snapshot_id
 LEFT JOIN git_snapshots es ON es.id = tr.end_snapshot_id`;
