import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { createDashboardRuntime, type DashboardRuntime } from "./support.js";

let runtime: DashboardRuntime;

test.beforeAll(async () => {
  runtime = await createDashboardRuntime();
});

test.afterAll(async () => {
  await runtime.close();
});

const pages = [
  ["Overview", "/"],
  ["Sessions", "/sessions"],
  ["Session detail", "/sessions/demo-session-12"],
  ["Tracking runs", "/tracking-runs"],
  ["Tracking detail", "/tracking-runs/demo-tracking-01"],
  ["Test runs", "/test-runs"],
  ["Test detail", "/test-runs/demo-test-02"],
  ["Diagnostics", "/diagnostics"],
] as const;

for (const [name, path] of pages) {
  test(`${name} has no serious or critical axe violations`, async ({
    page,
  }) => {
    await page.goto(`${runtime.url}${path}`);
    await expect(page.locator("main h1")).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const violations = results.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    expect(violations).toEqual([]);
  });
}

test("dark theme has no serious or critical axe violations", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("codeoutcome-theme", "dark"),
  );
  await page.goto(runtime.url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});
