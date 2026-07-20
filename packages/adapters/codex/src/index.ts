import { homedir } from "node:os";
import path from "node:path";

import {
  asRecord,
  discoverJsonlFiles,
  fallbackSessionId,
  firstNumber,
  firstString,
  readJsonlRecords,
  toIsoTimestamp,
  updateTimestampBounds,
  type JsonRecord,
  type Session,
  type SessionAdapter,
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

export class CodexAdapter implements SessionAdapter {
  readonly provider = "codex" as const;

  constructor(readonly logRoot = path.join(homedir(), ".codex", "sessions")) {}

  discoverSourceFiles(): Promise<string[]> {
    return discoverJsonlFiles(this.logRoot);
  }

  async parseFile(sourceFile: string): Promise<Session> {
    let id: string | undefined;
    let model: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let workingDirectory: string | undefined;
    let repositoryPath: string | undefined;
    let branch: string | undefined;
    let cumulativeUsage: UsageTotals | undefined;
    const incrementalUsage: UsageTotals = { input: 0, output: 0, cached: 0 };
    let estimatedCost: number | undefined;

    for await (const entry of readJsonlRecords(sourceFile)) {
      const payload = asRecord(entry.payload);
      const git = asRecord(payload?.git) ?? asRecord(entry.git);
      const info = asRecord(payload?.info);
      const totalUsage = asRecord(info?.total_token_usage);
      const lastUsage =
        asRecord(info?.last_token_usage) ??
        asRecord(payload?.usage) ??
        asRecord(entry.usage);

      id ??= firstString(
        payload?.id,
        entry.session_id,
        entry.sessionId,
        entry.id,
      );
      model ??= firstString(payload?.model, entry.model);
      workingDirectory ??= firstString(
        payload?.cwd,
        entry.cwd,
        payload?.working_directory,
      );
      repositoryPath ??= firstString(
        payload?.repository_path,
        git?.repository_path,
        git?.worktree_path,
      );
      branch ??= firstString(payload?.branch, git?.branch, entry.branch);

      const bounds = updateTimestampBounds(
        startedAt,
        endedAt,
        toIsoTimestamp(entry.timestamp ?? payload?.timestamp),
      );
      startedAt = bounds.start;
      endedAt = bounds.end;

      if (totalUsage !== undefined) {
        const snapshot = usageTotals(totalUsage);
        cumulativeUsage = {
          input: Math.max(cumulativeUsage?.input ?? 0, snapshot.input),
          output: Math.max(cumulativeUsage?.output ?? 0, snapshot.output),
          cached: Math.max(cumulativeUsage?.cached ?? 0, snapshot.cached),
        };
      } else if (lastUsage !== undefined) {
        const usage = usageTotals(lastUsage);
        incrementalUsage.input += usage.input;
        incrementalUsage.output += usage.output;
        incrementalUsage.cached += usage.cached;
      }

      const cost = firstNumber(
        payload?.estimated_cost,
        info?.estimated_cost,
        entry.estimated_cost,
      );
      if (cost !== undefined) {
        estimatedCost = Math.max(estimatedCost ?? 0, cost);
      }
    }

    const usage = cumulativeUsage ?? incrementalUsage;
    return {
      id: id ?? fallbackSessionId(sourceFile),
      provider: this.provider,
      model: model ?? "unknown",
      startedAt: startedAt ?? null,
      endedAt: endedAt ?? null,
      workingDirectory: workingDirectory ?? null,
      repositoryPath: repositoryPath ?? null,
      branch: branch ?? null,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cached,
      estimatedCost: estimatedCost ?? null,
      sourceFile,
    };
  }
}
