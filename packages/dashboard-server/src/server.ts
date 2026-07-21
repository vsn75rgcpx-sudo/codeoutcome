import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { serve } from "@hono/node-server";

import { createDashboardApp } from "./app.js";
import { DashboardStore, type DashboardStoreOptions } from "./store.js";

export interface StartDashboardServerOptions extends DashboardStoreOptions {
  host?: string;
  port?: number;
  staticRoot: string;
  indexHtml?: string;
  accessToken?: string;
}

export interface RunningDashboardServer {
  host: string;
  port: number;
  url: string;
  accessToken: string;
  store: DashboardStore;
  close(): Promise<void>;
  closed: Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export async function startDashboardServer(
  options: StartDashboardServerOptions,
): Promise<RunningDashboardServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      "Dashboard host must be loopback (127.0.0.1, localhost, or ::1)",
    );
  }
  const requestedPort = options.port ?? 0;
  if (
    !Number.isSafeInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65_535
  ) {
    throw new Error("Dashboard port must be an integer between 0 and 65535");
  }
  const accessToken =
    options.accessToken ?? randomBytes(32).toString("base64url");
  const store = new DashboardStore(options);
  let origin = "";
  const app = createDashboardApp({
    store,
    accessToken,
    expectedOrigin: () => origin,
    staticRoot: options.staticRoot,
    indexHtml: options.indexHtml,
    now: options.now,
  });
  let server: ReturnType<typeof serve>;
  const port = await new Promise<number>((resolve, reject) => {
    try {
      server = serve(
        { fetch: app.fetch, hostname: host, port: requestedPort },
        (info) => resolve(info.port),
      );
      server.once("error", reject);
    } catch (error) {
      reject(error);
    }
  }).catch((error) => {
    store.close();
    throw error;
  });
  origin = `http://${urlHost(host)}:${port}`;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server!.once("close", () => resolveClosed?.());
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        store.close();
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    return closing;
  };
  return { host, port, url: origin, accessToken, store, close, closed };
}
