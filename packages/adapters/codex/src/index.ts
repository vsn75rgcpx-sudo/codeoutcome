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
} from "@agentledger/shared";

interface UsageTotals {
  input: number;
  output: number;
  cached: number;
}

function tokenCount(record: JsonRecord | undefined, ...keys: string[]): number {
  return Math.trunc(firstNumber(...keys.map((key) => record?.[key])) ?? 0);
}

function usageTotals(record: JsonRecord | undefined): UsageTotals {
  return {
    input: tokenCount(record, "input_tokens", "inputTokens"),
    output: tokenCount(record, "output_tokens", "outputTokens"),
    cached: tokenCount(
      record,
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cachedInputTokens",
    ),
  };
}

function summarizeEvents(events: readonly UsageEvent[]): UsageTotals {
  const cumulative = events.filter((event) => event.eventType === "cumulative");
  if (cumulative.length > 0) {
    return cumulative.reduce<UsageTotals>(
      (totals, event) => ({
        input: Math.max(totals.input, event.inputTokens),
        output: Math.max(totals.output, event.outputTokens),
        cached: Math.max(totals.cached, event.cachedInputTokens),
      }),
      { input: 0, output: 0, cached: 0 },
    );
  }

  return events.reduce<UsageTotals>(
    (totals, event) => ({
      input: totals.input + event.inputTokens,
      output: totals.output + event.outputTokens,
      cached: totals.cached + event.cachedInputTokens,
    }),
    { input: 0, output: 0, cached: 0 },
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

        const eventType: UsageEventType | undefined =
          totalUsage !== undefined
            ? "cumulative"
            : lastUsage !== undefined
              ? "incremental"
              : undefined;
        const usage = totalUsage ?? lastUsage;
        if (eventType === undefined || usage === undefined) {
          return;
        }

        const totals = usageTotals(usage);
        const estimatedCost =
          firstNumber(
            payload?.estimated_cost,
            info?.estimated_cost,
            usage.estimated_cost,
            entry.estimated_cost,
          ) ?? null;
        if (
          totals.input === 0 &&
          totals.output === 0 &&
          totals.cached === 0 &&
          estimatedCost === null
        ) {
          return;
        }

        pendingEvents.push({
          sourceFile,
          sourceOffset: position.startOffset,
          eventTime: eventTime ?? null,
          eventType,
          inputTokens: totals.input,
          outputTokens: totals.output,
          cachedInputTokens: totals.cached,
          estimatedCost,
        });
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
        event.eventType,
      ),
      sessionId,
    }));
    const usage = summarizeEvents(usageEvents);
    const cumulativeCosts = usageEvents
      .filter((event) => event.eventType === "cumulative")
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
        estimatedCost,
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
