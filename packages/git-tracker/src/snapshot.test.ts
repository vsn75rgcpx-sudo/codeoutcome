import { execFile } from "node:child_process";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureGitSnapshot,
  compareGitSnapshots,
  NotGitRepositoryError,
} from "./snapshot.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(
  cwd: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], {
    cwd,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function repository(commit = true): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agentledger-git-"));
  temporaryDirectories.push(directory);
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.name", "AgentLedger Test"]);
  await git(directory, ["config", "user.email", "fixture@example.invalid"]);
  if (commit) {
    await writeFile(path.join(directory, "tracked.txt"), "initial\n", "utf8");
    await git(directory, ["add", "tracked.txt"]);
    await git(directory, ["commit", "-m", "initial"]);
  }
  return directory;
}

async function snapshot(
  workingDirectory: string,
  privacyMode: "git-metadata" | "strict" = "git-metadata",
) {
  return captureGitSnapshot({
    workingDirectory,
    trigger: "manual",
    privacyMode,
    now: () => new Date("2026-04-01T00:00:00.000Z"),
  });
}

describe("Git machine-readable snapshots", () => {
  it("captures a clean repository without upstream", async () => {
    const directory = await repository();
    const result = await snapshot(directory);

    expect(result).toMatchObject({
      branch: "main",
      isDirty: false,
      isDetachedHead: false,
      isUnbornBranch: false,
      aheadCount: null,
      behindCount: null,
      fileStats: [],
    });
  });

  it("captures an unborn branch without inventing a HEAD", async () => {
    const directory = await repository(false);
    const result = await snapshot(directory);

    expect(result).toMatchObject({
      branch: "main",
      headCommit: null,
      isUnbornBranch: true,
      isDetachedHead: false,
    });
  });

  it("separates staged, unstaged, untracked, and dual-area changes", async () => {
    const directory = await repository();
    await writeFile(path.join(directory, "tracked.txt"), "staged\n", "utf8");
    await git(directory, ["add", "tracked.txt"]);
    await appendFile(path.join(directory, "tracked.txt"), "unstaged\n", "utf8");
    await writeFile(path.join(directory, "new.txt"), "untracked\n", "utf8");

    const result = await snapshot(directory);
    expect(result).toMatchObject({
      stagedFileCount: 1,
      unstagedFileCount: 1,
      untrackedFileCount: 1,
      isDirty: true,
    });
    expect(
      result.fileStats
        .filter((stat) => stat.relativePath === "tracked.txt")
        .map((stat) => stat.area)
        .sort(),
    ).toEqual(["staged", "unstaged"]);
  });

  it("handles rename, spaces, and Unicode paths", async () => {
    const directory = await repository();
    await writeFile(path.join(directory, "old name.txt"), "rename\n", "utf8");
    await writeFile(path.join(directory, "你好.txt"), "unicode\n", "utf8");
    await git(directory, ["add", "old name.txt", "你好.txt"]);
    await git(directory, ["commit", "-m", "paths"]);
    await git(directory, ["mv", "old name.txt", "new name.txt"]);
    await appendFile(path.join(directory, "你好.txt"), "changed\n", "utf8");

    const result = await snapshot(directory);
    expect(result.fileStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "new name.txt",
          previousPath: "old name.txt",
          changeType: "renamed",
          area: "staged",
        }),
        expect.objectContaining({
          relativePath: "你好.txt",
          changeType: "modified",
          area: "unstaged",
        }),
      ]),
    );
  });

  it("marks binary numstat without reading or storing file content", async () => {
    const directory = await repository();
    const binaryPath = path.join(directory, "image.bin");
    await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
    await git(directory, ["add", "image.bin"]);
    await git(directory, ["commit", "-m", "binary"]);
    await writeFile(binaryPath, Buffer.from([0, 9, 8, 7]));

    const result = await snapshot(directory);
    expect(result.fileStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "image.bin",
          isBinary: true,
          additions: null,
          deletions: null,
          contentFingerprint: null,
        }),
      ]),
    );
  });

  it("captures deleted files and excludes ignored files", async () => {
    const directory = await repository();
    await writeFile(
      path.join(directory, ".gitignore"),
      "ignored.txt\n",
      "utf8",
    );
    await git(directory, ["add", ".gitignore"]);
    await git(directory, ["commit", "-m", "ignore rule"]);
    await rm(path.join(directory, "tracked.txt"));
    await writeFile(
      path.join(directory, "ignored.txt"),
      "ignored-body\n",
      "utf8",
    );

    const result = await snapshot(directory);
    expect(result.fileStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "tracked.txt",
          changeType: "deleted",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("ignored.txt");
    expect(JSON.stringify(result)).not.toContain("ignored-body");
  });

  it("detects detached HEAD", async () => {
    const directory = await repository();
    await git(directory, ["checkout", "--detach"]);

    const result = await snapshot(directory);
    expect(result).toMatchObject({ branch: null, isDetachedHead: true });
  });

  it("uses the worktree root for a Git worktree", async () => {
    const directory = await repository();
    const worktree = path.join(
      path.dirname(directory),
      `${path.basename(directory)}-wt`,
    );
    temporaryDirectories.push(worktree);
    await git(directory, ["worktree", "add", "-b", "worktree-test", worktree]);

    const result = await snapshot(worktree);
    expect(result.repositoryPath).toBe(await realpath(worktree));
    expect(result.branch).toBe("worktree-test");
  });

  it("captures merge conflicts as conflicted files", async () => {
    const directory = await repository();
    await git(directory, ["checkout", "-b", "feature"]);
    await writeFile(path.join(directory, "tracked.txt"), "feature\n", "utf8");
    await git(directory, ["commit", "-am", "feature"]);
    await git(directory, ["checkout", "main"]);
    await writeFile(path.join(directory, "tracked.txt"), "main\n", "utf8");
    await git(directory, ["commit", "-am", "main"]);
    await expect(git(directory, ["merge", "feature"])).rejects.toBeDefined();

    const result = await snapshot(directory);
    expect(result.conflictedFileCount).toBe(1);
    expect(result.fileStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "tracked.txt",
          area: "conflicted",
          changeType: "unmerged",
        }),
      ]),
    );
  });
});

describe("Git snapshot comparison", () => {
  it("reports observed working changes from a clean baseline", async () => {
    const directory = await repository();
    const start = await snapshot(directory);
    await appendFile(path.join(directory, "tracked.txt"), "one\ntwo\n", "utf8");
    const end = await snapshot(directory);

    const summary = await compareGitSnapshots(start, end);
    expect(summary).toMatchObject({
      attribution: "observed_changes",
      filesChanged: 1,
      additions: 2,
      deletions: 0,
      baselineDirty: false,
    });
  });

  it("marks a dirty baseline unknown instead of claiming contribution", async () => {
    const directory = await repository();
    await appendFile(path.join(directory, "tracked.txt"), "before\n", "utf8");
    const start = await snapshot(directory);
    await appendFile(path.join(directory, "tracked.txt"), "during\n", "utf8");
    const end = await snapshot(directory);

    const summary = await compareGitSnapshots(start, end);
    expect(summary).toMatchObject({
      baselineDirty: true,
      attribution: "unknown",
      filesChanged: null,
      additions: null,
    });
    expect(summary.warnings).toContain("baseline_dirty");
  });

  it("computes committed net change when HEAD advances", async () => {
    const directory = await repository();
    const start = await snapshot(directory);
    await appendFile(
      path.join(directory, "tracked.txt"),
      "committed\n",
      "utf8",
    );
    await git(directory, ["commit", "-am", "advance"]);
    const end = await snapshot(directory);

    const summary = await compareGitSnapshots(start, end);
    expect(summary).toMatchObject({
      attribution: "committed_net_change",
      newCommit: true,
      filesChanged: 1,
      additions: 1,
    });
  });

  it("warns on branch changes and HEAD rewind/reset", async () => {
    const directory = await repository();
    await appendFile(path.join(directory, "tracked.txt"), "second\n", "utf8");
    await git(directory, ["commit", "-am", "second"]);
    const start = await snapshot(directory);
    await git(directory, ["checkout", "-b", "rewound"]);
    await git(directory, ["reset", "--hard", "HEAD^"]);
    const end = await snapshot(directory);

    const summary = await compareGitSnapshots(start, end);
    expect(summary.branchChanged).toBe(true);
    expect(summary.newCommit).toBe(false);
    expect(summary.warnings).toEqual(
      expect.arrayContaining(["branch_changed", "head_rewritten_or_rewound"]),
    );
  });
});

describe("Git privacy and failure behavior", () => {
  it("strict mode stores fingerprints but no plaintext paths or source", async () => {
    const directory = await repository();
    await writeFile(
      path.join(directory, "private-source.txt"),
      "secret-source-marker\n",
      "utf8",
    );
    const result = await snapshot(directory, "strict");
    const serialized = JSON.stringify(result);

    expect(result.fileStats[0]).toMatchObject({
      relativePath: null,
      previousPath: null,
      contentFingerprint: null,
    });
    expect(result.fileStats[0]?.pathFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain("private-source.txt");
    expect(serialized).not.toContain("secret-source-marker");
    expect(serialized).not.toContain("diff --git");
  });

  it("returns a safe typed error outside a Git repository", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-nongit-"));
    temporaryDirectories.push(directory);

    await expect(snapshot(directory)).rejects.toBeInstanceOf(
      NotGitRepositoryError,
    );
  });
});
