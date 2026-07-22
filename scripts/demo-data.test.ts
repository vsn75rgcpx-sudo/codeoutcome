import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { seedDemoDatabase } from "./demo-data.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("deterministic demo database", () => {
  it("creates the complete synthetic Phase 4B dataset deterministically", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-demo-"));
    directories.push(directory);
    const first = seedDemoDatabase(path.join(directory, "first.sqlite"));
    const second = seedDemoDatabase(path.join(directory, "second.sqlite"));
    expect(first).toMatchObject({
      repositories: 4,
      sessions: 12,
      trackingRuns: 6,
      gitSnapshots: 12,
      gitFileStats: 7,
      testRuns: 8,
      quickCheck: "ok",
    });
    expect(second.logicalFingerprint).toBe(first.logicalFingerprint);
  });

  it("contains no user names, home paths, prompts, responses, or source bodies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-demo-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "demo.sqlite");
    seedDemoDatabase(databaseFile);
    const bytes = await readFile(databaseFile);
    const text = bytes.toString("utf8");
    expect(text).toContain("agentledger-demo");
    expect(text).not.toContain(homedir());
    expect(text).not.toContain(userInfo().username);
    expect(text).not.toMatch(
      /\/Users\/|\.codex|\.claude|prompt body|response body|api[_ -]?key|cookie/i,
    );
  });
});
