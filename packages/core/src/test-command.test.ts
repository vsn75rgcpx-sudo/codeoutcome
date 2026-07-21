import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionDatabase } from "@agentledger/database";
import type { CapturedGitSnapshot } from "@agentledger/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  runTestCommand,
  safeTestCommand,
  type TestProcessRunner,
} from "./test-command.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentledger-test-command-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function database(directory: string): SessionDatabase {
  return new SessionDatabase(path.join(directory, "agentledger.sqlite"));
}

function snapshot(workingDirectory: string): CapturedGitSnapshot {
  return {
    id: randomUUID(),
    repositoryPath: workingDirectory,
    capturedAt: "2026-07-21T00:00:00.000Z",
    trigger: "tracking_start",
    privacyMode: "git-metadata",
    workingDirectory,
    headCommit: "a".repeat(40),
    branch: "main",
    isDetachedHead: false,
    isUnbornBranch: false,
    isDirty: false,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    aheadCount: 0,
    behindCount: 0,
    gitVersion: "git version fixture",
    fileStats: [],
  };
}

function addActiveRun(
  store: SessionDatabase,
  workingDirectory: string,
  id = randomUUID(),
): string {
  const start = snapshot(workingDirectory);
  store.startTrackingRun({
    id,
    provider: "codex",
    label: "fixture",
    workingDirectory,
    repository: {
      canonicalPath: workingDirectory,
      name: path.basename(workingDirectory),
      remoteUrl: null,
    },
    startSnapshot: start,
    startedAt: start.capturedAt,
    createdAt: start.capturedAt,
  });
  return id;
}

function clock(): () => Date {
  const values = [
    new Date("2026-07-21T00:00:00.000Z"),
    new Date("2026-07-21T00:00:01.250Z"),
  ];
  return () => values.shift() ?? new Date("2026-07-21T00:00:02.000Z");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("safe test command wrapper", () => {
  it("records a generic zero exit without persisting stdout or stderr", async () => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    const runner: TestProcessRunner = async (
      executable,
      arguments_,
      options,
    ) => {
      expect(executable).toBe("fixture test");
      expect(arguments_).toEqual(["value with spaces", "雪"]);
      expect(options.shell).toBe(false);
      options.stdout(Buffer.from("private stdout\n"));
      options.stderr(Buffer.from("private stderr and stack\n"));
      return { exitCode: 0, signal: null };
    };
    const result = await runTestCommand({
      database: store,
      executable: "fixture test",
      arguments: ["value with spaces", "雪"],
      workingDirectory: directory,
      now: clock(),
      processRunner: runner,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.testRun).toMatchObject({
      status: "completed",
      outcome: "passed",
      parserStatus: "exit_code_only",
      durationMs: 1250,
    });
    expect(JSON.stringify(result.testRun)).not.toContain("private stdout");
    expect(JSON.stringify(result.testRun)).not.toContain("private stderr");
    expect(result.testRun.warnings).toContain(
      "framework_detection:no_supported_framework_evidence",
    );
    store.close();
  });

  it("preserves nonzero exit codes and does not pass arguments through a shell", async () => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    const injected = `; touch ${path.join(directory, "forbidden")}`;
    const result = await runTestCommand({
      database: store,
      executable: "fake",
      arguments: [injected],
      workingDirectory: directory,
      framework: "generic",
      now: clock(),
      processRunner: async (_executable, arguments_, options) => {
        expect(arguments_).toEqual([injected]);
        expect(options.shell).toBe(false);
        return { exitCode: 23, signal: null };
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(result.exitCode).toBe(23);
    expect(result.testRun).toMatchObject({
      outcome: "errored",
      failedTests: null,
    });
    store.close();
  });

  it("uses the real direct-spawn path without interpreting shell metacharacters", async () => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    const script = path.join(directory, "fixture runner.mjs");
    const marker = path.join(directory, "must-not-exist");
    await writeFile(
      script,
      "process.exit(process.argv[2] === 'value with spaces' ? 0 : 4);\n",
    );
    const result = await runTestCommand({
      database: store,
      executable: process.execPath,
      arguments: [script, "value with spaces", `; touch ${marker}`],
      workingDirectory: directory,
      framework: "generic",
      now: clock(),
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    store.close();
  });

  it("records command-not-found without inventing an exit code in storage", async () => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    const result = await runTestCommand({
      database: store,
      executable: "missing-fixture",
      arguments: [],
      workingDirectory: directory,
      now: clock(),
      processRunner: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(result.exitCode).toBe(127);
    expect(result.testRun).toMatchObject({
      status: "failed_to_start",
      outcome: "unknown",
      exitCode: null,
    });
    expect(result.testRun.warnings).toContain(
      "test_process_failed_to_start:ENOENT",
    );
    store.close();
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("records %s interruption", async (signal, exitCode) => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    const result = await runTestCommand({
      database: store,
      executable: "fake",
      arguments: [],
      workingDirectory: directory,
      now: clock(),
      processRunner: async () => ({ exitCode, signal }),
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(result.exitCode).toBe(exitCode);
    expect(result.testRun).toMatchObject({
      status: "interrupted",
      outcome: "interrupted",
      terminationSignal: signal,
    });
    store.close();
  });

  it("redacts secret-like arguments and strict mode hides every argument", () => {
    const regular = safeTestCommand(
      "/usr/local/bin/runner",
      ["--token", "secret-value", "API_KEY=also-secret", "safe"],
      "git-metadata",
    );
    expect(regular.commandDisplay).toBe(
      "runner --token <redacted> API_KEY=<redacted> safe",
    );
    expect(regular.commandDisplay).not.toContain("secret-value");
    expect(regular.containsSensitiveArguments).toBe(true);
    const strict = safeTestCommand(
      "/usr/local/bin/runner",
      ["private", "values"],
      "strict",
    );
    expect(strict.commandDisplay).toBe("runner");
    expect(strict.commandFingerprint).toHaveLength(64);
    const inlineCode = safeTestCommand(
      "node",
      ["-e", "console.log('source')"],
      "git-metadata",
    );
    expect(inlineCode.commandDisplay).toBe("node -e <redacted-code>");
    expect(inlineCode.commandDisplay).not.toContain("console.log");
    const auth = safeTestCommand(
      "runner",
      [
        "Authorization: Bearer private",
        "https://example.invalid/?access_token=private",
      ],
      "git-metadata",
    );
    expect(auth.commandDisplay).toBe(
      "runner Authorization:<redacted> <redacted-url>",
    );
    expect(auth.commandDisplay).not.toContain("private");
  });

  it("marks bounded output capture as truncated while continuing terminal forwarding", async () => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    let forwarded = 0;
    const result = await runTestCommand({
      database: store,
      executable: "fake",
      arguments: [],
      workingDirectory: directory,
      framework: "generic",
      outputCaptureLimit: 8,
      now: clock(),
      processRunner: async (_executable, _arguments, options) => {
        options.stdout(Buffer.from("12345678901234567890"));
        return { exitCode: 0, signal: null };
      },
      writeStdout: (chunk) => {
        forwarded += chunk.length;
      },
      writeStderr: () => undefined,
    });
    expect(forwarded).toBe(20);
    expect(result.testRun.outputTruncated).toBe(true);
    store.close();
  });

  it("auto-links one active run and leaves no-match tests standalone", async () => {
    const directory = await temporaryDirectory();
    const store = database(directory);
    const trackingRunId = addActiveRun(store, directory);
    const linked = await runTestCommand({
      database: store,
      executable: "fake",
      arguments: [],
      workingDirectory: directory,
      now: clock(),
      processRunner: async () => ({ exitCode: 0, signal: null }),
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(linked.testRun.trackingRunId).toBe(trackingRunId);
    const other = await temporaryDirectory();
    const standalone = await runTestCommand({
      database: store,
      executable: "fake",
      arguments: [],
      workingDirectory: other,
      now: clock(),
      processRunner: async () => ({ exitCode: 0, signal: null }),
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(standalone.testRun.trackingRunId).toBeNull();
    store.close();
  });

  it("does not link when nested active tracking candidates are ambiguous", async () => {
    const directory = await temporaryDirectory();
    const nested = path.join(directory, "nested");
    const working = path.join(nested, "working");
    await mkdir(working, { recursive: true });
    const store = database(await temporaryDirectory());
    addActiveRun(store, directory);
    addActiveRun(store, nested);
    const result = await runTestCommand({
      database: store,
      executable: "fake",
      arguments: [],
      workingDirectory: working,
      now: clock(),
      processRunner: async () => ({ exitCode: 0, signal: null }),
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(result.testRun.trackingRunId).toBeNull();
    expect(result.testRun.warnings).toContain(
      "test_tracking_association_ambiguous",
    );
    store.close();
  });
});
