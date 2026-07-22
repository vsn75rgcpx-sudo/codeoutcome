import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAdapter } from "@codeoutcome/adapter-codex";
import {
  REPARSE_REQUIRED_CHECKPOINT,
  SessionDatabase,
} from "@codeoutcome/database";

import { runImport } from "./importer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sessionMeta(sessionId: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId },
  });
}

function tokenEvent(
  eventId: string,
  timestamp: string,
  total: number | null,
  last: number,
): string {
  return JSON.stringify({
    id: eventId,
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        ...(total === null
          ? {}
          : {
              total_token_usage: {
                input_tokens: total,
                cached_input_tokens: Math.floor(total / 2),
                output_tokens: Math.floor(total / 10),
                reasoning_output_tokens: Math.floor(total / 20),
                total_tokens: total + Math.floor(total / 10),
              },
            }),
        last_token_usage: {
          input_tokens: last,
          cached_input_tokens: Math.floor(last / 2),
          output_tokens: Math.floor(last / 10),
          reasoning_output_tokens: Math.floor(last / 20),
          total_tokens: last + Math.floor(last / 10),
        },
      },
    },
  });
}

async function fixture(): Promise<{
  database: SessionDatabase;
  databaseFile: string;
  adapter: CodexAdapter;
  sourceFile: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codeoutcome-codex-import-"),
  );
  temporaryDirectories.push(directory);
  const logs = path.join(directory, "logs");
  const databaseFile = path.join(directory, "test.sqlite");
  await mkdir(logs);
  return {
    database: new SessionDatabase(databaseFile),
    databaseFile,
    adapter: new CodexAdapter(logs),
    sourceFile: path.join(logs, "session.jsonl"),
  };
}

describe("Codex incremental import", () => {
  it("replaces the canonical cumulative snapshot on append and rebuilds a rewrite", async () => {
    const { database, adapter, sourceFile } = await fixture();
    await writeFile(
      sourceFile,
      `${sessionMeta("cumulative-session")}\n${tokenEvent(
        "event-1",
        "2026-01-01T00:01:00.000Z",
        100,
        100,
      )}\n`,
      "utf8",
    );
    await runImport({ adapters: [adapter], database, provider: "codex" });
    await appendFile(
      sourceFile,
      `${tokenEvent("event-2", "2026-01-01T00:02:00.000Z", 150, 50)}\n`,
      "utf8",
    );

    const appended = await runImport({
      adapters: [adapter],
      database,
      provider: "codex",
    });
    const afterAppend = database.listSessions()[0];
    expect(appended.appendedFiles).toBe(1);
    expect(afterAppend).toMatchObject({
      inputTokens: 150,
      cachedInputTokens: 75,
      outputTokens: 15,
      accountingMethod: "cumulative_snapshot",
    });
    expect(database.usageEventCount()).toBe(4);

    await writeFile(
      sourceFile,
      `${sessionMeta("cumulative-session")}\n${tokenEvent(
        "event-rewritten",
        "2026-01-01T00:01:00.000Z",
        80,
        80,
      )}\n`,
      "utf8",
    );
    const rewritten = await runImport({
      adapters: [adapter],
      database,
      provider: "codex",
    });

    expect(rewritten.rewrittenFiles).toBe(1);
    expect(database.listSessions()[0]?.inputTokens).toBe(80);
    expect(database.usageEventCount()).toBe(2);
    database.close();
  });

  it("adds last-only increments once and keeps a repeated import unchanged", async () => {
    const { database, adapter, sourceFile } = await fixture();
    await writeFile(
      sourceFile,
      `${sessionMeta("incremental-session")}\n${tokenEvent(
        "event-1",
        "2026-01-01T00:01:00.000Z",
        null,
        10,
      )}\n`,
      "utf8",
    );
    await runImport({ adapters: [adapter], database, provider: "codex" });
    await appendFile(
      sourceFile,
      `${tokenEvent("event-2", "2026-01-01T00:02:00.000Z", null, 15)}\n`,
      "utf8",
    );
    await runImport({ adapters: [adapter], database, provider: "codex" });
    const beforeRepeat = database.listSessions()[0];

    const repeated = await runImport({
      adapters: [adapter],
      database,
      provider: "codex",
    });

    expect(beforeRepeat).toMatchObject({
      inputTokens: 25,
      outputTokens: 2,
      accountingMethod: "incremental_events",
    });
    expect(repeated.skippedSessions).toBe(1);
    expect(database.listSessions()[0]).toEqual(beforeRepeat);
    expect(database.usageEventCount()).toBe(2);
    database.close();
  });

  it("honors the migration reparse marker even when size and mtime are unchanged", async () => {
    const { database, databaseFile, adapter, sourceFile } = await fixture();
    await writeFile(
      sourceFile,
      `${sessionMeta("migration-reparse-session")}\n${tokenEvent(
        "event-1",
        "2026-01-01T00:01:00.000Z",
        100,
        20,
      )}\n`,
      "utf8",
    );
    await runImport({ adapters: [adapter], database, provider: "codex" });

    const direct = new DatabaseSync(databaseFile);
    direct
      .prepare("UPDATE source_files SET processed_hash = ?")
      .run(REPARSE_REQUIRED_CHECKPOINT);
    direct.close();

    const reparsed = await runImport({
      adapters: [adapter],
      database,
      provider: "codex",
    });

    expect(reparsed.rewrittenFiles).toBe(1);
    expect(reparsed.importedEvents).toBe(2);
    expect(database.usageEventCount()).toBe(2);
    expect(database.listSessions()[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      accountingMethod: "cumulative_snapshot",
    });
    database.close();
  });
});
