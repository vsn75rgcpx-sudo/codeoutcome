import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GitPrivacyMode } from "@agentledger/shared";

export interface AgentLedgerConfig {
  privacy: GitPrivacyMode;
}

export const DEFAULT_AGENTLEDGER_CONFIG: AgentLedgerConfig = {
  privacy: "git-metadata",
};

export function configFilePath(dataDirectory: string): string {
  return path.join(dataDirectory, "config.json");
}

export async function readAgentLedgerConfig(
  dataDirectory: string,
): Promise<AgentLedgerConfig> {
  try {
    const raw = await readFile(configFilePath(dataDirectory), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ...DEFAULT_AGENTLEDGER_CONFIG };
    }
    const privacy = (parsed as Record<string, unknown>).privacy;
    return {
      privacy: privacy === "strict" ? "strict" : "git-metadata",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_AGENTLEDGER_CONFIG };
    }
    if (error instanceof SyntaxError) {
      throw new Error("AgentLedger local config is not valid JSON");
    }
    throw error;
  }
}

export async function setPrivacyMode(
  dataDirectory: string,
  privacy: GitPrivacyMode,
): Promise<AgentLedgerConfig> {
  const config = { privacy } satisfies AgentLedgerConfig;
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
