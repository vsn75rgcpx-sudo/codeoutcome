import { Link, useParams } from "react-router";

import type { DashboardTrackingRunDetail } from "@codeoutcome/shared/dashboard";

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
import { formatDuration, formatInteger } from "../format.js";

export default function TrackingDetailPage() {
  const id = useParams().id ?? "";
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardTrackingRunDetail>(
    `/api/tracking-runs/${encodeURIComponent(id)}`,
    refreshKey,
  );
  if (state.loading) return <LoadingState label="Loading tracking detail" />;
  if (state.error !== null)
    return (
      <ErrorState
        message={state.error.message}
        suggestion={state.error.suggestion}
      />
    );
  const run = state.data?.data;
  if (run === undefined)
    return (
      <EmptyState
        title="Tracking run unavailable"
        detail="The requested run was not returned."
      />
    );
  return (
    <>
      <PageHeader
        eyebrow={`${run.provider} · ${run.repository}`}
        title={run.label ?? "Tracking detail"}
        description="Observed Git, session, and test metadata within this interval. Associations are contextual, not exact AI code attribution."
        actions={<Link to="/tracking-runs">Back to tracking runs</Link>}
      />
      <section className="metrics-grid">
        <MetricCard label="Duration" value={formatDuration(run.durationMs)} />
        <MetricCard
          label="Observed files"
          value={formatInteger(run.filesChanged)}
        />
        <MetricCard label="Additions" value={formatInteger(run.additions)} />
        <MetricCard label="Deletions" value={formatInteger(run.deletions)} />
        <MetricCard
          label="Recorded tests"
          value={run.testRuns === 0 ? "unavailable" : run.testRuns}
          detail={run.testRuns === 0 ? "No recorded test runs" : undefined}
        />
      </section>
      <div className="dashboard-grid two-columns">
        <section className="panel detail-list">
          <h2>Tracking metadata</h2>
          <dl>
            <dt>Status</dt>
            <dd>
              <StatusBadge value={run.status} />
            </dd>
            <dt>Started</dt>
            <dd>
              <LocalTime value={run.startedAt} />
            </dd>
            <dt>Ended</dt>
            <dd>
              <LocalTime value={run.endedAt} />
            </dd>
            <dt>Branch</dt>
            <dd>{run.branch ?? "unavailable"}</dd>
            <dt>Start / end HEAD</dt>
            <dd>
              <code>{run.startHead ?? "unborn"}</code> →{" "}
              <code>{run.endHead ?? "unavailable"}</code>
            </dd>
            <dt>Link confidence</dt>
            <dd>
              {run.linkConfidenceLevel ?? "unlinked"}
              {run.linkConfidence === null
                ? ""
                : ` (${run.linkConfidence.toFixed(3)})`}
            </dd>
            <dt>Reasons</dt>
            <dd>
              {run.reasons.length === 0
                ? "unavailable"
                : run.reasons.join("; ")}
            </dd>
          </dl>
        </section>
        <section className="panel detail-list">
          <h2>Linked session Token</h2>
          {run.linkedSession === null || run.tokenSummary === null ? (
            <p className="muted">No linked session.</p>
          ) : (
            <>
              <p>
                <Link to={`/sessions/${run.linkedSession.id}`}>
                  {run.linkedSession.provider} · {run.linkedSession.model}
                </Link>
              </p>
              <dl>
                <dt>Input</dt>
                <dd>
                  <TokenNumber value={run.tokenSummary.inputTokens} />
                </dd>
                <dt>Cache</dt>
                <dd>
                  <TokenNumber value={run.tokenSummary.cachedInputTokens} />
                </dd>
                <dt>Output</dt>
                <dd>
                  <TokenNumber value={run.tokenSummary.outputTokens} />
                </dd>
                <dt>Total</dt>
                <dd>
                  <TokenNumber value={run.tokenSummary.totalTokens} />
                </dd>
              </dl>
            </>
          )}
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Start / end snapshots</h2>
          <span className="muted">Observed Git metadata</span>
        </div>
        <div className="snapshot-grid">
          {[run.startSnapshot, run.endSnapshot].map((snapshot, index) =>
            snapshot === null ? (
              <article key="missing" className="snapshot">
                <h3>End snapshot</h3>
                <p>unavailable</p>
              </article>
            ) : (
              <article key={snapshot.id} className="snapshot">
                <h3>{index === 0 ? "Start" : "End"} snapshot</h3>
                <p>
                  <LocalTime value={snapshot.capturedAt} />
                </p>
                <code>{snapshot.headCommit ?? "unborn"}</code>
                <p>
                  {snapshot.dirty ? "Dirty working tree" : "Clean working tree"}
                </p>
                <small>
                  staged {snapshot.stagedFiles} · unstaged{" "}
                  {snapshot.unstagedFiles} · untracked {snapshot.untrackedFiles}{" "}
                  · conflicted {snapshot.conflictedFiles}
                </small>
              </article>
            ),
          )}
        </div>
      </section>
      <section className="panel">
        <h2>Observed Git areas</h2>
        {run.gitAreas.length === 0 ? (
          <p className="muted">No observed file metadata.</p>
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="Observed Git area summary table"
            tabIndex={0}
          >
            <table>
              <caption className="sr-only">
                Aggregate observed Git changes by area and change type
              </caption>
              <thead>
                <tr>
                  <th scope="col">Area</th>
                  <th scope="col">Change</th>
                  <th scope="col">Files</th>
                  <th scope="col">Additions</th>
                  <th scope="col">Deletions</th>
                  <th scope="col">Binary</th>
                </tr>
              </thead>
              <tbody>
                {run.gitAreas.map((area) => (
                  <tr key={`${area.area}:${area.changeType}`}>
                    <td>{area.area}</td>
                    <td>{area.changeType}</td>
                    <td>{area.files}</td>
                    <td>{formatInteger(area.additions)}</td>
                    <td>{formatInteger(area.deletions)}</td>
                    <td>{area.binaryFiles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel comparison-panel">
        <h2>Baseline / final comparison</h2>
        {run.comparison === null ? (
          <p className="muted">No recorded test runs</p>
        ) : (
          <div className="comparison-grid">
            <div>
              <p>Baseline ({run.comparison.baselineSelection})</p>
              <StatusBadge value={run.comparison.baselineOutcome} />
              {run.comparison.baselineTestRunId === null ? null : (
                <Link to={`/test-runs/${run.comparison.baselineTestRunId}`}>
                  {" "}
                  View baseline
                </Link>
              )}
            </div>
            <div className="comparison-arrow" aria-hidden="true">
              →
            </div>
            <div>
              <p>Final ({run.comparison.finalSelection})</p>
              <StatusBadge value={run.comparison.finalOutcome} />
              {run.comparison.finalTestRunId === null ? null : (
                <Link to={`/test-runs/${run.comparison.finalTestRunId}`}>
                  {" "}
                  View final
                </Link>
              )}
            </div>
            <dl>
              <dt>Comparability</dt>
              <dd>{run.comparison.comparability}</dd>
              <dt>Passed delta</dt>
              <dd>{formatInteger(run.comparison.passedDelta)}</dd>
              <dt>Failed delta</dt>
              <dd>{formatInteger(run.comparison.failedDelta)}</dd>
              <dt>Duration delta</dt>
              <dd>{formatInteger(run.comparison.durationDeltaMs)} ms</dd>
              <dt>Warnings</dt>
              <dd>{run.comparison.warnings.join("; ") || "—"}</dd>
            </dl>
          </div>
        )}
      </section>
      <section className="panel timeline-panel">
        <h2>Unified timeline</h2>
        <ol className="activity-list">
          {run.timeline.map((event) => (
            <li key={event.id}>
              <LocalTime value={event.at} />
              <div>
                {event.href === null ? (
                  <strong>{event.summary}</strong>
                ) : (
                  <Link to={event.href}>{event.summary}</Link>
                )}
                <p>{event.type.replaceAll("_", " ")}</p>
              </div>
              <StatusBadge value={event.status} />
            </li>
          ))}
        </ol>
      </section>
      <section className="panel">
        <h2>Warnings</h2>
        {run.warnings.length === 0 ? (
          <p className="muted">No tracking warnings.</p>
        ) : (
          <ul>
            {run.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
