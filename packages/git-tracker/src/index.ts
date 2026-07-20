import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";

import type { Session } from "@agentledger/shared";

const execFileAsync = promisify(execFile);

export interface GitContext {
  repositoryPath: string | null;
  branch: string | null;
}

async function gitValue(
  workingDirectory: string,
  arguments_: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workingDirectory, ...arguments_],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function inspectGitContext(
  workingDirectory: string,
): Promise<GitContext> {
  try {
    await access(workingDirectory, constants.R_OK);
  } catch {
    return { repositoryPath: null, branch: null };
  }

  const [repositoryPath, rawBranch] = await Promise.all([
    gitValue(workingDirectory, ["rev-parse", "--show-toplevel"]),
    gitValue(workingDirectory, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  return {
    repositoryPath,
    branch: rawBranch === "HEAD" ? null : rawBranch,
  };
}

export async function enrichSessionsWithGit(
  sessions: readonly Session[],
): Promise<Session[]> {
  const cache = new Map<string, Promise<GitContext>>();

  return Promise.all(
    sessions.map(async (session) => {
      if (
        session.workingDirectory === null ||
        (session.repositoryPath !== null && session.branch !== null)
      ) {
        return session;
      }

      let context = cache.get(session.workingDirectory);
      if (context === undefined) {
        context = inspectGitContext(session.workingDirectory);
        cache.set(session.workingDirectory, context);
      }
      const git = await context;

      return {
        ...session,
        repositoryPath: session.repositoryPath ?? git.repositoryPath,
        branch: session.branch ?? git.branch,
      };
    }),
  );
}
