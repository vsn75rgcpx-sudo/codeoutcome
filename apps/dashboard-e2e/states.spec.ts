import { expect, test } from "@playwright/test";

import { createDashboardRuntime } from "./support.js";

test("empty database distinguishes no records from zero failures", async ({
  page,
}) => {
  const runtime = await createDashboardRuntime({ kind: "empty" });
  try {
    await page.goto(runtime.url);
    await expect(
      page.getByText("unavailable", { exact: true }).first(),
    ).toBeVisible();
    await page.goto(`${runtime.url}/test-runs`);
    await expect(
      page.getByRole("heading", { name: "No recorded test runs" }),
    ).toBeVisible();
    await expect(
      page.getByText("not the same as zero failed tests"),
    ).toBeVisible();
    await expect(page.getByText("0 failed", { exact: true })).toHaveCount(0);
  } finally {
    await runtime.close();
  }
});

test("outdated schema and missing database show actionable read-only errors", async ({
  page,
}) => {
  const outdated = await createDashboardRuntime({ kind: "outdated" });
  try {
    await page.goto(outdated.url);
    await expect(page.getByRole("alert")).toContainText("schema is older");
  } finally {
    await outdated.close();
  }
  const missing = await createDashboardRuntime({ kind: "missing" });
  try {
    await page.goto(missing.url);
    await expect(page.getByRole("alert")).toContainText("does not exist");
  } finally {
    await missing.close();
  }
});

test("strict privacy never exposes Demo paths or full commands", async ({
  page,
}) => {
  const runtime = await createDashboardRuntime({ privacyMode: "strict" });
  try {
    await page.goto(`${runtime.url}/diagnostics`);
    await expect(page.getByText("strict", { exact: true })).toBeVisible();
    await expect(
      page.getByText("<redacted>", { exact: true }).first(),
    ).toBeVisible();
    await page.goto(`${runtime.url}/test-runs/demo-test-02`);
    await expect(page.getByText("vitest", { exact: true })).toBeVisible();
    await expect(
      page.getByText("vitest run --demo", { exact: true }),
    ).toHaveCount(0);
    expect(
      (await page.locator("body").innerText()).includes("/codeoutcome-demo/"),
    ).toBe(false);
  } finally {
    await runtime.close();
  }
});

test("front end reports an error after its local server stops", async ({
  page,
}) => {
  const runtime = await createDashboardRuntime();
  await page.goto(runtime.url);
  await expect(
    page.getByRole("heading", { name: "Activity overview" }),
  ).toBeVisible();
  await runtime.server.close();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Dashboard data unavailable",
  );
  await runtime.close();
});
