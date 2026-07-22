import path from "node:path";

import type { SessionDatabase } from "@codeoutcome/database";
import { inspectGitContext } from "@codeoutcome/git-tracker";
import {
  canonicalizePath,
  type TestRun,
  type TestRunLink,
} from "@codeoutcome/shared";

export const TRACKING_RUN_ENVIRONMENT_VARIABLE = "CODEOUTCOME_TRACKING_RUN_ID";
export const LEGACY_TRACKING_RUN_ENVIRONMENT_VARIABLE =
  "AGENTLEDGER_TRACKING_RUN_ID";

export interface ProviderTestHookContext {
  trackingRunId: string;
  workingDirectory: string;
  sessionId?: string;
}

export interface TestAssociation {
  trackingRunId: string | null;
  sessionId: string | null;
  repositoryId: number | null;
  workingDirectory: string;
  state: "linked" | "standalone" | "ambiguous";
  confidence: number | null;
  reasons: string[];
  warnings: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function resolveTestAssociation(options: {
  database: SessionDatabase;
  workingDirectory: string;
  environment?: NodeJS.ProcessEnv;
  now: string;
}): Promise<TestAssociation> {
  const workingDirectory = await canonicalizePath(options.workingDirectory);
  const environment = options.environment ?? process.env;
  const git = await inspectGitContext(workingDirectory);
  const repositoryPath = git.repositoryPath;
  const warnings: string[] = [];
  const currentId = environment[TRACKING_RUN_ENVIRONMENT_VARIABLE]?.trim();
  const legacyId =
    environment[LEGACY_TRACKING_RUN_ENVIRONMENT_VARIABLE]?.trim();
  const explicitId =
    currentId !== undefined && currentId.length > 0 ? currentId : legacyId;
  if (
    (currentId === undefined || currentId.length === 0) &&
    legacyId !== undefined &&
    legacyId.length > 0
  ) {
    warnings.push("legacy_tracking_run_environment_variable_is_deprecated");
  }

  if (explicitId !== undefined && explicitId.length > 0) {
    const run = options.database.getTrackingRun(explicitId);
    const runWorkingDirectory =
      run === null ? null : await canonicalizePath(run.workingDirectory);
    const runRepositoryPath =
      run === null ? null : await canonicalizePath(run.repositoryPath);
    const matchesPath =
      run !== null &&
      (runWorkingDirectory === workingDirectory ||
        (repositoryPath !== null && runRepositoryPath === repositoryPath));
    if (run !== null && run.status === "active" && matchesPath) {
      return {
        trackingRunId: run.id,
        sessionId: run.linkedSessionId,
        repositoryId: run.repositoryId,
        workingDirectory,
        state: "linked",
        confidence: 1,
        reasons: [
          `active tracking run selected by ${
            currentId !== undefined && currentId.length > 0
              ? TRACKING_RUN_ENVIRONMENT_VARIABLE
              : LEGACY_TRACKING_RUN_ENVIRONMENT_VARIABLE
          }`,
        ],
        warnings,
      };
    }
    warnings.push(
      "tracking_run_environment_hint_was_not_a_reliable_active_match",
    );
  }

  const active = options.database.listTrackingRuns({
    status: "active",
    limit: 10_000,
  });
  const normalized = await Promise.all(
    active.map(async (run) => ({
      run,
      workingDirectory: await canonicalizePath(run.workingDirectory),
      repositoryPath: await canonicalizePath(run.repositoryPath),
    })),
  );
  const candidates = normalized.filter(
    (candidate) =>
      candidate.workingDirectory === workingDirectory ||
      (repositoryPath !== null &&
        candidate.repositoryPath === repositoryPath) ||
      isWithin(candidate.workingDirectory, workingDirectory),
  );
  if (candidates.length === 1 && candidates[0] !== undefined) {
    const { run, workingDirectory: runWorkingDirectory } = candidates[0];
    return {
      trackingRunId: run.id,
      sessionId: run.linkedSessionId,
      repositoryId: run.repositoryId,
      workingDirectory,
      state: "linked",
      confidence: 1,
      reasons: [
        runWorkingDirectory === workingDirectory
          ? "unique active tracking run matched canonical working directory"
          : "unique active tracking run matched canonical Git worktree",
      ],
      warnings,
    };
  }

  let repositoryId: number | null = null;
  if (repositoryPath !== null) {
    repositoryId = options.database.upsertRepository(
      {
        canonicalPath: repositoryPath,
        name: git.repositoryName ?? path.basename(repositoryPath),
        remoteUrl: git.remoteUrl,
      },
      options.now,
    );
  }
  if (candidates.length > 1) {
    return {
      trackingRunId: null,
      sessionId: null,
      repositoryId,
      workingDirectory,
      state: "ambiguous",
      confidence: null,
      reasons: [
        "multiple active tracking runs matched the working directory or worktree",
      ],
      warnings: [...warnings, "test_tracking_association_ambiguous"],
    };
  }
  return {
    trackingRunId: null,
    sessionId: null,
    repositoryId,
    workingDirectory,
    state: "standalone",
    confidence: null,
    reasons: ["no matching active tracking run"],
    warnings,
  };
}

export function associationLink(
  testRunId: string,
  association: TestAssociation,
  createdAt: string,
): Omit<TestRunLink, "id"> | undefined {
  if (association.trackingRunId === null && association.sessionId === null) {
    return undefined;
  }
  return {
    testRunId,
    trackingRunId: association.trackingRunId,
    sessionId: association.sessionId,
    linkType: "auto",
    confidence: association.confidence,
    reasons: association.reasons,
    createdAt,
  };
}

export function manualLinkTestRun(
  database: SessionDatabase,
  testRunId: string,
  options: { trackingRunId?: string; sessionId?: string; now?: () => Date },
): TestRun {
  if (options.trackingRunId === undefined && options.sessionId === undefined) {
    throw new Error("test link requires --tracking-run or --session");
  }
  return database.linkTestRun(testRunId, {
    trackingRunId: options.trackingRunId,
    sessionId: options.sessionId,
    linkType: "manual",
    confidence: 1,
    reasons: ["manually linked by user"],
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  });
}

export function unlinkTestRun(
  database: SessionDatabase,
  testRunId: string,
  now: () => Date = () => new Date(),
): TestRun {
  return database.unlinkTestRun(testRunId, now().toISOString());
}
