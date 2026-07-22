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
} from "@codeoutcome/shared";

function valueFrom(record: JsonRecord | undefined, keys: string[]): unknown[] {
  return keys.map((key) => record?.[key]);
}

function tokenCount(record: JsonRecord | undefined, ...keys: string[]): number {
  return Math.trunc(firstNumber(...valueFrom(record, keys)) ?? 0);
}

function hasNegativeTokenValue(
  record: JsonRecord | undefined,
  keys: string[],
): boolean {
  return keys.some((key) => {
    const value = record?.[key];
    return typeof value === "number" && Number.isFinite(value) && value < 0;
  });
}

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly provider = "claude-code" as const;
  readonly supportedFormats = [
    "Claude Code project JSONL: user/assistant records with message.usage",
  ] as const;

  constructor(readonly logRoot = path.join(homedir(), ".claude", "projects")) {}

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
    const pendingEvents: Array<Omit<UsageEvent, "id" | "sessionId">> = [];

    const readResult = await streamJsonlRecords(
      sourceFile,
      options.startOffset ?? 0,
      (entry, position) => {
        const message = asRecord(entry.message);
        const usage = asRecord(message?.usage) ?? asRecord(entry.usage);
        const git = asRecord(entry.git);

        explicitProviderSessionId ??= firstString(
          entry.sessionId,
          entry.session_id,
          entry.session,
        );
        model ??= firstString(message?.model, entry.model);
        workingDirectory ??= firstString(entry.cwd, entry.workingDirectory);
        repositoryPath ??= firstString(
          entry.repositoryPath,
          entry.repository_path,
          git?.repositoryPath,
          git?.root,
        );
        branch ??= firstString(entry.gitBranch, entry.branch, git?.branch);

        const eventTime = toIsoTimestamp(entry.timestamp ?? message?.timestamp);
        const bounds = updateTimestampBounds(startedAt, endedAt, eventTime);
        startedAt = bounds.start;
        endedAt = bounds.end;

        if (usage === undefined) {
          return;
        }

        const cachedInputTokens = tokenCount(
          usage,
          "cache_read_input_tokens",
          "cached_input_tokens",
          "cachedInputTokens",
        );
        const inputTokens =
          tokenCount(usage, "input_tokens", "inputTokens") +
          tokenCount(
            usage,
            "cache_creation_input_tokens",
            "cache_write_input_tokens",
          ) +
          cachedInputTokens;
        const outputTokens = tokenCount(usage, "output_tokens", "outputTokens");
        const estimatedCost =
          firstNumber(usage.estimated_cost, usage.cost_usd, usage.costUSD) ??
          null;

        if (
          inputTokens === 0 &&
          outputTokens === 0 &&
          cachedInputTokens === 0 &&
          estimatedCost === null
        ) {
          return;
        }

        pendingEvents.push({
          sourceFile,
          sourceOffset: position.startOffset,
          eventTime: eventTime ?? null,
          eventType: "incremental",
          accountingRole: "incremental",
          isCanonical: false,
          providerEventId: firstString(entry.uuid, entry.event_id) ?? null,
          snapshotSequence: position.startOffset,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningOutputTokens: tokenCount(usage, "reasoning_output_tokens"),
          reportedTotalTokens:
            firstNumber(usage.total_tokens, usage.totalTokens) ?? null,
          hasNegativeValues: hasNegativeTokenValue(usage, [
            "input_tokens",
            "inputTokens",
            "output_tokens",
            "outputTokens",
            "cache_read_input_tokens",
            "cached_input_tokens",
            "cachedInputTokens",
            "cache_creation_input_tokens",
            "cache_write_input_tokens",
            "reasoning_output_tokens",
            "total_tokens",
            "totalTokens",
          ]),
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
    const inputTokens = usageEvents.reduce(
      (total, event) => total + event.inputTokens,
      0,
    );
    const outputTokens = usageEvents.reduce(
      (total, event) => total + event.outputTokens,
      0,
    );
    const cachedInputTokens = usageEvents.reduce(
      (total, event) => total + event.cachedInputTokens,
      0,
    );
    const costs = usageEvents
      .map((event) => event.estimatedCost)
      .filter((cost): cost is number => cost !== null);

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
        inputTokens,
        outputTokens,
        cachedInputTokens,
        uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
        estimatedCost:
          costs.length === usageEvents.length && costs.length > 0
            ? costs.reduce((total, cost) => total + cost, 0)
            : null,
        accountingMethod:
          usageEvents.length > 0 ? "incremental_events" : "unavailable",
        accountingStatus: usageEvents.some((event) => event.hasNegativeValues)
          ? "invalid"
          : "verified",
        accountingVersion: "codeoutcome-accounting-v1",
        lastUsageEventAt: usageEvents.at(-1)?.eventTime ?? endedAt ?? null,
        sourceFile,
        sourceFileHash: "",
        importedAt: null,
      },
      usageEvents,
      ...readResult,
      format: "claude-code-project-jsonl-v1",
    };
  }
}
