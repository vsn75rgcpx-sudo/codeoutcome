import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AccountingMethod,
  AccountingRole,
  AccountingStatus,
  CapturedGitSnapshot,
  GitChangeSummary,
  GitFileStat,
  GitSnapshot,
  LinkConfidenceLevel,
  Provider,
  ProviderSelection,
  Session,
  SessionGitLink,
  SessionLinkMethod,
  TrackingRun,
  TrackingRunStatus,
  UsageEvent,
  UsageEventType,
} from "@agentledger/shared";

import {
  LATEST_MIGRATION_VERSION,
  readAppliedMigrationVersion,
  runMigrations,
} from "./migrations.js";

export { LATEST_MIGRATION_VERSION } from "./migrations.js";
export { REPARSE_REQUIRED_CHECKPOINT } from "./migrations.js";

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

export interface SessionAccountingUpdate {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  estimatedCost: number | null;
  accountingMethod: AccountingMethod;
  accountingStatus: AccountingStatus;
  accountingVersion: string;
  lastUsageEventAt: string | null;
  canonicalEventIds: readonly string[];
}

export interface StartTrackingRunInput {
  id: string;
  provider: Provider;
  label: string | null;
  workingDirectory: string;
  repository: RepositoryInput;
  startSnapshot: CapturedGitSnapshot;
  startedAt: string;
  createdAt: string;
}

export interface FinishTrackingRunInput {
  trackingRunId: string;
  endSnapshot: CapturedGitSnapshot;
  endedAt: string;
  status: Exclude<TrackingRunStatus, "active" | "abandoned">;
  summary: GitChangeSummary;
  warnings: readonly string[];
  updatedAt: string;
}

export interface TrackingRunQuery {
  status?: TrackingRunStatus;
  since?: string;
  workingDirectory?: string;
  limit?: number;
}

export interface CreateSessionGitLinkInput {
  id: string;
  trackingRunId: string;
  sessionId: string;
  confidenceScore: number;
  confidenceLevel: LinkConfidenceLevel;
  method: SessionLinkMethod;
  reasons: readonly string[];
  createdAt: string;
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
  uncached_input_tokens: unknown;
  estimated_cost: unknown;
  accounting_method: unknown;
  accounting_status: unknown;
  accounting_version: unknown;
  last_usage_event_at: unknown;
  source_file: unknown;
  source_file_hash: unknown;
  imported_at: unknown;
}

interface UsageEventRow {
  id: unknown;
  session_id: unknown;
  event_time: unknown;
  event_type: unknown;
  accounting_role: unknown;
  is_canonical: unknown;
  provider_event_id: unknown;
  snapshot_sequence: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cached_input_tokens: unknown;
  reasoning_output_tokens: unknown;
  reported_total_tokens: unknown;
  has_negative_values: unknown;
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

interface GitSnapshotRow {
  id: unknown;
  repository_id: unknown;
  repository_path: unknown;
  captured_at: unknown;
  trigger: unknown;
  privacy_mode: unknown;
  working_directory: unknown;
  head_commit: unknown;
  branch: unknown;
  is_detached_head: unknown;
  is_unborn_branch: unknown;
  is_dirty: unknown;
  staged_file_count: unknown;
  unstaged_file_count: unknown;
  untracked_file_count: unknown;
  conflicted_file_count: unknown;
  ahead_count: unknown;
  behind_count: unknown;
  git_version: unknown;
}

interface GitFileStatRow {
  id: unknown;
  snapshot_id: unknown;
  relative_path: unknown;
  previous_path: unknown;
  change_type: unknown;
  area: unknown;
  additions: unknown;
  deletions: unknown;
  is_binary: unknown;
  content_fingerprint: unknown;
  path_fingerprint: unknown;
}

interface TrackingRunRow {
  id: unknown;
  provider: unknown;
  label: unknown;
  working_directory: unknown;
  repository_id: unknown;
  repository_path: unknown;
  repository_name: unknown;
  started_at: unknown;
  ended_at: unknown;
  status: unknown;
  start_snapshot_id: unknown;
  end_snapshot_id: unknown;
  linked_session_id: unknown;
  link_confidence: unknown;
  link_confidence_level: unknown;
  link_method: unknown;
  link_reasons_json: unknown;
  summary_json: unknown;
  warnings_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface SessionGitLinkRow {
  id: unknown;
  session_id: unknown;
  tracking_run_id: unknown;
  repository_id: unknown;
  confidence_score: unknown;
  confidence_level: unknown;
  method: unknown;
  reasons_json: unknown;
  created_at: unknown;
  unlinked_at: unknown;
  unlink_reason: unknown;
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

function accountingMethodFrom(value: unknown): AccountingMethod {
  if (
    value === "cumulative_snapshot" ||
    value === "incremental_events" ||
    value === "ambiguous" ||
    value === "unavailable"
  ) {
    return value;
  }
  return "unavailable";
}

function accountingStatusFrom(value: unknown): AccountingStatus {
  if (value === "verified" || value === "warning" || value === "invalid") {
    return value;
  }
  return "warning";
}

function accountingRoleFrom(value: unknown): AccountingRole {
  if (
    value === "cumulative_snapshot" ||
    value === "incremental" ||
    value === "informational"
  ) {
    return value;
  }
  return "informational";
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trackingStatusFrom(value: unknown): TrackingRunStatus {
  if (
    value === "active" ||
    value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "abandoned"
  ) {
    return value;
  }
  throw new Error(`Unsupported tracking status: ${String(value)}`);
}

function confidenceLevelFrom(value: unknown): LinkConfidenceLevel | null {
  return value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "ambiguous"
    ? value
    : null;
}

function linkMethodFrom(value: unknown): SessionLinkMethod | null {
  return value === "automatic" || value === "manual" ? value : null;
}

function stringArrayFromJson(value: unknown): string[] {
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

function summaryFromJson(value: unknown): GitChangeSummary | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const attribution =
      row.attribution === "observed_changes" ||
      row.attribution === "committed_net_change"
        ? row.attribution
        : "unknown";
    return {
      startHead: nullableString(row.startHead),
      endHead: nullableString(row.endHead),
      branchChanged: row.branchChanged === true,
      startDirty: row.startDirty === true,
      endDirty: row.endDirty === true,
      stagedFileCount: safeNumber(row.stagedFileCount),
      unstagedFileCount: safeNumber(row.unstagedFileCount),
      untrackedFileCount: safeNumber(row.untrackedFileCount),
      conflictedFileCount: safeNumber(row.conflictedFileCount),
      filesChanged: nullableNumber(row.filesChanged),
      additions: nullableNumber(row.additions),
      deletions: nullableNumber(row.deletions),
      binaryFiles: nullableNumber(row.binaryFiles),
      renamedFiles: nullableNumber(row.renamedFiles),
      newCommit: typeof row.newCommit === "boolean" ? row.newCommit : null,
      baselineDirty: row.baselineDirty === true,
      attribution,
      warnings: Array.isArray(row.warnings)
        ? row.warnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

function gitChangeTypeFrom(value: unknown): GitFileStat["changeType"] {
  if (
    value === "added" ||
    value === "modified" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "copied" ||
    value === "unmerged" ||
    value === "untracked" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function gitChangeAreaFrom(value: unknown): GitFileStat["area"] {
  if (
    value === "staged" ||
    value === "unstaged" ||
    value === "untracked" ||
    value === "conflicted"
  ) {
    return value;
  }
  return "unstaged";
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

function sessionFromRow(row: SessionRow): Session {
  return {
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
    uncachedInputTokens: safeNumber(row.uncached_input_tokens),
    estimatedCost:
      row.estimated_cost === null ? null : safeNumber(row.estimated_cost),
    accountingMethod: accountingMethodFrom(row.accounting_method),
    accountingStatus: accountingStatusFrom(row.accounting_status),
    accountingVersion: requiredString(row.accounting_version, "legacy-unknown"),
    lastUsageEventAt: nullableString(row.last_usage_event_at),
    sourceFile: requiredString(row.source_file, "unknown"),
    sourceFileHash: requiredString(row.source_file_hash, ""),
    importedAt: nullableString(row.imported_at),
  };
}

function gitFileStatFromRow(row: GitFileStatRow): GitFileStat {
  return {
    id: requiredString(row.id, ""),
    snapshotId: requiredString(row.snapshot_id, ""),
    relativePath: nullableString(row.relative_path),
    previousPath: nullableString(row.previous_path),
    changeType: gitChangeTypeFrom(row.change_type),
    area: gitChangeAreaFrom(row.area),
    additions: nullableNumber(row.additions),
    deletions: nullableNumber(row.deletions),
    isBinary: safeNumber(row.is_binary) === 1,
    contentFingerprint: nullableString(row.content_fingerprint),
    pathFingerprint: requiredString(row.path_fingerprint, ""),
  };
}

function snapshotFromRow(
  row: GitSnapshotRow,
  fileStats: GitFileStat[],
): GitSnapshot {
  const trigger =
    row.trigger === "tracking_start" ||
    row.trigger === "tracking_end" ||
    row.trigger === "manual" ||
    row.trigger === "recovery"
      ? row.trigger
      : "manual";
  return {
    id: requiredString(row.id, ""),
    repositoryId: safeNumber(row.repository_id),
    repositoryPath: requiredString(row.repository_path, ""),
    capturedAt: requiredString(row.captured_at, ""),
    trigger,
    privacyMode: row.privacy_mode === "strict" ? "strict" : "git-metadata",
    workingDirectory: requiredString(row.working_directory, ""),
    headCommit: nullableString(row.head_commit),
    branch: nullableString(row.branch),
    isDetachedHead: safeNumber(row.is_detached_head) === 1,
    isUnbornBranch: safeNumber(row.is_unborn_branch) === 1,
    isDirty: safeNumber(row.is_dirty) === 1,
    stagedFileCount: safeNumber(row.staged_file_count),
    unstagedFileCount: safeNumber(row.unstaged_file_count),
    untrackedFileCount: safeNumber(row.untracked_file_count),
    conflictedFileCount: safeNumber(row.conflicted_file_count),
    aheadCount: nullableNumber(row.ahead_count),
    behindCount: nullableNumber(row.behind_count),
    gitVersion: requiredString(row.git_version, "unknown"),
    fileStats,
  };
}

function trackingRunFromRow(row: TrackingRunRow): TrackingRun {
  return {
    id: requiredString(row.id, ""),
    provider: providerFrom(row.provider),
    label: nullableString(row.label),
    workingDirectory: requiredString(row.working_directory, ""),
    repositoryId: safeNumber(row.repository_id),
    repositoryPath: requiredString(row.repository_path, ""),
    repositoryName: requiredString(row.repository_name, "unknown"),
    startedAt: requiredString(row.started_at, ""),
    endedAt: nullableString(row.ended_at),
    status: trackingStatusFrom(row.status),
    startSnapshotId: requiredString(row.start_snapshot_id, ""),
    endSnapshotId: nullableString(row.end_snapshot_id),
    linkedSessionId: nullableString(row.linked_session_id),
    linkConfidence: nullableNumber(row.link_confidence),
    linkConfidenceLevel: confidenceLevelFrom(row.link_confidence_level),
    linkMethod: linkMethodFrom(row.link_method),
    linkReasons: stringArrayFromJson(row.link_reasons_json),
    summary: summaryFromJson(row.summary_json),
    warnings: stringArrayFromJson(row.warnings_json),
    createdAt: requiredString(row.created_at, ""),
    updatedAt: requiredString(row.updated_at, ""),
  };
}

function sessionGitLinkFromRow(row: SessionGitLinkRow): SessionGitLink {
  const confidenceLevel = confidenceLevelFrom(row.confidence_level);
  const method = linkMethodFrom(row.method);
  if (confidenceLevel === null || method === null) {
    throw new Error("Invalid session Git link row");
  }
  return {
    id: requiredString(row.id, ""),
    sessionId: requiredString(row.session_id, ""),
    trackingRunId: requiredString(row.tracking_run_id, ""),
    repositoryId: safeNumber(row.repository_id),
    confidenceScore: safeNumber(row.confidence_score),
    confidenceLevel,
    method,
    reasons: stringArrayFromJson(row.reasons_json),
    createdAt: requiredString(row.created_at, ""),
    unlinkedAt: nullableString(row.unlinked_at),
    unlinkReason: nullableString(row.unlink_reason),
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
          : `ready; database will be created by the first writable command (${databaseFile})`,
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
          source_file, source_offset, accounting_role, is_canonical,
          provider_event_id, snapshot_sequence, reasoning_output_tokens,
          reported_total_tokens, has_negative_values
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
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
          event.accountingRole,
          event.isCanonical ? 1 : 0,
          event.providerEventId,
          event.snapshotSequence,
          event.reasoningOutputTokens,
          event.reportedTotalTokens,
          event.hasNegativeValues ? 1 : 0,
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
      accountingRole: accountingRoleFrom(row.accounting_role),
      isCanonical: safeNumber(row.is_canonical) === 1,
      providerEventId: nullableString(row.provider_event_id),
      snapshotSequence:
        row.snapshot_sequence === null
          ? null
          : safeNumber(row.snapshot_sequence),
      inputTokens: safeNumber(row.input_tokens),
      outputTokens: safeNumber(row.output_tokens),
      cachedInputTokens: safeNumber(row.cached_input_tokens),
      reasoningOutputTokens: safeNumber(row.reasoning_output_tokens),
      reportedTotalTokens:
        row.reported_total_tokens === null
          ? null
          : safeNumber(row.reported_total_tokens),
      hasNegativeValues: safeNumber(row.has_negative_values) === 1,
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

  applyUsageReconciliation(updates: readonly SessionAccountingUpdate[]): void {
    this.#assertWritable("applyUsageReconciliation");
    const clearCanonical = this.#database.prepare(
      "UPDATE usage_events SET is_canonical = 0 WHERE session_id = ?",
    );
    const markCanonical = this.#database.prepare(
      "UPDATE usage_events SET is_canonical = 1 WHERE session_id = ? AND id = ?",
    );
    const updateSession = this.#database.prepare(`
      UPDATE sessions SET
        input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
        uncached_input_tokens = ?, estimated_cost = ?,
        accounting_method = ?, accounting_status = ?, accounting_version = ?,
        last_usage_event_at = ?
      WHERE id = ?
    `);

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const update of updates) {
        clearCanonical.run(update.sessionId);
        for (const eventId of update.canonicalEventIds) {
          markCanonical.run(update.sessionId, eventId);
        }
        updateSession.run(
          update.inputTokens,
          update.outputTokens,
          update.cachedInputTokens,
          update.uncachedInputTokens,
          update.estimatedCost,
          update.accountingMethod,
          update.accountingStatus,
          update.accountingVersion,
          update.lastUsageEventAt,
          update.sessionId,
        );
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getSession(sessionId: string): Session | null {
    const row = this.#database
      .prepare(
        `
        SELECT s.*, r.name AS repository_name, r.remote_url AS remote_url
        FROM sessions s
        LEFT JOIN repositories r ON r.id = s.repository_id
        WHERE s.id = ?
      `,
      )
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? null : sessionFromRow(row);
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

    return rows.map(sessionFromRow);
  }

  #insertGitSnapshot(
    snapshot: CapturedGitSnapshot,
    repositoryId: number,
  ): GitSnapshot {
    this.#database
      .prepare(
        `
        INSERT INTO git_snapshots (
          id, repository_id, captured_at, trigger, privacy_mode,
          working_directory, head_commit, branch, is_detached_head,
          is_unborn_branch, is_dirty, staged_file_count,
          unstaged_file_count, untracked_file_count, conflicted_file_count,
          ahead_count, behind_count, git_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        snapshot.id,
        repositoryId,
        snapshot.capturedAt,
        snapshot.trigger,
        snapshot.privacyMode,
        snapshot.workingDirectory,
        snapshot.headCommit,
        snapshot.branch,
        snapshot.isDetachedHead ? 1 : 0,
        snapshot.isUnbornBranch ? 1 : 0,
        snapshot.isDirty ? 1 : 0,
        snapshot.stagedFileCount,
        snapshot.unstagedFileCount,
        snapshot.untrackedFileCount,
        snapshot.conflictedFileCount,
        snapshot.aheadCount,
        snapshot.behindCount,
        snapshot.gitVersion,
      );
    const insertStat = this.#database.prepare(`
      INSERT INTO git_file_stats (
        id, snapshot_id, relative_path, previous_path, change_type, area,
        additions, deletions, is_binary, content_fingerprint, path_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const stat of snapshot.fileStats) {
      insertStat.run(
        stat.id,
        snapshot.id,
        stat.relativePath,
        stat.previousPath,
        stat.changeType,
        stat.area,
        stat.additions,
        stat.deletions,
        stat.isBinary ? 1 : 0,
        stat.contentFingerprint,
        stat.pathFingerprint,
      );
    }
    return { ...snapshot, repositoryId };
  }

  saveGitSnapshot(
    snapshot: CapturedGitSnapshot,
    repository: RepositoryInput,
  ): GitSnapshot {
    this.#assertWritable("saveGitSnapshot");
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const repositoryId = this.upsertRepository(
        repository,
        snapshot.capturedAt,
      );
      const stored = this.#insertGitSnapshot(snapshot, repositoryId);
      this.#database.exec("COMMIT;");
      return stored;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  startTrackingRun(input: StartTrackingRunInput): TrackingRun {
    this.#assertWritable("startTrackingRun");
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const repositoryId = this.upsertRepository(
        input.repository,
        input.createdAt,
      );
      this.#insertGitSnapshot(input.startSnapshot, repositoryId);
      this.#database
        .prepare(
          `
          INSERT INTO tracking_runs (
            id, provider, label, working_directory, repository_id,
            started_at, status, start_snapshot_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `,
        )
        .run(
          input.id,
          input.provider,
          input.label,
          input.workingDirectory,
          repositoryId,
          input.startedAt,
          input.startSnapshot.id,
          input.createdAt,
          input.createdAt,
        );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      if (
        error instanceof Error &&
        error.message.includes("tracking_runs_one_active_directory_idx")
      ) {
        throw new Error(
          `An active tracking run already exists for ${input.workingDirectory}`,
        );
      }
      throw error;
    }
    const run = this.getTrackingRun(input.id);
    if (run === null) throw new Error("Tracking run insert failed");
    return run;
  }

  finishTrackingRun(input: FinishTrackingRunInput): TrackingRun {
    this.#assertWritable("finishTrackingRun");
    const current = this.getTrackingRun(input.trackingRunId);
    if (current === null) throw new Error("Tracking run not found");
    if (current.status !== "active") {
      throw new Error(`Tracking run is not active (${current.status})`);
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#insertGitSnapshot(input.endSnapshot, current.repositoryId);
      this.#database
        .prepare(
          `
          UPDATE tracking_runs SET
            ended_at = ?, status = ?, end_snapshot_id = ?, summary_json = ?,
            warnings_json = ?, updated_at = ?
          WHERE id = ? AND status = 'active'
        `,
        )
        .run(
          input.endedAt,
          input.status,
          input.endSnapshot.id,
          JSON.stringify(input.summary),
          JSON.stringify(input.warnings),
          input.updatedAt,
          input.trackingRunId,
        );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getTrackingRun(input.trackingRunId)!;
  }

  abandonTrackingRun(
    trackingRunId: string,
    updatedAt: string,
    warning = "tracking_run_abandoned_by_user",
  ): TrackingRun {
    this.#assertWritable("abandonTrackingRun");
    const result = this.#database
      .prepare(
        `
        UPDATE tracking_runs SET status = 'abandoned', warnings_json = ?,
          updated_at = ? WHERE id = ? AND status = 'active'
      `,
      )
      .run(JSON.stringify([warning]), updatedAt, trackingRunId);
    if (result.changes !== 1) {
      throw new Error("Active tracking run not found");
    }
    return this.getTrackingRun(trackingRunId)!;
  }

  getGitSnapshot(snapshotId: string): GitSnapshot | null {
    const row = this.#database
      .prepare(
        `
        SELECT g.*, r.canonical_path AS repository_path
        FROM git_snapshots g
        JOIN repositories r ON r.id = g.repository_id
        WHERE g.id = ?
      `,
      )
      .get(snapshotId) as GitSnapshotRow | undefined;
    if (row === undefined) return null;
    const stats = this.#database
      .prepare(
        "SELECT * FROM git_file_stats WHERE snapshot_id = ? ORDER BY area, path_fingerprint",
      )
      .all(snapshotId) as unknown as GitFileStatRow[];
    return snapshotFromRow(row, stats.map(gitFileStatFromRow));
  }

  listGitSnapshots(limit = 20): GitSnapshot[] {
    const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const rows = this.#database
      .prepare(
        `
        SELECT g.*, r.canonical_path AS repository_path
        FROM git_snapshots g
        JOIN repositories r ON r.id = g.repository_id
        ORDER BY g.captured_at DESC LIMIT ?
      `,
      )
      .all(safeLimit) as unknown as GitSnapshotRow[];
    return rows.map((row) => {
      const id = requiredString(row.id, "");
      const stats = this.#database
        .prepare(
          "SELECT * FROM git_file_stats WHERE snapshot_id = ? ORDER BY area, path_fingerprint",
        )
        .all(id) as unknown as GitFileStatRow[];
      return snapshotFromRow(row, stats.map(gitFileStatFromRow));
    });
  }

  getTrackingRun(trackingRunId: string): TrackingRun | null {
    const row = this.#database
      .prepare(
        `
        SELECT t.*, r.canonical_path AS repository_path,
          r.name AS repository_name
        FROM tracking_runs t
        JOIN repositories r ON r.id = t.repository_id
        WHERE t.id = ?
      `,
      )
      .get(trackingRunId) as TrackingRunRow | undefined;
    return row === undefined ? null : trackingRunFromRow(row);
  }

  listTrackingRuns(query: TrackingRunQuery = {}): TrackingRun[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.status !== undefined) {
      conditions.push("t.status = ?");
      parameters.push(query.status);
    }
    if (query.since !== undefined) {
      conditions.push("t.started_at >= ?");
      parameters.push(query.since);
    }
    if (query.workingDirectory !== undefined) {
      conditions.push("t.working_directory = ?");
      parameters.push(query.workingDirectory);
    }
    const limit = Math.max(1, Math.min(10_000, Math.trunc(query.limit ?? 100)));
    parameters.push(limit);
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#database
      .prepare(
        `
        SELECT t.*, r.canonical_path AS repository_path,
          r.name AS repository_name
        FROM tracking_runs t
        JOIN repositories r ON r.id = t.repository_id
        ${where}
        ORDER BY t.started_at DESC LIMIT ?
      `,
      )
      .all(...parameters) as unknown as TrackingRunRow[];
    return rows.map(trackingRunFromRow);
  }

  activeTrackingRun(workingDirectory?: string): TrackingRun | null {
    return (
      this.listTrackingRuns({
        status: "active",
        workingDirectory,
        limit: 1,
      })[0] ?? null
    );
  }

  activeTrackingRunCount(): number {
    const row = this.#database
      .prepare(
        "SELECT COUNT(*) AS count FROM tracking_runs WHERE status = 'active'",
      )
      .get() as { count?: unknown } | undefined;
    return safeNumber(row?.count);
  }

  setTrackingLinkDecision(
    trackingRunId: string,
    decision: {
      confidenceScore: number;
      confidenceLevel: LinkConfidenceLevel;
      reasons: readonly string[];
      updatedAt: string;
    },
  ): void {
    this.#assertWritable("setTrackingLinkDecision");
    this.#database
      .prepare(
        `
        UPDATE tracking_runs SET linked_session_id = NULL,
          link_confidence = ?, link_confidence_level = ?, link_method = NULL,
          link_reasons_json = ?, updated_at = ? WHERE id = ?
      `,
      )
      .run(
        decision.confidenceScore,
        decision.confidenceLevel,
        JSON.stringify(decision.reasons),
        decision.updatedAt,
        trackingRunId,
      );
  }

  createSessionGitLink(input: CreateSessionGitLinkInput): SessionGitLink {
    this.#assertWritable("createSessionGitLink");
    const run = this.getTrackingRun(input.trackingRunId);
    if (run === null) throw new Error("Tracking run not found");
    if (!this.sessionExists(input.sessionId))
      throw new Error("Session not found");
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare(
          `
          UPDATE session_git_links SET unlinked_at = ?,
            unlink_reason = 'superseded_by_new_link'
          WHERE tracking_run_id = ? AND unlinked_at IS NULL
        `,
        )
        .run(input.createdAt, input.trackingRunId);
      this.#database
        .prepare(
          `
          INSERT INTO session_git_links (
            id, session_id, tracking_run_id, repository_id,
            confidence_score, confidence_level, method, reasons_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.id,
          input.sessionId,
          input.trackingRunId,
          run.repositoryId,
          input.confidenceScore,
          input.confidenceLevel,
          input.method,
          JSON.stringify(input.reasons),
          input.createdAt,
        );
      this.#database
        .prepare(
          `
          UPDATE tracking_runs SET linked_session_id = ?, link_confidence = ?,
            link_confidence_level = ?, link_method = ?, link_reasons_json = ?,
            updated_at = ? WHERE id = ?
        `,
        )
        .run(
          input.sessionId,
          input.confidenceScore,
          input.confidenceLevel,
          input.method,
          JSON.stringify(input.reasons),
          input.createdAt,
          input.trackingRunId,
        );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.listSessionGitLinks(input.trackingRunId)[0]!;
  }

  unlinkTrackingRun(
    trackingRunId: string,
    unlinkedAt: string,
    reason = "manual_unlink",
  ): void {
    this.#assertWritable("unlinkTrackingRun");
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare(
          `
          UPDATE session_git_links SET unlinked_at = ?, unlink_reason = ?
          WHERE tracking_run_id = ? AND unlinked_at IS NULL
        `,
        )
        .run(unlinkedAt, reason, trackingRunId);
      this.#database
        .prepare(
          `
          UPDATE tracking_runs SET linked_session_id = NULL,
            link_confidence = NULL, link_confidence_level = NULL,
            link_method = NULL, link_reasons_json = '[]', updated_at = ?
          WHERE id = ?
        `,
        )
        .run(unlinkedAt, trackingRunId);
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listSessionGitLinks(trackingRunId: string): SessionGitLink[] {
    const rows = this.#database
      .prepare(
        `
        SELECT * FROM session_git_links WHERE tracking_run_id = ?
        ORDER BY created_at DESC
      `,
      )
      .all(trackingRunId) as unknown as SessionGitLinkRow[];
    return rows.map(sessionGitLinkFromRow);
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
