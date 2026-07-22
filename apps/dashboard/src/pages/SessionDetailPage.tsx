import { Link, useParams } from "react-router";

import type { DashboardSessionDetail } from "@codeoutcome/shared/dashboard";

import { useApi } from "../api.js";
import { useDashboard } from "../app.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  LocalTime,
  MetricCard,
  PageHeader,
  StatusBadge,
  TokenNumber,
} from "../components.js";
import { formatDuration } from "../format.js";

export default function SessionDetailPage() {
  const id = useParams().id ?? "";
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardSessionDetail>(
    `/api/sessions/${encodeURIComponent(id)}`,
    refreshKey,
  );
  if (state.loading) return <LoadingState label="Loading session detail" />;
  if (state.error !== null)
    return (
      <ErrorState
        message={state.error.message}
        suggestion={state.error.suggestion}
      />
    );
  const session = state.data?.data;
  if (session === undefined)
    return (
      <EmptyState
        title="Session unavailable"
        detail="The requested session was not returned."
      />
    );
  return (
    <>
      <PageHeader
        eyebrow={`${session.provider} · ${session.model}`}
        title="Session detail"
        description="Canonical accounting metadata and observed associations. No Prompt or response body is available here."
        actions={<Link to="/sessions">Back to sessions</Link>}
      />
      <section className="metrics-grid">
        <MetricCard
          label="Input"
          value={<TokenNumber value={session.inputTokens} />}
        />
        <MetricCard
          label="Cached Input"
          value={<TokenNumber value={session.cachedInputTokens} />}
        />
        <MetricCard
          label="Uncached Input"
          value={<TokenNumber value={session.uncachedInputTokens} />}
        />
        <MetricCard
          label="Output"
          value={<TokenNumber value={session.outputTokens} />}
        />
        <MetricCard
          label="Total"
          value={<TokenNumber value={session.totalTokens} />}
        />
      </section>
      <div className="dashboard-grid two-columns">
        <section className="panel detail-list">
          <h2>Session metadata</h2>
          <dl>
            <dt>Started</dt>
            <dd>
              <LocalTime value={session.startedAt} />
            </dd>
            <dt>Ended</dt>
            <dd>
              <LocalTime value={session.endedAt} />
            </dd>
            <dt>Duration</dt>
            <dd>{formatDuration(session.durationMs)}</dd>
            <dt>Repository</dt>
            <dd>{session.repository ?? "unavailable"}</dd>
            <dt>Branch</dt>
            <dd>{session.branch ?? "unavailable"}</dd>
            <dt>Accounting method</dt>
            <dd>{session.accountingMethod}</dd>
            <dt>Accounting status</dt>
            <dd>
              <StatusBadge value={session.accountingStatus} />
            </dd>
            <dt>Accounting version</dt>
            <dd>{session.accountingVersion}</dd>
            <dt>Last usage event</dt>
            <dd>
              <LocalTime value={session.lastUsageEventAt} />
            </dd>
          </dl>
        </section>
        <section className="panel">
          <h2>Warnings</h2>
          {session.warnings.length === 0 ? (
            <p className="muted">No accounting warnings.</p>
          ) : (
            <ul>
              {session.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Associated tracking runs</h2>
        {session.trackingRuns.length === 0 ? (
          <p className="muted">No associated tracking runs.</p>
        ) : (
          <ul className="entity-list">
            {session.trackingRuns.map((run) => (
              <li key={run.id}>
                <Link to={`/tracking-runs/${run.id}`}>
                  {run.label ?? run.id.slice(0, 10)}
                </Link>
                <StatusBadge value={run.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Associated tests</h2>
        {session.testRuns.length === 0 ? (
          <p className="muted">No recorded test runs</p>
        ) : (
          <ul className="entity-list">
            {session.testRuns.map((test) => (
              <li key={test.id}>
                <Link to={`/test-runs/${test.id}`}>
                  {test.framework} · {test.stage}
                </Link>
                <StatusBadge value={test.outcome} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
