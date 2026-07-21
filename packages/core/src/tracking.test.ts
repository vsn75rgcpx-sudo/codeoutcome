import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { SessionDatabase, type SourceImportInput } from "@agentledger/database";
import {
  stableSessionId,
  type Session,
  type UsageEvent,
} from "@agentledger/shared";

import {
  abandonTracking,
  manualLinkTrackingRun,
  startTracking,
  stopTracking,
  unlinkTrackingRun,
} from "./tracking.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execFileAsync("git", [...arguments_], { cwd });
}

async function fixture(): Promise<{
  directory: string;
  repository: string;
  database: SessionDatabase;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "agentledger-track-"));
  temporaryDirectories.push(directory);
  const repository = path.join(directory, "repository");
  await execFileAsync("mkdir", [repository]);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "AgentLedger Test"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "tracked.txt"), "initial\n", "utf8");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "-m", "initial"]);
  return {
    directory,
    repository: await realpath(repository),
    database: new SessionDatabase(path.join(directory, "agentledger.sqlite")),
  };
}

function importedSession(repository: string): SourceImportInput {
  const providerSessionId = "tracking-session";
  const session: Session = {
    id: stableSessionId("codex", providerSessionId),
    provider: "codex",
    providerSessionId,
    model: "fixture",
    startedAt: "2026-01-01T00:00:05.000Z",
    endedAt: "2026-01-01T00:09:55.000Z",
    workingDirectory: repository,
    repositoryPath: repository,
    repositoryName: path.basename(repository),
    remoteUrl: null,
    branch: "main",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    estimatedCost: null,
    accountingMethod: "unavailable",
    accountingStatus: "warning",
    accountingVersion: "fixture",
    lastUsageEventAt: null,
    sourceFile: path.join(repository, ".fixture-session.jsonl"),
    sourceFileHash: "hash",
    importedAt: "2026-01-01T00:10:00.000Z",
  };
  const event: UsageEvent = {
    id: "tracking-event",
    sessionId: session.id,
    sourceFile: session.sourceFile,
    sourceOffset: 0,
    eventTime: session.endedAt,
    eventType: "cumulative",
    accountingRole: "cumulative_snapshot",
    isCanonical: false,
    providerEventId: null,
    snapshotSequence: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    reasoningOutputTokens: 10,
    reportedTotalTokens: 120,
    hasNegativeValues: false,
    estimatedCost: null,
  };
  return {
    session,
    usageEvents: [event],
    repository: {
      canonicalPath: repository,
      name: path.basename(repository),
      remoteUrl: null,
    },
    fileSize: 1,
    fileMtimeMs: 1,
    processedBytes: 1,
    processedHash: "hash",
    sourceFileHash: "hash",
    format: "fixture",
    malformedLines: 0,
    truncated: false,
    resetSource: true,
    importedAt: "2026-01-01T00:10:00.000Z",
  };
}

describe("tracking lifecycle", () => {
  it("starts and stops a clean repository with zero observed changes", async () => {
    const { database, repository } = await fixture();
    const started = await startTracking({
      database,
      provider: "codex",
      workingDirectory: repository,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const stopped = await stopTracking({
      database,
      trackingRunId: started.id,
      now: () => new Date("2026-01-01T00:10:00.000Z"),
      importProviderLogs: false,
    });

    expect(stopped.run).toMatchObject({
      status: "completed",
      summary: {
        attribution: "observed_changes",
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
    });
    expect(stopped.startSnapshot.trigger).toBe("tracking_start");
    expect(stopped.endSnapshot.trigger).toBe("tracking_end");
    database.close();
  });

  it("rejects a second active run for the same canonical directory", async () => {
    const { database, repository } = await fixture();
    await startTracking({
      database,
      provider: "codex",
      workingDirectory: repository,
    });

    await expect(
      startTracking({
        database,
        provider: "claude-code",
        workingDirectory: path.join(repository, "."),
      }),
    ).rejects.toThrow("already exists");
    expect(database.activeTrackingRunCount()).toBe(1);
    database.close();
  });

  it("recovers an interrupted run with a recovery snapshot", async () => {
    const { database, repository } = await fixture();
    const started = await startTracking({
      database,
      provider: "codex",
      workingDirectory: repository,
    });
    const result = await stopTracking({
      database,
      trackingRunId: started.id,
      recovery: true,
      importProviderLogs: false,
    });

    expect(result.run.status).toBe("interrupted");
    expect(result.endSnapshot.trigger).toBe("recovery");
    expect(result.run.warnings).toContain("recovered_after_interruption");
    database.close();
  });

  it("abandons an active run without deleting its start snapshot", async () => {
    const { database, repository } = await fixture();
    const started = await startTracking({
      database,
      provider: "codex",
      workingDirectory: repository,
    });

    const abandoned = abandonTracking(database, started.id);
    expect(abandoned.status).toBe("abandoned");
    expect(database.getGitSnapshot(started.startSnapshotId)).not.toBeNull();
    expect(database.activeTrackingRunCount()).toBe(0);
    database.close();
  });

  it("automatically links one high-confidence imported session", async () => {
    const { database, repository } = await fixture();
    const imported = importedSession(repository);
    database.applySourceImport(imported);
    const started = await startTracking({
      database,
      provider: "codex",
      workingDirectory: repository,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = await stopTracking({
      database,
      trackingRunId: started.id,
      now: () => new Date("2026-01-01T00:10:00.000Z"),
      importProviderLogs: false,
    });

    expect(result.run).toMatchObject({
      linkedSessionId: imported.session.id,
      linkMethod: "automatic",
      linkConfidenceLevel: "high",
    });
    database.close();
  });

  it("preserves manual link and unlink history", async () => {
    const { database, repository } = await fixture();
    const imported = importedSession(repository);
    database.applySourceImport(imported);
    const started = await startTracking({
      database,
      provider: "claude-code",
      workingDirectory: repository,
    });
    await stopTracking({
      database,
      trackingRunId: started.id,
      importProviderLogs: false,
    });

    const linked = manualLinkTrackingRun(
      database,
      started.id,
      imported.session.id.slice(0, 12),
      () => new Date("2026-01-01T01:00:00.000Z"),
    );
    expect(linked.linkMethod).toBe("manual");
    const unlinked = unlinkTrackingRun(
      database,
      started.id,
      () => new Date("2026-01-01T01:01:00.000Z"),
    );
    expect(unlinked.linkedSessionId).toBeNull();
    manualLinkTrackingRun(
      database,
      started.id,
      imported.session.id,
      () => new Date("2026-01-01T01:02:00.000Z"),
    );
    const history = database.listSessionGitLinks(started.id);
    expect(history).toHaveLength(2);
    expect(history[1]?.unlinkedAt).not.toBeNull();
    expect(history[0]).toMatchObject({ method: "manual", unlinkedAt: null });
    database.close();
  });
});
