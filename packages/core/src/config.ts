import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GitPrivacyMode } from "@codeoutcome/shared";

export interface CodeOutcomeConfig {
  privacy: GitPrivacyMode;
}

export const DEFAULT_CODEOUTCOME_CONFIG: CodeOutcomeConfig = {
  privacy: "git-metadata",
};

export function configFilePath(dataDirectory: string): string {
  return path.join(dataDirectory, "config.json");
}

export async function readCodeOutcomeConfig(
  dataDirectory: string,
): Promise<CodeOutcomeConfig> {
  try {
    const raw = await readFile(configFilePath(dataDirectory), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ...DEFAULT_CODEOUTCOME_CONFIG };
    }
    const privacy = (parsed as Record<string, unknown>).privacy;
    return {
      privacy: privacy === "strict" ? "strict" : "git-metadata",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CODEOUTCOME_CONFIG };
    }
    if (error instanceof SyntaxError) {
      throw new Error("CodeOutcome local config is not valid JSON");
    }
    throw error;
  }
}

export async function setPrivacyMode(
  dataDirectory: string,
  privacy: GitPrivacyMode,
): Promise<CodeOutcomeConfig> {
  const config = { privacy } satisfies CodeOutcomeConfig;
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const destination = configFilePath(dataDirectory);
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
  return config;
}
