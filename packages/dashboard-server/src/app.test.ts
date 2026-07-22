import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DASHBOARD_TOKEN_HEADER } from "@codeoutcome/shared/dashboard";
import { afterEach, describe, expect, it } from "vitest";

import { createDashboardTestDatabase } from "../test/test-database.js";
import { isLoopbackHost, startDashboardServer } from "./server.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codeoutcome-dashboard-server-"),
  );
  temporaryDirectories.push(directory);
  const databaseFile = path.join(directory, "codeoutcome.sqlite");
  const staticRoot = path.join(directory, "dist");
  await mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await writeFile(
    path.join(staticRoot, "index.html"),
    '<!doctype html><meta name="codeoutcome-dashboard-token" content="__CODEOUTCOME_DASHBOARD_TOKEN__"><div id="root">CodeOutcome</div>',
  );
  await writeFile(
    path.join(staticRoot, "assets", "app.js"),
    "export const fixture = true;",
  );
  return { directory, databaseFile, staticRoot };
}

async function requestWithHost(url: URL, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        headers: {
          host,
          [DASHBOARD_TOKEN_HEADER]: "test-token",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard HTTP server", () => {
  it("accepts only loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.12.4.2")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });

  it("serves all APIs and static assets with token, Host, and Origin protection", async () => {
    const files = await fixture();
    createDashboardTestDatabase(files.databaseFile);
    const before = createHash("sha256")
      .update(await readFile(files.databaseFile))
      .digest("hex");
    const server = await startDashboardServer({
      databaseFile: files.databaseFile,
      privacyMode: "git-metadata",
      userHome: "/private",
      claudeLogDirectory: "/missing/claude",
      codexLogDirectory: "/missing/codex",
      version: "test",
      staticRoot: files.staticRoot,
      host: "127.0.0.1",
      port: 0,
      accessToken: "test-token",
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(server.port).toBeGreaterThan(0);
    const headers = { [DASHBOARD_TOKEN_HEADER]: "test-token" };
    for (const endpoint of [
      "/api/health",
      "/api/meta",
      "/api/overview",
      "/api/sessions",
      "/api/sessions/session-1",
      "/api/tracking-runs",
      "/api/tracking-runs/tracking-1",
      "/api/test-runs",
      "/api/test-runs/final",
      "/api/diagnostics",
      "/api/filters",
    ]) {
      const response = await fetch(`${server.url}${endpoint}`, { headers });
      expect(response.status, endpoint).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await fetch(`${server.url}/api/health`)).status).toBe(401);
    const badToken = await fetch(`${server.url}/api/health`, {
      headers: { [DASHBOARD_TOKEN_HEADER]: "wrong-token" },
    });
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toMatchObject({
      data: null,
      pagination: null,
      error: { code: "unauthorized" },
    });
    expect(
      (
        await fetch(`${server.url}/api/health`, {
          headers: { ...headers, origin: "http://evil.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      await requestWithHost(new URL("/api/health", server.url), "evil.invalid"),
    ).toBe(403);
    expect(
      (await fetch(`${server.url}/api/sessions?sort=raw_sql`, { headers }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${server.url}/api/sessions?pageSize=201`, { headers }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${server.url}/api/sessions/missing`, { headers })).status,
    ).toBe(404);
    expect(
      (await fetch(`${server.url}/api/not-a-route`, { headers })).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${server.url}/api/sessions`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(404);
    const index = await (await fetch(server.url)).text();
    expect(index).toContain("test-token");
    expect(index).not.toContain("__CODEOUTCOME_DASHBOARD_TOKEN__");
    expect((await fetch(`${server.url}/assets/app.js`)).status).toBe(200);
    const fallback = await fetch(`${server.url}/sessions/session-1`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("test-token");

    const overview = await (
      await fetch(`${server.url}/api/overview`, { headers })
    ).text();
    expect(overview).not.toMatch(
      /source_file|stdout|stderr|prompt|full.?diff/i,
    );
    await server.close();
    await server.closed;
    const after = createHash("sha256")
      .update(await readFile(files.databaseFile))
      .digest("hex");
    expect(after).toBe(before);
  });

  it("returns a sanitized error for a missing database without creating it", async () => {
    const files = await fixture();
    const server = await startDashboardServer({
      databaseFile: files.databaseFile,
      privacyMode: "strict",
      userHome: files.directory,
      claudeLogDirectory: path.join(files.directory, "claude"),
      codexLogDirectory: path.join(files.directory, "codex"),
      version: "test",
      staticRoot: files.staticRoot,
      accessToken: "missing-token",
    });
    const response = await fetch(`${server.url}/api/overview`, {
      headers: { [DASHBOARD_TOKEN_HEADER]: "missing-token" },
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("database_missing");
    expect(body).not.toContain(files.directory);
    expect(await readFile(files.databaseFile).catch(() => null)).toBeNull();
    await server.close();
  });

  it("projects strict privacy mode through every API response", async () => {
    const files = await fixture();
    createDashboardTestDatabase(files.databaseFile);
    const server = await startDashboardServer({
      databaseFile: files.databaseFile,
      privacyMode: "strict",
      userHome: "/private",
      claudeLogDirectory: "/private/claude",
      codexLogDirectory: "/private/codex",
      version: "test",
      staticRoot: files.staticRoot,
      accessToken: "strict-token",
    });
    const headers = { [DASHBOARD_TOKEN_HEADER]: "strict-token" };
    const bodies: string[] = [];
    for (const endpoint of [
      "/api/overview",
      "/api/sessions",
      "/api/sessions/session-1",
      "/api/tracking-runs",
      "/api/tracking-runs/tracking-1",
      "/api/test-runs/baseline",
      "/api/filters",
      "/api/diagnostics",
    ]) {
      bodies.push(
        await (await fetch(`${server.url}${endpoint}`, { headers })).text(),
      );
    }
    expect(bodies.join("\n")).not.toContain("/private/");
    expect(bodies[5]).not.toContain("pytest -q");
    expect(bodies[5]).toContain('"commandDisplay":"pytest"');
    await server.close();
  });

  it("reports an outdated schema without applying migrations", async () => {
    const files = await fixture();
    const database = new DatabaseSync(files.databaseFile);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (4);",
    );
    database.close();
    const before = createHash("sha256")
      .update(await readFile(files.databaseFile))
      .digest("hex");
    const server = await startDashboardServer({
      databaseFile: files.databaseFile,
      privacyMode: "git-metadata",
      userHome: files.directory,
      claudeLogDirectory: path.join(files.directory, "claude"),
      codexLogDirectory: path.join(files.directory, "codex"),
      version: "test",
      staticRoot: files.staticRoot,
      accessToken: "outdated-token",
    });
    const response = await fetch(`${server.url}/api/overview`, {
      headers: { [DASHBOARD_TOKEN_HEADER]: "outdated-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      data: null,
      error: { code: "schema_outdated" },
      meta: { schemaVersion: 4 },
    });
    await server.close();
    const after = createHash("sha256")
      .update(await readFile(files.databaseFile))
      .digest("hex");
    expect(after).toBe(before);
  });
});
