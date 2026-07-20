import type { Provider, Session, UsageEvent } from "@agentledger/shared";

import {
  DEFAULT_PRICING_CATALOG,
  estimateUsageCost,
  type PricingCatalog,
} from "./pricing.js";

export interface AccountedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
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
  events: readonly UsageEvent[],
  model: string,
  catalog: PricingCatalog = DEFAULT_PRICING_CATALOG,
): AccountedUsage {
  const cumulative = events.filter((event) => event.eventType === "cumulative");
  const selected = cumulative.length > 0 ? cumulative : events;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  if (cumulative.length > 0) {
    for (const event of selected) {
      inputTokens = Math.max(inputTokens, event.inputTokens);
      outputTokens = Math.max(outputTokens, event.outputTokens);
      cachedInputTokens = Math.max(cachedInputTokens, event.cachedInputTokens);
    }
  } else {
    for (const event of selected) {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      cachedInputTokens += event.cachedInputTokens;
    }
  }

  const warnings: string[] = [];
  if (cachedInputTokens > inputTokens) {
    cachedInputTokens = inputTokens;
    warnings.push("cached input exceeded total input and was clamped");
  }

  const eventCosts = selected.map((event) => event.estimatedCost);
  let estimatedCost: number | null = null;
  if (eventCosts.length > 0 && eventCosts.every((cost) => cost !== null)) {
    const knownCosts = eventCosts.filter(
      (cost): cost is number => cost !== null,
    );
    estimatedCost =
      cumulative.length > 0
        ? Math.max(...knownCosts)
        : knownCosts.reduce((total, cost) => total + cost, 0);
  }
  estimatedCost ??= estimateUsageCost(
    model,
    { inputTokens, outputTokens, cachedInputTokens },
    catalog,
  );

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedCost,
    warnings,
  };
}

interface MutableBucket {
  key: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
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
