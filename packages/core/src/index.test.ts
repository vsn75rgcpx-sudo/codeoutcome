import { describe, expect, it } from "vitest";

import type { Session, SessionAdapter } from "@agentledger/shared";

import { collectSessions } from "./index.js";

const baseSession: Session = {
  id: "fixture",
  provider: "codex",
  model: "test-model",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  workingDirectory: null,
  repositoryPath: null,
  branch: null,
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  estimatedCost: null,
  sourceFile: "/redacted/fixture.jsonl",
};

describe("collectSessions", () => {
  it("isolates a broken source file and keeps valid sessions", async () => {
    const adapter: SessionAdapter = {
      provider: "codex",
      logRoot: "/redacted",
      async discoverSourceFiles() {
        return ["good", "bad"];
      },
      async parseFile(sourceFile) {
        if (sourceFile === "bad") {
          throw new Error("malformed fixture");
        }
        return baseSession;
      },
    };

    const result = await collectSessions([adapter]);

    expect(result.sessions).toEqual([baseSession]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.sourceFile).toBe("bad");
  });
});
