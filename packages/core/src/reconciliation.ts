import type {
  SessionAccountingUpdate,
  SessionDatabase,
} from "@agentledger/database";
import type {
  AccountingMethod,
  Provider,
  Session,
  UsageEvent,
} from "@agentledger/shared";

import {
  analyzeUsageEvents,
  type UsageAccountingAnalysis,
} from "./accounting.js";
import { DEFAULT_PRICING_CATALOG, type PricingCatalog } from "./pricing.js";

export interface UsageAuditOptions {
  provider?: Provider;
  session?: string;
  top?: number;
  pricingCatalog?: PricingCatalog;
}

export interface UsageAuditSession {
  sessionId: string;
  providerSessionId: string;
  provider: Provider;
  model: string;
  sourceFiles: string[];
  totalSnapshotCount: number;
  incrementalEventCount: number;
  informationalEventCount: number;
  canonicalEventCount: number;
  accountingMethod: AccountingMethod;
  accountingStatus: UsageAccountingAnalysis["accountingStatus"];
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  hasMonotonicityAnomaly: boolean;
  hasDuplicateEvent: boolean;
  hasInputLessThanCache: boolean;
  hasNegativeValues: boolean;
  hasMixedAccounting: boolean;
  warnings: string[];
}

export interface UsageAuditReport {
  accountingVersion: string;
  checkedSessions: number;
  warningSessions: number;
  ambiguousSessions: number;
  invalidSessions: number;
  methods: Record<AccountingMethod, number>;
  sessions: UsageAuditSession[];
}

export interface UsageTotalsSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  totalTokens: number;
}

export interface ReconciliationSessionDiff {
  sessionId: string;
  provider: Provider;
  modified: boolean;
  before: UsageTotalsSnapshot & {
    accountingMethod: AccountingMethod;
  };
  after: UsageTotalsSnapshot & {
    accountingMethod: AccountingMethod;
    accountingStatus: UsageAccountingAnalysis["accountingStatus"];
  };
  warnings: string[];
}

export interface UsageReconciliationReport {
  provider: Provider | "all";
  dryRun: boolean;
  checkedSessions: number;
  modifiedSessions: number;
  warningSessions: number;
  ambiguousSessions: number;
  before: UsageTotalsSnapshot;
  after: UsageTotalsSnapshot;
  sessions: ReconciliationSessionDiff[];
}

interface AnalyzedSession {
  session: Session;
  events: UsageEvent[];
  analysis: UsageAccountingAnalysis;
}

function matchesSession(session: Session, requested: string): boolean {
  return (
    session.id === requested ||
    session.providerSessionId === requested ||
    session.id.startsWith(requested) ||
    session.providerSessionId.startsWith(requested)
  );
}

function analyzeDatabase(
  database: SessionDatabase,
  options: UsageAuditOptions,
): AnalyzedSession[] {
  const catalog = options.pricingCatalog ?? DEFAULT_PRICING_CATALOG;
  return database
    .listSessions({ provider: options.provider })
    .filter(
      (session) =>
        options.session === undefined ||
        matchesSession(session, options.session),
    )
    .map((session) => {
      const events = database.getUsageEvents(session.id);
      return {
        session,
        events,
        analysis: analyzeUsageEvents(
          session.provider,
          session.model,
          events,
          catalog,
        ),
      };
    });
}

function methodCounts(
  analyses: readonly AnalyzedSession[],
): Record<AccountingMethod, number> {
  const counts: Record<AccountingMethod, number> = {
    cumulative_snapshot: 0,
    incremental_events: 0,
    ambiguous: 0,
    unavailable: 0,
  };
  for (const item of analyses) counts[item.analysis.accountingMethod] += 1;
  return counts;
}

function sourceFiles(item: AnalyzedSession): string[] {
  const files = new Set(item.events.map((event) => event.sourceFile));
  if (files.size === 0) files.add(item.session.sourceFile);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function auditSession(item: AnalyzedSession): UsageAuditSession {
  const { session, analysis } = item;
  return {
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    provider: session.provider,
    model: session.model,
    sourceFiles: sourceFiles(item),
    totalSnapshotCount: analysis.totalSnapshotCount,
    incrementalEventCount: analysis.incrementalEventCount,
    informationalEventCount: analysis.informationalEventCount,
    canonicalEventCount: analysis.canonicalEventCount,
    accountingMethod: analysis.accountingMethod,
    accountingStatus: analysis.accountingStatus,
    inputTokens: analysis.inputTokens,
    uncachedInputTokens: analysis.uncachedInputTokens,
    cachedInputTokens: analysis.cachedInputTokens,
    outputTokens: analysis.outputTokens,
    reasoningOutputTokens: analysis.reasoningOutputTokens,
    totalTokens: analysis.totalTokens,
    hasMonotonicityAnomaly: analysis.hasMonotonicityAnomaly,
    hasDuplicateEvent: analysis.hasDuplicateEvent,
    hasInputLessThanCache: analysis.hasInputLessThanCache,
    hasNegativeValues: analysis.hasNegativeValues,
    hasMixedAccounting: analysis.hasMixedAccounting,
    warnings: analysis.warnings,
  };
}

export function auditUsage(
  database: SessionDatabase,
  options: UsageAuditOptions = {},
): UsageAuditReport {
  const analyzed = analyzeDatabase(database, options);
  const sorted = analyzed
    .map(auditSession)
    .sort(
      (left, right) =>
        right.inputTokens - left.inputTokens ||
        left.sessionId.localeCompare(right.sessionId),
    );
  const sessions =
    options.top === undefined ? sorted : sorted.slice(0, options.top);
  return {
    accountingVersion:
      analyzed[0]?.analysis.accountingVersion ??
      "agentledger-accounting-v2.5.0",
    checkedSessions: analyzed.length,
    warningSessions: analyzed.filter(
      (item) => item.analysis.accountingStatus === "warning",
    ).length,
    ambiguousSessions: analyzed.filter(
      (item) => item.analysis.accountingMethod === "ambiguous",
    ).length,
    invalidSessions: analyzed.filter(
      (item) => item.analysis.accountingStatus === "invalid",
    ).length,
    methods: methodCounts(analyzed),
    sessions,
  };
}

function sessionTotals(session: Session): UsageTotalsSnapshot {
  return {
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cachedInputTokens: session.cachedInputTokens,
    uncachedInputTokens: session.uncachedInputTokens,
    totalTokens: session.inputTokens + session.outputTokens,
  };
}

function analysisTotals(
  analysis: UsageAccountingAnalysis,
): UsageTotalsSnapshot {
  return {
    inputTokens: analysis.inputTokens,
    outputTokens: analysis.outputTokens,
    cachedInputTokens: analysis.cachedInputTokens,
    uncachedInputTokens: analysis.uncachedInputTokens,
    totalTokens: analysis.totalTokens,
  };
}

function sumTotals(
  totals: readonly UsageTotalsSnapshot[],
): UsageTotalsSnapshot {
  return totals.reduce(
    (sum, item) => ({
      inputTokens: sum.inputTokens + item.inputTokens,
      outputTokens: sum.outputTokens + item.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + item.cachedInputTokens,
      uncachedInputTokens: sum.uncachedInputTokens + item.uncachedInputTokens,
      totalTokens: sum.totalTokens + item.totalTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      totalTokens: 0,
    },
  );
}

function canonicalStateMatches(item: AnalyzedSession): boolean {
  const stored = item.events
    .filter((event) => event.isCanonical)
    .map((event) => event.id)
    .sort();
  const expected = [...item.analysis.canonicalEventIds].sort();
  return (
    stored.length === expected.length &&
    stored.every((id, index) => id === expected[index])
  );
}

function needsUpdate(item: AnalyzedSession): boolean {
  const { session, analysis } = item;
  return (
    session.inputTokens !== analysis.inputTokens ||
    session.outputTokens !== analysis.outputTokens ||
    session.cachedInputTokens !== analysis.cachedInputTokens ||
    session.uncachedInputTokens !== analysis.uncachedInputTokens ||
    session.estimatedCost !== analysis.estimatedCost ||
    session.accountingMethod !== analysis.accountingMethod ||
    session.accountingStatus !== analysis.accountingStatus ||
    session.accountingVersion !== analysis.accountingVersion ||
    session.lastUsageEventAt !== analysis.lastUsageEventAt ||
    !canonicalStateMatches(item)
  );
}

function databaseUpdate(item: AnalyzedSession): SessionAccountingUpdate {
  const { analysis } = item;
  return {
    sessionId: item.session.id,
    inputTokens: analysis.inputTokens,
    outputTokens: analysis.outputTokens,
    cachedInputTokens: analysis.cachedInputTokens,
    uncachedInputTokens: analysis.uncachedInputTokens,
    estimatedCost: analysis.estimatedCost,
    accountingMethod: analysis.accountingMethod,
    accountingStatus: analysis.accountingStatus,
    accountingVersion: analysis.accountingVersion,
    lastUsageEventAt: analysis.lastUsageEventAt,
    canonicalEventIds: analysis.canonicalEventIds,
  };
}

export function reconcileUsage(
  database: SessionDatabase,
  options: {
    provider?: Provider;
    dryRun?: boolean;
    pricingCatalog?: PricingCatalog;
  } = {},
): UsageReconciliationReport {
  const analyzed = analyzeDatabase(database, options);
  const changed = analyzed.filter(needsUpdate);
  if (!(options.dryRun ?? false) && changed.length > 0) {
    database.applyUsageReconciliation(changed.map(databaseUpdate));
  }

  const sessions = analyzed
    .map((item): ReconciliationSessionDiff => ({
      sessionId: item.session.id,
      provider: item.session.provider,
      modified: needsUpdate(item),
      before: {
        ...sessionTotals(item.session),
        accountingMethod: item.session.accountingMethod,
      },
      after: {
        ...analysisTotals(item.analysis),
        accountingMethod: item.analysis.accountingMethod,
        accountingStatus: item.analysis.accountingStatus,
      },
      warnings: item.analysis.warnings,
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  return {
    provider: options.provider ?? "all",
    dryRun: options.dryRun ?? false,
    checkedSessions: analyzed.length,
    modifiedSessions: changed.length,
    warningSessions: analyzed.filter(
      (item) => item.analysis.accountingStatus !== "verified",
    ).length,
    ambiguousSessions: analyzed.filter(
      (item) => item.analysis.accountingMethod === "ambiguous",
    ).length,
    before: sumTotals(analyzed.map((item) => sessionTotals(item.session))),
    after: sumTotals(analyzed.map((item) => analysisTotals(item.analysis))),
    sessions,
  };
}
