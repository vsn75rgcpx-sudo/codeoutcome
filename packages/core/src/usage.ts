import type { Provider, Session, UsageEvent } from "@codeoutcome/shared";

import { analyzeUsageEvents } from "./accounting.js";
import { DEFAULT_PRICING_CATALOG, type PricingCatalog } from "./pricing.js";

export interface AccountedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  estimatedCost: number | null;
  warnings: string[];
}

export type UsagePeriod = "daily" | "weekly" | "monthly";

export interface CostSummary {
  amount: number | null;
  status: "unavailable" | "estimated" | "partial";
  pricedSessions: number;
  unpricedSessions: number;
}

export interface UsageBucket {
  key: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  totalTokens: number;
  cost: CostSummary;
}

export interface UsageReport {
  period: UsagePeriod;
  totals: UsageBucket;
  byProvider: UsageBucket[];
  byModel: UsageBucket[];
  byDate: UsageBucket[];
  pricing: Pick<
    PricingCatalog,
    "version" | "updatedAt" | "source" | "currency"
  >;
}

export function accountUsageEvents(
  provider: Provider,
  events: readonly UsageEvent[],
  model: string,
  catalog: PricingCatalog = DEFAULT_PRICING_CATALOG,
): AccountedUsage {
  const analysis = analyzeUsageEvents(provider, model, events, catalog);

  return {
    inputTokens: analysis.inputTokens,
    outputTokens: analysis.outputTokens,
    cachedInputTokens: analysis.cachedInputTokens,
    uncachedInputTokens: analysis.uncachedInputTokens,
    estimatedCost: analysis.estimatedCost,
    warnings: analysis.warnings,
  };
}

interface MutableBucket {
  key: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  knownCost: number;
  pricedSessions: number;
  unpricedSessions: number;
}

function createBucket(key: string): MutableBucket {
  return {
    key,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    knownCost: 0,
    pricedSessions: 0,
    unpricedSessions: 0,
  };
}

function addSession(bucket: MutableBucket, session: Session): void {
  bucket.sessions += 1;
  bucket.inputTokens += session.inputTokens;
  bucket.outputTokens += session.outputTokens;
  bucket.cachedInputTokens += session.cachedInputTokens;
  bucket.uncachedInputTokens += session.uncachedInputTokens;
  if (session.estimatedCost === null) {
    bucket.unpricedSessions += 1;
  } else {
    bucket.knownCost += session.estimatedCost;
    bucket.pricedSessions += 1;
  }
}

function finishBucket(bucket: MutableBucket): UsageBucket {
  const status: CostSummary["status"] =
    bucket.pricedSessions === 0
      ? "unavailable"
      : bucket.unpricedSessions === 0
        ? "estimated"
        : "partial";
  return {
    key: bucket.key,
    sessions: bucket.sessions,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cachedInputTokens: bucket.cachedInputTokens,
    uncachedInputTokens: bucket.uncachedInputTokens,
    totalTokens: bucket.inputTokens + bucket.outputTokens,
    cost: {
      amount: bucket.pricedSessions === 0 ? null : bucket.knownCost,
      status,
      pricedSessions: bucket.pricedSessions,
      unpricedSessions: bucket.unpricedSessions,
    },
  };
}

function isoWeekKey(date: Date): string {
  const utcDate = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utcDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${utcDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dateKey(session: Session, period: UsagePeriod): string {
  const raw = session.startedAt ?? session.endedAt ?? session.importedAt;
  if (raw === null) {
    return "unknown";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  if (period === "monthly") {
    return date.toISOString().slice(0, 7);
  }
  if (period === "weekly") {
    return isoWeekKey(date);
  }
  return date.toISOString().slice(0, 10);
}

function groupedBuckets(
  sessions: readonly Session[],
  keyFor: (session: Session) => string,
): UsageBucket[] {
  const groups = new Map<string, MutableBucket>();
  for (const session of sessions) {
    const key = keyFor(session);
    const bucket = groups.get(key) ?? createBucket(key);
    addSession(bucket, session);
    groups.set(key, bucket);
  }
  return [...groups.values()]
    .map(finishBucket)
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function buildUsageReport(
  sessions: readonly Session[],
  period: UsagePeriod = "daily",
  catalog: PricingCatalog = DEFAULT_PRICING_CATALOG,
): UsageReport {
  const total = createBucket("all");
  for (const session of sessions) {
    addSession(total, session);
  }
  return {
    period,
    totals: finishBucket(total),
    byProvider: groupedBuckets(sessions, (session) => session.provider),
    byModel: groupedBuckets(sessions, (session) => session.model),
    byDate: groupedBuckets(sessions, (session) => dateKey(session, period)),
    pricing: {
      version: catalog.version,
      updatedAt: catalog.updatedAt,
      source: catalog.source,
      currency: catalog.currency,
    },
  };
}

export function isProvider(value: string): value is Provider {
  return value === "claude-code" || value === "codex";
}
