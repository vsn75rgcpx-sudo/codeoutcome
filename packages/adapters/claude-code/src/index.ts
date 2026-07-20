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

function valueFrom(record: JsonRecord | undefined, keys: string[]): unknown[] {
  return keys.map((key) => record?.[key]);
}

function tokenCount(record: JsonRecord | undefined, ...keys: string[]): number {
  return Math.trunc(firstNumber(...valueFrom(record, keys)) ?? 0);
}

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly provider = "claude-code" as const;

  constructor(readonly logRoot = path.join(homedir(), ".claude", "projects")) {}

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
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let estimatedCost: number | undefined;

    for await (const entry of readJsonlRecords(sourceFile)) {
      const message = asRecord(entry.message);
      const usage = asRecord(message?.usage) ?? asRecord(entry.usage);
      const git = asRecord(entry.git);

      id ??= firstString(entry.sessionId, entry.session_id, entry.session);
      model ??= firstString(message?.model, entry.model);
      workingDirectory ??= firstString(entry.cwd, entry.workingDirectory);
      repositoryPath ??= firstString(
        entry.repositoryPath,
        entry.repository_path,
        git?.repositoryPath,
        git?.root,
      );
      branch ??= firstString(entry.gitBranch, entry.branch, git?.branch);

      const bounds = updateTimestampBounds(
        startedAt,
        endedAt,
        toIsoTimestamp(entry.timestamp ?? message?.timestamp),
      );
      startedAt = bounds.start;
      endedAt = bounds.end;

      inputTokens += tokenCount(usage, "input_tokens", "inputTokens");
      outputTokens += tokenCount(usage, "output_tokens", "outputTokens");
      cachedInputTokens += tokenCount(
        usage,
        "cache_read_input_tokens",
        "cached_input_tokens",
        "cachedInputTokens",
      );

      const cost = firstNumber(
        entry.estimated_cost,
        entry.cost_usd,
        entry.costUSD,
      );
      if (cost !== undefined) {
        estimatedCost = Math.max(estimatedCost ?? 0, cost);
      }
    }

    return {
      id: id ?? fallbackSessionId(sourceFile),
      provider: this.provider,
      model: model ?? "unknown",
      startedAt: startedAt ?? null,
      endedAt: endedAt ?? null,
      workingDirectory: workingDirectory ?? null,
      repositoryPath: repositoryPath ?? null,
      branch: branch ?? null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      estimatedCost: estimatedCost ?? null,
      sourceFile,
    };
  }
}
