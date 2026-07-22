import { Link, useParams } from "react-router";

import type { DashboardTestRunDetail } from "@codeoutcome/shared/dashboard";

import { useApi } from "../api.js";
import { useDashboard } from "../app.js";
import {
  EmptyState,
  EntityLink,
  ErrorState,
  LoadingState,
  LocalTime,
  MetricCard,
  PageHeader,
  StatusBadge,
} from "../components.js";
import { formatDuration, formatInteger } from "../format.js";

export default function TestDetailPage() {
  const id = useParams().id ?? "";
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardTestRunDetail>(
    `/api/test-runs/${encodeURIComponent(id)}`,
    refreshKey,
  );
  if (state.loading) return <LoadingState label="Loading test detail" />;
  if (state.error !== null)
    return (
      <ErrorState
        message={state.error.message}
        suggestion={state.error.suggestion}
      />
    );
  const test = state.data?.data;
  if (test === undefined)
    return (
      <EmptyState
        title="Test run unavailable"
        detail="The requested test record was not returned."
      />
    );
  return (
    <>
      <PageHeader
        eyebrow={`${test.framework} · ${test.stage}`}
        title="Test run detail"
        description="Aggregate execution metadata only. Raw output, failures, stack traces, and case names are not stored."
        actions={<Link to="/test-runs">Back to test runs</Link>}
      />
      <section className="metrics-grid">
        <MetricCard
          label="Outcome"
          value={<StatusBadge value={test.outcome} />}
        />
        <MetricCard label="Total" value={formatInteger(test.totalTests)} />
        <MetricCard label="Passed" value={formatInteger(test.passedTests)} />
        <MetricCard label="Failed" value={formatInteger(test.failedTests)} />
        <MetricCard label="Skipped" value={formatInteger(test.skippedTests)} />
        <MetricCard label="Duration" value={formatDuration(test.durationMs)} />
      </section>
      <div className="dashboard-grid two-columns">
        <section className="panel detail-list">
          <h2>Execution</h2>
          <dl>
            <dt>Started</dt>
            <dd>
              <LocalTime value={test.startedAt} />
            </dd>
            <dt>Ended</dt>
            <dd>
              <LocalTime value={test.endedAt} />
            </dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge value={test.status} />
            </dd>
            <dt>Exit code</dt>
            <dd>{test.exitCode ?? "unavailable"}</dd>
            <dt>Signal</dt>
            <dd>{test.terminationSignal ?? "none"}</dd>
            <dt>Command</dt>
            <dd>
              <code>{test.commandDisplay}</code>
            </dd>
            <dt>Fingerprint</dt>
            <dd>
              <code>{test.commandFingerprintShort}</code>
            </dd>
            <dt>Output capture</dt>
            <dd>
              {test.outputTruncated
                ? "Aggregate parser buffer truncated"
                : "Raw output not stored"}
            </dd>
          </dl>
        </section>
        <section className="panel detail-list">
          <h2>Parser and association</h2>
          <dl>
            <dt>Framework version</dt>
            <dd>{test.frameworkVersion ?? "unavailable"}</dd>
            <dt>Parser status</dt>
            <dd>{test.parserStatus}</dd>
            <dt>Parser version</dt>
            <dd>{test.parserVersion}</dd>
            <dt>Todo / errored</dt>
            <dd>
              {formatInteger(test.todoTests)} /{" "}
              {formatInteger(test.erroredTests)}
            </dd>
            <dt>Tracking run</dt>
            <dd>
              <EntityLink kind="tracking-run" id={test.trackingRunId} />
            </dd>
            <dt>Session</dt>
            <dd>
              <EntityLink kind="session" id={test.sessionId} />
            </dd>
            <dt>Source</dt>
            <dd>{test.source}</dd>
          </dl>
        </section>
      </div>
      <section className="panel">
        <h2>Association history</h2>
        {test.linkHistory.length === 0 ? (
          <p className="muted">No association history.</p>
        ) : (
          <ol className="activity-list">
            {test.linkHistory.map((link, index) => (
              <li key={`${link.createdAt}:${index}`}>
                <LocalTime value={link.createdAt} />
                <div>
                  <strong>{link.linkType}</strong>
                  <p>{link.reasons.join("; ") || "No reason recorded"}</p>
                </div>
                <span>{link.confidence ?? "unavailable"}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="panel">
        <h2>Warnings</h2>
        {test.warnings.length === 0 ? (
          <p className="muted">No parser or privacy warnings.</p>
        ) : (
          <ul>
            {test.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
