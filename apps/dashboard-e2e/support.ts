import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SessionDatabase } from "../../packages/database/src/index.js";
import {
  startDashboardServer,
  type RunningDashboardServer,
} from "../../packages/dashboard-server/src/index.js";
import { AGENTLEDGER_VERSION } from "../../packages/shared/src/index.js";
import { DEMO_NOW, seedDemoDatabase } from "../../scripts/demo-data.js";

export type DashboardFixtureKind = "demo" | "empty" | "missing" | "outdated";

export interface DashboardRuntime {
  directory: string;
  databaseFile: string;
  server: RunningDashboardServer;
  url: string;
  close(): Promise<void>;
}

export async function createDashboardRuntime(
  options: {
    kind?: DashboardFixtureKind;
    privacyMode?: "git-metadata" | "strict";
  } = {},
): Promise<DashboardRuntime> {
  const kind = options.kind ?? "demo";
  const directory = await mkdtemp(path.join(tmpdir(), "agentledger-e2e-"));
  const databaseFile = path.join(directory, "agentledger.sqlite");
  try {
    if (kind === "demo") {
      seedDemoDatabase(databaseFile);
    } else if (kind === "empty") {
      new SessionDatabase(databaseFile).close();
    } else if (kind === "outdated") {
      const database = new DatabaseSync(databaseFile);
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES (4, 'demo-outdated', '2026-07-01T00:00:00.000Z');",
      );
      database.close();
    }
    const server = await startDashboardServer({
      databaseFile,
      privacyMode: options.privacyMode ?? "git-metadata",
      userHome: path.join(directory, "synthetic-home"),
      claudeLogDirectory: path.join(directory, "synthetic-claude-logs"),
      codexLogDirectory: path.join(directory, "synthetic-codex-logs"),
      version: AGENTLEDGER_VERSION,
      staticRoot: path.resolve("apps/dashboard/dist"),
      host: "127.0.0.1",
      port: 0,
      now: () => new Date(DEMO_NOW),
    });
    let closed = false;
    return {
      directory,
      databaseFile,
      server,
      url: server.url,
      close: async () => {
        if (closed) return;
        closed = true;
        await server.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
