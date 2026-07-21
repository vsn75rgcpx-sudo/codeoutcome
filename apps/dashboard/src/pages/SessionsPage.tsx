import { useSearchParams } from "react-router";

import type {
  DashboardFilters,
  DashboardSessionListItem,
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
  TokenNumber,
} from "../components.js";
import { formatDuration } from "../format.js";

export default function SessionsPage() {
  const [parameters, setParameters] = useSearchParams();
  const { refreshKey } = useDashboard();
  const path = `/api/sessions${queryString(Object.fromEntries(parameters))}`;
  const state = useApi<DashboardSessionListItem[]>(path, refreshKey);
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
        eyebrow="Canonical Provider records"
        title="Sessions"
        description="Token and repository metadata only. Prompt and response bodies are never returned by this API."
      />
      <section className="panel filter-panel" aria-label="Session filters">
        <label>
          Search
          <input
            value={parameters.get("search") ?? ""}
            onChange={(event) => update("search", event.target.value)}
            placeholder="Model, Provider, repository, branch"
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
          Model
          <select
            value={parameters.get("model") ?? ""}
            onChange={(event) => update("model", event.target.value)}
          >
            <option value="">All</option>
            {filters.data?.data.models.map((model) => (
              <option key={model}>{model}</option>
            ))}
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
          Accounting
          <select
            value={parameters.get("accountingStatus") ?? ""}
            onChange={(event) => update("accountingStatus", event.target.value)}
          >
            <option value="">All</option>
            <option value="verified">Verified</option>
            <option value="warning">Warning</option>
            <option value="invalid">Invalid</option>
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
          Until
          <input
            type="date"
            value={parameters.get("until")?.slice(0, 10) ?? ""}
            onChange={(event) => update("until", event.target.value)}
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
            <option value="model">Model</option>
            <option value="repository">Repository</option>
            <option value="inputTokens">Input</option>
            <option value="outputTokens">Output</option>
            <option value="totalTokens">Total</option>
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
        <LoadingState label="Loading sessions" />
      ) : state.error !== null ? (
        <ErrorState
          message={state.error.message}
          suggestion={state.error.suggestion}
        />
      ) : state.data?.data.length === 0 ? (
        <EmptyState
          title="No sessions found"
          detail="No session matches the current read-only filters."
        />
      ) : (
        <>
          <div className="table-scroll panel">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Duration</th>
                  <th>Repository</th>
                  <th>Branch</th>
                  <th>Input</th>
                  <th>Cache</th>
                  <th>Output</th>
                  <th>Total</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>Tracking</th>
                </tr>
              </thead>
              <tbody>
                {state.data?.data.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <EntityLink kind="session" id={session.id} />
                      <br />
                      <LocalTime value={session.startedAt} />
                    </td>
                    <td>{session.provider}</td>
                    <td>{session.model}</td>
                    <td>{formatDuration(session.durationMs)}</td>
                    <td>{session.repository ?? "unavailable"}</td>
                    <td>{session.branch ?? "unavailable"}</td>
                    <td>
                      <TokenNumber value={session.inputTokens} />
                    </td>
                    <td>
                      <TokenNumber value={session.cachedInputTokens} />
                    </td>
                    <td>
                      <TokenNumber value={session.outputTokens} />
                    </td>
                    <td>
                      <TokenNumber value={session.totalTokens} />
                    </td>
                    <td>{session.accountingMethod}</td>
                    <td>
                      <StatusBadge value={session.accountingStatus} />
                    </td>
                    <td>
                      {session.linkedTrackingRunCount > 0
                        ? `${session.linkedTrackingRunCount} linked`
                        : "unlinked"}
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
