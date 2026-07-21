import type {
  AccountingMethod,
  AccountingStatus,
  GitPrivacyMode,
  Provider,
  TestFramework,
  TestOutcome,
  TestParserStatus,
  TestStage,
  TrackingRunStatus,
} from "./index.js";

export const DASHBOARD_API_VERSION = "phase-4a-v1";
export const DASHBOARD_TOKEN_HEADER = "x-agentledger-dashboard-token";

export type TokenValue = string;
export type DashboardRange = "7d" | "30d" | "all";
export type SortOrder = "asc" | "desc";

export interface DashboardPagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface DashboardMeta {
  apiVersion: typeof DASHBOARD_API_VERSION;
  generatedAt: string;
  schemaVersion: number | null;
  privacyMode: GitPrivacyMode;
}

export interface DashboardEnvelope<T> {
  data: T;
  pagination: DashboardPagination | null;
  meta: DashboardMeta;
}

export interface DashboardApiError {
  code: string;
  message: string;
  suggestion: string | null;
}

export interface DashboardErrorEnvelope {
  data: null;
  pagination: null;
  meta: DashboardMeta;
  error: DashboardApiError;
}

export interface DashboardHealth {
  status: "ok" | "database_unavailable" | "schema_outdated";
  database: "ready" | "missing" | "locked" | "outdated" | "error";
  queryOnly: boolean;
}

export interface DashboardActivity {
  id: string;
  at: string;
  type: "session" | "tracking" | "test" | "git_snapshot";
  title: string;
  summary: string;
  status: string;
  href: string | null;
}

export interface DashboardTokenTrend {
  date: string;
  sessions: number;
  inputTokens: TokenValue;
  cachedInputTokens: TokenValue;
  uncachedInputTokens: TokenValue;
  outputTokens: TokenValue;
  totalTokens: TokenValue;
}

export interface DashboardDistribution {
  key: string;
  label: string;
  count: number;
}

export interface DashboardOverview {
  range: DashboardRange;
  latestImport: {
    provider: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
  } | null;
  totals: {
    sessions: number;
    sessionsLast7Days: number;
    inputTokens: TokenValue;
    cachedInputTokens: TokenValue;
    uncachedInputTokens: TokenValue;
    outputTokens: TokenValue;
    totalTokens: TokenValue;
    trackingRuns: number;
    trackingRunsWithGitChanges: number;
    observedChangedFiles: number | null;
    testRuns: number;
    passedTestRuns: number;
    failedTestRuns: number;
    unknownTestRuns: number;
    failingToPassingComparisons: number | null;
    unlinkedOrAmbiguousRecords: number;
  };
  pricing: { status: "unavailable"; label: "Pricing unavailable" };
  providerDistribution: DashboardDistribution[];
  modelDistribution: DashboardDistribution[];
  testOutcomeDistribution: DashboardDistribution[];
  tokenTrend: DashboardTokenTrend[];
  recentActivity: DashboardActivity[];
}

export interface DashboardSessionListItem {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  provider: Provider;
  model: string;
  repository: string | null;
  branch: string | null;
  inputTokens: TokenValue;
  cachedInputTokens: TokenValue;
  uncachedInputTokens: TokenValue;
  outputTokens: TokenValue;
  totalTokens: TokenValue;
  accountingMethod: AccountingMethod;
  accountingStatus: AccountingStatus;
  linkedTrackingRunCount: number;
}

export interface DashboardSessionDetail extends DashboardSessionListItem {
  lastUsageEventAt: string | null;
  accountingVersion: string;
  trackingRuns: DashboardTrackingRunListItem[];
  testRuns: DashboardTestRunListItem[];
  warnings: string[];
}

export interface DashboardTrackingRunListItem {
  id: string;
  label: string | null;
  provider: Provider;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  repository: string;
  branch: string | null;
  startHead: string | null;
  endHead: string | null;
  startDirty: boolean;
  endDirty: boolean | null;
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
  testRuns: number;
  baselineOutcome: TestOutcome | null;
  finalOutcome: TestOutcome | null;
  linkConfidence: number | null;
  linkConfidenceLevel: string | null;
  status: TrackingRunStatus;
  warnings: string[];
  hasGitChanges: boolean | null;
  linkedSessionId: string | null;
}

export interface DashboardGitSnapshot {
  id: string;
  capturedAt: string;
  trigger: string;
  headCommit: string | null;
  branch: string | null;
  dirty: boolean;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  conflictedFiles: number;
}

export interface DashboardGitAreaSummary {
  area: string;
  changeType: string;
  files: number;
  additions: number | null;
  deletions: number | null;
  binaryFiles: number;
}

export interface DashboardTimelineEvent {
  id: string;
  at: string;
  type:
    | "tracking_started"
    | "tracking_completed"
    | "tracking_recovered"
    | "tracking_abandoned"
    | "session_started"
    | "session_ended"
    | "git_snapshot"
    | "test_baseline"
    | "test_intermediate"
    | "test_final"
    | "test_unspecified";
  summary: string;
  status: string;
  href: string | null;
}

export interface DashboardTestComparison {
  baselineTestRunId: string | null;
  finalTestRunId: string | null;
  baselineSelection: string;
  finalSelection: string;
  baselineOutcome: TestOutcome | null;
  finalOutcome: TestOutcome | null;
  totalDelta: number | null;
  passedDelta: number | null;
  failedDelta: number | null;
  skippedDelta: number | null;
  durationDeltaMs: number | null;
  comparability: string;
  confidence: number | null;
  warnings: string[];
}

export interface DashboardTrackingRunDetail extends DashboardTrackingRunListItem {
  startSnapshot: DashboardGitSnapshot;
  endSnapshot: DashboardGitSnapshot | null;
  gitAreas: DashboardGitAreaSummary[];
  timeline: DashboardTimelineEvent[];
  comparison: DashboardTestComparison | null;
  linkedSession: DashboardSessionListItem | null;
  reasons: string[];
  tokenSummary: {
    inputTokens: TokenValue;
    cachedInputTokens: TokenValue;
    outputTokens: TokenValue;
    totalTokens: TokenValue;
  } | null;
}

export interface DashboardTestRunListItem {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  stage: TestStage;
  framework: TestFramework;
  outcome: TestOutcome;
  passedTests: number | null;
  failedTests: number | null;
  skippedTests: number | null;
  parserStatus: TestParserStatus;
  trackingRunId: string | null;
  sessionId: string | null;
  outputTruncated: boolean;
  status: string;
}

export interface DashboardTestRunDetail extends DashboardTestRunListItem {
  frameworkVersion: string | null;
  exitCode: number | null;
  terminationSignal: string | null;
  totalTests: number | null;
  todoTests: number | null;
  erroredTests: number | null;
  parserVersion: string;
  commandDisplay: string;
  commandFingerprintShort: string;
  source: string;
  warnings: string[];
  linkHistory: Array<{
    linkType: string;
    trackingRunId: string | null;
    sessionId: string | null;
    confidence: number | null;
    reasons: string[];
    createdAt: string;
  }>;
}

export interface DashboardDiagnostics {
  database: {
    status: "ready" | "missing" | "locked" | "outdated" | "error";
    path: string;
    schemaVersion: number | null;
    latestMigration: number;
    foreignKeys: boolean;
    queryOnly: boolean;
    quickCheck: string | null;
  };
  providerLogs: Array<{
    provider: Provider;
    status: "PASS" | "WARN";
    path: string;
    readable: boolean;
  }>;
  latestImport: DashboardOverview["latestImport"];
  accountingWarningCount: number | null;
  ambiguousSessionCount: number | null;
  activeTrackingRunCount: number | null;
  runningTestRunCount: number | null;
  privacyMode: GitPrivacyMode;
  version: string;
  suggestions: string[];
}

export interface DashboardFilters {
  providers: string[];
  models: string[];
  repositories: Array<{ id: number; name: string; path: string | null }>;
  accountingStatuses: string[];
  frameworks: string[];
  outcomes: string[];
  stages: string[];
  parserStatuses: string[];
  trackingStatuses: string[];
  confidenceLevels: string[];
}
