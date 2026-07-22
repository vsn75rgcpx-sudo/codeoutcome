import type {
  AccountingMethod,
  AccountingStatus,
  Provider,
  UsageEvent,
} from "@codeoutcome/shared";

import {
  DEFAULT_PRICING_CATALOG,
  estimateUsageCost,
  type PricingCatalog,
} from "./pricing.js";

export const ACCOUNTING_VERSION = "codeoutcome-accounting-v2.5.0";

export interface UsageAccountingAnalysis {
  accountingMethod: AccountingMethod;
  accountingStatus: AccountingStatus;
  accountingVersion: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  lastUsageEventAt: string | null;
  canonicalEventIds: string[];
  totalSnapshotCount: number;
  incrementalEventCount: number;
  informationalEventCount: number;
  canonicalEventCount: number;
  duplicateEventCount: number;
  hasMonotonicityAnomaly: boolean;
  hasDuplicateEvent: boolean;
  hasInputLessThanCache: boolean;
  hasNegativeValues: boolean;
  hasMixedAccounting: boolean;
  hasReasoningOutputConflict: boolean;
  warnings: string[];
}

function eventTimeValue(event: UsageEvent): number | null {
  if (event.eventTime === null) {
    return null;
  }
  const value = new Date(event.eventTime).getTime();
  return Number.isFinite(value) ? value : null;
}

function compareEvents(left: UsageEvent, right: UsageEvent): number {
  const leftTime = eventTimeValue(left);
  const rightTime = eventTimeValue(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  const sourceOrder = left.sourceFile.localeCompare(right.sourceFile);
  if (sourceOrder !== 0) return sourceOrder;
  const sequenceOrder =
    (left.snapshotSequence ?? left.sourceOffset) -
    (right.snapshotSequence ?? right.sourceOffset);
  if (sequenceOrder !== 0) return sequenceOrder;
  return left.id.localeCompare(right.id);
}

function duplicateEventCount(events: readonly UsageEvent[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const event of events) {
    if (event.providerEventId === null) continue;
    const key = `${event.accountingRole}\0${event.providerEventId}`;
    if (seen.has(key)) {
      duplicates += 1;
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

function deduplicateIncrementalEvents(
  events: readonly UsageEvent[],
): UsageEvent[] {
  const seenProviderIds = new Set<string>();
  const seenEventIds = new Set<string>();
  const result: UsageEvent[] = [];
  for (const event of [...events].sort(compareEvents)) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    if (event.providerEventId !== null) {
      if (seenProviderIds.has(event.providerEventId)) continue;
      seenProviderIds.add(event.providerEventId);
    }
    result.push(event);
  }
  return result;
}

function cumulativeDecreased(events: readonly UsageEvent[]): boolean {
  const sorted = [...events].sort(compareEvents);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (
      current.inputTokens < previous.inputTokens ||
      current.outputTokens < previous.outputTokens ||
      current.cachedInputTokens < previous.cachedInputTokens ||
      current.reasoningOutputTokens < previous.reasoningOutputTokens ||
      (current.reportedTotalTokens !== null &&
        previous.reportedTotalTokens !== null &&
        current.reportedTotalTokens < previous.reportedTotalTokens)
    ) {
      return true;
    }
  }
  return false;
}

function latestValidSnapshot(events: readonly UsageEvent[]): UsageEvent {
  const sorted = [...events].sort(compareEvents);
  const withValidTime = sorted.filter(
    (event) => eventTimeValue(event) !== null,
  );
  return withValidTime.at(-1) ?? sorted.at(-1) ?? events[0]!;
}

function sumEvents(events: readonly UsageEvent[]): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
} {
  return events.reduce(
    (total, event) => ({
      inputTokens: total.inputTokens + event.inputTokens,
      outputTokens: total.outputTokens + event.outputTokens,
      cachedInputTokens: total.cachedInputTokens + event.cachedInputTokens,
      reasoningOutputTokens:
        total.reasoningOutputTokens + event.reasoningOutputTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
}

function selectedCost(
  selected: readonly UsageEvent[],
  method: AccountingMethod,
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  },
  catalog: PricingCatalog,
): number | null {
  const costs = selected.map((event) => event.estimatedCost);
  if (costs.length > 0 && costs.every((cost) => cost !== null)) {
    const known = costs.filter((cost): cost is number => cost !== null);
    return method === "incremental_events"
      ? known.reduce((sum, cost) => sum + cost, 0)
      : (known.at(-1) ?? null);
  }
  return estimateUsageCost(model, usage, catalog);
}

export function analyzeUsageEvents(
  provider: Provider,
  model: string,
  events: readonly UsageEvent[],
  catalog: PricingCatalog = DEFAULT_PRICING_CATALOG,
): UsageAccountingAnalysis {
  const cumulative = events.filter(
    (event) => event.accountingRole === "cumulative_snapshot",
  );
  const incremental = events.filter(
    (event) => event.accountingRole === "incremental",
  );
  const informational = events.filter(
    (event) => event.accountingRole === "informational",
  );
  const duplicateCount = duplicateEventCount(events);
  const monotonicityAnomaly = cumulativeDecreased(cumulative);
  const mixedAccounting = cumulative.length > 0 && incremental.length > 0;
  const inputLessThanCache = events.some(
    (event) => event.inputTokens < event.cachedInputTokens,
  );
  const negativeValues = events.some((event) => event.hasNegativeValues);
  const reasoningConflict = events.some(
    (event) => event.reasoningOutputTokens > event.outputTokens,
  );
  const missingEventTime = events.some(
    (event) => eventTimeValue(event) === null,
  );
  const warnings: string[] = [];
  if (monotonicityAnomaly) warnings.push("cumulative_snapshot_decreased");
  if (mixedAccounting) {
    warnings.push("cumulative_and_incremental_ranges_mixed");
  }
  if (duplicateCount > 0) warnings.push("duplicate_provider_event_id");
  if (inputLessThanCache) warnings.push("input_less_than_cached_input");
  if (negativeValues) warnings.push("negative_token_value_clamped");
  if (reasoningConflict) warnings.push("reasoning_output_exceeds_output");
  if (missingEventTime && events.length > 0)
    warnings.push("missing_event_time");

  let accountingMethod: AccountingMethod;
  let selected: UsageEvent[];
  let values: ReturnType<typeof sumEvents>;
  if (cumulative.length > 0) {
    const latest = latestValidSnapshot(cumulative);
    selected = [latest];
    values = {
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      cachedInputTokens: latest.cachedInputTokens,
      reasoningOutputTokens: latest.reasoningOutputTokens,
    };
    accountingMethod =
      monotonicityAnomaly || mixedAccounting
        ? "ambiguous"
        : "cumulative_snapshot";
  } else if (incremental.length > 0) {
    selected = deduplicateIncrementalEvents(incremental);
    values = sumEvents(selected);
    accountingMethod = "incremental_events";
  } else {
    selected = [];
    values = sumEvents([]);
    accountingMethod = "unavailable";
    warnings.push("no_canonical_usage_events");
  }

  const selectedReportedTotal = selected.at(-1)?.reportedTotalTokens ?? null;
  if (
    accountingMethod !== "incremental_events" &&
    selectedReportedTotal !== null &&
    selectedReportedTotal !== values.inputTokens + values.outputTokens
  ) {
    warnings.push("reported_total_not_input_plus_output");
  }
  if (
    provider === "codex" &&
    informational.length > 0 &&
    cumulative.length === 0
  ) {
    warnings.push("codex_informational_usage_without_snapshot");
  }

  const accountingStatus: AccountingStatus = negativeValues
    ? "invalid"
    : warnings.length > 0
      ? "warning"
      : "verified";
  const canonicalEventIds = selected.map((event) => event.id);
  const lastUsageEventAt =
    selected
      .map((event) => event.eventTime)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;

  return {
    accountingMethod,
    accountingStatus,
    accountingVersion: ACCOUNTING_VERSION,
    inputTokens: values.inputTokens,
    outputTokens: values.outputTokens,
    cachedInputTokens: values.cachedInputTokens,
    uncachedInputTokens: Math.max(
      values.inputTokens - values.cachedInputTokens,
      0,
    ),
    reasoningOutputTokens: values.reasoningOutputTokens,
    totalTokens: values.inputTokens + values.outputTokens,
    estimatedCost: selectedCost(
      selected,
      accountingMethod,
      model,
      values,
      catalog,
    ),
    lastUsageEventAt,
    canonicalEventIds,
    totalSnapshotCount: cumulative.length,
    incrementalEventCount: incremental.length,
    informationalEventCount: informational.length,
    canonicalEventCount: canonicalEventIds.length,
    duplicateEventCount: duplicateCount,
    hasMonotonicityAnomaly: monotonicityAnomaly,
    hasDuplicateEvent: duplicateCount > 0,
    hasInputLessThanCache: inputLessThanCache,
    hasNegativeValues: negativeValues,
    hasMixedAccounting: mixedAccounting,
    hasReasoningOutputConflict: reasoningConflict,
    warnings,
  };
}
