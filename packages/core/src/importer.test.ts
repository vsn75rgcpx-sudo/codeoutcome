import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "@agentledger/adapter-claude-code";
import { SessionDatabase } from "@agentledger/database";

import { runImport } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function claudeRecord(
  timestamp: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  content: string,
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "incremental-fixture",
    timestamp,
    message: {
      model: "unknown-local-model",
      content,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
      },
    },
  });
}

describe("runImport", () => {
  it("is idempotent and imports only an appended JSONL tail", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-import-"));
    temporaryDirectories.push(directory);
    const logDirectory = path.join(directory, "logs");
    const sourceFile = path.join(logDirectory, "session.jsonl");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      sourceFile,
      `${claudeRecord("2026-01-01T00:00:00Z", 10, 3, 1, "private prompt body")}\n`,
      "utf8",
    );
    const database = new SessionDatabase(
      path.join(directory, "agentledger.sqlite"),
    );
    const adapter = new ClaudeCodeAdapter(logDirectory);

    const first = await runImport({
      adapters: [adapter],
      database,
      provider: "claude-code",
    });
    const duplicate = await runImport({
      adapters: [adapter],
      database,
      provider: "claude-code",
    });
    await appendFile(
      sourceFile,
      `${claudeRecord("2026-01-01T00:01:00Z", 5, 2, 2, "private reply body")}\n`,
      "utf8",
    );
    const appended = await runImport({
      adapters: [adapter],
      database,
      provider: "claude-code",
    });

    expect(first.importedSessions).toBe(1);
    expect(duplicate.skippedSessions).toBe(1);
    expect(database.usageEventCount()).toBe(2);
    expect(appended.appendedFiles).toBe(1);
    expect(appended.updatedSessions).toBe(1);
    expect(database.listSessions()[0]).toMatchObject({
      inputTokens: 18,
      outputTokens: 5,
      cachedInputTokens: 3,
      estimatedCost: null,
    });
    expect(JSON.stringify(database.listSessions())).not.toContain(
      "private prompt body",
    );
    expect(JSON.stringify(database.listSessions())).not.toContain(
      "private reply body",
    );
    database.close();
  });

  it("reports an empty provider source as a warning in dry-run mode", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-empty-"));
    temporaryDirectories.push(directory);

    const report = await runImport({
      adapters: [new ClaudeCodeAdapter(directory)],
      database: null,
      provider: "claude-code",
      dryRun: true,
    });

    expect(report.status).toBe("partial");
    expect(report.warnings[0]?.message).toContain("no readable JSONL");
  });
});
