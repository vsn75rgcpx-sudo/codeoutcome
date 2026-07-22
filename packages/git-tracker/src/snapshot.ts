import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  canonicalizePath,
  type CapturedGitSnapshot,
  type GitChangeArea,
  type GitChangeSummary,
  type GitChangeType,
  type GitFileStat,
  type GitPrivacyMode,
  type GitSnapshot,
  type GitSnapshotTrigger,
} from "@codeoutcome/shared";

export interface GitProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface GitProcessOptions {
  cwd?: string;
  maxOutputBytes?: number;
}

export type GitProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options?: GitProcessOptions,
) => Promise<GitProcessResult>;

export class NotGitRepositoryError extends Error {
  constructor() {
    super(
      "The current working directory is not inside a readable Git repository",
    );
    this.name = "NotGitRepositoryError";
  }
}

export const defaultGitProcessRunner: GitProcessRunner = (
  executable,
  arguments_,
  options = {},
) =>
  new Promise((resolve, reject) => {
    const maximum = options.maxOutputBytes ?? 64 * 1024 * 1024;
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maximum) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (outputExceeded) {
        reject(
          new Error("Git machine-readable output exceeded the safety limit"),
        );
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });

interface StatusEntry {
  path: string;
  previousPath: string | null;
  stagedCode: string;
  unstagedCode: string;
  unmerged: boolean;
  untracked: boolean;
}

interface NumstatValue {
  path: string;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
}

function decodeNullRecords(buffer: Buffer): string[] {
  const records = buffer.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

function remainderAfterFields(
  record: string,
  fieldCount: number,
): string | null {
  let offset = 0;
  for (let count = 0; count < fieldCount; count += 1) {
    const next = record.indexOf(" ", offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  return record.slice(offset);
}

function parseStatus(buffer: Buffer): StatusEntry[] {
  const records = decodeNullRecords(buffer);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("# ") || record.length === 0) continue;
    if (record.startsWith("? ")) {
      entries.push({
        path: record.slice(2),
        previousPath: null,
        stagedCode: ".",
        unstagedCode: ".",
        unmerged: false,
        untracked: true,
      });
      continue;
    }
    const kind = record[0];
    if (kind === "1") {
      const xy = record.slice(2, 4);
      const filePath = remainderAfterFields(record, 8);
      if (filePath !== null) {
        entries.push({
          path: filePath,
          previousPath: null,
          stagedCode: xy[0] ?? ".",
          unstagedCode: xy[1] ?? ".",
          unmerged: false,
          untracked: false,
        });
      }
      continue;
    }
    if (kind === "2") {
      const xy = record.slice(2, 4);
      const filePath = remainderAfterFields(record, 9);
      const previousPath = records[index + 1];
      if (filePath !== null && previousPath !== undefined) {
        entries.push({
          path: filePath,
          previousPath,
          stagedCode: xy[0] ?? ".",
          unstagedCode: xy[1] ?? ".",
          unmerged: false,
          untracked: false,
        });
        index += 1;
      }
      continue;
    }
    if (kind === "u") {
      const filePath = remainderAfterFields(record, 10);
      if (filePath !== null) {
        entries.push({
          path: filePath,
          previousPath: null,
          stagedCode: "U",
          unstagedCode: "U",
          unmerged: true,
          untracked: false,
        });
      }
    }
  }
  return entries;
}

function parseCount(value: string): number | null {
  if (value === "-") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseNumstat(buffer: Buffer): NumstatValue[] {
  const records = decodeNullRecords(buffer);
  const values: NumstatValue[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = parseCount(record.slice(0, firstTab));
    const deletions = parseCount(record.slice(firstTab + 1, secondTab));
    const inlinePath = record.slice(secondTab + 1);
    let previousPath: string | null = null;
    let filePath = inlinePath;
    if (inlinePath.length === 0) {
      previousPath = records[index + 1] ?? null;
      filePath = records[index + 2] ?? "";
      index += 2;
    }
    if (filePath.length === 0) continue;
    values.push({
      path: filePath,
      previousPath,
      additions,
      deletions,
      isBinary: additions === null || deletions === null,
    });
  }
  return values;
}

function changeType(code: string, fallback: GitChangeType): GitChangeType {
  switch (code) {
    case "A":
      return "added";
    case "M":
    case "T":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    default:
      return fallback;
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileStat(
  snapshotId: string,
  entry: StatusEntry,
  area: GitChangeArea,
  type: GitChangeType,
  numstat: NumstatValue | undefined,
  privacyMode: GitPrivacyMode,
): GitFileStat {
  return {
    id: randomUUID(),
    snapshotId,
    relativePath: privacyMode === "strict" ? null : entry.path,
    previousPath: privacyMode === "strict" ? null : entry.previousPath,
    changeType: type,
    area,
    additions: numstat?.additions ?? null,
    deletions: numstat?.deletions ?? null,
    isBinary: numstat?.isBinary ?? false,
    contentFingerprint: null,
    pathFingerprint: fingerprint(entry.path),
  };
}

function statsForEntries(
  snapshotId: string,
  entries: readonly StatusEntry[],
  staged: readonly NumstatValue[],
  unstaged: readonly NumstatValue[],
  privacyMode: GitPrivacyMode,
): GitFileStat[] {
  const stagedByPath = new Map(staged.map((value) => [value.path, value]));
  const unstagedByPath = new Map(unstaged.map((value) => [value.path, value]));
  const result: GitFileStat[] = [];
  for (const entry of entries) {
    if (entry.untracked) {
      result.push(
        fileStat(
          snapshotId,
          entry,
          "untracked",
          "untracked",
          undefined,
          privacyMode,
        ),
      );
      continue;
    }
    if (entry.unmerged) {
      result.push(
        fileStat(
          snapshotId,
          entry,
          "conflicted",
          "unmerged",
          undefined,
          privacyMode,
        ),
      );
      continue;
    }
    if (entry.stagedCode !== ".") {
      result.push(
        fileStat(
          snapshotId,
          entry,
          "staged",
          changeType(entry.stagedCode, "unknown"),
          stagedByPath.get(entry.path),
          privacyMode,
        ),
      );
    }
    if (entry.unstagedCode !== ".") {
      result.push(
        fileStat(
          snapshotId,
          entry,
          "unstaged",
          changeType(entry.unstagedCode, "unknown"),
          unstagedByPath.get(entry.path),
          privacyMode,
        ),
      );
    }
  }
  return result;
}

async function run(
  runner: GitProcessRunner,
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<GitProcessResult> {
  return runner("git", ["-C", workingDirectory, ...arguments_], {
    cwd: workingDirectory,
  });
}

function requiredResult(result: GitProcessResult, action: string): Buffer {
  if (result.exitCode !== 0) {
    throw new Error(`Git ${action} failed without exposing command output`);
  }
  return result.stdout;
}

function singleLine(buffer: Buffer): string | null {
  const value = buffer.toString("utf8").trim();
  return value.length === 0 ? null : (value.split("\n")[0] ?? null);
}

export interface CaptureGitSnapshotOptions {
  workingDirectory: string;
  trigger: GitSnapshotTrigger;
  privacyMode?: GitPrivacyMode;
  now?: () => Date;
  runner?: GitProcessRunner;
}

export async function captureGitSnapshot(
  options: CaptureGitSnapshotOptions,
): Promise<CapturedGitSnapshot> {
  const runner = options.runner ?? defaultGitProcessRunner;
  const rootResult = await run(runner, options.workingDirectory, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (rootResult.exitCode !== 0) throw new NotGitRepositoryError();
  const shownRoot = singleLine(rootResult.stdout);
  if (shownRoot === null) throw new NotGitRepositoryError();
  const repositoryPath = await canonicalizePath(shownRoot);
  const workingDirectory = await canonicalizePath(options.workingDirectory);
  const [status, staged, unstaged, head, branch, upstream, gitVersion] =
    await Promise.all([
      run(runner, repositoryPath, [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
      ]),
      run(runner, repositoryPath, [
        "diff",
        "--cached",
        "--numstat",
        "-z",
        "--",
      ]),
      run(runner, repositoryPath, ["diff", "--numstat", "-z", "--"]),
      run(runner, repositoryPath, ["rev-parse", "--verify", "HEAD"]),
      run(runner, repositoryPath, ["symbolic-ref", "--short", "HEAD"]),
      run(runner, repositoryPath, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ]),
      runner("git", ["--version"], { cwd: repositoryPath }),
    ]);
  const statusEntries = parseStatus(requiredResult(status, "status"));
  const snapshotId = randomUUID();
  const privacyMode = options.privacyMode ?? "git-metadata";
  const fileStats = statsForEntries(
    snapshotId,
    statusEntries,
    parseNumstat(requiredResult(staged, "staged numstat")),
    parseNumstat(requiredResult(unstaged, "unstaged numstat")),
    privacyMode,
  );
  const areas = (area: GitChangeArea): number =>
    new Set(
      fileStats
        .filter((stat) => stat.area === area)
        .map((stat) => stat.pathFingerprint),
    ).size;
  const upstreamCounts = singleLine(upstream.stdout)?.split(/\s+/) ?? [];
  const ahead = Number(upstreamCounts[0]);
  const behind = Number(upstreamCounts[1]);
  const headCommit = head.exitCode === 0 ? singleLine(head.stdout) : null;
  const branchName = branch.exitCode === 0 ? singleLine(branch.stdout) : null;
  return {
    id: snapshotId,
    repositoryPath,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    trigger: options.trigger,
    privacyMode,
    workingDirectory,
    headCommit,
    branch: branchName,
    isDetachedHead: headCommit !== null && branchName === null,
    isUnbornBranch: headCommit === null && branchName !== null,
    isDirty: fileStats.length > 0,
    stagedFileCount: areas("staged"),
    unstagedFileCount: areas("unstaged"),
    untrackedFileCount: areas("untracked"),
    conflictedFileCount: areas("conflicted"),
    aheadCount:
      upstream.exitCode === 0 && Number.isSafeInteger(ahead) ? ahead : null,
    behindCount:
      upstream.exitCode === 0 && Number.isSafeInteger(behind) ? behind : null,
    gitVersion:
      gitVersion.exitCode === 0
        ? (singleLine(gitVersion.stdout) ?? "unknown")
        : "unknown",
    fileStats,
  };
}

function summarizeStats(
  stats: readonly GitFileStat[],
): Pick<
  GitChangeSummary,
  "filesChanged" | "additions" | "deletions" | "binaryFiles" | "renamedFiles"
> {
  const unique = new Set(stats.map((stat) => stat.pathFingerprint));
  const overlappingAreas = unique.size !== stats.length;
  const numeric = stats.filter(
    (stat) => stat.additions !== null && stat.deletions !== null,
  );
  return {
    filesChanged: unique.size,
    additions:
      numeric.length === stats.length && !overlappingAreas
        ? numeric.reduce((sum, stat) => sum + (stat.additions ?? 0), 0)
        : null,
    deletions:
      numeric.length === stats.length && !overlappingAreas
        ? numeric.reduce((sum, stat) => sum + (stat.deletions ?? 0), 0)
        : null,
    binaryFiles: new Set(
      stats.filter((stat) => stat.isBinary).map((stat) => stat.pathFingerprint),
    ).size,
    renamedFiles: new Set(
      stats
        .filter((stat) => stat.changeType === "renamed")
        .map((stat) => stat.pathFingerprint),
    ).size,
  };
}

function rangeStats(
  snapshotId: string,
  values: readonly NumstatValue[],
): GitFileStat[] {
  return values.map((value) => ({
    id: randomUUID(),
    snapshotId,
    relativePath: value.path,
    previousPath: value.previousPath,
    changeType: value.previousPath === null ? "modified" : "renamed",
    area: "staged",
    additions: value.additions,
    deletions: value.deletions,
    isBinary: value.isBinary,
    contentFingerprint: null,
    pathFingerprint: fingerprint(value.path),
  }));
}

export async function compareGitSnapshots(
  start: GitSnapshot | CapturedGitSnapshot,
  end: GitSnapshot | CapturedGitSnapshot,
  runner: GitProcessRunner = defaultGitProcessRunner,
): Promise<GitChangeSummary> {
  const warnings: string[] = [];
  const branchChanged = start.branch !== end.branch;
  if (start.isDirty) warnings.push("baseline_dirty");
  if (branchChanged) warnings.push("branch_changed");
  let selected: GitFileStat[] | null = null;
  let attribution: GitChangeSummary["attribution"] = "unknown";
  let newCommit: boolean | null = false;

  if (
    start.headCommit !== null &&
    end.headCommit !== null &&
    start.headCommit !== end.headCommit
  ) {
    const ancestor = await run(runner, end.repositoryPath, [
      "merge-base",
      "--is-ancestor",
      start.headCommit,
      end.headCommit,
    ]);
    newCommit = ancestor.exitCode === 0;
    if (!newCommit) warnings.push("head_rewritten_or_rewound");
    const diff = await run(runner, end.repositoryPath, [
      "diff",
      "--numstat",
      "-z",
      start.headCommit,
      end.headCommit,
      "--",
    ]);
    if (diff.exitCode === 0) {
      selected = rangeStats(end.id, parseNumstat(diff.stdout));
      attribution = "committed_net_change";
    } else {
      warnings.push("commit_range_unavailable");
    }
  } else if (!start.isDirty && !branchChanged) {
    selected = end.fileStats;
    attribution = "observed_changes";
    if (
      new Set(end.fileStats.map((stat) => stat.pathFingerprint)).size !==
      end.fileStats.length
    ) {
      warnings.push("overlapping_staged_and_unstaged_changes");
    }
  }

  const totals =
    selected === null
      ? {
          filesChanged: null,
          additions: null,
          deletions: null,
          binaryFiles: null,
          renamedFiles: null,
        }
      : summarizeStats(selected);
  return {
    startHead: start.headCommit,
    endHead: end.headCommit,
    branchChanged,
    startDirty: start.isDirty,
    endDirty: end.isDirty,
    stagedFileCount: end.stagedFileCount,
    unstagedFileCount: end.unstagedFileCount,
    untrackedFileCount: end.untrackedFileCount,
    conflictedFileCount: end.conflictedFileCount,
    ...totals,
    newCommit,
    baselineDirty: start.isDirty,
    attribution,
    warnings,
  };
}

export function repositoryInputFromSnapshot(snapshot: CapturedGitSnapshot): {
  canonicalPath: string;
  name: string;
  remoteUrl: null;
} {
  return {
    canonicalPath: snapshot.repositoryPath,
    name: path.basename(snapshot.repositoryPath),
    remoteUrl: null,
  };
}
