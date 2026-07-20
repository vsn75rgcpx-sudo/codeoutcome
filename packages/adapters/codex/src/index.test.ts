import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CodexAdapter } from "./index.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/codex/session.jsonl", import.meta.url),
);

describe("CodexAdapter", () => {
  it("uses the latest cumulative usage snapshot", async () => {
    const parsed = await new CodexAdapter().parseFile(fixture);

    expect(parsed.session).toMatchObject({
      provider: "codex",
      providerSessionId: "codex-fixture-001",
      model: "gpt-test-model",
      branch: "feature/fixture",
      inputTokens: 250,
      outputTokens: 44,
      cachedInputTokens: 50,
    });
    expect(parsed.usageEvents).toHaveLength(2);
    expect(
      parsed.usageEvents.every((event) => event.eventType === "cumulative"),
    ).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("redacted response");
  });

  it("uses safe defaults for a missing session id and unknown model", async () => {
    const parsed = await new CodexAdapter().parseFile(
      fileURLToPath(
        new URL(
          "../../../../fixtures/codex/unknown-model.jsonl",
          import.meta.url,
        ),
      ),
    );

    expect(parsed.session.providerSessionId).toMatch(/^generated:/);
    expect(parsed.session.model).toBe("unknown");
    expect(parsed.session.inputTokens).toBe(8);
    expect(parsed.session.cachedInputTokens).toBe(3);
  });
});
