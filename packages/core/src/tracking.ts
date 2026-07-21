import { randomUUID } from "node:crypto";
import path from "node:path";

import type { SessionDatabase } from "@agentledger/database";
import {
  captureGitSnapshot,
  compareGitSnapshots,
  repositoryInputFromSnapshot,
  type GitProcessRunner,
} from "@agentledger/git-tracker";
import {
  canonicalizePath,
  type GitPrivacyMode,
  type GitSnapshot,
  type Provider,
  type TrackingRun,
  type TrackingRunStatus,
} from "@agentledger/shared";

import {
  scoreSessionLink,
  type SessionLinkDecision,
} from "./session-linking.js";

export interface TrackingServiceOptions {
  database: SessionDatabase;
  privacyMode?: GitPrivacyMode;
  now?: () => Date;
  gitRunner?: GitProcessRunner;
  importLatest?: (provider: Provider) => Promise<void>;
}

export interface StartTrackingOptions extends TrackingServiceOptions {
  provider: Provider;
  label?: string;
  workingDirectory?: string;
}

export interface StopTrackingOptions extends TrackingServiceOptions {
  trackingRunId?: string;
  workingDirectory?: string;
  status?: "completed" | "interrupted" | "failed";
  recovery?: boolean;
  importProviderLogs?: boolean;
}

export interface StopTrackingResult {
  run: TrackingRun;
  startSnapshot: GitSnapshot;
  endSnapshot: GitSnapshot;
  linkDecision: SessionLinkDecision;
}

function nowFunction(options: TrackingServiceOptions): () => Date {
  return options.now ?? (() => new Date());
}

async function canonicalWorkingDirectory(candidate?: string): Promise<string> {
  return canonicalizePath(candidate ?? process.cwd());
}

export async function startTracking(
  options: StartTrackingOptions,
): Promise<TrackingRun> {
  const workingDirectory = await canonicalWorkingDirectory(
    options.workingDirectory,
  );
  const existing = options.database.activeTrackingRun(workingDirectory);
  if (existing !== null) {
    throw new Error(
      `Active tracking run ${existing.id} already exists for this working directory`,
    );
  }
  const now = nowFunction(options);
  const snapshot = await captureGitSnapshot({
    workingDirectory,
    trigger: "tracking_start",
    privacyMode: options.privacyMode,
    now,
    runner: options.gitRunner,
  });
  return options.database.startTrackingRun({
    id: randomUUID(),
    provider: options.provider,
    label: options.label?.trim() || null,
    workingDirectory,
    repository: repositoryInputFromSnapshot(snapshot),
    startSnapshot: snapshot,
    startedAt: snapshot.capturedAt,
    createdAt: snapshot.capturedAt,
  });
}

async function resolveActiveRun(
  options: StopTrackingOptions,
): Promise<TrackingRun> {
  if (options.trackingRunId !== undefined) {
    const run = options.database.getTrackingRun(options.trackingRunId);
    if (run === null) throw new Error("Tracking run not found");
    if (run.status !== "active") {
      throw new Error(`Tracking run is not active (${run.status})`);
    }
    return run;
  }
  const workingDirectory = await canonicalWorkingDirectory(
    options.workingDirectory,
  );
  const run = options.database.activeTrackingRun(workingDirectory);
  if (run === null) {
    throw new Error("No active tracking run exists for this working directory");
  }
  return run;
}

export async function stopTracking(
  options: StopTrackingOptions,
): Promise<StopTrackingResult> {
  const run = await resolveActiveRun(options);
  const now = nowFunction(options);
  const startSnapshot = options.database.getGitSnapshot(run.startSnapshotId);
  if (startSnapshot === null) throw new Error("Start Git snapshot is missing");
  const endSnapshotDraft = await captureGitSnapshot({
    workingDirectory: run.workingDirectory,
    trigger: options.recovery === true ? "recovery" : "tracking_end",
    privacyMode: options.privacyMode ?? startSnapshot.privacyMode,
    now,
    runner: options.gitRunner,
  });
  const endForComparison: GitSnapshot = {
    ...endSnapshotDraft,
    repositoryId: run.repositoryId,
  };
  const summary = await compareGitSnapshots(
    startSnapshot,
    endForComparison,
    options.gitRunner,
  );
  const warnings = [...summary.warnings];
  if (options.recovery === true) warnings.push("recovered_after_interruption");
  if (
    options.importProviderLogs !== false &&
    options.importLatest !== undefined
  ) {
    try {
      await options.importLatest(run.provider);
    } catch {
      warnings.push("provider_log_import_failed_during_stop");
    }
  }
  const persisted = options.database.finishTrackingRun({
    trackingRunId: run.id,
    endSnapshot: endSnapshotDraft,
    endedAt: endSnapshotDraft.capturedAt,
    status:
      options.recovery === true
        ? "interrupted"
        : (options.status ?? "completed"),
    summary,
    warnings,
    updatedAt: endSnapshotDraft.capturedAt,
  });

  const sessions = options.database.listSessions({ provider: run.provider });
  const decision = scoreSessionLink(
    persisted,
    sessions,
    summary,
    startSnapshot.branch,
  );
  if (decision.sessionId !== null) {
    options.database.createSessionGitLink({
      id: randomUUID(),
      trackingRunId: run.id,
      sessionId: decision.sessionId,
      confidenceScore: decision.score,
      confidenceLevel: decision.confidenceLevel,
      method: "automatic",
      reasons: decision.reasons,
      createdAt: endSnapshotDraft.capturedAt,
    });
  } else {
    options.database.setTrackingLinkDecision(run.id, {
      confidenceScore: decision.score,
      confidenceLevel: decision.confidenceLevel,
      reasons: decision.reasons,
      updatedAt: endSnapshotDraft.capturedAt,
    });
  }
  const finalRun = options.database.getTrackingRun(run.id);
  if (finalRun === null) throw new Error("Completed tracking run is missing");
  options.database.backfillTestRunSessionLinks(
    finalRun.id,
    finalRun.linkedSessionId,
    endSnapshotDraft.capturedAt,
  );
  const endSnapshot = options.database.getGitSnapshot(endSnapshotDraft.id);
  if (endSnapshot === null) throw new Error("End Git snapshot is missing");
  return { run: finalRun, startSnapshot, endSnapshot, linkDecision: decision };
}

export async function captureManualSnapshot(
  options: TrackingServiceOptions & { workingDirectory?: string },
): Promise<GitSnapshot> {
  const workingDirectory = await canonicalWorkingDirectory(
    options.workingDirectory,
  );
  const snapshot = await captureGitSnapshot({
    workingDirectory,
    trigger: "manual",
    privacyMode: options.privacyMode,
    now: nowFunction(options),
    runner: options.gitRunner,
  });
  return options.database.saveGitSnapshot(
    snapshot,
    repositoryInputFromSnapshot(snapshot),
  );
}

export function abandonTracking(
  database: SessionDatabase,
  trackingRunId: string,
  now: () => Date = () => new Date(),
): TrackingRun {
  return database.abandonTrackingRun(trackingRunId, now().toISOString());
}

export function manualLinkTrackingRun(
  database: SessionDatabase,
  trackingRunId: string,
  requestedSessionId: string,
  now: () => Date = () => new Date(),
): TrackingRun {
  const matches = database
    .listSessions()
    .filter(
      (session) =>
        session.id === requestedSessionId ||
        session.providerSessionId === requestedSessionId ||
        session.id.startsWith(requestedSessionId) ||
        session.providerSessionId.startsWith(requestedSessionId),
    );
  if (matches.length === 0) throw new Error("Session not found");
  if (matches.length > 1) throw new Error("Session identifier is ambiguous");
  const session = matches[0]!;
  const run = database.getTrackingRun(trackingRunId);
  if (run === null) throw new Error("Tracking run not found");
  const createdAt = now().toISOString();
  database.createSessionGitLink({
    id: randomUUID(),
    trackingRunId,
    sessionId: session.id,
    confidenceScore: 1,
    confidenceLevel: "high",
    method: "manual",
    reasons: ["manually linked by user"],
    createdAt,
  });
  database.backfillTestRunSessionLinks(trackingRunId, session.id, createdAt);
  return database.getTrackingRun(trackingRunId)!;
}

export function unlinkTrackingRun(
  database: SessionDatabase,
  trackingRunId: string,
  now: () => Date = () => new Date(),
): TrackingRun {
  if (database.getTrackingRun(trackingRunId) === null) {
    throw new Error("Tracking run not found");
  }
  database.unlinkTrackingRun(trackingRunId, now().toISOString());
  return database.getTrackingRun(trackingRunId)!;
}

export function trackingDuration(run: TrackingRun): number | null {
  if (run.endedAt === null) return null;
  const start = new Date(run.startedAt).getTime();
  const end = new Date(run.endedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : null;
}

export function shortRepositoryName(run: TrackingRun): string {
  return run.repositoryName || path.basename(run.repositoryPath);
}

export type TerminalTrackingStatus = Exclude<
  TrackingRunStatus,
  "active" | "abandoned"
>;
