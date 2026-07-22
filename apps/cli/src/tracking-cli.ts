import {
  abandonTracking,
  buildTrackingTestSummary,
  captureManualSnapshot,
  manualLinkTrackingRun,
  readCodeOutcomeConfig,
  runImport,
  runTrackedProvider,
  setPrivacyMode,
  startTracking,
  stopTracking,
  TRACKING_RUN_ENVIRONMENT_VARIABLE,
  trackingDuration,
  unlinkTrackingRun,
  type ProviderProcessRunner,
} from "@codeoutcome/core";
import { SessionDatabase } from "@codeoutcome/database";
import {
  captureGitSnapshot,
  NotGitRepositoryError,
  type GitProcessRunner,
} from "@codeoutcome/git-tracker";
import {
  canonicalizePath,
  redactHomePath,
  type GitSnapshot,
  type Provider,
  type SessionAdapter,
  type TrackingRun,
  type TestRun,
} from "@codeoutcome/shared";

export interface TrackingCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface TrackingCliContext {
  io: TrackingCliIo;
  databaseFile: string;
  dataDirectory: string;
  userHome: string;
  workingDirectory: string;
  now: () => Date;
  adapters: readonly SessionAdapter[];
  gitRunner?: GitProcessRunner;
  processRunner?: ProviderProcessRunner;
  codexExecutable: string;
  environment: NodeJS.ProcessEnv;
}

interface Flags {
  json: boolean;
  values: Map<string, string>;
  positional: string[];
}

function parseFlags(
  arguments_: readonly string[],
  valueNames: readonly string[] = [],
  booleanNames: readonly string[] = ["--json"],
): Flags {
  const values = new Map<string, string>();
  const positional: string[] = [];
  const allowedValues = new Set(valueNames);
  const allowedBooleans = new Set(booleanNames);
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index] ?? "";
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (allowedBooleans.has(value)) {
      if (value === "--json") json = true;
      continue;
    }
    if (!allowedValues.has(value)) throw new Error(`Unknown option: ${value}`);
    const next = arguments_[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${value} requires a value`);
    }
    values.set(value, next);
    index += 1;
  }
  return { json, values, positional };
}

function provider(value: string | undefined): Provider {
  const selected = value ?? "codex";
  if (selected === "codex" || selected === "claude-code") return selected;
  throw new Error("--provider must be codex or claude-code");
}

function since(value: string | undefined, now: Date): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)(h|d|w)$/.exec(value);
  if (match === null) throw new Error("--since must look like 24h, 7d, or 4w");
  const quantity = Number(match[1]);
  const multiplier =
    match[2] === "h" ? 3_600_000 : match[2] === "d" ? 86_400_000 : 604_800_000;
  return new Date(now.getTime() - quantity * multiplier).toISOString();
}

function redact(value: string, home: string): string {
  return redactHomePath(value, home) ?? value;
}

function safeSnapshot(snapshot: GitSnapshot, home: string): GitSnapshot {
  return {
    ...snapshot,
    repositoryPath: redact(snapshot.repositoryPath, home),
    workingDirectory: redact(snapshot.workingDirectory, home),
  };
}

function safeRun(run: TrackingRun, home: string): TrackingRun {
  return {
    ...run,
    repositoryPath: redact(run.repositoryPath, home),
    workingDirectory: redact(run.workingDirectory, home),
  };
}

function safeTestRun(run: TestRun, home: string): TestRun {
  return {
    ...run,
    workingDirectory: redact(run.workingDirectory, home),
    commandDisplay: run.commandDisplay.split(home).join("~"),
  };
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null) return "active";
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function snapshotText(snapshot: GitSnapshot): string {
  return [
    `Snapshot: ${snapshot.id}`,
    `Repository: ${snapshot.repositoryPath}`,
    `Branch: ${snapshot.branch ?? (snapshot.isDetachedHead ? "detached" : "unknown")}`,
    `HEAD: ${snapshot.headCommit ?? "unborn"}`,
    `Dirty: ${snapshot.isDirty ? "yes" : "no"}`,
    `Staged/unstaged/untracked/conflicted: ${snapshot.stagedFileCount}/${snapshot.unstagedFileCount}/${snapshot.untrackedFileCount}/${snapshot.conflictedFileCount}`,
    `Privacy: ${snapshot.privacyMode}`,
  ].join("\n");
}

function runText(run: TrackingRun, database: SessionDatabase): string {
  const start = database.getGitSnapshot(run.startSnapshotId);
  const end =
    run.endSnapshotId === null
      ? null
      : database.getGitSnapshot(run.endSnapshotId);
  const session =
    run.linkedSessionId === null
      ? null
      : database.getSession(run.linkedSessionId);
  const summary = run.summary;
  const testSummary = buildTrackingTestSummary(
    run,
    database.listTestRuns({ trackingRunId: run.id, limit: 10_000 }),
  );
  const testLines =
    testSummary.testRunCount === 0
      ? ["Test results: No recorded test runs"]
      : [
          `Test runs: ${testSummary.testRunCount}`,
          `Test successful/failed/interrupted runs: ${testSummary.successfulRunCount}/${testSummary.failedRunCount}/${testSummary.interruptedRunCount}`,
          `Test framework: ${testSummary.framework ?? "mixed or unavailable"}`,
          `First successful run: ${testSummary.firstSuccessAt ?? "unavailable"}`,
          `Time to first success: ${testSummary.timeToFirstSuccessMs ?? "unavailable"}ms`,
          `Failed runs before first success: ${testSummary.failedRunsBeforeFirstSuccess ?? "unavailable"}`,
          `Test baseline/final outcome: ${testSummary.baselineOutcome ?? "unavailable"}/${testSummary.finalOutcome ?? "unavailable"}`,
          `Test failed/passed/duration delta: ${testSummary.failedTestDelta ?? "unknown"}/${testSummary.passedTestDelta ?? "unknown"}/${testSummary.durationDeltaMs ?? "unknown"}ms`,
          `Test comparison: ${testSummary.comparison?.comparability ?? "unavailable"}`,
          `Test warnings: ${testSummary.warnings.join("; ") || "—"}`,
          "Test results recorded during an AI coding session; passing tests do not prove code correctness.",
        ];
  return [
    `Tracking run: ${run.id}`,
    `Label: ${run.label ?? "—"}`,
    `Provider: ${run.provider}`,
    `Status: ${run.status}`,
    `Duration: ${duration(trackingDuration(run))}`,
    `Repository: ${run.repositoryPath}`,
    `Branch: ${start?.branch ?? "unknown"}${summary?.branchChanged === true ? " → changed" : ""}`,
    `Start HEAD: ${start?.headCommit ?? "unborn"}`,
    `End HEAD: ${end?.headCommit ?? "unknown"}`,
    `Start dirty: ${start?.isDirty === true ? "yes" : "no"}`,
    `End dirty: ${end?.isDirty === true ? "yes" : "unknown"}`,
    `Files changed: ${summary?.filesChanged ?? "unknown"}`,
    `Additions/deletions: ${summary?.additions ?? "unknown"}/${summary?.deletions ?? "unknown"}`,
    `Staged/unstaged/untracked: ${summary?.stagedFileCount ?? "unknown"}/${summary?.unstagedFileCount ?? "unknown"}/${summary?.untrackedFileCount ?? "unknown"}`,
    `Linked session: ${run.linkedSessionId ?? "none"}`,
    `Session Token: ${session === null ? "unavailable" : session.inputTokens + session.outputTokens}`,
    `Link confidence: ${run.linkConfidenceLevel ?? "none"}${run.linkConfidence === null ? "" : ` (${run.linkConfidence.toFixed(3)})`}`,
    `Link method: ${run.linkMethod ?? "none"}`,
    `Reasons: ${run.linkReasons.join("; ") || "—"}`,
    `Warnings: ${run.warnings.join("; ") || "—"}`,
    ...testLines,
    "Changes are observed during the tracked AI coding session; they are not exact AI code attribution.",
  ].join("\n");
}

function runJson(run: TrackingRun, database: SessionDatabase, home: string) {
  const safe = safeRun(run, home);
  const start = database.getGitSnapshot(run.startSnapshotId);
  const end =
    run.endSnapshotId === null
      ? null
      : database.getGitSnapshot(run.endSnapshotId);
  const session =
    run.linkedSessionId === null
      ? null
      : database.getSession(run.linkedSessionId);
  const testSummary = buildTrackingTestSummary(
    run,
    database.listTestRuns({ trackingRunId: run.id, limit: 10_000 }),
  );
  const safeTestSummary = {
    ...testSummary,
    comparison:
      testSummary.comparison === null
        ? null
        : {
            ...testSummary.comparison,
            baseline:
              testSummary.comparison.baseline === null
                ? null
                : safeTestRun(testSummary.comparison.baseline, home),
            final:
              testSummary.comparison.final === null
                ? null
                : safeTestRun(testSummary.comparison.final, home),
          },
  };
  return {
    ...safe,
    startSnapshot: start === null ? null : safeSnapshot(start, home),
    endSnapshot: end === null ? null : safeSnapshot(end, home),
    linkedSession:
      session === null
        ? null
        : {
            id: session.id,
            provider: session.provider,
            model: session.model,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            totalTokens: session.inputTokens + session.outputTokens,
          },
    testSummary: safeTestSummary,
  };
}

async function withDatabase<T>(
  databaseFile: string,
  action: (database: SessionDatabase) => Promise<T> | T,
): Promise<T> {
  const database = new SessionDatabase(databaseFile);
  try {
    return await action(database);
  } finally {
    database.close();
  }
}

async function runGitCommand(
  subcommand: string,
  arguments_: readonly string[],
  context: TrackingCliContext,
): Promise<number> {
  const parsed = parseFlags(arguments_);
  if (parsed.positional.length > (subcommand === "show" ? 1 : 0)) {
    throw new Error("Unexpected Git command argument");
  }
  const config = await readCodeOutcomeConfig(context.dataDirectory);
  if (subcommand === "status") {
    const draft = await captureGitSnapshot({
      workingDirectory: context.workingDirectory,
      trigger: "manual",
      privacyMode: config.privacy,
      now: context.now,
      runner: context.gitRunner,
    });
    const safe = safeSnapshot({ ...draft, repositoryId: 0 }, context.userHome);
    context.io.stdout(
      parsed.json ? JSON.stringify(safe, null, 2) : snapshotText(safe),
    );
    return 0;
  }
  return withDatabase(context.databaseFile, async (database) => {
    if (subcommand === "snapshot") {
      const snapshot = await captureManualSnapshot({
        database,
        privacyMode: config.privacy,
        workingDirectory: context.workingDirectory,
        now: context.now,
        gitRunner: context.gitRunner,
      });
      const safe = safeSnapshot(snapshot, context.userHome);
      context.io.stdout(
        parsed.json ? JSON.stringify(safe, null, 2) : snapshotText(safe),
      );
      return 0;
    }
    if (subcommand === "show") {
      const id = parsed.positional[0];
      if (id === undefined) throw new Error("git show requires a snapshot ID");
      const snapshot = database.getGitSnapshot(id);
      if (snapshot === null) throw new Error("Git snapshot not found");
      const safe = safeSnapshot(snapshot, context.userHome);
      context.io.stdout(
        parsed.json ? JSON.stringify(safe, null, 2) : snapshotText(safe),
      );
      return 0;
    }
    throw new Error(`Unknown git subcommand: ${subcommand}`);
  });
}

async function runTrackCommand(
  subcommand: string,
  arguments_: readonly string[],
  context: TrackingCliContext,
): Promise<number> {
  const parsed = parseFlags(
    arguments_,
    subcommand === "start"
      ? ["--provider", "--label"]
      : subcommand === "list"
        ? ["--since"]
        : subcommand === "link"
          ? ["--session"]
          : [],
    subcommand === "recover" ? ["--json", "--list"] : ["--json"],
  );
  const config = await readCodeOutcomeConfig(context.dataDirectory);
  return withDatabase(context.databaseFile, async (database) => {
    const importLatest = async (selectedProvider: Provider): Promise<void> => {
      await runImport({
        adapters: context.adapters,
        database,
        provider: selectedProvider,
        now: context.now,
      });
    };
    if (subcommand === "start") {
      const run = await startTracking({
        database,
        provider: provider(parsed.values.get("--provider")),
        label: parsed.values.get("--label"),
        workingDirectory: context.workingDirectory,
        privacyMode: config.privacy,
        now: context.now,
        gitRunner: context.gitRunner,
      });
      context.io.stdout(
        parsed.json
          ? JSON.stringify(runJson(run, database, context.userHome), null, 2)
          : `Tracking started: ${run.id}`,
      );
      return 0;
    }
    if (subcommand === "stop") {
      const result = await stopTracking({
        database,
        trackingRunId: parsed.positional[0],
        workingDirectory: context.workingDirectory,
        privacyMode: config.privacy,
        now: context.now,
        gitRunner: context.gitRunner,
        importLatest,
      });
      const safe = safeRun(result.run, context.userHome);
      context.io.stdout(
        parsed.json
          ? JSON.stringify(
              {
                ...runJson(result.run, database, context.userHome),
                linkDecision: result.linkDecision,
              },
              null,
              2,
            )
          : runText(safe, database),
      );
      return 0;
    }
    if (subcommand === "status") {
      const run = database.activeTrackingRun(
        await canonicalizePath(context.workingDirectory),
      );
      if (run === null) {
        context.io.stdout(parsed.json ? "null" : "No active tracking run.");
      } else {
        const safe = safeRun(run, context.userHome);
        context.io.stdout(
          parsed.json
            ? JSON.stringify(runJson(run, database, context.userHome), null, 2)
            : runText(safe, database),
        );
      }
      return 0;
    }
    if (subcommand === "list") {
      const runs = database
        .listTrackingRuns({
          since: since(parsed.values.get("--since"), context.now()),
        })
        .map((run) => safeRun(run, context.userHome));
      context.io.stdout(
        parsed.json
          ? JSON.stringify(runs, null, 2)
          : runs.length === 0
            ? "No tracking runs found."
            : runs
                .map(
                  (run) =>
                    `${run.id}  ${run.status}  ${run.provider}  ${run.startedAt}  ${run.label ?? "—"}`,
                )
                .join("\n"),
      );
      return 0;
    }
    if (subcommand === "show") {
      const id = parsed.positional[0];
      if (id === undefined)
        throw new Error("track show requires a tracking run ID");
      const run = database.getTrackingRun(id);
      if (run === null) throw new Error("Tracking run not found");
      const safe = safeRun(run, context.userHome);
      context.io.stdout(
        parsed.json
          ? JSON.stringify(runJson(run, database, context.userHome), null, 2)
          : runText(safe, database),
      );
      return 0;
    }
    if (subcommand === "link") {
      const id = parsed.positional[0];
      const sessionId = parsed.values.get("--session");
      if (id === undefined || sessionId === undefined) {
        throw new Error("track link requires a run ID and --session ID");
      }
      const run = manualLinkTrackingRun(database, id, sessionId, context.now);
      const safe = safeRun(run, context.userHome);
      context.io.stdout(
        parsed.json
          ? JSON.stringify(runJson(run, database, context.userHome), null, 2)
          : runText(safe, database),
      );
      return 0;
    }
    if (subcommand === "unlink") {
      const id = parsed.positional[0];
      if (id === undefined)
        throw new Error("track unlink requires a tracking run ID");
      const run = unlinkTrackingRun(database, id, context.now);
      const safe = safeRun(run, context.userHome);
      context.io.stdout(
        parsed.json
          ? JSON.stringify(runJson(run, database, context.userHome), null, 2)
          : runText(safe, database),
      );
      return 0;
    }
    if (subcommand === "recover") {
      if (arguments_.includes("--list")) {
        const runs = database
          .listTrackingRuns({ status: "active" })
          .map((run) => safeRun(run, context.userHome));
        context.io.stdout(
          parsed.json
            ? JSON.stringify(runs, null, 2)
            : runs.map((run) => `${run.id}  ${run.startedAt}`).join("\n") ||
                "No active tracking runs.",
        );
        return 0;
      }
      const result = await stopTracking({
        database,
        trackingRunId: parsed.positional[0],
        workingDirectory: context.workingDirectory,
        privacyMode: config.privacy,
        now: context.now,
        gitRunner: context.gitRunner,
        recovery: true,
        importProviderLogs: false,
      });
      const safe = safeRun(result.run, context.userHome);
      context.io.stdout(
        parsed.json
          ? JSON.stringify(
              runJson(result.run, database, context.userHome),
              null,
              2,
            )
          : runText(safe, database),
      );
      return 0;
    }
    if (subcommand === "abandon") {
      const id = parsed.positional[0];
      if (id === undefined)
        throw new Error("track abandon requires a tracking run ID");
      const run = abandonTracking(database, id, context.now);
      const safe = safeRun(run, context.userHome);
      context.io.stdout(
        parsed.json
          ? JSON.stringify(runJson(run, database, context.userHome), null, 2)
          : runText(safe, database),
      );
      return 0;
    }
    throw new Error(`Unknown track subcommand: ${subcommand}`);
  });
}

async function runCodex(
  arguments_: readonly string[],
  context: TrackingCliContext,
): Promise<number> {
  const forwarded = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  let trackingRunId: string | null = null;
  return runTrackedProvider({
    executable: context.codexExecutable,
    arguments: forwarded,
    processRunner: context.processRunner,
    processEnvironment: () => {
      const inherited = { ...context.environment };
      if (inherited[TRACKING_RUN_ENVIRONMENT_VARIABLE] !== undefined) {
        context.io.stderr(
          `WARN: Existing ${TRACKING_RUN_ENVIRONMENT_VARIABLE} was preserved; nested test auto-linking may refer to another run.`,
        );
      } else if (trackingRunId !== null) {
        inherited[TRACKING_RUN_ENVIRONMENT_VARIABLE] = trackingRunId;
      }
      return inherited;
    },
    onFinalizationError: (error) => {
      const message =
        error instanceof Error
          ? (error.message.split("\n")[0] ?? error.name)
          : "unknown error";
      context.io.stderr(
        `WARN: Codex exited, but tracking finalization failed: ${message.split(context.userHome).join("~")}`,
      );
    },
    startTracking: async () => {
      await withDatabase(context.databaseFile, async (database) => {
        const config = await readCodeOutcomeConfig(context.dataDirectory);
        const run = await startTracking({
          database,
          provider: "codex",
          label: "codeoutcome run codex",
          workingDirectory: context.workingDirectory,
          privacyMode: config.privacy,
          now: context.now,
          gitRunner: context.gitRunner,
        });
        trackingRunId = run.id;
      });
    },
    stopTracking: async (status) => {
      const runId = trackingRunId;
      if (runId === null) return;
      await withDatabase(context.databaseFile, async (database) => {
        const config = await readCodeOutcomeConfig(context.dataDirectory);
        await stopTracking({
          database,
          trackingRunId: runId,
          status,
          privacyMode: config.privacy,
          now: context.now,
          gitRunner: context.gitRunner,
          importLatest: async () => {
            await runImport({
              adapters: context.adapters,
              database,
              provider: "codex",
              now: context.now,
            });
          },
        });
      });
    },
  });
}

export async function runPhase3Cli(
  arguments_: readonly string[],
  context: TrackingCliContext,
): Promise<number | null> {
  const [command, subcommand, ...rest] = arguments_;
  if (command === "git") {
    if (subcommand === undefined) throw new Error("git requires a subcommand");
    try {
      return await runGitCommand(subcommand, rest, context);
    } catch (error) {
      if (error instanceof NotGitRepositoryError) {
        const detail = error.message;
        if (rest.includes("--json")) {
          context.io.stdout(
            JSON.stringify({ status: "WARN", detail }, null, 2),
          );
        } else {
          context.io.stderr(`WARN: ${detail}`);
        }
        return 1;
      }
      throw error;
    }
  }
  if (command === "track") {
    if (subcommand === undefined)
      throw new Error("track requires a subcommand");
    return runTrackCommand(subcommand, rest, context);
  }
  if (command === "config") {
    if (subcommand !== "set" || rest[0] !== "privacy") {
      throw new Error(
        "Use: codeoutcome config set privacy git-metadata|strict",
      );
    }
    const mode = rest[1];
    if (mode !== "git-metadata" && mode !== "strict") {
      throw new Error("Privacy mode must be git-metadata or strict");
    }
    const config = await setPrivacyMode(context.dataDirectory, mode);
    context.io.stdout(JSON.stringify(config, null, 2));
    return 0;
  }
  if (command === "run") {
    if (subcommand !== "codex")
      throw new Error("Only `codeoutcome run codex` is supported");
    return runCodex(rest, context);
  }
  return null;
}

export const PHASE3_HELP = `
  codeoutcome git snapshot [--json]
  codeoutcome git status [--json]
  codeoutcome git show <snapshot-id> [--json]
  codeoutcome track start [--provider codex|claude-code] [--label text] [--json]
  codeoutcome track stop [tracking-run-id] [--json]
  codeoutcome track status [--json]
  codeoutcome track list [--since 7d] [--json]
  codeoutcome track show <tracking-run-id> [--json]
  codeoutcome track link <tracking-run-id> --session <session-id> [--json]
  codeoutcome track unlink <tracking-run-id> [--json]
  codeoutcome track recover [tracking-run-id|--list] [--json]
  codeoutcome track abandon <tracking-run-id> [--json]
  codeoutcome run codex [-- <codex arguments>]
  codeoutcome config set privacy git-metadata|strict`;
