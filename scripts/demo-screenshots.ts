import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

import { createDashboardRuntime } from "../apps/dashboard-e2e/support.js";

const outputDirectory = path.resolve("docs/assets");

async function settle(page: Page): Promise<void> {
  await page.locator("main h1").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
}

async function capture(
  page: Page,
  url: string,
  fileName: string,
  theme: "light" | "dark",
): Promise<void> {
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem("agentledger-theme", selectedTheme);
  }, theme);
  await page.goto(url);
  await settle(page);
  await page.screenshot({
    path: path.join(outputDirectory, fileName),
    animations: "disabled",
    fullPage: false,
  });
}

await mkdir(outputDirectory, { recursive: true });
const runtime = await createDashboardRuntime();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await capture(page, runtime.url, "dashboard-overview-light.png", "light");
  await capture(page, runtime.url, "dashboard-overview-dark.png", "dark");
  await capture(
    page,
    `${runtime.url}/tracking-runs/demo-tracking-01`,
    "dashboard-tracking-detail.png",
    "light",
  );
  await capture(
    page,
    `${runtime.url}/sessions/demo-session-12`,
    "dashboard-session-detail.png",
    "light",
  );
  await context.close();
} finally {
  await browser.close();
  await runtime.close();
}

console.log(`Demo Dashboard screenshots written to ${outputDirectory}`);
