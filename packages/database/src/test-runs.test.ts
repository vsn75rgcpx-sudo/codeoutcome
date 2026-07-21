import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TestRun } from "@agentledger/shared";

import { SessionDatabase } from "./index.js";

const temporaryDirectories: string[] = [];

async function store(): Promise<SessionDatabase> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentledger-test-store-"),
  );
  temporaryDirectories.push(directory);
  return new SessionDatabase(path.join(directory, "agentledger.sqlite"));
}

function testRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: overrides.id ?? "test-1",
    trackingRunId: null,
    sessionId: null,
    repositoryId: null,
    workingDirectory: "/redacted/project",
    startedAt: "2026-07-21T00:00:00.000Z",
    endedAt: null,
    durationMs: null,
    stage: "unspecified",
    framework: "generic",
    frameworkVersion: null,
    executable: "fixture",
    commandDisplay: "fixture",
    commandFingerprint: "f".repeat(64),
    argumentCount: 0,
    exitCode: null,
    terminationSignal: null,
    status: "running",
    outcome: "unknown",
    totalTests: null,
    passedTests: null,
    failedTests: null,
    skippedTests: null,
    todoTests: null,
    erroredTests: null,
    parserStatus: "unsupported",
    parserVersion: "fixture-v1",
    outputTruncated: false,
    source: "wrapped_command",
    warnings: [],
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function addTrackingRun(database: SessionDatabase, id = "tracking-1"): string {
  database.startTrackingRun({
    id,
    provider: "codex",
    label: null,
    workingDirectory: "/redacted/project",
    repository: {
      canonicalPath: "/redacted/project",
      name: "project",
      remoteUrl: null,
    },
    startSnapshot: {
      id: `snapshot-${id}`,
      repositoryPath: "/redacted/project",
      capturedAt: "2026-07-21T00:00:00.000Z",
      trigger: "tracking_start",
      privacyMode: "git-metadata",
      workingDirectory: "/redacted/project",
      headCommit: null,
      branch: "main",
      isDetachedHead: false,
      isUnbornBranch: true,
      isDirty: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
      conflictedFileCount: 0,
      aheadCount: null,
      behindCount: null,
      gitVersion: "fixture",
      fileStats: [],
    },
    startedAt: "2026-07-21T00:00:00.000Z",
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  return id;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("test run storage", () => {
  it("creates and completes a run with foreign keys enabled", async () => {
    const database = await store();
    database.createTestRun(testRun());
    const completed = database.completeTestRun("test-1", {
      endedAt: "2026-07-21T00:00:02.000Z",
      durationMs: 2000,
      exitCode: 0,
      terminationSignal: null,
      status: "completed",
      outcome: "passed",
      totalTests: null,
      passedTests: null,
      failedTests: null,
      skippedTests: null,
      todoTests: null,
      erroredTests: null,
      parserStatus: "exit_code_only",
      parserVersion: "fixture-v1",
      outputTruncated: false,
      warnings: [],
      updatedAt: "2026-07-21T00:00:02.000Z",
    });
    expect(completed).toMatchObject({
      status: "completed",
      exitCode: 0,
      durationMs: 2000,
    });
    expect(database.foreignKeysEnabled()).toBe(true);
    expect(database.quickCheck()).toBe("ok");
    database.close();
  });

  it("keeps manual link and unlink as append-only history", async () => {
    const database = await store();
    database.createTestRun(testRun());
    addTrackingRun(database);
    const linked = database.linkTestRun("test-1", {
      trackingRunId: "tracking-1",
      linkType: "manual",
      confidence: 1,
      reasons: ["fixture"],
      createdAt: "2026-07-21T00:01:00.000Z",
    });
    expect(linked.trackingRunId).toBe("tracking-1");
    const unlinked = database.unlinkTestRun(
      "test-1",
      "2026-07-21T00:02:00.000Z",
    );
    expect(unlinked.trackingRunId).toBeNull();
    expect(
      database.listTestRunLinks("test-1").map((link) => link.linkType),
    ).toEqual(["manual", "unlink"]);
    database.close();
  });

  it("recovers and abandons stale runs without fabricated counts or exit codes", async () => {
    const database = await store();
    database.createTestRun(testRun({ id: "recover" }));
    database.createTestRun(testRun({ id: "abandon" }));
    expect(database.runningTestRunCount()).toBe(2);
    const recovered = database.recoverTestRun(
      "recover",
      "recover",
      "2026-07-21T00:05:00.000Z",
    );
    const abandoned = database.recoverTestRun(
      "abandon",
      "abandon",
      "2026-07-21T00:06:00.000Z",
    );
    expect(recovered).toMatchObject({
      status: "interrupted",
      outcome: "interrupted",
      exitCode: null,
      totalTests: null,
    });
    expect(abandoned).toMatchObject({
      status: "abandoned",
      outcome: "unknown",
      exitCode: null,
    });
    expect(database.runningTestRunCount()).toBe(0);
    database.close();
  });

  it("counts a dry-run query and deletes only test metadata", async () => {
    const database = await store();
    const trackingRunId = addTrackingRun(database, "tracking-delete-fixture");
    database.createTestRun(
      testRun({
        id: "old",
        trackingRunId,
        startedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    database.createTestRun(
      testRun({ id: "new", startedAt: "2026-07-21T00:00:00.000Z" }),
    );
    expect(database.countTestRuns({ before: "2026-07-01T00:00:00.000Z" })).toBe(
      1,
    );
    expect(database.listTestRuns()).toHaveLength(2);
    expect(
      database.deleteTestRuns({ before: "2026-07-01T00:00:00.000Z" }),
    ).toBe(1);
    expect(database.listTestRuns().map((run) => run.id)).toEqual(["new"]);
    expect(database.getTrackingRun(trackingRunId)).not.toBeNull();
    expect(database.getGitSnapshot(`snapshot-${trackingRunId}`)).not.toBeNull();
    database.close();
  });
});
