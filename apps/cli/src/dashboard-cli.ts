import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readCodeOutcomeConfig } from "@codeoutcome/core";
import { CODEOUTCOME_VERSION } from "@codeoutcome/shared";
import {
  startDashboardServer,
  type RunningDashboardServer,
  type StartDashboardServerOptions,
} from "@codeoutcome/dashboard-server";

const execFileAsync = promisify(execFile);

export interface DashboardCliContext {
  io: { stdout(message: string): void; stderr(message: string): void };
  databaseFile: string;
  dataDirectory: string;
  userHome: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  staticRoot?: string;
  startServer?: (
    options: StartDashboardServerOptions,
  ) => Promise<RunningDashboardServer>;
  openBrowser?: (url: string) => Promise<void>;
}

interface DashboardArguments {
  host: string;
  port: number;
  noOpen: boolean;
  json: boolean;
}

function parse(arguments_: readonly string[]): DashboardArguments {
  let host = "127.0.0.1";
  let port = 0;
  let noOpen = false;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--no-open") {
      noOpen = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--host" || argument === "--port") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--host") {
        host = value;
      } else {
        port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
          throw new Error("--port must be an integer between 0 and 65535");
        }
      }
      index += 1;
    } else {
      throw new Error(`Unknown dashboard option: ${argument ?? ""}`);
    }
  }
  return { host, port, noOpen, json };
}

async function openSystemBrowser(
  url: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }
  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url], {
      windowsHide: true,
    });
    return;
  }
  await execFileAsync("xdg-open", [url]);
}

function defaultStaticRoot(): string {
  return fileURLToPath(new URL("../../dashboard/dist/", import.meta.url));
}

function configuredLogDirectory(
  environment: NodeJS.ProcessEnv,
  currentName: string,
  legacyName: string,
  fallback: string,
): string {
  const current = environment[currentName]?.trim();
  if (current !== undefined && current.length > 0) return current;
  const legacy = environment[legacyName]?.trim();
  return legacy !== undefined && legacy.length > 0 ? legacy : fallback;
}

export async function runDashboardCli(
  arguments_: readonly string[],
  context: DashboardCliContext,
): Promise<number | null> {
  const [command, ...rest] = arguments_;
  if (command !== "dashboard") return null;
  const parsed = parse(rest);
  const config = await readCodeOutcomeConfig(context.dataDirectory);
  const server = await (context.startServer ?? startDashboardServer)({
    databaseFile: context.databaseFile,
    privacyMode: config.privacy,
    userHome: context.userHome,
    claudeLogDirectory: configuredLogDirectory(
      context.environment,
      "CODEOUTCOME_CLAUDE_LOG_DIR",
      "AGENTLEDGER_CLAUDE_LOG_DIR",
      path.join(context.userHome, ".claude", "projects"),
    ),
    codexLogDirectory: configuredLogDirectory(
      context.environment,
      "CODEOUTCOME_CODEX_LOG_DIR",
      "AGENTLEDGER_CODEX_LOG_DIR",
      path.join(context.userHome, ".codex", "sessions"),
    ),
    version: CODEOUTCOME_VERSION,
    host: parsed.host,
    port: parsed.port,
    staticRoot: context.staticRoot ?? defaultStaticRoot(),
    now: context.now,
  });
  context.io.stdout(
    parsed.json
      ? JSON.stringify(
          {
            url: server.url,
            host: server.host,
            port: server.port,
            databaseMode: "read-only",
            browserOpened: !parsed.noOpen,
          },
          null,
          2,
        )
      : `CodeOutcome Dashboard: ${server.url}\nDatabase mode: read-only`,
  );
  if (!parsed.noOpen) {
    try {
      await (
        context.openBrowser ??
        ((url) => openSystemBrowser(url, context.platform))
      )(server.url);
    } catch {
      context.io.stderr(
        `WARN: The browser could not be opened automatically. Open ${server.url} manually.`,
      );
    }
  }
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close().catch(() => undefined);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await server.closed;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
  return 0;
}

export const DASHBOARD_HELP = `  codeoutcome dashboard [--no-open] [--port 4567] [--host 127.0.0.1] [--json]`;
