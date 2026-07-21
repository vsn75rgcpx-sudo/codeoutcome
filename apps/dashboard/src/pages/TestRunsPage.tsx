import { useSearchParams } from "react-router";

import type {
  DashboardFilters,
  DashboardTestRunListItem,
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

export default function TestRunsPage() {
  const [parameters, setParameters] = useSearchParams();
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardTestRunListItem[]>(
    `/api/test-runs${queryString(Object.fromEntries(parameters))}`,
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
        eyebrow="Explicit wrapper and report records"
        title="Test Runs"
        description="Aggregate results only. No stdout, stderr, stack, test case body, or source code is available."
      />
      <section className="panel filter-panel" aria-label="Test run filters">
        <label>
          Framework
          <select
            value={parameters.get("framework") ?? ""}
            onChange={(event) => update("framework", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.frameworks.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            value={parameters.get("outcome") ?? ""}
            onChange={(event) => update("outcome", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.outcomes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Stage
          <select
            value={parameters.get("stage") ?? ""}
            onChange={(event) => update("stage", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.stages.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Parser
          <select
            value={parameters.get("parserStatus") ?? ""}
            onChange={(event) => update("parserStatus", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.parserStatuses.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Tracking ID
          <input
            value={parameters.get("trackingRunId") ?? ""}
            onChange={(event) => update("trackingRunId", event.target.value)}
          />
        </label>
        <label>
          Session ID
          <input
            value={parameters.get("sessionId") ?? ""}
            onChange={(event) => update("sessionId", event.target.value)}
          />
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
            <option value="startedAt">Time</option>
            <option value="framework">Framework</option>
            <option value="outcome">Outcome</option>
            <option value="stage">Stage</option>
            <option value="duration">Duration</option>
            <option value="failedTests">Failed</option>
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
        <LoadingState label="Loading test runs" />
      ) : state.error !== null ? (
        <ErrorState
          message={state.error.message}
          suggestion={state.error.suggestion}
        />
      ) : state.data?.data.length === 0 ? (
        <EmptyState
          title="No recorded test runs"
          detail="No explicit test wrapper or imported report matches these filters. This is not the same as zero failed tests."
        />
      ) : (
        <>
          <div className="table-scroll panel">
            <table>
              <thead>
                <tr>
                  <th>Time / ID</th>
                  <th>Stage</th>
                  <th>Framework</th>
                  <th>Outcome</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Skipped</th>
                  <th>Duration</th>
                  <th>Parser</th>
                  <th>Tracking</th>
                  <th>Session</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {state.data?.data.map((test) => (
                  <tr key={test.id}>
                    <td>
                      <EntityLink kind="test-run" id={test.id} />
                      <br />
                      <LocalTime value={test.startedAt} />
                    </td>
                    <td>{test.stage}</td>
                    <td>{test.framework}</td>
                    <td>
                      <StatusBadge value={test.outcome} />
                    </td>
                    <td>{formatInteger(test.passedTests)}</td>
                    <td>{formatInteger(test.failedTests)}</td>
                    <td>{formatInteger(test.skippedTests)}</td>
                    <td>{formatDuration(test.durationMs)}</td>
                    <td>{test.parserStatus}</td>
                    <td>
                      <EntityLink kind="tracking-run" id={test.trackingRunId} />
                    </td>
                    <td>
                      <EntityLink kind="session" id={test.sessionId} />
                    </td>
                    <td>{test.outputTruncated ? "truncated" : "not stored"}</td>
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
