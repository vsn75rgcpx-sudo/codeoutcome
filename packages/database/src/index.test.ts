import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Session } from "@agentledger/shared";

import { inspectDatabase, SessionDatabase } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SessionDatabase", () => {
  it("stores metadata fields and passes a read-only integrity inspection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-test-"));
    temporaryDirectories.push(directory);
    const databaseFile = path.join(directory, "session.sqlite");
    const session: Session = {
      id: "database-fixture",
      provider: "codex",
      model: "gpt-test-model",
      startedAt: null,
      endedAt: null,
      workingDirectory: "/redacted/project",
      repositoryPath: "/redacted/project",
      branch: "main",
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 3,
      estimatedCost: null,
      sourceFile: "/redacted/session.jsonl",
    };

    const database = new SessionDatabase(databaseFile);
    database.upsertSessions([session]);
    expect(database.listSessions()).toEqual([session]);
    database.close();

    expect(inspectDatabase(databaseFile).ok).toBe(true);
  });
});
