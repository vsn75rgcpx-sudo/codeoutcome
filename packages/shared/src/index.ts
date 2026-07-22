import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Provider = "claude-code" | "codex";
export type ProviderSelection = Provider | "all";
export type UsageEventType = "incremental" | "cumulative";
export type AccountingMethod =
  "cumulative_snapshot" | "incremental_events" | "ambiguous" | "unavailable";
export type AccountingStatus = "verified" | "warning" | "invalid";
export type AccountingRole =
  "cumulative_snapshot" | "incremental" | "informational";
export type GitPrivacyMode = "git-metadata" | "strict";
export type GitSnapshotTrigger =
  "tracking_start" | "tracking_end" | "manual" | "recovery";
export type GitChangeArea = "staged" | "unstaged" | "untracked" | "conflicted";
export type GitChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "untracked"
  | "unknown";
export type TrackingRunStatus =
  "active" | "completed" | "interrupted" | "failed" | "abandoned";
export type LinkConfidenceLevel = "high" | "medium" | "low" | "ambiguous";
export type SessionLinkMethod = "automatic" | "manual";
export type TestStage = "baseline" | "intermediate" | "final" | "unspecified";
export type TestFramework =
  "pytest" | "jest" | "vitest" | "junit" | "go" | "cargo" | "generic";
export type TestRunStatus =
  "running" | "completed" | "interrupted" | "failed_to_start" | "abandoned";
export type TestOutcome =
  "passed" | "failed" | "errored" | "interrupted" | "unknown";
export type TestParserStatus =
  | "parsed"
  | "partially_parsed"
  | "exit_code_only"
  | "unsupported"
  | "malformed";
export type TestRunSource = "wrapped_command" | "imported_report" | "manual";
export type TestLinkType = "auto" | "manual" | "unlink";
export type TestComparability =
  "comparable" | "partially_comparable" | "not_comparable";

export interface GitFileStat {
  id: string;
  snapshotId: string;
  relativePath: string | null;
  previousPath: string | null;
  changeType: GitChangeType;
  area: GitChangeArea;
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
  contentFingerprint: string | null;
  pathFingerprint: string;
}

export interface GitSnapshot {
  id: string;
  repositoryId: number;
  repositoryPath: string;
  capturedAt: string;
  trigger: GitSnapshotTrigger;
  privacyMode: GitPrivacyMode;
  workingDirectory: string;
  headCommit: string | null;
  branch: string | null;
  isDetachedHead: boolean;
  isUnbornBranch: boolean;
  isDirty: boolean;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  conflictedFileCount: number;
  aheadCount: number | null;
  behindCount: number | null;
  gitVersion: string;
  fileStats: GitFileStat[];
}

export type CapturedGitSnapshot = Omit<GitSnapshot, "repositoryId">;

export interface GitChangeSummary {
  startHead: string | null;
  endHead: string | null;
  branchChanged: boolean;
  startDirty: boolean;
  endDirty: boolean;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  conflictedFileCount: number;
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
  binaryFiles: number | null;
  renamedFiles: number | null;
  newCommit: boolean | null;
  baselineDirty: boolean;
  attribution: "observed_changes" | "committed_net_change" | "unknown";
  warnings: string[];
}

export interface TrackingRun {
  id: string;
  provider: Provider;
  label: string | null;
  workingDirectory: string;
  repositoryId: number;
  repositoryPath: string;
  repositoryName: string;
  startedAt: string;
  endedAt: string | null;
  status: TrackingRunStatus;
  startSnapshotId: string;
  endSnapshotId: string | null;
  linkedSessionId: string | null;
  linkConfidence: number | null;
  linkConfidenceLevel: LinkConfidenceLevel | null;
  linkMethod: SessionLinkMethod | null;
  linkReasons: string[];
  summary: GitChangeSummary | null;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionGitLink {
  id: string;
  sessionId: string;
  trackingRunId: string;
  repositoryId: number;
  confidenceScore: number;
  confidenceLevel: LinkConfidenceLevel;
  method: SessionLinkMethod;
  reasons: string[];
  createdAt: string;
  unlinkedAt: string | null;
  unlinkReason: string | null;
}

export interface TestRun {
  id: string;
  trackingRunId: string | null;
  sessionId: string | null;
  repositoryId: number | null;
  workingDirectory: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  stage: TestStage;
  framework: TestFramework;
  frameworkVersion: string | null;
  executable: string;
  commandDisplay: string;
  commandFingerprint: string;
  argumentCount: number;
  exitCode: number | null;
  terminationSignal: "SIGINT" | "SIGTERM" | null;
  status: TestRunStatus;
  outcome: TestOutcome;
  totalTests: number | null;
  passedTests: number | null;
  failedTests: number | null;
  skippedTests: number | null;
  todoTests: number | null;
  erroredTests: number | null;
  parserStatus: TestParserStatus;
  parserVersion: string;
  outputTruncated: boolean;
  source: TestRunSource;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TestReportImport {
  id: string;
  testRunId: string;
  format: string;
  canonicalPath: string;
  fileFingerprint: string;
  fileSize: number;
  importedAt: string;
  parserVersion: string;
  status: "imported" | "updated" | "unchanged";
  warning: string | null;
}

export interface TestRunLink {
  id: string;
  testRunId: string;
  trackingRunId: string | null;
  sessionId: string | null;
  linkType: TestLinkType;
  confidence: number | null;
  reasons: string[];
  createdAt: string;
}

export interface TestCountSummary {
  totalTests: number | null;
  passedTests: number | null;
  failedTests: number | null;
  skippedTests: number | null;
  todoTests: number | null;
  erroredTests: number | null;
}

export interface TestComparison {
  baseline: TestRun | null;
  final: TestRun | null;
  baselineSelection: "explicit" | "inferred" | "unavailable";
  finalSelection: "explicit" | "inferred" | "unavailable";
  comparability: TestComparability;
  comparisonConfidence: number | null;
  sameCommand: boolean | null;
  totalTestDelta: number | null;
  passedTestDelta: number | null;
  failedTestDelta: number | null;
  skippedTestDelta: number | null;
  durationDeltaMs: number | null;
  warnings: string[];
}

export interface TrackingTestSummary {
  testRunCount: number;
  failedRunCount: number;
  successfulRunCount: number;
  interruptedRunCount: number;
  firstSuccessAt: string | null;
  timeToFirstSuccessMs: number | null;
  failedRunsBeforeFirstSuccess: number | null;
  baselineOutcome: TestOutcome | null;
  finalOutcome: TestOutcome | null;
  failedTestDelta: number | null;
  passedTestDelta: number | null;
  durationDeltaMs: number | null;
  comparisonConfidence: number | null;
  framework: TestFramework | null;
  comparison: TestComparison | null;
  warnings: string[];
}

export interface Session {
  id: string;
  provider: Provider;
  providerSessionId: string;
  model: string;
  startedAt: string | null;
  endedAt: string | null;
  workingDirectory: string | null;
  repositoryPath: string | null;
  repositoryName: string | null;
  remoteUrl: string | null;
  branch: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  estimatedCost: number | null;
  accountingMethod: AccountingMethod;
  accountingStatus: AccountingStatus;
  accountingVersion: string;
  lastUsageEventAt: string | null;
  sourceFile: string;
  sourceFileHash: string;
  importedAt: string | null;
}

export interface UsageEvent {
  id: string;
  sessionId: string;
  sourceFile: string;
  sourceOffset: number;
  eventTime: string | null;
  eventType: UsageEventType;
  accountingRole: AccountingRole;
  isCanonical: boolean;
  providerEventId: string | null;
  snapshotSequence: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  reportedTotalTokens: number | null;
  hasNegativeValues: boolean;
  estimatedCost: number | null;
}

export interface ParseFileOptions {
  startOffset?: number;
  providerSessionIdHint?: string;
}

export interface ParsedLogFile {
  session: Session;
  usageEvents: UsageEvent[];
  processedBytes: number;
  fileSize: number;
  malformedLines: number;
  truncated: boolean;
  format: string;
}

export interface SessionAdapter {
  readonly provider: Provider;
  readonly logRoot: string;
  readonly supportedFormats: readonly string[];
  readonly formatSupport?: readonly ProviderFormatSupport[];
  discoverSourceFiles(): Promise<string[]>;
  parseFile(
    sourceFile: string,
    options?: ParseFileOptions,
  ): Promise<ParsedLogFile>;
}

export type ProviderFormatValidation =
  "local-log-validated" | "synthetic-fixtures-only";

export interface ProviderFormatSupport {
  id: string;
  description: string;
  validation: ProviderFormatValidation;
  recordMarkers: readonly string[];
  limitations: readonly string[];
}

export interface ParseWarning {
  provider: Provider;
  sourceFile: string | null;
  message: string;
}

export interface CollectionResult {
  sessions: Session[];
  warnings: ParseWarning[];
}

export interface JsonlRecordPosition {
  startOffset: number;
  endOffset: number;
}

export interface JsonlReadResult {
  processedBytes: number;
  fileSize: number;
  malformedLines: number;
  truncated: boolean;
}

export const DEFAULT_MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const FILE_CHECKPOINT_SAMPLE_BYTES = 64 * 1024;
const FILE_CHECKPOINT_SAMPLES = 8;
const FILE_CHECKPOINT_PREFIX = "sampled-v1";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonRecord;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return undefined;
}

export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}

export function updateTimestampBounds(
  currentStart: string | undefined,
  currentEnd: string | undefined,
  candidate: string | undefined,
): { start: string | undefined; end: string | undefined } {
  if (candidate === undefined) {
    return { start: currentStart, end: currentEnd };
  }

  return {
    start:
      currentStart === undefined || candidate < currentStart
        ? candidate
        : currentStart,
    end:
      currentEnd === undefined || candidate > currentEnd
        ? candidate
        : currentEnd,
  };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function canonicalizePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function discoverJsonlFiles(root: string): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const visitedDirectories = new Set<string>();
  const discovered = new Set<string>();

  async function visit(directory: string): Promise<void> {
    const canonicalDirectory = await realpath(directory);
    if (
      visitedDirectories.has(canonicalDirectory) ||
      !isWithinRoot(canonicalRoot, canonicalDirectory)
    ) {
      return;
    }
    visitedDirectories.add(canonicalDirectory);

    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(canonicalDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(entryPath);
        } catch {
          continue;
        }
        if (!isWithinRoot(canonicalRoot, target)) {
          continue;
        }
        const targetStat = await stat(target);
        if (targetStat.isDirectory()) {
          await visit(target);
        } else if (targetStat.isFile() && target.endsWith(".jsonl")) {
          discovered.add(target);
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        discovered.add(await realpath(entryPath));
      }
    }
  }

  await visit(canonicalRoot);
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function parseJsonRecord(
  line: Buffer,
):
  | { kind: "record"; record: JsonRecord }
  | { kind: "ignored" }
  | { kind: "invalid" } {
  const content = line.toString("utf8").replace(/\r$/, "");
  if (content.trim().length === 0) {
    return { kind: "ignored" };
  }

  try {
    const parsed: unknown = JSON.parse(content);
    const record = asRecord(parsed);
    return record === undefined
      ? { kind: "ignored" }
      : { kind: "record", record };
  } catch {
    return { kind: "invalid" };
  }
}

export async function streamJsonlRecords(
  sourceFile: string,
  startOffset: number,
  onRecord: (
    record: JsonRecord,
    position: JsonlRecordPosition,
  ) => void | Promise<void>,
  options: { maxLineBytes?: number } = {},
): Promise<JsonlReadResult> {
  const metadata = await stat(sourceFile);
  const fileSize = metadata.size;
  const safeStart =
    Number.isSafeInteger(startOffset) &&
    startOffset >= 0 &&
    startOffset <= fileSize
      ? startOffset
      : 0;

  if (safeStart === fileSize) {
    return {
      processedBytes: safeStart,
      fileSize,
      malformedLines: 0,
      truncated: false,
    };
  }

  const maximumLineBytes = Math.max(
    1,
    Math.trunc(options.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES),
  );
  const stream = createReadStream(sourceFile, {
    flags: "r",
    start: safeStart,
    end: fileSize - 1,
  });
  let lineSegments: Buffer[] = [];
  let lineBytes = 0;
  let bufferStart = safeStart;
  let processedBytes = safeStart;
  let malformedLines = 0;
  let discardingOversizedLine = false;
  let chunkStart = safeStart;

  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let cursor = 0;
    while (cursor < bytes.length) {
      const newlineIndex = bytes.indexOf(0x0a, cursor);
      const segmentEnd = newlineIndex < 0 ? bytes.length : newlineIndex;
      const segment = bytes.subarray(cursor, segmentEnd);
      if (!discardingOversizedLine) {
        if (lineBytes + segment.length > maximumLineBytes) {
          lineSegments = [];
          lineBytes = 0;
          discardingOversizedLine = true;
        } else if (segment.length > 0) {
          lineSegments.push(segment);
          lineBytes += segment.length;
        }
      }

      if (newlineIndex < 0) break;
      const endOffset = chunkStart + newlineIndex + 1;
      if (discardingOversizedLine) {
        malformedLines += 1;
      } else {
        const line =
          lineSegments.length === 1
            ? (lineSegments[0] ?? Buffer.alloc(0))
            : Buffer.concat(lineSegments, lineBytes);
        const parsed = parseJsonRecord(line);
        if (parsed.kind === "record") {
          await onRecord(parsed.record, {
            startOffset: bufferStart,
            endOffset,
          });
        } else if (parsed.kind === "invalid") {
          malformedLines += 1;
        }
      }
      processedBytes = endOffset;
      lineSegments = [];
      lineBytes = 0;
      bufferStart = endOffset;
      discardingOversizedLine = false;
      cursor = newlineIndex + 1;
    }
    chunkStart += bytes.length;
  }

  if (discardingOversizedLine) {
    return {
      processedBytes: fileSize,
      fileSize,
      malformedLines: malformedLines + 1,
      truncated: false,
    };
  }

  if (lineBytes === 0) {
    return { processedBytes, fileSize, malformedLines, truncated: false };
  }

  const trailing = parseJsonRecord(
    lineSegments.length === 1
      ? (lineSegments[0] ?? Buffer.alloc(0))
      : Buffer.concat(lineSegments, lineBytes),
  );
  if (trailing.kind === "record") {
    await onRecord(trailing.record, {
      startOffset: bufferStart,
      endOffset: fileSize,
    });
    processedBytes = fileSize;
  } else if (trailing.kind === "ignored") {
    processedBytes = fileSize;
  } else {
    return { processedBytes, fileSize, malformedLines, truncated: true };
  }

  return { processedBytes, fileSize, malformedLines, truncated: false };
}

async function hashFileRange(
  sourceFile: string,
  start: number,
  end: number,
): Promise<string> {
  const hash = createHash("sha256");
  if (end <= start) return hash.digest("hex");
  const stream = createReadStream(sourceFile, {
    flags: "r",
    start,
    end: end - 1,
  });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function createFileCheckpoint(
  sourceFile: string,
  byteLength?: number,
): Promise<string> {
  const metadata = await stat(sourceFile);
  const length =
    byteLength === undefined
      ? metadata.size
      : Math.max(0, Math.min(metadata.size, Math.trunc(byteLength)));
  const checkpoint = createHash("sha256");
  checkpoint.update(FILE_CHECKPOINT_PREFIX).update("\0").update(String(length));
  if (length === 0) {
    return `${FILE_CHECKPOINT_PREFIX}:0:${checkpoint.digest("hex")}`;
  }
  const sampleSize = Math.min(FILE_CHECKPOINT_SAMPLE_BYTES, length);
  const maximumStart = Math.max(0, length - sampleSize);
  const starts = new Set<number>();
  for (let index = 0; index < FILE_CHECKPOINT_SAMPLES; index += 1) {
    starts.add(
      Math.trunc((maximumStart * index) / (FILE_CHECKPOINT_SAMPLES - 1)),
    );
  }
  for (const start of [...starts].sort((left, right) => left - right)) {
    checkpoint
      .update("\0")
      .update(String(start))
      .update("\0")
      .update(await hashFileRange(sourceFile, start, start + sampleSize));
  }
  return `${FILE_CHECKPOINT_PREFIX}:${length}:${checkpoint.digest("hex")}`;
}

export async function matchesFileCheckpoint(
  sourceFile: string,
  byteLength: number,
  expected: string,
): Promise<boolean> {
  if (expected.startsWith(`${FILE_CHECKPOINT_PREFIX}:`)) {
    return (await createFileCheckpoint(sourceFile, byteLength)) === expected;
  }
  return (await hashFilePrefix(sourceFile, byteLength)) === expected;
}

export async function hashFilePrefix(
  sourceFile: string,
  byteLength?: number,
): Promise<string> {
  const metadata = await stat(sourceFile);
  const length =
    byteLength === undefined
      ? metadata.size
      : Math.max(0, Math.min(metadata.size, Math.trunc(byteLength)));
  const hash = createHash("sha256");
  if (length === 0) {
    return hash.digest("hex");
  }

  const stream = createReadStream(sourceFile, {
    flags: "r",
    start: 0,
    end: length - 1,
  });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export function stableSessionId(
  provider: Provider,
  providerSessionId: string,
): string {
  return createHash("sha256")
    .update(provider)
    .update("\0")
    .update(providerSessionId)
    .digest("hex");
}

export function fallbackProviderSessionId(
  provider: Provider,
  sourceFile: string,
): string {
  const digest = createHash("sha256")
    .update(provider)
    .update("\0")
    .update(path.resolve(sourceFile))
    .digest("hex");
  return `generated:${digest}`;
}

export function stableUsageEventId(
  provider: Provider,
  sourceFile: string,
  sourceOffset: number,
  discriminator: UsageEventType | AccountingRole,
): string {
  return createHash("sha256")
    .update(provider)
    .update("\0")
    .update(path.resolve(sourceFile))
    .update("\0")
    .update(String(sourceOffset))
    .update("\0")
    .update(discriminator)
    .digest("hex");
}

export function redactHomePath(
  candidate: string | null,
  userHome = homedir(),
): string | null {
  if (candidate === null) {
    return null;
  }
  const canonical = (value: string): string => {
    try {
      return realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(canonical(userHome), canonical(candidate));
  if (relative === "") {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join("~", relative);
  }
  return candidate;
}

export * from "./dashboard.js";
export * from "./version.js";
