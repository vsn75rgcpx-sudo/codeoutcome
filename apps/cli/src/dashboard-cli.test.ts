import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  RunningDashboardServer,
  StartDashboardServerOptions,
} from "@codeoutcome/dashboard-server";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function resolvedServer(): RunningDashboardServer {
  return {
    host: "127.0.0.1",
    port: 45_678,
    url: "http://127.0.0.1:45678",
    accessToken: "must-not-be-logged",
    store: {} as RunningDashboardServer["store"],
    close: async () => undefined,
    closed: Promise.resolve(),
  };
}

async function directory(): Promise<string> {
  const value = await mkdtemp(
    path.join(tmpdir(), "codeoutcome-dashboard-cli-"),
  );
  temporaryDirectories.push(value);
  return value;
}

describe("dashboard CLI", () => {
  it("starts on a random loopback port, opens the browser, and never logs the token", async () => {
    const dataDirectory = await directory();
    const output = memoryIo();
    let startOptions: StartDashboardServerOptions | undefined;
    const opened: string[] = [];
    expect(
      await runCli(["dashboard", "--json"], {
        databaseFile: path.join(dataDirectory, "codeoutcome.sqlite"),
        userHome: dataDirectory,
        io: output.io,
        dashboardStarter: async (options) => {
          startOptions = options;
          return resolvedServer();
        },
        dashboardBrowserOpener: async (url) => {
          opened.push(url);
        },
      }),
    ).toBe(0);
    expect(startOptions).toMatchObject({ host: "127.0.0.1", port: 0 });
    expect(opened).toEqual(["http://127.0.0.1:45678"]);
    expect(JSON.parse(output.stdout[0] ?? "{}")).toMatchObject({
      url: "http://127.0.0.1:45678",
      databaseMode: "read-only",
      browserOpened: true,
    });
    expect(output.stdout.join("\n")).not.toContain("must-not-be-logged");
  });

  it("honors --no-open, explicit loopback host, and explicit port", async () => {
    const dataDirectory = await directory();
    const output = memoryIo();
    let startOptions: StartDashboardServerOptions | undefined;
    let browserCalls = 0;
    await runCli(
      [
        "dashboard",
        "--no-open",
        "--host",
        "localhost",
        "--port",
        "4567",
        "--json",
      ],
      {
        databaseFile: path.join(dataDirectory, "codeoutcome.sqlite"),
        userHome: dataDirectory,
        io: output.io,
        dashboardStarter: async (options) => {
          startOptions = options;
          return resolvedServer();
        },
        dashboardBrowserOpener: async () => {
          browserCalls += 1;
        },
      },
    );
    expect(startOptions).toMatchObject({ host: "localhost", port: 4567 });
    expect(browserCalls).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "{}")).toMatchObject({
      browserOpened: false,
    });
  });

  it("closes the server when SIGINT is received", async () => {
    const dataDirectory = await directory();
    const output = memoryIo();
    let resolveClosed: (() => void) | undefined;
    let closeCalls = 0;
    const server = resolvedServer();
    server.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    server.close = async () => {
      closeCalls += 1;
      resolveClosed?.();
    };
    let resolveServerStarted: (() => void) | undefined;
    const serverStarted = new Promise<void>((resolve) => {
      resolveServerStarted = resolve;
    });
    const running = runCli(["dashboard", "--no-open"], {
      databaseFile: path.join(dataDirectory, "codeoutcome.sqlite"),
      userHome: dataDirectory,
      io: output.io,
      dashboardStarter: async () => {
        resolveServerStarted?.();
        return server;
      },
    });
    await serverStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.emit("SIGINT");
    expect(closeCalls).toBe(1);
    expect(await running).toBe(0);
  });

  it("rejects invalid ports before starting a server", async () => {
    const dataDirectory = await directory();
    await expect(
      runCli(["dashboard", "--port", "70000"], {
        databaseFile: path.join(dataDirectory, "codeoutcome.sqlite"),
        userHome: dataDirectory,
      }),
    ).rejects.toThrow("--port must be an integer between 0 and 65535");
  });
});
