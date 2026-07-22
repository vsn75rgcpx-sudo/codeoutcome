import type { TestRun, TrackingRun } from "@codeoutcome/shared";
import { describe, expect, it } from "vitest";

import {
  buildTrackingTestSummary,
  compareTestRuns,
  selectTestComparison,
} from "./test-comparison.js";

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: overrides.id ?? "test-1",
    trackingRunId: "tracking-1",
    sessionId: null,
    repositoryId: 1,
    workingDirectory: "/tmp/repo",
    startedAt: "2026-07-21T00:01:00.000Z",
    endedAt: "2026-07-21T00:01:01.000Z",
    durationMs: 1000,
    stage: "unspecified",
    framework: "pytest",
    frameworkVersion: null,
    executable: "pytest",
    commandDisplay: "pytest -q",
    commandFingerprint: "same",
    argumentCount: 1,
    exitCode: 0,
    terminationSignal: null,
    status: "completed",
    outcome: "passed",
    totalTests: 3,
    passedTests: 3,
    failedTests: 0,
    skippedTests: 0,
    todoTests: null,
    erroredTests: null,
    parserStatus: "partially_parsed",
    parserVersion: "fixture-v1",
    outputTruncated: false,
    source: "wrapped_command",
    warnings: [],
    createdAt: "2026-07-21T00:01:00.000Z",
    updatedAt: "2026-07-21T00:01:01.000Z",
    ...overrides,
  };
}

function tracking(): TrackingRun {
  return {
    id: "tracking-1",
    provider: "codex",
    label: null,
    workingDirectory: "/tmp/repo",
    repositoryId: 1,
    repositoryPath: "/tmp/repo",
    repositoryName: "repo",
    startedAt: "2026-07-21T00:00:00.000Z",
    endedAt: "2026-07-21T00:10:00.000Z",
    status: "completed",
    startSnapshotId: "start",
    endSnapshotId: "end",
    linkedSessionId: null,
    linkConfidence: null,
    linkConfidenceLevel: null,
    linkMethod: null,
    linkReasons: [],
    summary: null,
    warnings: [],
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:10:00.000Z",
  };
}

describe("test result comparison", () => {
  it("selects explicit baseline/final and computes signed deltas", () => {
    const baseline = run({
      id: "baseline",
      stage: "baseline",
      outcome: "failed",
      failedTests: 1,
      passedTests: 2,
      exitCode: 1,
    });
    const final = run({
      id: "final",
      stage: "final",
      startedAt: "2026-07-21T00:05:00.000Z",
      failedTests: 0,
      passedTests: 3,
      durationMs: 800,
    });
    const comparison = selectTestComparison([final, baseline]);
    expect(comparison).toMatchObject({
      baselineSelection: "explicit",
      finalSelection: "explicit",
      comparability: "comparable",
      failedTestDelta: -1,
      passedTestDelta: 1,
      durationDeltaMs: -200,
    });
  });

  it("does not invent deltas when only one run exists", () => {
    const comparison = selectTestComparison([run()]);
    expect(comparison.comparability).toBe("not_comparable");
    expect(comparison.failedTestDelta).toBeNull();
  });

  it("marks different frameworks not comparable", () => {
    const comparison = compareTestRuns(
      run({ id: "a" }),
      run({ id: "b", framework: "jest" }),
    );
    expect(comparison.comparability).toBe("not_comparable");
    expect(comparison.warnings).toContain("frameworks_differ");
  });

  it("marks different commands and exit-code-only results partially comparable", () => {
    const comparison = compareTestRuns(
      run({
        id: "a",
        parserStatus: "exit_code_only",
        totalTests: null,
        failedTests: null,
      }),
      run({
        id: "b",
        commandFingerprint: "different",
        parserStatus: "exit_code_only",
        totalTests: null,
        failedTests: null,
      }),
    );
    expect(comparison.comparability).toBe("partially_comparable");
    expect(comparison.failedTestDelta).toBeNull();
    expect(comparison.warnings).toContain("command_fingerprints_differ");
  });

  it("builds tracking metrics without treating unknown values as zero", () => {
    const baseline = run({
      id: "baseline",
      stage: "baseline",
      outcome: "failed",
      failedTests: null,
      passedTests: null,
      parserStatus: "exit_code_only",
    });
    const final = run({
      id: "final",
      stage: "final",
      startedAt: "2026-07-21T00:03:00.000Z",
      endedAt: "2026-07-21T00:03:01.000Z",
      failedTests: null,
      passedTests: null,
      parserStatus: "exit_code_only",
    });
    const summary = buildTrackingTestSummary(tracking(), [baseline, final]);
    expect(summary).toMatchObject({
      testRunCount: 2,
      failedRunCount: 1,
      successfulRunCount: 1,
      firstSuccessAt: final.endedAt,
      timeToFirstSuccessMs: 181_000,
      failedRunsBeforeFirstSuccess: 1,
      failedTestDelta: null,
    });
  });

  it("returns unavailable metrics when no test runs were recorded", () => {
    const summary = buildTrackingTestSummary(tracking(), []);
    expect(summary).toMatchObject({
      testRunCount: 0,
      firstSuccessAt: null,
      failedRunsBeforeFirstSuccess: null,
      comparison: null,
    });
    expect(summary.warnings).toContain("no_recorded_test_runs");
  });
});
