import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TestProcessRunner } from "@agentledger/core";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";

const temporaryDirectories: string[] = [];

async function context() {
  const directory = await mkdtemp(path.join(tmpdir(), "agentledger-test-cli-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    directory,
    databaseFile: path.join(directory, "agentledger.sqlite"),
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("test CLI", () => {
  it("returns original exit codes and produces private JSON list/show output", async () => {
    const fixture = await context();
    const runner: TestProcessRunner = async (
      _executable,
      _arguments,
      options,
    ) => {
      expect(options.shell).toBe(false);
      return { exitCode: 7, signal: null };
    };
    const exitCode = await runCli(
      [
        "test",
        "run",
        "--stage",
        "baseline",
        "--framework",
        "generic",
        "--json",
        "--",
        "fake",
        "--token",
        "private-secret",
      ],
      {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        userHome: fixture.directory,
        io: fixture.io,
        testProcessRunner: runner,
      },
    );
    expect(exitCode).toBe(7);
    const created = JSON.parse(fixture.stdout.at(-1) ?? "null") as {
      id: string;
      commandDisplay: string;
    };
    expect(created.commandDisplay).toContain("<redacted>");
    expect(JSON.stringify(created)).not.toContain("private-secret");
    expect(JSON.stringify(created)).not.toContain("private failure body");

    fixture.stdout.length = 0;
    expect(
      await runCli(["test", "list", "--outcome", "errored", "--json"], {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        userHome: fixture.directory,
        io: fixture.io,
      }),
    ).toBe(0);
    const list = JSON.parse(fixture.stdout[0] ?? "[]") as Array<{ id: string }>;
    expect(list.map((run) => run.id)).toEqual([created.id]);

    fixture.stdout.length = 0;
    await runCli(["test", "show", created.id, "--json"], {
      databaseFile: fixture.databaseFile,
      workingDirectory: fixture.directory,
      userHome: fixture.directory,
      io: fixture.io,
    });
    expect(JSON.parse(fixture.stdout[0] ?? "null")).toMatchObject({
      id: created.id,
      linkHistory: [],
    });
  });

  it("compares baseline and final runs through JSON output", async () => {
    const fixture = await context();
    const exitCodes = [1, 0];
    const runner: TestProcessRunner = async () => ({
      exitCode: exitCodes.shift() ?? 0,
      signal: null,
    });
    const ids: string[] = [];
    for (const stage of ["baseline", "final"] as const) {
      fixture.stdout.length = 0;
      await runCli(["test", "run", "--stage", stage, "--json", "--", "fake"], {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        io: fixture.io,
        testProcessRunner: runner,
      });
      ids.push(
        (JSON.parse(fixture.stdout.at(-1) ?? "null") as { id: string }).id,
      );
    }
    fixture.stdout.length = 0;
    const result = await runCli(
      ["test", "compare", ids[0]!, ids[1]!, "--json"],
      {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        io: fixture.io,
      },
    );
    expect(result).toBe(0);
    expect(JSON.parse(fixture.stdout[0] ?? "null")).toMatchObject({
      baseline: { outcome: "errored" },
      final: { outcome: "passed" },
      comparability: "partially_comparable",
      failedTestDelta: null,
    });
  });

  it("imports structured reports and returns idempotent JSON results", async () => {
    const fixture = await context();
    const report = path.join(fixture.directory, "fixture.xml");
    await writeFile(
      report,
      '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    );
    const options = {
      databaseFile: fixture.databaseFile,
      workingDirectory: fixture.directory,
      userHome: fixture.directory,
      io: fixture.io,
    };
    await runCli(
      ["test", "import", "--file", report, "--format", "junit", "--json"],
      options,
    );
    expect(JSON.parse(fixture.stdout.at(-1) ?? "null")).toMatchObject({
      kind: "inserted",
      testRun: { outcome: "passed", totalTests: 1 },
    });
    await runCli(
      ["test", "import", report, "--format", "junit", "--json"],
      options,
    );
    expect(JSON.parse(fixture.stdout.at(-1) ?? "null")).toMatchObject({
      kind: "unchanged",
    });

    fixture.stdout.length = 0;
    expect(await runCli(["test", "--help"], options)).toBe(0);
    expect(fixture.stdout[0]).toContain("agentledger test import --file");
  });

  it("requires confirmation for deletion and keeps dry-run non-mutating", async () => {
    const fixture = await context();
    await runCli(["test", "run", "--", "fake"], {
      databaseFile: fixture.databaseFile,
      workingDirectory: fixture.directory,
      io: fixture.io,
      testProcessRunner: async () => ({ exitCode: 0, signal: null }),
    });
    fixture.stdout.length = 0;
    expect(
      await runCli(["data", "delete-tests", "--dry-run", "--json"], {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        io: fixture.io,
      }),
    ).toBe(0);
    expect(JSON.parse(fixture.stdout[0] ?? "null")).toMatchObject({
      dryRun: true,
      matched: 1,
      deleted: 0,
    });
    expect(
      await runCli(["data", "delete-tests"], {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        io: fixture.io,
      }),
    ).toBe(2);
    expect(
      await runCli(["data", "delete-tests", "--yes", "--json"], {
        databaseFile: fixture.databaseFile,
        workingDirectory: fixture.directory,
        io: fixture.io,
      }),
    ).toBe(0);
    expect(JSON.parse(fixture.stdout.at(-1) ?? "null")).toMatchObject({
      deleted: 1,
    });
  });
});
