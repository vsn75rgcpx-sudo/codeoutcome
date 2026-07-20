import { describe, expect, it } from "vitest";

import type {
  ParsedLogFile,
  Session,
  SessionAdapter,
  UsageEvent,
} from "@agentledger/shared";

import {
  accountUsageEvents,
  buildUsageReport,
  collectSessions,
} from "./index.js";

const baseSession: Session = {
  id: "fixture",
  provider: "codex",
  providerSessionId: "provider-fixture",
  model: "test-model",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  workingDirectory: null,
  repositoryPath: null,
  repositoryName: null,
  remoteUrl: null,
  branch: null,
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  estimatedCost: null,
  sourceFile: "/redacted/fixture.jsonl",
  sourceFileHash: "fixture-hash",
  importedAt: "2026-01-01T00:02:00.000Z",
};

function parsedLog(session: Session): ParsedLogFile {
  return {
    session,
    usageEvents: [],
    processedBytes: 0,
    fileSize: 0,
    malformedLines: 0,
    truncated: false,
    format: "test",
  };
}

describe("collectSessions", () => {
  it("isolates a broken source file and keeps valid sessions", async () => {
    const adapter: SessionAdapter = {
      provider: "codex",
      logRoot: "/redacted",
      supportedFormats: ["fixture"],
      async discoverSourceFiles() {
        return ["good", "bad"];
      },
      async parseFile(sourceFile) {
        if (sourceFile === "bad") {
          throw new Error("malformed fixture");
        }
        return parsedLog(baseSession);
      },
    };

    const result = await collectSessions([adapter]);

    expect(result.sessions).toEqual([baseSession]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.sourceFile).toBe("bad");
  });
});

describe("usage accounting", () => {
  it("uses cumulative snapshots without adding historical totals twice", () => {
    const events: UsageEvent[] = [100, 250].map((inputTokens, index) => ({
      id: `event-${index}`,
      sessionId: "session",
      sourceFile: "/redacted/session.jsonl",
      sourceOffset: index,
      eventTime: `2026-01-01T00:0${index}:00.000Z`,
      eventType: "cumulative",
      inputTokens,
      outputTokens: index === 0 ? 10 : 30,
      cachedInputTokens: index === 0 ? 20 : 50,
      estimatedCost: null,
    }));

    expect(accountUsageEvents(events, "unknown-model")).toMatchObject({
      inputTokens: 250,
      outputTokens: 30,
      cachedInputTokens: 50,
      estimatedCost: null,
    });
  });

  it("does not add cached input to total tokens a second time", () => {
    const report = buildUsageReport([baseSession], "weekly");

    expect(report.totals.totalTokens).toBe(2);
    expect(report.totals.cost.status).toBe("unavailable");
    expect(report.byDate[0]?.key).toBe("2026-W01");
    expect(report.pricing.version).toBe("local-unpriced-v1");
  });
});
