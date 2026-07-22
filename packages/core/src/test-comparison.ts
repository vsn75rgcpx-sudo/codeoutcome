import type { SessionDatabase } from "@codeoutcome/database";
import type {
  TestComparison,
  TestRun,
  TrackingRun,
  TrackingTestSummary,
} from "@codeoutcome/shared";

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : right - left;
}

function chronological(runs: readonly TestRun[]): TestRun[] {
  return [...runs].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function compareTestRuns(
  baseline: TestRun | null,
  final: TestRun | null,
  selection: {
    baseline: TestComparison["baselineSelection"];
    final: TestComparison["finalSelection"];
  } = { baseline: "explicit", final: "explicit" },
): TestComparison {
  const warnings: string[] = [];
  if (selection.baseline === "inferred")
    warnings.push("baseline_inferred_from_earliest_run");
  if (selection.final === "inferred")
    warnings.push("final_inferred_from_latest_run");
  if (baseline === null || final === null || baseline.id === final.id) {
    warnings.push("at_least_two_test_runs_are_required");
    return {
      baseline,
      final,
      baselineSelection: baseline === null ? "unavailable" : selection.baseline,
      finalSelection: final === null ? "unavailable" : selection.final,
      comparability: "not_comparable",
      comparisonConfidence: null,
      sameCommand:
        baseline === null || final === null
          ? null
          : baseline.commandFingerprint === final.commandFingerprint,
      totalTestDelta: null,
      passedTestDelta: null,
      failedTestDelta: null,
      skippedTestDelta: null,
      durationDeltaMs: null,
      warnings,
    };
  }
  const sameCommand = baseline.commandFingerprint === final.commandFingerprint;
  let comparability: TestComparison["comparability"];
  let comparisonConfidence: number | null;
  if (baseline.framework !== final.framework) {
    comparability = "not_comparable";
    comparisonConfidence = null;
    warnings.push("frameworks_differ");
  } else {
    const baselineStructured =
      baseline.parserStatus === "parsed" ||
      baseline.parserStatus === "partially_parsed";
    const finalStructured =
      final.parserStatus === "parsed" ||
      final.parserStatus === "partially_parsed";
    if (sameCommand && baselineStructured && finalStructured) {
      comparability = "comparable";
      comparisonConfidence = 1;
    } else {
      comparability = "partially_comparable";
      comparisonConfidence = sameCommand ? 0.7 : 0.55;
      if (!sameCommand) warnings.push("command_fingerprints_differ");
      if (!baselineStructured || !finalStructured) {
        warnings.push("one_or_both_runs_have_exit_code_only_results");
      }
    }
  }
  if (baseline.outcome === "unknown" || final.outcome === "unknown") {
    warnings.push("one_or_both_outcomes_are_unknown");
    if (comparability === "comparable") {
      comparability = "partially_comparable";
      comparisonConfidence = 0.6;
    }
  }
  return {
    baseline,
    final,
    baselineSelection: selection.baseline,
    finalSelection: selection.final,
    comparability,
    comparisonConfidence,
    sameCommand,
    totalTestDelta: delta(baseline.totalTests, final.totalTests),
    passedTestDelta: delta(baseline.passedTests, final.passedTests),
    failedTestDelta: delta(baseline.failedTests, final.failedTests),
    skippedTestDelta: delta(baseline.skippedTests, final.skippedTests),
    durationDeltaMs: delta(baseline.durationMs, final.durationMs),
    warnings,
  };
}

export function selectTestComparison(runs: readonly TestRun[]): TestComparison {
  const ordered = chronological(runs).filter((run) => run.status !== "running");
  const explicitBaseline =
    ordered.find((run) => run.stage === "baseline") ?? null;
  const explicitFinal =
    [...ordered].reverse().find((run) => run.stage === "final") ?? null;
  const baseline = explicitBaseline ?? ordered[0] ?? null;
  const final = explicitFinal ?? ordered.at(-1) ?? null;
  return compareTestRuns(baseline, final, {
    baseline:
      explicitBaseline === null
        ? baseline === null
          ? "unavailable"
          : "inferred"
        : "explicit",
    final:
      explicitFinal === null
        ? final === null
          ? "unavailable"
          : "inferred"
        : "explicit",
  });
}

export function compareTrackingRunTests(
  database: SessionDatabase,
  trackingRunId: string,
): TestComparison {
  if (database.getTrackingRun(trackingRunId) === null)
    throw new Error("Tracking run not found");
  return selectTestComparison(
    database.listTestRuns({ trackingRunId, limit: 10_000 }),
  );
}

export function compareSessionTests(
  database: SessionDatabase,
  sessionId: string,
): TestComparison {
  if (!database.sessionExists(sessionId)) throw new Error("Session not found");
  return selectTestComparison(
    database.listTestRuns({ sessionId, limit: 10_000 }),
  );
}

export function buildTrackingTestSummary(
  trackingRun: TrackingRun,
  runs: readonly TestRun[],
): TrackingTestSummary {
  const ordered = chronological(runs);
  const completed = ordered.filter((run) => run.status !== "running");
  const firstSuccess =
    completed.find((run) => run.outcome === "passed") ?? null;
  const failed = completed.filter(
    (run) => run.outcome === "failed" || run.outcome === "errored",
  );
  const comparison =
    completed.length === 0 ? null : selectTestComparison(completed);
  const trackingStart = new Date(trackingRun.startedAt).getTime();
  const firstSuccessAt =
    firstSuccess === null
      ? null
      : (firstSuccess.endedAt ?? firstSuccess.startedAt);
  const firstSuccessTime =
    firstSuccessAt === null ? Number.NaN : new Date(firstSuccessAt).getTime();
  const frameworks = new Set(completed.map((run) => run.framework));
  return {
    testRunCount: ordered.length,
    failedRunCount: failed.length,
    successfulRunCount: completed.filter((run) => run.outcome === "passed")
      .length,
    interruptedRunCount: completed.filter(
      (run) => run.outcome === "interrupted",
    ).length,
    firstSuccessAt,
    timeToFirstSuccessMs:
      Number.isFinite(trackingStart) && Number.isFinite(firstSuccessTime)
        ? Math.max(0, firstSuccessTime - trackingStart)
        : null,
    failedRunsBeforeFirstSuccess:
      firstSuccess === null
        ? null
        : completed
            .filter((run) => run.startedAt < firstSuccess.startedAt)
            .filter(
              (run) => run.outcome === "failed" || run.outcome === "errored",
            ).length,
    baselineOutcome: comparison?.baseline?.outcome ?? null,
    finalOutcome: comparison?.final?.outcome ?? null,
    failedTestDelta: comparison?.failedTestDelta ?? null,
    passedTestDelta: comparison?.passedTestDelta ?? null,
    durationDeltaMs: comparison?.durationDeltaMs ?? null,
    comparisonConfidence: comparison?.comparisonConfidence ?? null,
    framework: frameworks.size === 1 ? (completed[0]?.framework ?? null) : null,
    comparison,
    warnings:
      comparison?.warnings ??
      (ordered.length === 0 ? ["no_recorded_test_runs"] : []),
  };
}
