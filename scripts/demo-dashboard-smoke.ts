import path from "node:path";

import { startDashboardServer } from "../packages/dashboard-server/src/index.js";
import { CODEOUTCOME_VERSION } from "../packages/shared/src/index.js";
import { DEMO_NOW, DEMO_ROOT } from "./demo-data.js";

const server = await startDashboardServer({
  databaseFile: path.resolve("artifacts/demo/codeoutcome.sqlite"),
  privacyMode: "git-metadata",
  userHome: `${DEMO_ROOT}/home`,
  claudeLogDirectory: `${DEMO_ROOT}/provider-logs/claude-code`,
  codexLogDirectory: `${DEMO_ROOT}/provider-logs/codex`,
  version: CODEOUTCOME_VERSION,
  host: "127.0.0.1",
  port: 0,
  staticRoot: path.resolve("apps/dashboard/dist"),
  now: () => new Date(DEMO_NOW),
});

try {
  const home = await fetch(server.url);
  const html = await home.text();
  const token = /name="codeoutcome-dashboard-token"\s+content="([^"]+)"/.exec(
    html,
  )?.[1];
  if (!home.ok || token === undefined || !html.includes('<div id="root">')) {
    throw new Error("Demo Dashboard homepage smoke check failed");
  }
  const health = await fetch(new URL("/api/health", server.url), {
    headers: { "x-codeoutcome-dashboard-token": token },
  });
  const result = (await health.json()) as { data?: { status?: string } };
  if (!health.ok || result.data?.status !== "ok") {
    throw new Error("Demo Dashboard health smoke check failed");
  }
  console.log(
    JSON.stringify(
      {
        demoData: true,
        homepage: home.status,
        health: health.status,
        databaseMode: "read-only",
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
