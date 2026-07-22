import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "./index.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/claude-code/session.jsonl", import.meta.url),
);
const unknownFixture = fileURLToPath(
  new URL("../../../../fixtures/claude-code/unknown.jsonl", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ClaudeCodeAdapter", () => {
  it("extracts metadata and usage without retaining message content", async () => {
    const parsed = await new ClaudeCodeAdapter().parseFile(fixture);

    expect(parsed.session).toMatchObject({
      provider: "claude-code",
      providerSessionId: "claude-fixture-001",
      model: "claude-test-model",
      branch: "main",
      inputTokens: 187,
      outputTokens: 60,
      cachedInputTokens: 17,
    });
    expect(parsed.usageEvents).toHaveLength(2);
    expect(JSON.stringify(parsed)).not.toContain("redacted prompt");
    expect(JSON.stringify(parsed)).not.toContain("redacted response");
  });

  it("falls back safely for unknown and malformed records", async () => {
    const parsed = await new ClaudeCodeAdapter().parseFile(unknownFixture);

    expect(parsed.session.providerSessionId).toMatch(/^generated:/);
    expect(parsed.session.model).toBe("unknown");
    expect(parsed.session.startedAt).toBeNull();
    expect(parsed.session.inputTokens).toBe(0);
    expect(parsed.malformedLines).toBe(1);
  });

  it("retains an incomplete trailing record for a later append", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codeoutcome-claude-"));
    temporaryDirectories.push(directory);
    const sourceFile = path.join(directory, "truncated.jsonl");
    const complete = `${JSON.stringify({
      type: "assistant",
      sessionId: "truncated-fixture",
      timestamp: "2026-01-02T00:00:00Z",
      message: { model: "test-model", usage: { input_tokens: 2 } },
    })}\n`;
    await writeFile(sourceFile, `${complete}{"type":"assistant"`, "utf8");

    const parsed = await new ClaudeCodeAdapter().parseFile(sourceFile);

    expect(parsed.truncated).toBe(true);
    expect(parsed.processedBytes).toBe(Buffer.byteLength(complete));
    expect(parsed.session.inputTokens).toBe(2);
  });
});
