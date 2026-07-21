import { useSearchParams } from "react-router";

import type {
  DashboardFilters,
  DashboardTrackingRunListItem,
} from "@agentledger/shared/dashboard";

import { queryString, useApi } from "../api.js";
import { useDashboard } from "../app.js";
import {
  EmptyState,
  EntityLink,
  ErrorState,
  LoadingState,
  LocalTime,
  Pagination,
  PageHeader,
  StatusBadge,
} from "../components.js";
import { formatDuration, formatInteger } from "../format.js";

export default function TrackingRunsPage() {
  const [parameters, setParameters] = useSearchParams();
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardTrackingRunListItem[]>(
    `/api/tracking-runs${queryString(Object.fromEntries(parameters))}`,
    refreshKey,
  );
  const filters = useApi<DashboardFilters>("/api/filters", refreshKey);
  const update = (name: string, value: string) => {
    const next = new URLSearchParams(parameters);
    if (value.length === 0) next.delete(name);
    else next.set(name, value);
    if (name !== "page") next.delete("page");
    setParameters(next);
  };
  return (
    <>
      <PageHeader
        eyebrow="Observed Git intervals"
        title="Tracking Runs"
        description="Start/end snapshots, aggregate changes, linked sessions, and recorded tests. No full Diff or source content."
      />
      <section className="panel filter-panel" aria-label="Tracking run filters">
        <label>
          Search
          <input
            value={parameters.get("search") ?? ""}
            onChange={(event) => update("search", event.target.value)}
            placeholder="Label or repository"
          />
        </label>
        <label>
          Provider
          <select
            value={parameters.get("provider") ?? ""}
            onChange={(event) => update("provider", event.target.value)}
          >
            <option value="">All</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          Repository
          <select
            value={parameters.get("repository") ?? ""}
            onChange={(event) => update("repository", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.repositories.map((repository) => (
              <option key={repository.id} value={repository.name}>
                {repository.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={parameters.get("status") ?? ""}
            onChange={(event) => update("status", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.trackingStatuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label>
          Confidence
          <select
            value={parameters.get("confidence") ?? ""}
            onChange={(event) => update("confidence", event.target.value)}
          >
            <option value="">All</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
            <option value="ambiguous">ambiguous</option>
            <option value="unlinked">unlinked</option>
          </select>
        </label>
        <label>
          Git changes
          <select
            value={parameters.get("hasGitChanges") ?? ""}
            onChange={(event) => update("hasGitChanges", event.target.value)}
          >
            <option value="">All</option>
            <option value="true">Has changes</option>
            <option value="false">No observed changes</option>
          </select>
        </label>
        <label>
          Tests
          <select
            value={parameters.get("hasTests") ?? ""}
            onChange={(event) => update("hasTests", event.target.value)}
          >
            <option value="">All</option>
            <option value="true">Has recorded tests</option>
            <option value="false">No recorded tests</option>
          </select>
        </label>
        <label>
          Test change
          <select
            value={parameters.get("testChange") ?? ""}
            onChange={(event) => update("testChange", event.target.value)}
          >
            <option value="">All</option>
            <option value="improved">Failing → passing</option>
            <option value="regressed">Passing → failing</option>
            <option value="unchanged">Outcome unchanged</option>
          </select>
        </label>
        <label>
          Since
          <input
            type="date"
            value={parameters.get("since")?.slice(0, 10) ?? ""}
            onChange={(event) => update("since", event.target.value)}
          />
        </label>
        <label>
          Sort
          <select
            value={parameters.get("sort") ?? "startedAt"}
            onChange={(event) => update("sort", event.target.value)}
          >
            <option value="startedAt">Started</option>
            <option value="provider">Provider</option>
            <option value="repository">Repository</option>
            <option value="filesChanged">Files changed</option>
            <option value="additions">Additions</option>
            <option value="deletions">Deletions</option>
            <option value="status">Status</option>
          </select>
        </label>
        <label>
          Order
          <select
            value={parameters.get("order") ?? "desc"}
            onChange={(event) => update("order", event.target.value)}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
      </section>
      {state.loading ? (
        <LoadingState label="Loading tracking runs" />
      ) : state.error !== null ? (
        <ErrorState
          message={state.error.message}
          suggestion={state.error.suggestion}
        />
      ) : state.data?.data.length === 0 ? (
        <EmptyState
          title="No tracking runs found"
          detail="No run matches the current filters."
        />
      ) : (
        <>
          <div className="table-scroll panel">
            <table>
              <thead>
                <tr>
                  <th>Label / started</th>
                  <th>Provider</th>
                  <th>Duration</th>
                  <th>Repository</th>
                  <th>Branch</th>
                  <th>Start / end HEAD</th>
                  <th>Dirty start/end</th>
                  <th>Files</th>
                  <th>+ / −</th>
                  <th>Tests</th>
                  <th>Baseline / final</th>
                  <th>Confidence</th>
                  <th>Status</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {state.data?.data.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <EntityLink kind="tracking-run" id={run.id} />{" "}
                      {run.label ?? "unlabeled"}
                      <br />
                      <LocalTime value={run.startedAt} />
                    </td>
                    <td>{run.provider}</td>
                    <td>{formatDuration(run.durationMs)}</td>
                    <td>{run.repository}</td>
                    <td>{run.branch ?? "unavailable"}</td>
                    <td>
                      <code>{run.startHead ?? "unborn"}</code>
                      <br />
                      <code>{run.endHead ?? "unavailable"}</code>
                    </td>
                    <td>
                      {run.startDirty ? "dirty" : "clean"} /{" "}
                      {run.endDirty === null
                        ? "unavailable"
                        : run.endDirty
                          ? "dirty"
                          : "clean"}
                    </td>
                    <td>{formatInteger(run.filesChanged)}</td>
                    <td>
                      {formatInteger(run.additions)} /{" "}
                      {formatInteger(run.deletions)}
                    </td>
                    <td>
                      {run.testRuns === 0
                        ? "No recorded test runs"
                        : run.testRuns}
                    </td>
                    <td>
                      <StatusBadge value={run.baselineOutcome} />{" "}
                      <StatusBadge value={run.finalOutcome} />
                    </td>
                    <td>
                      {run.linkConfidenceLevel ?? "unlinked"}
                      {run.linkConfidence === null
                        ? ""
                        : ` · ${run.linkConfidence.toFixed(2)}`}
                    </td>
                    <td>
                      <StatusBadge value={run.status} />
                    </td>
                    <td>
                      {run.warnings.length === 0
                        ? "—"
                        : run.warnings.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            pagination={state.data?.pagination ?? null}
            onPage={(page) => update("page", String(page))}
          />
        </>
      )}
    </>
  );
}
