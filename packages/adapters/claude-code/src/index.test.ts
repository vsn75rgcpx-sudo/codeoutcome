import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "./index.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/claude-code/session.jsonl", import.meta.url),
);
const unknownFixture = fileURLToPath(
  new URL("../../../../fixtures/claude-code/unknown.jsonl", import.meta.url),
);

describe("ClaudeCodeAdapter", () => {
  it("extracts metadata and usage without retaining message content", async () => {
    const session = await new ClaudeCodeAdapter().parseFile(fixture);

    expect(session).toMatchObject({
      id: "claude-fixture-001",
      provider: "claude-code",
      model: "claude-test-model",
      branch: "main",
      inputTokens: 170,
      outputTokens: 60,
      cachedInputTokens: 17,
    });
    expect(JSON.stringify(session)).not.toContain("redacted prompt");
  });

  it("falls back safely for unknown and malformed records", async () => {
    const session = await new ClaudeCodeAdapter().parseFile(unknownFixture);

    expect(session.id).toBe("unknown");
    expect(session.model).toBe("unknown");
    expect(session.startedAt).toBeNull();
    expect(session.inputTokens).toBe(0);
  });
});
