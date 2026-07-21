import { describe, expect, it } from "vitest";

import {
  runTrackedProvider,
  type ProviderProcessRunner,
} from "./provider-runner.js";

describe("provider process wrapper", () => {
  it("passes arguments without a shell and preserves a normal exit code", async () => {
    const calls: string[] = [];
    const runner: ProviderProcessRunner = async (
      executable,
      arguments_,
      options,
    ) => {
      expect(executable).toBe("fake-codex");
      expect(arguments_).toEqual(["--model", "fixture; touch forbidden"]);
      expect(options).toEqual({ shell: false, stdio: "inherit" });
      return { exitCode: 7, signal: null };
    };

    const code = await runTrackedProvider({
      executable: "fake-codex",
      arguments: ["--model", "fixture; touch forbidden"],
      processRunner: runner,
      startTracking: async () => {
        calls.push("start");
      },
      stopTracking: async (status) => {
        calls.push(`stop:${status}`);
      },
    });

    expect(code).toBe(7);
    expect(calls).toEqual(["start", "stop:failed"]);
  });

  it("marks SIGINT interrupted and returns the signal exit code", async () => {
    let stopped = "";
    const code = await runTrackedProvider({
      executable: "fake-codex",
      arguments: [],
      processRunner: async () => ({ exitCode: 130, signal: "SIGINT" }),
      startTracking: async () => undefined,
      stopTracking: async (status) => {
        stopped = status;
      },
    });

    expect(code).toBe(130);
    expect(stopped).toBe("interrupted");
  });

  it("still invokes finalization if process startup fails", async () => {
    let stopped = false;
    await expect(
      runTrackedProvider({
        executable: "missing-codex",
        arguments: [],
        processRunner: async () => {
          throw new Error("spawn failed");
        },
        startTracking: async () => undefined,
        stopTracking: async (status) => {
          expect(status).toBe("failed");
          stopped = true;
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(stopped).toBe(true);
  });

  it("preserves the provider exit code when best-effort finalization fails", async () => {
    let finalizationError: unknown;
    const code = await runTrackedProvider({
      executable: "fake-codex",
      arguments: [],
      processRunner: async () => ({ exitCode: 23, signal: null }),
      startTracking: async () => undefined,
      stopTracking: async () => {
        throw new Error("snapshot unavailable");
      },
      onFinalizationError: (error) => {
        finalizationError = error;
      },
    });

    expect(code).toBe(23);
    expect(finalizationError).toBeInstanceOf(Error);
  });
});
