import { stat } from "node:fs/promises";
import path from "node:path";

import {
  REPARSE_REQUIRED_CHECKPOINT,
  type ImportRunSummary,
  type RepositoryInput,
  type SessionDatabase,
} from "@codeoutcome/database";
import { enrichSessionWithGit } from "@codeoutcome/git-tracker";
import {
  canonicalizePath,
  createFileCheckpoint,
  matchesFileCheckpoint,
  type Provider,
  type ProviderSelection,
  type SessionAdapter,
} from "@codeoutcome/shared";

import { DEFAULT_PRICING_CATALOG, type PricingCatalog } from "./pricing.js";
import { analyzeUsageEvents } from "./accounting.js";

export interface ImportWarning {
  provider: Provider;
  sourceFile: string | null;
  message: string;
}

export interface ImportReport extends ImportRunSummary {
  provider: ProviderSelection;
  dryRun: boolean;
  status: "completed" | "partial" | "failed";
  startedAt: string;
  completedAt: string;
  appendedFiles: number;
  rewrittenFiles: number;
  importedEvents: number;
  processedBytes: number;
  warnings: ImportWarning[];
}

export interface ImportOptions {
  adapters: readonly SessionAdapter[];
  database: SessionDatabase | null;
  provider: ProviderSelection;
  dryRun?: boolean;
  since?: string;
  now?: () => Date;
  pricingCatalog?: PricingCatalog;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? (error.message.split("\n")[0] ?? error.name)
    : "unknown import error";
}

function selectedAdapters(
  adapters: readonly SessionAdapter[],
  provider: ProviderSelection,
): SessionAdapter[] {
  return adapters.filter(
    (adapter) => provider === "all" || adapter.provider === provider,
  );
}

export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const dryRun = options.dryRun ?? false;
  if (!dryRun && options.database === null) {
    throw new Error("A database is required for a non-dry-run import");
  }
  const database = options.database;
  const importRunId =
    dryRun || database === null
      ? null
      : database.startImportRun(options.provider, startedAt);
  const warnings: ImportWarning[] = [];
  const importedSessionIds = new Set<string>();
  const updatedSessionIds = new Set<string>();
  let scannedFiles = 0;
  let skippedSessions = 0;
  let malformedFiles = 0;
  let appendedFiles = 0;
  let rewrittenFiles = 0;
  let importedEvents = 0;
  let processedBytes = 0;

  try {
    for (const adapter of selectedAdapters(
      options.adapters,
      options.provider,
    )) {
      let sourceFiles: string[];
      try {
        sourceFiles = await adapter.discoverSourceFiles();
      } catch (error) {
        warnings.push({
          provider: adapter.provider,
          sourceFile: null,
          message: `log discovery failed: ${safeErrorMessage(error)}`,
        });
        continue;
      }
      if (sourceFiles.length === 0) {
        warnings.push({
          provider: adapter.provider,
          sourceFile: null,
          message: "no readable JSONL log files discovered",
        });
      }

      for (const discoveredFile of sourceFiles) {
        const sourceFile = await canonicalizePath(discoveredFile);
        let metadata;
        try {
          metadata = await stat(sourceFile);
        } catch (error) {
          warnings.push({
            provider: adapter.provider,
            sourceFile,
            message: `file stat failed: ${safeErrorMessage(error)}`,
          });
          malformedFiles += 1;
          continue;
        }
        if (
          options.since !== undefined &&
          metadata.mtime.toISOString() < options.since
        ) {
          continue;
        }
        scannedFiles += 1;

        const oldState = database?.getSourceFileState(sourceFile) ?? null;
        if (
          !dryRun &&
          oldState !== null &&
          oldState.fileSize === metadata.size &&
          oldState.fileMtimeMs === Math.trunc(metadata.mtimeMs) &&
          oldState.processedHash !== REPARSE_REQUIRED_CHECKPOINT
        ) {
          skippedSessions += 1;
          continue;
        }

        let startOffset = 0;
        let resetSource = true;
        if (
          !dryRun &&
          oldState !== null &&
          metadata.size > oldState.fileSize &&
          metadata.size >= oldState.processedBytes
        ) {
          const prefixMatches = await matchesFileCheckpoint(
            sourceFile,
            oldState.processedBytes,
            oldState.processedHash,
          );
          if (prefixMatches) {
            startOffset = oldState.processedBytes;
            resetSource = false;
            if (metadata.size > oldState.fileSize) {
              appendedFiles += 1;
            }
          } else {
            rewrittenFiles += 1;
          }
        } else if (!dryRun && oldState !== null) {
          rewrittenFiles += 1;
        }

        try {
          const parsed = await adapter.parseFile(sourceFile, {
            startOffset,
            providerSessionIdHint: oldState?.providerSessionId,
          });
          if (parsed.malformedLines > 0 || parsed.truncated) {
            malformedFiles += 1;
            warnings.push({
              provider: adapter.provider,
              sourceFile,
              message: parsed.truncated
                ? `truncated trailing JSON retained for the next import; malformed lines: ${parsed.malformedLines}`
                : `malformed JSON lines skipped: ${parsed.malformedLines}`,
            });
          }
          importedEvents += parsed.usageEvents.length;
          processedBytes += Math.max(0, parsed.processedBytes - startOffset);

          if (dryRun || database === null) {
            importedSessionIds.add(parsed.session.id);
            continue;
          }

          const processedHash = await createFileCheckpoint(
            sourceFile,
            parsed.processedBytes,
          );
          const sourceFileHash =
            parsed.processedBytes === parsed.fileSize
              ? processedHash
              : await createFileCheckpoint(sourceFile);
          const importedAt = now().toISOString();
          const enriched = await enrichSessionWithGit({
            ...parsed.session,
            sourceFileHash,
            importedAt,
          });
          if (
            enriched.session.workingDirectory !== null &&
            enriched.session.repositoryPath === null
          ) {
            warnings.push({
              provider: adapter.provider,
              sourceFile,
              message:
                "Git repository metadata unavailable for the working directory",
            });
          }
          const repositoryPath = enriched.session.repositoryPath;
          const repository: RepositoryInput | null =
            repositoryPath === null
              ? null
              : {
                  canonicalPath: await canonicalizePath(repositoryPath),
                  name:
                    enriched.session.repositoryName ??
                    path.basename(repositoryPath),
                  remoteUrl: enriched.session.remoteUrl,
                };
          const mutation = database.applySourceImport({
            session: enriched.session,
            usageEvents: parsed.usageEvents,
            repository,
            fileSize: parsed.fileSize,
            fileMtimeMs: Math.trunc(metadata.mtimeMs),
            processedBytes: parsed.processedBytes,
            processedHash,
            sourceFileHash,
            format: parsed.format,
            malformedLines: parsed.malformedLines,
            truncated: parsed.truncated,
            resetSource,
            importedAt,
          });
          if (mutation.kind === "inserted") {
            importedSessionIds.add(parsed.session.id);
            updatedSessionIds.delete(parsed.session.id);
          } else if (!importedSessionIds.has(parsed.session.id)) {
            updatedSessionIds.add(parsed.session.id);
          }

          for (const sessionId of mutation.affectedSessionIds) {
            const storedSession = database.getSession(sessionId);
            if (storedSession === null) continue;
            const events = database.getUsageEvents(sessionId);
            const usage = analyzeUsageEvents(
              storedSession.provider,
              storedSession.model,
              events,
              options.pricingCatalog ?? DEFAULT_PRICING_CATALOG,
            );
            database.applyUsageReconciliation([
              {
                sessionId,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                uncachedInputTokens: usage.uncachedInputTokens,
                estimatedCost: usage.estimatedCost,
                accountingMethod: usage.accountingMethod,
                accountingStatus: usage.accountingStatus,
                accountingVersion: usage.accountingVersion,
                lastUsageEventAt: usage.lastUsageEventAt,
                canonicalEventIds: usage.canonicalEventIds,
              },
            ]);
            for (const warning of usage.warnings) {
              warnings.push({
                provider: adapter.provider,
                sourceFile,
                message: warning,
              });
            }
          }
        } catch (error) {
          malformedFiles += 1;
          warnings.push({
            provider: adapter.provider,
            sourceFile,
            message: `parse/import failed: ${safeErrorMessage(error)}`,
          });
        }
      }
    }

    const summary: ImportRunSummary = {
      scannedFiles,
      importedSessions: importedSessionIds.size,
      updatedSessions: updatedSessionIds.size,
      skippedSessions,
      malformedFiles,
    };
    const status = warnings.length > 0 ? "partial" : "completed";
    const completedAt = now().toISOString();
    if (importRunId !== null && database !== null) {
      database.finishImportRun(importRunId, completedAt, summary, status);
    }
    return {
      ...summary,
      provider: options.provider,
      dryRun,
      status,
      startedAt,
      completedAt,
      appendedFiles,
      rewrittenFiles,
      importedEvents,
      processedBytes,
      warnings,
    };
  } catch (error) {
    const completedAt = now().toISOString();
    const summary: ImportRunSummary = {
      scannedFiles,
      importedSessions: importedSessionIds.size,
      updatedSessions: updatedSessionIds.size,
      skippedSessions,
      malformedFiles,
    };
    if (importRunId !== null && database !== null) {
      database.finishImportRun(importRunId, completedAt, summary, "failed");
    }
    throw error;
  }
}
