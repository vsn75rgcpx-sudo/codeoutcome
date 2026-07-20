import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export type Provider = "claude-code" | "codex";

export interface Session {
  id: string;
  provider: Provider;
  model: string;
  startedAt: string | null;
  endedAt: string | null;
  workingDirectory: string | null;
  repositoryPath: string | null;
  branch: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCost: number | null;
  sourceFile: string;
}

export interface SessionAdapter {
  readonly provider: Provider;
  readonly logRoot: string;
  discoverSourceFiles(): Promise<string[]>;
  parseFile(sourceFile: string): Promise<Session>;
}

export interface ParseWarning {
  provider: Provider;
  sourceFile: string | null;
  message: string;
}

export interface CollectionResult {
  sessions: Session[];
  warnings: ParseWarning[];
}

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonRecord;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return undefined;
}

export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}

export function updateTimestampBounds(
  currentStart: string | undefined,
  currentEnd: string | undefined,
  candidate: string | undefined,
): { start: string | undefined; end: string | undefined } {
  if (candidate === undefined) {
    return { start: currentStart, end: currentEnd };
  }

  return {
    start:
      currentStart === undefined || candidate < currentStart
        ? candidate
        : currentStart,
    end:
      currentEnd === undefined || candidate > currentEnd
        ? candidate
        : currentEnd,
  };
}

export async function discoverJsonlFiles(root: string): Promise<string[]> {
  const discovered: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        discovered.push(entryPath);
      }
    }
  }

  await visit(root);
  return discovered.sort((left, right) => left.localeCompare(right));
}

export async function* readJsonlRecords(
  sourceFile: string,
): AsyncGenerator<JsonRecord> {
  const input = createReadStream(sourceFile, {
    encoding: "utf8",
    flags: "r",
  });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      const record = asRecord(parsed);
      if (record !== undefined) {
        yield record;
      }
    } catch {
      // A partially written or unknown line must not make the whole session fail.
    }
  }
}

export function fallbackSessionId(sourceFile: string): string {
  const basename = path.basename(sourceFile, path.extname(sourceFile)).trim();
  return basename.length > 0 ? basename : "unknown-session";
}
