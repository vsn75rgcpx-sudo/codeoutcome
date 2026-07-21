import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderProcessRunner } from "@agentledger/core";

import { runCli, type CliIo } from "./cli.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

async function repository(): Promise<{ root: string; databaseFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agentledger-cli-track-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "AgentLedger Test"], {
    cwd: root,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    { cwd: root },
  );
  await writeFile(path.join(root, "tracked.txt"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return {
    root,
    databaseFile: path.join(root, ".git", "agentledger-test.sqlite"),
  };
}

describe("Phase 3 CLI JSON", () => {
  it("supports snapshot and clean start/status/stop/list/show lifecycle", async () => {
    const { root, databaseFile } = await repository();
    const io = memoryIo();
    const options = {
      adapters: [],
      databaseFile,
      io: io.io,
      userHome: root,
      workingDirectory: root,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
    };

    expect(await runCli(["git", "snapshot", "--json"], options)).toBe(0);
    const snapshot = JSON.parse(io.stdout.at(-1) ?? "{}");
    expect(snapshot).toMatchObject({
      trigger: "manual",
      isDirty: false,
      repositoryPath: "~",
    });
    await runCli(["git", "show", snapshot.id, "--json"], options);
    expect(JSON.parse(io.stdout.at(-1) ?? "{}").id).toBe(snapshot.id);

    expect(
      await runCli(
        [
          "track",
          "start",
          "--provider",
          "codex",
          "--label",
          "fixture",
          "--json",
        ],
        options,
      ),
    ).toBe(0);
    const started = JSON.parse(io.stdout.at(-1) ?? "{}");
    expect(started).toMatchObject({ status: "active", label: "fixture" });

    await runCli(["track", "status", "--json"], options);
    expect(JSON.parse(io.stdout.at(-1) ?? "{}").id).toBe(started.id);
    await runCli(["track", "recover", "--list", "--json"], options);
    expect(JSON.parse(io.stdout.at(-1) ?? "[]")[0].id).toBe(started.id);

    await runCli(
      ["test", "run", "--stage", "baseline", "--json", "--", "fake-test"],
      {
        ...options,
        testProcessRunner: async () => ({ exitCode: 0, signal: null }),
      },
    );
    const testRun = JSON.parse(io.stdout.at(-1) ?? "{}");
    expect(testRun).toMatchObject({
      trackingRunId: started.id,
      outcome: "passed",
    });

    await runCli(["doctor", "--json"], options);
    const doctor = JSON.parse(io.stdout.at(-1) ?? "{}");
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "Active tracking runs",
          status: "WARN",
        }),
      ]),
    );

    await runCli(["track", "stop", started.id, "--json"], options);
    const stopped = JSON.parse(io.stdout.at(-1) ?? "{}");
    expect(stopped).toMatchObject({
      id: started.id,
      status: "completed",
      summary: { filesChanged: 0, additions: 0, deletions: 0 },
    });

    await runCli(["track", "list", "--since", "7d", "--json"], options);
    expect(JSON.parse(io.stdout.at(-1) ?? "[]")).toHaveLength(1);
    await runCli(["track", "show", started.id, "--json"], options);
    expect(JSON.parse(io.stdout.at(-1) ?? "{}")).toMatchObject({
      id: started.id,
      testSummary: { testRunCount: 1, successfulRunCount: 1 },
    });
    expect(io.stdout.join("\n")).not.toContain("diff --git");
    expect(io.stdout.join("\n")).not.toContain("initial\n");
  });

  it("applies strict privacy to new CLI snapshots", async () => {
    const { root, databaseFile } = await repository();
    await writeFile(
      path.join(root, "private path.txt"),
      "secret-body\n",
      "utf8",
    );
    const io = memoryIo();
    const options = {
      databaseFile,
      io: io.io,
      userHome: root,
      workingDirectory: root,
    };

    await runCli(["config", "set", "privacy", "strict"], options);
    await runCli(["git", "snapshot", "--json"], options);
    const output = io.stdout.at(-1) ?? "";
    const snapshot = JSON.parse(output);
    expect(snapshot.privacyMode).toBe("strict");
    expect(snapshot.fileStats[0].relativePath).toBeNull();
    expect(output).not.toContain("private path.txt");
    expect(output).not.toContain("secret-body");
  });

  it("forwards run codex arguments without shell parsing and returns its code", async () => {
    const { root, databaseFile } = await repository();
    const io = memoryIo();
    const runner: ProviderProcessRunner = async (
      executable,
      arguments_,
      spawn,
    ) => {
      expect(executable).toBe("fake-codex");
      expect(arguments_).toEqual(["--model", "value; touch not-run"]);
      expect(spawn.shell).toBe(false);
      expect(spawn.env.AGENTLEDGER_TRACKING_RUN_ID).toMatch(/^[0-9a-f-]{36}$/);
      return { exitCode: 9, signal: null };
    };

    const result = await runCli(
      ["run", "codex", "--", "--model", "value; touch not-run"],
      {
        adapters: [],
        codexExecutable: "fake-codex",
        databaseFile,
        io: io.io,
        processRunner: runner,
        userHome: root,
        workingDirectory: root,
      },
    );

    expect(result).toBe(9);
  });

  it("preserves an existing tracking environment hint and warns", async () => {
    const { root, databaseFile } = await repository();
    const io = memoryIo();
    const result = await runCli(["run", "codex"], {
      adapters: [],
      codexExecutable: "fake-codex",
      databaseFile,
      environment: {
        ...process.env,
        AGENTLEDGER_TRACKING_RUN_ID: "existing-fixture",
      },
      io: io.io,
      processRunner: async (_executable, _arguments, spawn) => {
        expect(spawn.env.AGENTLEDGER_TRACKING_RUN_ID).toBe("existing-fixture");
        return { exitCode: 0, signal: null };
      },
      userHome: root,
      workingDirectory: root,
    });
    expect(result).toBe(0);
    expect(io.stderr.join("\n")).toContain("was preserved");
  });

  it("returns a structured WARN outside a Git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentledger-cli-nongit-"));
    temporaryDirectories.push(root);
    const io = memoryIo();

    const code = await runCli(["git", "status", "--json"], {
      io: io.io,
      userHome: root,
      workingDirectory: root,
    });

    expect(code).toBe(1);
    expect(JSON.parse(io.stdout[0] ?? "{}")).toMatchObject({ status: "WARN" });
  });
});
