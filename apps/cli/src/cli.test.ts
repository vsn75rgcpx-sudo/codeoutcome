import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "@agentledger/adapter-claude-code";

import { runCli, type CliIo } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

describe("CLI JSON output", () => {
  it("imports private logs and emits metadata-only sessions and weekly usage", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-cli-"));
    temporaryDirectories.push(directory);
    const logs = path.join(directory, "logs");
    await mkdir(logs);
    await writeFile(
      path.join(logs, "session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "cli-fixture",
        timestamp: "2026-01-10T00:00:00.000Z",
        message: {
          model: "unknown-cli-model",
          content: "secret response fixture",
          usage: {
            input_tokens: 20,
            output_tokens: 4,
            cache_read_input_tokens: 5,
          },
        },
      })}\n`,
      "utf8",
    );
    const databaseFile = path.join(directory, "agentledger.sqlite");
    const adapter = new ClaudeCodeAdapter(logs);
    const clock = () => new Date("2026-01-15T00:00:00.000Z");

    const importOutput = memoryIo();
    expect(
      await runCli(["import", "--provider", "claude-code", "--json"], {
        adapters: [adapter],
        databaseFile,
        io: importOutput.io,
        now: clock,
        userHome: directory,
      }),
    ).toBe(0);
    expect(JSON.parse(importOutput.stdout[0] ?? "{}")).toMatchObject({
      status: "completed",
      importedSessions: 1,
    });

    const sessionsOutput = memoryIo();
    await runCli(
      [
        "sessions",
        "--provider",
        "claude-code",
        "--since",
        "7d",
        "--limit",
        "10",
        "--json",
      ],
      {
        databaseFile,
        io: sessionsOutput.io,
        now: clock,
        userHome: directory,
      },
    );
    const sessions: unknown = JSON.parse(sessionsOutput.stdout[0] ?? "[]");
    expect(sessions).toMatchObject([
      {
        provider: "claude-code",
        model: "unknown-cli-model",
        inputTokens: 25,
        cachedInputTokens: 5,
        sourceFile: "~/logs/session.jsonl",
      },
    ]);

    const usageOutput = memoryIo();
    await runCli(["usage", "--weekly", "--json"], {
      databaseFile,
      io: usageOutput.io,
      now: clock,
      userHome: directory,
    });
    const usage = JSON.parse(usageOutput.stdout[0] ?? "{}");
    expect(usage).toMatchObject({
      period: "weekly",
      totals: {
        sessions: 1,
        inputTokens: 25,
        outputTokens: 4,
        totalTokens: 29,
      },
      pricing: { version: "local-unpriced-v1" },
    });
    expect(
      `${sessionsOutput.stdout.join("\n")}\n${usageOutput.stdout.join("\n")}`,
    ).not.toContain("secret response fixture");
  });
});
