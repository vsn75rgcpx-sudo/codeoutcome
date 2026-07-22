import { readFileSync } from "node:fs";
import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import {
  DASHBOARD_API_VERSION,
  DASHBOARD_TOKEN_HEADER,
  type DashboardErrorEnvelope,
  type DashboardMeta,
  type DashboardRange,
} from "@codeoutcome/shared";
import { Hono, type Context } from "hono";

import { DashboardDataError, type DashboardStore } from "./store.js";
import {
  DashboardRequestError,
  sessionQuery,
  testQuery,
  trackingQuery,
} from "./validation.js";

export interface DashboardAppOptions {
  store: DashboardStore;
  accessToken: string;
  expectedOrigin: () => string;
  staticRoot: string;
  indexHtml?: string;
  now?: () => Date;
}

function hasTraversal(url: string): boolean {
  const rawPath = url.split("?", 1)[0] ?? "";
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(decoded);
    decoded = decodeURIComponent(decoded);
  } catch {
    return true;
  }
  return decoded.split(/[\\/]/).includes("..");
}

function secureIndex(indexHtml: string, token: string): string {
  if (!indexHtml.includes("__CODEOUTCOME_DASHBOARD_TOKEN__")) {
    throw new Error("Dashboard index is missing the access-token placeholder");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Dashboard access token is not safe for HTML injection");
  }
  return indexHtml.replaceAll("__CODEOUTCOME_DASHBOARD_TOKEN__", token);
}

export function createDashboardApp(options: DashboardAppOptions): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());
  const index = secureIndex(
    options.indexHtml ??
      readFileSync(path.join(options.staticRoot, "index.html"), "utf8"),
    options.accessToken,
  );
  const meta = (): DashboardMeta => ({
    apiVersion: DASHBOARD_API_VERSION,
    generatedAt: now().toISOString(),
    schemaVersion: options.store.schemaVersion,
    privacyMode: options.store.diagnostics().privacyMode,
  });
  const envelope = <T>(
    data: T,
    pagination:
      ReturnType<DashboardStore["sessions"]>["pagination"] | null = null,
  ) => ({
    data,
    pagination,
    meta: meta(),
  });

  app.use("*", async (context, next) => {
    context.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Frame-Options", "DENY");
    if (hasTraversal(context.req.url)) {
      return context.json(
        {
          ...envelope(null),
          error: {
            code: "invalid_path",
            message: "Invalid path",
            suggestion: null,
          },
        },
        400,
      );
    }
    const expectedOrigin = options.expectedOrigin();
    const expectedHost =
      expectedOrigin.length === 0 ? "" : new URL(expectedOrigin).host;
    const requestHost = context.req.header("host") ?? "";
    if (expectedHost.length > 0 && requestHost !== expectedHost) {
      return context.json(
        {
          ...envelope(null),
          error: {
            code: "forbidden_host",
            message: "Host is not allowed",
            suggestion: null,
          },
        },
        403,
      );
    }
    if (context.req.path.startsWith("/api/")) {
      context.header("Cache-Control", "no-store");
      const origin = context.req.header("origin");
      if (origin !== undefined && origin !== expectedOrigin) {
        return context.json(
          {
            ...envelope(null),
            error: {
              code: "forbidden_origin",
              message: "Origin is not allowed",
              suggestion: null,
            },
          },
          403,
        );
      }
      if (context.req.header(DASHBOARD_TOKEN_HEADER) !== options.accessToken) {
        return context.json(
          {
            ...envelope(null),
            error: {
              code: "unauthorized",
              message: "Dashboard access token is required",
              suggestion: null,
            },
          },
          401,
        );
      }
    }
    await next();
  });

  app.get("/api/health", (context) =>
    context.json(
      envelope({
        status:
          options.store.status === "ready"
            ? "ok"
            : options.store.status === "outdated"
              ? "schema_outdated"
              : "database_unavailable",
        database: options.store.status,
        queryOnly: options.store.queryOnly,
      }),
    ),
  );
  app.get("/api/meta", (context) =>
    context.json(
      envelope({
        apiVersion: DASHBOARD_API_VERSION,
        privacyMode: options.store.diagnostics().privacyMode,
        schemaVersion: options.store.schemaVersion,
        refreshMinimumSeconds: 30,
      }),
    ),
  );
  app.get("/api/overview", (context) => {
    const rawRange = context.req.query("range") ?? "7d";
    if (rawRange !== "7d" && rawRange !== "30d" && rawRange !== "all") {
      throw new DashboardRequestError("range must be 7d, 30d, or all");
    }
    return context.json(
      envelope(options.store.overview(rawRange as DashboardRange)),
    );
  });
  app.get("/api/sessions", (context) => {
    const result = options.store.sessions(sessionQuery(context.req.query()));
    return context.json(envelope(result.items, result.pagination));
  });
  app.get("/api/sessions/:id", (context) => {
    const data = options.store.session(context.req.param("id"));
    if (data === null) {
      return context.json(
        {
          ...envelope(null),
          error: {
            code: "not_found",
            message: "Session not found",
            suggestion: null,
          },
        },
        404,
      );
    }
    return context.json(envelope(data));
  });
  app.get("/api/tracking-runs", (context) => {
    const result = options.store.trackingRuns(
      trackingQuery(context.req.query()),
    );
    return context.json(envelope(result.items, result.pagination));
  });
  app.get("/api/tracking-runs/:id", (context) => {
    const data = options.store.trackingRun(context.req.param("id"));
    if (data === null) {
      return context.json(
        {
          ...envelope(null),
          error: {
            code: "not_found",
            message: "Tracking run not found",
            suggestion: null,
          },
        },
        404,
      );
    }
    return context.json(envelope(data));
  });
  app.get("/api/test-runs", (context) => {
    const result = options.store.testRuns(testQuery(context.req.query()));
    return context.json(envelope(result.items, result.pagination));
  });
  app.get("/api/test-runs/:id", (context) => {
    const data = options.store.testRun(context.req.param("id"));
    if (data === null) {
      return context.json(
        {
          ...envelope(null),
          error: {
            code: "not_found",
            message: "Test run not found",
            suggestion: null,
          },
        },
        404,
      );
    }
    return context.json(envelope(data));
  });
  app.get("/api/diagnostics", (context) =>
    context.json(envelope(options.store.diagnostics())),
  );
  app.get("/api/filters", (context) =>
    context.json(envelope(options.store.filters())),
  );
  app.all("/api/*", (context) =>
    context.json(
      {
        ...envelope(null),
        error: {
          code: "not_found",
          message: "API route not found",
          suggestion: null,
        },
      },
      404,
    ),
  );

  const serveIndex = (context: Context) => {
    context.header("Cache-Control", "no-store");
    return context.html(index);
  };
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);
  app.use("*", serveStatic({ root: options.staticRoot }));
  app.get("*", serveIndex);

  app.onError((error, context) => {
    const requestError = error instanceof DashboardRequestError;
    const dataError = error instanceof DashboardDataError;
    const status = requestError ? 400 : dataError ? error.httpStatus : 500;
    const response: DashboardErrorEnvelope = {
      data: null,
      pagination: null,
      meta: meta(),
      error: {
        code: requestError
          ? "invalid_request"
          : dataError
            ? error.code
            : "internal_error",
        message: requestError
          ? error.message
          : dataError
            ? error.message
            : "The dashboard could not complete this request.",
        suggestion: dataError ? error.suggestion : null,
      },
    };
    return context.json(response, status as 400 | 500 | 503);
  });
  return app;
}
