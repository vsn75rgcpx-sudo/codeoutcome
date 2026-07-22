import { Link, useSearchParams } from "react-router";

import type {
  DashboardOverview,
  DashboardRange,
  DashboardTokenTrend,
} from "@codeoutcome/shared/dashboard";

import { useApi } from "../api.js";
import { useDashboard } from "../app.js";
import {
  DistributionChart,
  EmptyState,
  ErrorState,
  LoadingState,
  LocalTime,
  MetricCard,
  PageHeader,
  StatusBadge,
  TokenNumber,
} from "../components.js";

function TrendChart({ data }: { data: DashboardTokenTrend[] }) {
  const maximum = data.reduce((largest, item) => {
    const value = BigInt(item.totalTokens);
    return value > largest ? value : largest;
  }, 1n);
  const summary = data
    .map(
      (item) =>
        `${item.date}: ${item.totalTokens} tokens, ${item.sessions} sessions`,
    )
    .join("; ");
  return (
    <section className="panel chart-panel trend-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Canonical accounting</p>
          <h2>Daily token trend</h2>
        </div>
        <span className="muted">Total = Input + Output</span>
      </div>
      {data.length === 0 ? (
        <p className="muted">No session trend is available for this range.</p>
      ) : (
        <>
          <svg
            className="trend-chart"
            viewBox={`0 0 ${Math.max(500, data.length * 38)} 180`}
            role="img"
            aria-label={`Daily token and session summary. ${summary}`}
          >
            <line x1="0" y1="160" x2="100%" y2="160" className="chart-axis" />
            {data.map((item, index) => {
              const height = Number(
                (BigInt(item.totalTokens) * 130n) / maximum,
              );
              return (
                <g key={item.date} transform={`translate(${index * 38 + 8} 0)`}>
                  <rect
                    x="0"
                    y={160 - height}
                    width="22"
                    height={Math.max(2, height)}
                    rx="4"
                    className="trend-bar"
                  />
                  <text x="11" y="176" textAnchor="middle">
                    {item.date.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>
          <details className="chart-summary">
            <summary>Text summary</summary>
            <ul>
              {data.map((item) => (
                <li key={item.date}>
                  {item.date}: <TokenNumber value={item.totalTokens} /> tokens ·{" "}
                  {item.sessions} sessions
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

export default function OverviewPage() {
  const [searchParameters, setSearchParameters] = useSearchParams();
  const rawRange = searchParameters.get("range") ?? "7d";
  const range: DashboardRange =
    rawRange === "30d" || rawRange === "all" ? rawRange : "7d";
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardOverview>(
    `/api/overview?range=${range}`,
    refreshKey,
  );
  if (state.loading) return <LoadingState label="Loading overview" />;
  if (state.error !== null) {
    return (
      <ErrorState
        message={state.error.message}
        suggestion={state.error.suggestion}
      />
    );
  }
  const overview = state.data?.data;
  if (overview === undefined) {
    return (
      <EmptyState
        title="Overview unavailable"
        detail="No local overview data was returned."
      />
    );
  }
  const hasSessions = overview.totals.sessions > 0;
  const hasTracking = overview.totals.trackingRuns > 0;
  const hasTests = overview.totals.testRuns > 0;
  const setRange = (value: DashboardRange) => {
    setSearchParameters(value === "7d" ? {} : { range: value });
  };
  return (
    <>
      <PageHeader
        eyebrow="Read-only local dashboard"
        title="Activity overview"
        description="Canonical Token accounting, observed Git changes, and explicitly recorded tests — shown without sensitive bodies."
        actions={
          <div className="segmented" aria-label="Overview trend range">
            {(["7d", "30d", "all"] as const).map((value) => (
              <button
                key={value}
                className={range === value ? "active" : ""}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {value === "all"
                  ? "All"
                  : value === "7d"
                    ? "7 days"
                    : "30 days"}
              </button>
            ))}
          </div>
        }
      />
      <section className="metrics-grid hero-metrics" aria-label="Key metrics">
        <MetricCard
          label="Sessions"
          value={
            hasSessions
              ? overview.totals.sessions.toLocaleString()
              : "unavailable"
          }
          detail={`${overview.totals.sessionsLast7Days} in the last 7 days`}
          accent
        />
        <MetricCard
          label="Total Tokens"
          value={
            <TokenNumber
              value={overview.totals.totalTokens}
              available={hasSessions}
            />
          }
          detail="Input + Output; Cache is not added again"
        />
        <MetricCard
          label="Observed Changed Files"
          value={
            hasTracking && overview.totals.observedChangedFiles !== null
              ? overview.totals.observedChangedFiles.toLocaleString()
              : "unavailable"
          }
          detail="Observed during linked tracking intervals"
        />
        <MetricCard
          label="Recorded Test Runs"
          value={
            hasTests ? overview.totals.testRuns.toLocaleString() : "unavailable"
          }
          detail={
            hasTests
              ? `${overview.totals.passedTestRuns} passed runs`
              : "No recorded test runs"
          }
        />
        <MetricCard
          label="Tests changed from failing to passing"
          value={overview.totals.failingToPassingComparisons ?? "unavailable"}
          detail="Comparable or partially comparable records only"
        />
        <MetricCard
          label="Unlinked / ambiguous records"
          value={
            hasTracking || hasTests
              ? overview.totals.unlinkedOrAmbiguousRecords.toLocaleString()
              : "unavailable"
          }
          detail="Association context may need CLI review"
        />
      </section>
      <section
        className="metrics-grid token-breakdown"
        aria-label="Token breakdown"
      >
        <MetricCard
          label="Input"
          value={
            <TokenNumber
              value={overview.totals.inputTokens}
              available={hasSessions}
            />
          }
        />
        <MetricCard
          label="Cached Input"
          value={
            <TokenNumber
              value={overview.totals.cachedInputTokens}
              available={hasSessions}
            />
          }
        />
        <MetricCard
          label="Uncached Input"
          value={
            <TokenNumber
              value={overview.totals.uncachedInputTokens}
              available={hasSessions}
            />
          }
        />
        <MetricCard
          label="Output"
          value={
            <TokenNumber
              value={overview.totals.outputTokens}
              available={hasSessions}
            />
          }
        />
        <MetricCard label="Estimated cost" value={overview.pricing.label} />
      </section>
      <TrendChart data={overview.tokenTrend} />
      <div className="dashboard-grid three-columns">
        <DistributionChart
          title="Provider distribution"
          data={overview.providerDistribution}
          emptyText="No Provider data."
        />
        <DistributionChart
          title="Model distribution"
          data={overview.modelDistribution}
          emptyText="No model data."
        />
        <DistributionChart
          title="Test result distribution"
          data={overview.testOutcomeDistribution}
          emptyText="No recorded test runs."
        />
      </div>
      <section className="panel timeline-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Latest observed records</p>
            <h2>Recent activity</h2>
          </div>
          {overview.latestImport === null ? (
            <span className="muted">No import run</span>
          ) : (
            <span>
              Last import <StatusBadge value={overview.latestImport.status} />
            </span>
          )}
        </div>
        {overview.recentActivity.length === 0 ? (
          <EmptyState
            title="No recent activity"
            detail="Import sessions or start a tracking run from the CLI."
          />
        ) : (
          <ol className="activity-list">
            {overview.recentActivity.map((activity) => (
              <li key={`${activity.type}:${activity.id}`}>
                <LocalTime value={activity.at} />
                <div>
                  {activity.href === null ? (
                    <strong>{activity.title}</strong>
                  ) : (
                    <Link to={activity.href}>{activity.title}</Link>
                  )}
                  <p>{activity.summary}</p>
                </div>
                <StatusBadge value={activity.status} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
