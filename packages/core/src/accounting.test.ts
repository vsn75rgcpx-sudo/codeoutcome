import { describe, expect, it } from "vitest";

import type { AccountingRole, UsageEvent } from "@codeoutcome/shared";

import { analyzeUsageEvents } from "./accounting.js";

function event(
  id: string,
  role: AccountingRole,
  inputTokens: number,
  options: {
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    time?: string;
    sourceFile?: string;
    providerEventId?: string | null;
    negative?: boolean;
  } = {},
): UsageEvent {
  const outputTokens = options.outputTokens ?? 10;
  return {
    id,
    sessionId: "session",
    sourceFile: options.sourceFile ?? "/synthetic/session.jsonl",
    sourceOffset: Number(id.replace(/\D/g, "")) || 0,
    eventTime: options.time ?? `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
    eventType: role === "cumulative_snapshot" ? "cumulative" : "incremental",
    accountingRole: role,
    isCanonical: false,
    providerEventId: options.providerEventId ?? null,
    snapshotSequence: Number(id.replace(/\D/g, "")) || 0,
    inputTokens,
    outputTokens,
    cachedInputTokens: options.cachedInputTokens ?? 0,
    reasoningOutputTokens: options.reasoningOutputTokens ?? 0,
    reportedTotalTokens: inputTokens + outputTokens,
    hasNegativeValues: options.negative ?? false,
    estimatedCost: null,
  };
}

describe("canonical token accounting", () => {
  it("uses the chronologically last cumulative snapshot", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "cumulative_snapshot", 100, { outputTokens: 20 }),
      event("2", "cumulative_snapshot", 180, { outputTokens: 35 }),
      event("3", "cumulative_snapshot", 250, { outputTokens: 44 }),
    ]);

    expect(analysis).toMatchObject({
      accountingMethod: "cumulative_snapshot",
      inputTokens: 250,
      outputTokens: 44,
      totalSnapshotCount: 3,
      canonicalEventIds: ["3"],
    });
  });

  it("sums deduplicated incremental events only when snapshots are absent", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "incremental", 20),
      event("2", "incremental", 30),
    ]);

    expect(analysis).toMatchObject({
      accountingMethod: "incremental_events",
      inputTokens: 50,
      outputTokens: 20,
      canonicalEventCount: 2,
    });
  });

  it("does not add paired last usage stored as informational", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "cumulative_snapshot", 100),
      event("1-info", "informational", 100),
      event("2", "cumulative_snapshot", 150),
      event("2-info", "informational", 50),
    ]);

    expect(analysis.inputTokens).toBe(150);
    expect(analysis.informationalEventCount).toBe(2);
    expect(analysis.hasMixedAccounting).toBe(false);
  });

  it("treats cache and reasoning as subsets instead of adding them to total", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "cumulative_snapshot", 100, {
        outputTokens: 20,
        cachedInputTokens: 60,
        reasoningOutputTokens: 12,
      }),
    ]);

    expect(analysis.uncachedInputTokens).toBe(40);
    expect(analysis.totalTokens).toBe(120);
    expect(analysis.reasoningOutputTokens).toBe(12);
  });

  it("deduplicates a provider event ID across source files", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "incremental", 25, {
        sourceFile: "/synthetic/a.jsonl",
        providerEventId: "provider-event-1",
      }),
      event("2", "incremental", 25, {
        sourceFile: "/synthetic/b.jsonl",
        providerEventId: "provider-event-1",
      }),
    ]);

    expect(analysis.inputTokens).toBe(25);
    expect(analysis.hasDuplicateEvent).toBe(true);
    expect(analysis.warnings).toContain("duplicate_provider_event_id");
  });

  it("warns when cached input exceeds input without hiding the value", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "cumulative_snapshot", 10, { cachedInputTokens: 12 }),
    ]);

    expect(analysis.cachedInputTokens).toBe(12);
    expect(analysis.uncachedInputTokens).toBe(0);
    expect(analysis.accountingStatus).toBe("warning");
    expect(analysis.hasInputLessThanCache).toBe(true);
  });

  it("marks a decreasing cumulative sequence as ambiguous", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "cumulative_snapshot", 100),
      event("2", "cumulative_snapshot", 90),
    ]);

    expect(analysis.accountingMethod).toBe("ambiguous");
    expect(analysis.inputTokens).toBe(90);
    expect(analysis.hasMonotonicityAnomaly).toBe(true);
  });

  it("marks a clamped negative provider value as invalid", () => {
    const analysis = analyzeUsageEvents("codex", "unknown", [
      event("1", "cumulative_snapshot", 0, { negative: true }),
    ]);

    expect(analysis.accountingStatus).toBe("invalid");
    expect(analysis.warnings).toContain("negative_token_value_clamped");
  });
});
