import { request as httpRequest } from "node:http";

import { expect, test } from "@playwright/test";

import { createDashboardRuntime, type DashboardRuntime } from "./support.js";

let runtime: DashboardRuntime;

test.beforeAll(async () => {
  runtime = await createDashboardRuntime();
});

test.afterAll(async () => {
  await runtime.close();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(runtime.url);
  await expect(
    page.getByRole("heading", { name: "Activity overview" }),
  ).toBeVisible();
});

test("opens the production Overview with exact large Tokens and unavailable pricing", async ({
  page,
}) => {
  await expect(
    page.getByText("Pricing unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("11", { exact: true }).first()).toBeVisible();
  const total = page.getByText("9007.1T", { exact: true }).first();
  await expect(total).toBeVisible();
  await expect(total).toHaveAttribute("title", "9007199257625299");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();
});

test("paginates and filters Sessions by Provider, model, and repository", async ({
  page,
}) => {
  await page.goto(`${runtime.url}/sessions?pageSize=5`);
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Sessions table" }),
  ).toBeVisible();
  const sessionFilters = page.getByRole("region", { name: "Session filters" });
  await expect(page.getByText(/Page 1 of 3 · 12 records/)).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/Page 2 of 3 · 12 records/)).toBeVisible();
  await page.getByRole("button", { name: "Previous" }).click();
  await sessionFilters.locator("select").nth(0).selectOption("claude-code");
  await expect(
    page.getByRole("cell", { name: "claude-code" }).first(),
  ).toBeVisible();
  await sessionFilters
    .locator("select")
    .nth(1)
    .selectOption("claude-opus-demo");
  await expect(
    page.getByRole("cell", { name: "claude-opus-demo" }).first(),
  ).toBeVisible();
  await sessionFilters.locator("select").nth(2).selectOption("Cedar Notes");
  await expect(
    page.getByRole("cell", { name: "Cedar Notes" }).first(),
  ).toBeVisible();
  await sessionFilters.locator("select").nth(0).selectOption("");
  await sessionFilters.locator("select").nth(1).selectOption("");
  await sessionFilters.locator("select").nth(2).selectOption("");
  await expect(page.getByText(/Page 1 of 3 · 12 records/)).toBeVisible();
});

test("opens Session detail and survives a direct route refresh", async ({
  page,
}) => {
  await page.goto(`${runtime.url}/sessions/demo-session-12`);
  await expect(
    page.getByRole("heading", { name: "Session detail" }),
  ).toBeVisible();
  await expect(
    page.getByText("gpt-5.6-sol-demo", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Session detail" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Session detail · AgentLedger");
});

test("filters Tracking Runs and opens observed Git metadata", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Tracking Runs" }).click();
  await expect(
    page.getByRole("heading", { name: "Tracking runs" }),
  ).toBeVisible();
  const trackingFilters = page.getByRole("region", {
    name: "Tracking run filters",
  });
  await trackingFilters.locator("select").nth(0).selectOption("codex");
  await trackingFilters.locator("select").nth(3).selectOption("high");
  await expect(page.getByText("Stabilize queue handoff")).toBeVisible();
  await trackingFilters.locator("select").nth(4).selectOption("true");
  await expect(
    page.getByRole("region", { name: "Tracking runs table" }),
  ).toBeVisible();
});

test("shows Tracking detail timeline and comparable baseline/final change", async ({
  page,
}) => {
  await page.goto(`${runtime.url}/tracking-runs/demo-tracking-01`);
  await expect(
    page.getByRole("heading", { name: "Stabilize queue handoff" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Unified timeline" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Baseline / final comparison" }),
  ).toBeVisible();
  await expect(page.getByText("failed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("passed", { exact: true }).first()).toBeVisible();
});

test("filters Test Runs and opens metadata-only Test detail", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Test Runs" }).click();
  const testFilters = page.getByRole("region", { name: "Test run filters" });
  await testFilters.locator("select").nth(0).selectOption("vitest");
  await testFilters.locator("select").nth(1).selectOption("passed");
  await expect(
    page.getByRole("cell", { name: "vitest" }).first(),
  ).toBeVisible();
  await page.goto(`${runtime.url}/test-runs/demo-test-02`);
  await expect(
    page.getByRole("heading", { name: "Test run detail" }),
  ).toBeVisible();
  await expect(page.getByText("Raw output not stored")).toBeVisible();
  await expect(page.getByText("demo-command")).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Failed" }).getByText("0", {
      exact: true,
    }),
  ).toBeVisible();
});

test("shows read-only Diagnostics and the unified alpha version", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Diagnostics" }).click();
  await expect(
    page.getByRole("heading", { name: "Diagnostics" }),
  ).toBeVisible();
  await expect(page.getByText("0.1.0-alpha.1")).toBeVisible();
  await expect(page.getByText("enabled", { exact: true })).toHaveCount(2);
  await expect(page.getByText("ok", { exact: true })).toBeVisible();
});

test("cycles system, light, and dark themes and persists the preference", async ({
  page,
}) => {
  const theme = page.getByRole("button", { name: /Theme:/ });
  await expect(theme).toContainText("system");
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
});

test("remains operable at 768px and 390px with horizontal table scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await page.getByRole("link", { name: "Sessions" }).click();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const table = page.getByRole("region", { name: "Sessions table" });
  await expect(table).toBeVisible();
  expect(
    await table.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await table.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect(await table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(
    0,
  );
});

test("supports skip navigation and keyboard-only primary navigation", async ({
  page,
}) => {
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.getByRole("link", { name: "Sessions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
});

test("supports SPA fallback, route refresh, and browser back/forward", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Sessions" }).click();
  await page
    .getByRole("link", { name: /demo-sessi/i })
    .first()
    .click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Session detail" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Session detail" }),
  ).toBeVisible();
});

test("keeps API 404 separate from SPA fallback and enforces token and Origin", async ({
  request,
}) => {
  const notFound = await request.get(`${runtime.url}/api/not-a-route`, {
    headers: { "x-agentledger-dashboard-token": runtime.server.accessToken },
  });
  expect(notFound.status()).toBe(404);
  expect(notFound.headers()["content-type"]).toContain("application/json");
  expect((await request.get(`${runtime.url}/api/health`)).status()).toBe(401);
  expect(
    (
      await request.get(`${runtime.url}/api/health`, {
        headers: { "x-agentledger-dashboard-token": "wrong-demo-token" },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.get(`${runtime.url}/api/health`, {
        headers: {
          "x-agentledger-dashboard-token": runtime.server.accessToken,
          origin: "http://invalid.example",
        },
      })
    ).status(),
  ).toBe(403);
});

test("rejects an invalid Host on the production HTTP server", async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(
      new URL("/api/health", runtime.url),
      {
        headers: {
          host: "invalid.example",
          "x-agentledger-dashboard-token": runtime.server.accessToken,
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
  expect(status).toBe(403);
});

test("shows loading and sanitized API error states", async ({ page }) => {
  await page.route("**/api/sessions**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.goto(`${runtime.url}/sessions`);
  await expect(page.getByRole("status")).toContainText(
    /Loading (dashboard view|sessions)/,
  );
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await page.route("**/api/tracking-runs**", (route) => route.abort());
  await page.goto(`${runtime.url}/tracking-runs`);
  await expect(page.getByRole("alert")).toContainText(
    "Dashboard data unavailable",
  );
});

test("configures 30-second auto refresh and can turn it off", async ({
  page,
}) => {
  const refresh = page.getByLabel("Automatic refresh interval");
  await refresh.selectOption("30");
  await expect(refresh).toHaveValue("30");
  await refresh.selectOption("0");
  await expect(refresh).toHaveValue("0");
});

test("renders a semantic page-not-found state", async ({ page }) => {
  await page.goto(`${runtime.url}/does-not-exist`);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Page not found · AgentLedger");
});
