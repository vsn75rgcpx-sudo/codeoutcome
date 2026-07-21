import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionDatabase } from "@agentledger/database";
import {
  stableSessionId,
  type Session,
  type UsageEvent,
} from "@agentledger/shared";

import { reconcileUsage } from "./reconciliation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databaseFixture(): Promise<{
  database: SessionDatabase;
  sessionId: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentledger-reconcile-"),
  );
  temporaryDirectories.push(directory);
  const database = new SessionDatabase(path.join(directory, "test.sqlite"));
  const providerSessionId = "reconcile-fixture";
  const sessionId = stableSessionId("codex", providerSessionId);
  const sourceFile = path.join(directory, "synthetic.jsonl");
  const session: Session = {
    id: sessionId,
    provider: "codex",
    providerSessionId,
    model: "unknown-test-model",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    workingDirectory: null,
    repositoryPath: null,
    repositoryName: null,
    remoteUrl: null,
    branch: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    estimatedCost: null,
    accountingMethod: "unavailable",
    accountingStatus: "warning",
    accountingVersion: "fixture",
    lastUsageEventAt: null,
    sourceFile,
    sourceFileHash: "fixture",
    importedAt: "2026-01-01T00:02:00.000Z",
  };
  const usageEvent: UsageEvent = {
    id: "reconcile-event",
    sessionId,
    sourceFile,
    sourceOffset: 10,
    eventTime: "2026-01-01T00:01:00.000Z",
    eventType: "cumulative",
    accountingRole: "cumulative_snapshot",
    isCanonical: false,
    providerEventId: "provider-reconcile-event",
    snapshotSequence: 10,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    reasoningOutputTokens: 5,
    reportedTotalTokens: 120,
    hasNegativeValues: false,
    estimatedCost: null,
  };
  database.applySourceImport({
    session,
    usageEvents: [usageEvent],
    repository: null,
    fileSize: 100,
    fileMtimeMs: 1,
    processedBytes: 100,
    processedHash: "processed",
    sourceFileHash: "source",
    format: "fixture",
    malformedLines: 0,
    truncated: false,
    resetSource: true,
    importedAt: "2026-01-01T00:02:00.000Z",
  });
  database.updateSessionUsage(sessionId, {
    inputTokens: 999,
    outputTokens: 888,
    cachedInputTokens: 777,
    estimatedCost: null,
  });
  return { database, sessionId };
}

describe("usage reconciliation", () => {
  it("does not change aggregate or canonical rows in dry-run mode", async () => {
    const { database, sessionId } = await databaseFixture();

    const report = reconcileUsage(database, {
      provider: "codex",
      dryRun: true,
    });

    expect(report.modifiedSessions).toBe(1);
    expect(report.before.inputTokens).toBe(999);
    expect(report.after.inputTokens).toBe(100);
    expect(database.getSession(sessionId)?.inputTokens).toBe(999);
    expect(database.getUsageEvents(sessionId)[0]?.isCanonical).toBe(false);
    database.close();
  });

  it("repairs old aggregate values and marks canonical events", async () => {
    const { database, sessionId } = await databaseFixture();

    const report = reconcileUsage(database, { provider: "codex" });

    expect(report.modifiedSessions).toBe(1);
    expect(database.getSession(sessionId)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      uncachedInputTokens: 20,
      accountingMethod: "cumulative_snapshot",
      accountingStatus: "verified",
    });
    expect(database.getUsageEvents(sessionId)[0]?.isCanonical).toBe(true);
    database.close();
  });
});
