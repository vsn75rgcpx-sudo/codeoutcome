import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CodexAdapter } from "./index.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/codex/session.jsonl", import.meta.url),
);

describe("CodexAdapter", () => {
  it("uses the latest cumulative usage snapshot", async () => {
    const session = await new CodexAdapter().parseFile(fixture);

    expect(session).toMatchObject({
      id: "codex-fixture-001",
      provider: "codex",
      model: "gpt-test-model",
      branch: "feature/fixture",
      inputTokens: 250,
      outputTokens: 44,
      cachedInputTokens: 50,
    });
    expect(JSON.stringify(session)).not.toContain("redacted response");
  });
});
