import type {
  CollectionResult,
  Session,
  SessionAdapter,
} from "@codeoutcome/shared";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown parsing error";
}

function sessionSortKey(session: Session): string {
  return session.startedAt ?? session.endedAt ?? "";
}

export async function collectSessions(
  adapters: readonly SessionAdapter[],
): Promise<CollectionResult> {
  const result: CollectionResult = { sessions: [], warnings: [] };

  for (const adapter of adapters) {
    let sourceFiles: string[];
    try {
      sourceFiles = await adapter.discoverSourceFiles();
    } catch (error) {
      result.warnings.push({
        provider: adapter.provider,
        sourceFile: null,
        message: errorMessage(error),
      });
      continue;
    }

    for (const sourceFile of sourceFiles) {
      try {
        result.sessions.push((await adapter.parseFile(sourceFile)).session);
      } catch (error) {
        result.warnings.push({
          provider: adapter.provider,
          sourceFile,
          message: errorMessage(error),
        });
      }
    }
  }

  result.sessions.sort((left, right) =>
    sessionSortKey(right).localeCompare(sessionSortKey(left)),
  );
  return result;
}
