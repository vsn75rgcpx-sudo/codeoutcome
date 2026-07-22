import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { nextTheme } from "./app.js";
import {
  DistributionChart,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  TokenNumber,
} from "./components.js";
import { formatDuration, formatToken } from "./format.js";

const sourceRoot = path.join(process.cwd(), "apps", "dashboard", "src");

async function source(relativePath: string): Promise<string> {
  return await readFile(path.join(sourceRoot, relativePath), "utf8");
}

describe("dashboard UI", () => {
  it("formats Token values beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    expect(formatToken("9007199254740999")).toBe("9007.1T");
    expect(
      renderToStaticMarkup(<TokenNumber value="9007199254740999" />),
    ).toContain('title="9007199254740999"');
  });

  it("renders unavailable values instead of a misleading zero", () => {
    expect(formatToken("0", false)).toBe("unavailable");
    expect(formatDuration(null)).toBe("unavailable");
  });

  it("renders a polite loading state", () => {
    const markup = renderToStaticMarkup(
      <LoadingState label="Loading overview" />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading overview");
  });

  it("renders distinct empty and API error states", () => {
    expect(
      renderToStaticMarkup(
        <EmptyState title="No sessions" detail="Nothing matched." />,
      ),
    ).toContain("No sessions");
    const error = renderToStaticMarkup(
      <ErrorState message="Database unavailable" suggestion="Run doctor" />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("Run doctor");
  });

  it("renders status with text and a non-color marker", () => {
    const markup = renderToStaticMarkup(<StatusBadge value="failed" />);
    expect(markup).toContain("failed");
    expect(markup).toContain("status-mark");
  });

  it("provides an accessible chart text summary", () => {
    const markup = renderToStaticMarkup(
      <DistributionChart
        title="Provider distribution"
        data={[{ key: "codex", label: "Codex", count: 3 }]}
        emptyText="No providers"
      />,
    );
    expect(markup).toContain("Provider distribution. Codex: 3");
    expect(markup).toContain("Provider distribution text summary");
  });

  it("cycles system, light, and dark theme preferences", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("renders Overview metrics, trends, and Pricing unavailable", async () => {
    const text = await source("pages/OverviewPage.tsx");
    expect(text).toContain("Canonical Token accounting");
    expect(text).toContain("Daily token trend");
    expect(text).toContain("overview.pricing.label");
    expect(text).toContain("No recorded test runs");
  });

  it("provides Session list filters and a detail route view", async () => {
    const list = await source("pages/SessionsPage.tsx");
    const detail = await source("pages/SessionDetailPage.tsx");
    expect(list).toContain('aria-label="Session filters"');
    expect(list).toContain("accountingStatus");
    expect(detail).toContain("Canonical accounting metadata");
    expect(detail).not.toMatch(/session\.(prompt|response|sourceCode)/i);
  });

  it("provides Tracking list filters and a unified detail timeline", async () => {
    const list = await source("pages/TrackingRunsPage.tsx");
    const detail = await source("pages/TrackingDetailPage.tsx");
    expect(list).toContain('aria-label="Tracking run filters"');
    expect(list).toContain("testChange");
    expect(detail).toContain("Unified timeline");
    expect(detail).toContain("Baseline / final comparison");
  });

  it("provides Test list filters and a metadata-only detail view", async () => {
    const list = await source("pages/TestRunsPage.tsx");
    const detail = await source("pages/TestDetailPage.tsx");
    expect(list).toContain('aria-label="Test run filters"');
    expect(list).toContain("parserStatus");
    expect(detail).toContain("<dt>Fingerprint</dt>");
    expect(detail).not.toMatch(/stdout body|stderr body|stack trace body/i);
  });

  it("distinguishes no recorded tests from zero failed tests", async () => {
    const text = await source("pages/TestRunsPage.tsx");
    expect(text).toContain("No recorded test runs");
    expect(text).toContain("not the same as zero failed tests");
  });

  it("shows strict-mode null paths as unavailable", async () => {
    const sessions = await source("pages/SessionsPage.tsx");
    const diagnostics = await source("pages/DiagnosticsPage.tsx");
    expect(sessions).toContain('session.repository ?? "unavailable"');
    expect(diagnostics).toContain("diagnostics.database.path");
  });

  it("contains skip navigation and keyboard focus styling", async () => {
    const app = await source("app.tsx");
    const styles = await source("styles.css");
    expect(app).toContain('className="skip-link"');
    expect(app).toContain("tabIndex={-1}");
    expect(styles).toContain(":focus-visible");
  });

  it("keeps tables usable in narrow layouts", async () => {
    const styles = await source("styles.css");
    expect(styles).toContain("overflow-x: auto");
    expect(styles).toContain("@media (max-width: 860px)");
  });
});
