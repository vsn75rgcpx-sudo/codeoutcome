import { homedir } from "node:os";
import path from "node:path";

import {
  asRecord,
  discoverJsonlFiles,
  fallbackProviderSessionId,
  firstNumber,
  firstString,
  stableSessionId,
  stableUsageEventId,
  streamJsonlRecords,
  toIsoTimestamp,
  updateTimestampBounds,
  type JsonRecord,
  type ParseFileOptions,
  type ParsedLogFile,
  type SessionAdapter,
  type UsageEvent,
  type UsageEventType,
} from "@codeoutcome/shared";

interface UsageTotals {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  reportedTotal: number | null;
  hasNegativeValues: boolean;
}

function rawTokenCount(
  record: JsonRecord | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

function tokenCount(record: JsonRecord | undefined, ...keys: string[]): number {
  return Math.max(0, rawTokenCount(record, ...keys) ?? 0);
}

function usageTotals(record: JsonRecord | undefined): UsageTotals {
  const rawReportedTotal = rawTokenCount(record, "total_tokens", "totalTokens");
  const rawValues = [
    rawTokenCount(record, "input_tokens", "inputTokens"),
    rawTokenCount(record, "output_tokens", "outputTokens"),
    rawTokenCount(
      record,
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cachedInputTokens",
    ),
    rawTokenCount(record, "reasoning_output_tokens", "reasoningOutputTokens"),
    rawTokenCount(record, "total_tokens", "totalTokens"),
  ];
  return {
    input: tokenCount(record, "input_tokens", "inputTokens"),
    output: tokenCount(record, "output_tokens", "outputTokens"),
    cached: tokenCount(
      record,
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cachedInputTokens",
    ),
    reasoning: tokenCount(
      record,
      "reasoning_output_tokens",
      "reasoningOutputTokens",
    ),
    reportedTotal:
      rawReportedTotal === undefined ? null : Math.max(0, rawReportedTotal),
    hasNegativeValues: rawValues.some(
      (value) => value !== undefined && value < 0,
    ),
  };
}

function summarizeEvents(events: readonly UsageEvent[]): UsageTotals {
  const cumulative = events.filter(
    (event) => event.accountingRole === "cumulative_snapshot",
  );
  if (cumulative.length > 0) {
    const latest = cumulative.at(-1);
    if (latest !== undefined) {
      return {
        input: latest.inputTokens,
        output: latest.outputTokens,
        cached: latest.cachedInputTokens,
        reasoning: latest.reasoningOutputTokens,
        reportedTotal: latest.reportedTotalTokens,
        hasNegativeValues: latest.hasNegativeValues,
      };
    }
  }

  return events
    .filter((event) => event.accountingRole === "incremental")
    .reduce<UsageTotals>(
      (totals, event) => ({
        input: totals.input + event.inputTokens,
        output: totals.output + event.outputTokens,
        cached: totals.cached + event.cachedInputTokens,
        reasoning: totals.reasoning + event.reasoningOutputTokens,
        reportedTotal:
          totals.reportedTotal === null || event.reportedTotalTokens === null
            ? null
            : totals.reportedTotal + event.reportedTotalTokens,
        hasNegativeValues: totals.hasNegativeValues || event.hasNegativeValues,
      }),
      {
        input: 0,
        output: 0,
        cached: 0,
        reasoning: 0,
        reportedTotal: 0,
        hasNegativeValues: false,
      },
    );
}

export class CodexAdapter implements SessionAdapter {
  readonly provider = "codex" as const;
  readonly supportedFormats = [
    "Codex rollout JSONL: session_meta, turn_context, event_msg/token_count",
  ] as const;

  constructor(readonly logRoot = path.join(homedir(), ".codex", "sessions")) {}

  discoverSourceFiles(): Promise<string[]> {
    return discoverJsonlFiles(this.logRoot);
  }

  async parseFile(
    sourceFile: string,
    options: ParseFileOptions = {},
  ): Promise<ParsedLogFile> {
    let explicitProviderSessionId: string | undefined;
    let model: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let workingDirectory: string | undefined;
    let repositoryPath: string | undefined;
    let branch: string | undefined;
    const pendingEvents: Array<
      Omit<UsageEvent, "id" | "sessionId" | "eventType"> & {
        eventType: UsageEventType;
      }
    > = [];

    const readResult = await streamJsonlRecords(
      sourceFile,
      options.startOffset ?? 0,
      (entry, position) => {
        const payload = asRecord(entry.payload);
        const git = asRecord(payload?.git) ?? asRecord(entry.git);
        const info = asRecord(payload?.info);
        const totalUsage = asRecord(info?.total_token_usage);
        const lastUsage =
          asRecord(info?.last_token_usage) ??
          asRecord(payload?.usage) ??
          asRecord(entry.usage);

        explicitProviderSessionId ??= firstString(
          entry.type === "session_meta" ? payload?.id : undefined,
          payload?.session_id,
          entry.session_id,
          entry.sessionId,
          entry.type === "session_meta" ? entry.id : undefined,
        );
        model ??= firstString(
          payload?.model,
          asRecord(payload?.thread_settings)?.model,
          entry.model,
        );
        workingDirectory ??= firstString(
          payload?.cwd,
          asRecord(payload?.thread_settings)?.cwd,
          entry.cwd,
          payload?.working_directory,
        );
        repositoryPath ??= firstString(
          payload?.repository_path,
          git?.repository_path,
          git?.worktree_path,
        );
        branch ??= firstString(payload?.branch, git?.branch, entry.branch);

        const eventTime = toIsoTimestamp(entry.timestamp ?? payload?.timestamp);
        const bounds = updateTimestampBounds(startedAt, endedAt, eventTime);
        startedAt = bounds.start;
        endedAt = bounds.end;

        if (totalUsage === undefined && lastUsage === undefined) {
          return;
        }

        const providerEventId =
          firstString(entry.id, payload?.event_id, payload?.id) ?? null;
        const appendUsage = (
          usage: JsonRecord,
          eventType: UsageEventType,
          accountingRole: UsageEvent["accountingRole"],
        ): void => {
          const totals = usageTotals(usage);
          const estimatedCost =
            firstNumber(
              payload?.estimated_cost,
              info?.estimated_cost,
              usage.estimated_cost,
              entry.estimated_cost,
            ) ?? null;
          pendingEvents.push({
            sourceFile,
            sourceOffset: position.startOffset,
            eventTime: eventTime ?? null,
            eventType,
            accountingRole,
            isCanonical: false,
            providerEventId,
            snapshotSequence: position.startOffset,
            inputTokens: totals.input,
            outputTokens: totals.output,
            cachedInputTokens: totals.cached,
            reasoningOutputTokens: totals.reasoning,
            reportedTotalTokens: totals.reportedTotal,
            hasNegativeValues: totals.hasNegativeValues,
            estimatedCost,
          });
        };
        if (totalUsage !== undefined) {
          appendUsage(totalUsage, "cumulative", "cumulative_snapshot");
        }
        if (lastUsage !== undefined) {
          appendUsage(
            lastUsage,
            "incremental",
            totalUsage === undefined ? "incremental" : "informational",
          );
        }
      },
    );

    const providerSessionId =
      explicitProviderSessionId ??
      options.providerSessionIdHint ??
      fallbackProviderSessionId(this.provider, sourceFile);
    const sessionId = stableSessionId(this.provider, providerSessionId);
    const usageEvents = pendingEvents.map((event) => ({
      ...event,
      id: stableUsageEventId(
        this.provider,
        sourceFile,
        event.sourceOffset,
        event.accountingRole,
      ),
      sessionId,
    }));
    const usage = summarizeEvents(usageEvents);
    const cumulativeCosts = usageEvents
      .filter((event) => event.accountingRole === "cumulative_snapshot")
      .map((event) => event.estimatedCost)
      .filter((cost): cost is number => cost !== null);
    const estimatedCost =
      cumulativeCosts.length > 0 ? Math.max(...cumulativeCosts) : null;

    return {
      session: {
        id: sessionId,
        provider: this.provider,
        providerSessionId,
        model: model ?? "unknown",
        startedAt: startedAt ?? null,
        endedAt: endedAt ?? null,
        workingDirectory: workingDirectory ?? null,
        repositoryPath: repositoryPath ?? null,
        repositoryName: null,
        remoteUrl: null,
        branch: branch ?? null,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedInputTokens: usage.cached,
        uncachedInputTokens: Math.max(0, usage.input - usage.cached),
        estimatedCost,
        accountingMethod: usageEvents.some(
          (event) => event.accountingRole === "cumulative_snapshot",
        )
          ? "cumulative_snapshot"
          : usageEvents.some((event) => event.accountingRole === "incremental")
            ? "incremental_events"
            : "unavailable",
        accountingStatus: usage.hasNegativeValues ? "invalid" : "verified",
        accountingVersion: "codeoutcome-accounting-v1",
        lastUsageEventAt: usageEvents.at(-1)?.eventTime ?? endedAt ?? null,
        sourceFile,
        sourceFileHash: "",
        importedAt: null,
      },
      usageEvents,
      ...readResult,
      format: "codex-rollout-jsonl-v1",
    };
  }
}
