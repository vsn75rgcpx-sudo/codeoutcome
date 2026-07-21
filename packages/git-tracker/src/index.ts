import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalizePath, type Session } from "@agentledger/shared";

export {
  captureGitSnapshot,
  compareGitSnapshots,
  defaultGitProcessRunner,
  NotGitRepositoryError,
  parseNumstat,
  repositoryInputFromSnapshot,
  type CaptureGitSnapshotOptions,
  type GitProcessOptions,
  type GitProcessResult,
  type GitProcessRunner,
} from "./snapshot.js";

const execFileAsync = promisify(execFile);

interface GitCommandResult {
  value: string | null;
  error: string | null;
}

export interface GitContext {
  repositoryPath: string | null;
  repositoryName: string | null;
  remoteUrl: string | null;
  branch: string | null;
  warnings: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? (error.message.split("\n")[0] ?? error.name)
    : "unknown Git error";
}

async function gitValue(
  workingDirectory: string,
  arguments_: string[],
): Promise<GitCommandResult> {
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
    return { value: value.length > 0 ? value : null, error: null };
  } catch (error) {
    return { value: null, error: errorMessage(error) };
  }
}

export function sanitizeRemoteUrl(remoteUrl: string | null): string | null {
  if (remoteUrl === null || remoteUrl.trim().length === 0) {
    return null;
  }
  const value = remoteUrl.trim();
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const scpLike = value.match(/^[^@\s]+@([^:\s]+):(.+)$/);
    if (scpLike?.[1] !== undefined && scpLike[2] !== undefined) {
      return `${scpLike[1]}:${scpLike[2]}`;
    }
    return value.includes("?") ? value.slice(0, value.indexOf("?")) : value;
  }
}

export async function inspectGitContext(
  workingDirectory: string,
): Promise<GitContext> {
  try {
    await access(workingDirectory, constants.R_OK);
  } catch (error) {
    return {
      repositoryPath: null,
      repositoryName: null,
      remoteUrl: null,
      branch: null,
      warnings: [errorMessage(error)],
    };
  }

  const [repositoryResult, branchResult, remoteResult] = await Promise.all([
    gitValue(workingDirectory, ["rev-parse", "--show-toplevel"]),
    gitValue(workingDirectory, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitValue(workingDirectory, ["remote", "get-url", "origin"]),
  ]);
  const repositoryPath =
    repositoryResult.value === null
      ? null
      : await canonicalizePath(repositoryResult.value);
  const warnings = [
    repositoryResult.error,
    branchResult.error,
    remoteResult.error,
  ].filter((warning): warning is string => warning !== null);

  return {
    repositoryPath,
    repositoryName:
      repositoryPath === null ? null : path.basename(repositoryPath),
    remoteUrl: sanitizeRemoteUrl(remoteResult.value),
    branch: branchResult.value === "HEAD" ? null : branchResult.value,
    warnings,
  };
}

export async function enrichSessionWithGit(session: Session): Promise<{
  session: Session;
  warnings: string[];
}> {
  const lookupPath = session.workingDirectory ?? session.repositoryPath;
  if (lookupPath === null) {
    return { session, warnings: [] };
  }
  const context = await inspectGitContext(lookupPath);
  const repositoryPath = session.repositoryPath ?? context.repositoryPath;

  return {
    session: {
      ...session,
      repositoryPath,
      repositoryName:
        session.repositoryName ??
        context.repositoryName ??
        (repositoryPath === null ? null : path.basename(repositoryPath)),
      remoteUrl: session.remoteUrl ?? context.remoteUrl,
      branch: session.branch ?? context.branch,
    },
    warnings: context.warnings,
  };
}

export async function enrichSessionsWithGit(
  sessions: readonly Session[],
): Promise<Session[]> {
  const cache = new Map<string, Promise<GitContext>>();

  return Promise.all(
    sessions.map(async (session) => {
      const lookupPath = session.workingDirectory ?? session.repositoryPath;
      if (lookupPath === null) {
        return session;
      }

      let context = cache.get(lookupPath);
      if (context === undefined) {
        context = inspectGitContext(lookupPath);
        cache.set(lookupPath, context);
      }
      const git = await context;
      const repositoryPath = session.repositoryPath ?? git.repositoryPath;

      return {
        ...session,
        repositoryPath,
        repositoryName:
          session.repositoryName ??
          git.repositoryName ??
          (repositoryPath === null ? null : path.basename(repositoryPath)),
        remoteUrl: session.remoteUrl ?? git.remoteUrl,
        branch: session.branch ?? git.branch,
      };
    }),
  );
}
