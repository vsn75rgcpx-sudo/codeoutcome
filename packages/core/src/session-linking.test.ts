import { describe, expect, it } from "vitest";

import type {
  GitChangeSummary,
  Session,
  TrackingRun,
} from "@codeoutcome/shared";

import { scoreSessionLink } from "./session-linking.js";

const summary: GitChangeSummary = {
  startHead: "a",
  endHead: "a",
  branchChanged: false,
  startDirty: false,
  endDirty: false,
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  conflictedFileCount: 0,
  filesChanged: 0,
  additions: 0,
  deletions: 0,
  binaryFiles: 0,
  renamedFiles: 0,
  newCommit: false,
  baselineDirty: false,
  attribution: "observed_changes",
  warnings: [],
};

function run(overrides: Partial<TrackingRun> = {}): TrackingRun {
  return {
    id: "run-1",
    provider: "codex",
    label: null,
    workingDirectory: "/repo/subdir",
    repositoryId: 1,
    repositoryPath: "/repo",
    repositoryName: "repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    status: "completed",
    startSnapshotId: "start",
    endSnapshotId: "end",
    linkedSessionId: null,
    linkConfidence: null,
    linkConfidenceLevel: null,
    linkMethod: null,
    linkReasons: [],
    summary,
    warnings: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    provider: "codex",
    providerSessionId: id,
    model: "fixture",
    startedAt: "2026-01-01T00:00:10.000Z",
    endedAt: "2026-01-01T00:09:50.000Z",
    workingDirectory: "/repo/subdir",
    repositoryPath: "/repo",
    repositoryName: "repo",
    remoteUrl: null,
    branch: "main",
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
    uncachedInputTokens: 10,
    estimatedCost: null,
    accountingMethod: "cumulative_snapshot",
    accountingStatus: "verified",
    accountingVersion: "test",
    lastUsageEventAt: null,
    sourceFile: "/logs/fixture.jsonl",
    sourceFileHash: "hash",
    importedAt: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

describe("explainable session linking", () => {
  it("automatically selects a unique high-score candidate", () => {
    const decision = scoreSessionLink(run(), [session("one")], summary, "main");

    expect(decision).toMatchObject({
      sessionId: "one",
      confidenceLevel: "high",
    });
    expect(decision.score).toBeGreaterThanOrEqual(0.85);
    expect(decision.reasons.join(" ")).toContain("only viable candidate");
  });

  it("marks multiple equally strong candidates ambiguous", () => {
    const decision = scoreSessionLink(
      run(),
      [session("one"), session("two")],
      summary,
      "main",
    );

    expect(decision).toMatchObject({
      sessionId: null,
      confidenceLevel: "ambiguous",
    });
  });

  it("does not link a candidate below the threshold", () => {
    const far = session("far", {
      workingDirectory: "/other",
      repositoryPath: "/other",
      branch: "other",
      startedAt: "2025-01-01T00:00:00.000Z",
      endedAt: "2025-01-01T00:01:00.000Z",
    });
    const decision = scoreSessionLink(run(), [far], summary, "main");

    expect(decision.sessionId).toBeNull();
    expect(decision.reasons.join(" ")).toContain("threshold");
  });

  it("caps confidence at medium for a dirty baseline", () => {
    const dirty = { ...summary, baselineDirty: true, startDirty: true };
    const decision = scoreSessionLink(
      run({ summary: dirty }),
      [session("one")],
      dirty,
      "main",
    );

    expect(decision).toMatchObject({
      sessionId: "one",
      confidenceLevel: "medium",
    });
    expect(decision.reasons.join(" ")).toContain("dirty baseline");
  });

  it("reduces confidence for branch changes and rewritten history", () => {
    const disrupted = {
      ...summary,
      branchChanged: true,
      warnings: ["branch_changed", "head_rewritten_or_rewound"],
    };
    const decision = scoreSessionLink(
      run({ summary: disrupted }),
      [session("one")],
      disrupted,
      "main",
    );

    expect(decision.confidenceLevel).toBe("medium");
    expect(decision.reasons.join(" ")).toContain("history rewritten");
  });
});
