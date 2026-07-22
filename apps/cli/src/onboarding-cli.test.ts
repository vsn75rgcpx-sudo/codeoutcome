import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexAdapter } from "@codeoutcome/adapter-codex";
import {
  getLegacyMigrationPaths,
  SessionDatabase,
} from "@codeoutcome/database";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function output(): { io: CliIo; stdout: string[]; stderr: string[] } {
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

async function home(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codeoutcome-onboarding-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("onboarding CLI", () => {
  it("scopes doctor to Codex and provides actionable JSON summaries", async () => {
    const userHome = await home();
    const logs = path.join(userHome, "codex-logs");
    await mkdir(logs);
    const capture = output();
    const exitCode = await runCli(["doctor", "--provider", "codex", "--json"], {
      adapters: [new CodexAdapter(logs)],
      databaseFile: path.join(userHome, "data", "codeoutcome.sqlite"),
      io: capture.io,
      userHome,
    });
    const report = JSON.parse(capture.stdout[0] ?? "null") as {
      provider: string;
      summary: { fail: number; warn: number };
      checks: Array<{ check: string; status: string; solution: string | null }>;
      nextActions: string[];
    };

    expect(exitCode).toBe(0);
    expect(report.provider).toBe("codex");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.checks.some((check) => check.check.includes("claude"))).toBe(
      false,
    );
    expect(report.nextActions.join("\n")).toContain("codeoutcome import");
  });

  it("reports Provider format validation without claiming real Claude logs", async () => {
    const userHome = await home();
    const capture = output();
    await runCli(["formats", "--json"], {
      databaseFile: path.join(userHome, "missing.sqlite"),
      io: capture.io,
      userHome,
    });
    const report = JSON.parse(capture.stdout[0] ?? "null") as {
      formats: Array<{ provider: string; validation: string }>;
    };

    expect(report.formats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          validation: "local-log-validated",
        }),
        expect.objectContaining({
          provider: "claude-code",
          validation: "synthetic-fixtures-only",
        }),
      ]),
    );
  });

  it("generates a voluntary local feedback card without sending data", async () => {
    const capture = output();
    await runCli(["feedback", "--json"], {
      environment: {
        AGENTLEDGER_DATA_DIR: "/a/legacy/path/that/must/not/be-inspected",
      },
      io: capture.io,
    });
    const feedback = JSON.parse(capture.stdout[0] ?? "null") as {
      sent: boolean;
      automaticCollection: boolean;
      includesMachineIdentifiers: boolean;
      publicSubmission: { identityNotice: string };
    };

    expect(feedback).toMatchObject({
      sent: false,
      automaticCollection: false,
      includesMachineIdentifiers: false,
    });
    expect(feedback.publicSubmission.identityNotice).toContain("not anonymous");
    expect(capture.stderr).toEqual([]);
  });

  it("shows help without resolving or warning about local data paths", async () => {
    const capture = output();
    expect(
      await runCli(["--help"], {
        environment: {
          AGENTLEDGER_DATA_DIR: "/a/legacy/path/that/must/not/be-inspected",
        },
        io: capture.io,
      }),
    ).toBe(0);
    expect(capture.stdout.join("\n")).toContain("codeoutcome doctor");
    expect(capture.stderr).toEqual([]);
  });

  it("previews and applies legacy migration through redacted CLI output", async () => {
    const userHome = await home();
    const paths = getLegacyMigrationPaths({}, userHome, "darwin");
    new SessionDatabase(paths.legacyDatabaseFile).close();
    const previewOutput = output();
    expect(
      await runCli(["data", "migrate-legacy", "--dry-run", "--json"], {
        environment: {},
        io: previewOutput.io,
        platform: "darwin",
        userHome,
      }),
    ).toBe(0);
    expect(previewOutput.stdout.join("\n")).not.toContain(userHome);
    expect(JSON.parse(previewOutput.stdout[0] ?? "null")).toMatchObject({
      dryRun: true,
      canMigrate: true,
      migrated: false,
    });

    const applyOutput = output();
    expect(
      await runCli(["data", "migrate-legacy", "--json"], {
        environment: {},
        io: applyOutput.io,
        platform: "darwin",
        userHome,
      }),
    ).toBe(0);
    expect(JSON.parse(applyOutput.stdout[0] ?? "null")).toMatchObject({
      canMigrate: true,
      migrated: true,
    });
    expect(applyOutput.stdout.join("\n")).not.toContain(userHome);
  });
});
