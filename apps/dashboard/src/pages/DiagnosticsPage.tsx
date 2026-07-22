import type { DashboardDiagnostics } from "@codeoutcome/shared/dashboard";

import { useApi } from "../api.js";
import { useDashboard } from "../app.js";
import {
  ErrorState,
  LoadingState,
  LocalTime,
  PageHeader,
  StatusBadge,
} from "../components.js";

export default function DiagnosticsPage() {
  const { refreshKey } = useDashboard();
  const state = useApi<DashboardDiagnostics>("/api/diagnostics", refreshKey);
  if (state.loading) return <LoadingState label="Loading diagnostics" />;
  if (state.error !== null)
    return (
      <ErrorState
        message={state.error.message}
        suggestion={state.error.suggestion}
      />
    );
  const diagnostics = state.data?.data;
  if (diagnostics === undefined) return null;
  return (
    <>
      <PageHeader
        eyebrow="Read-only checks"
        title="Diagnostics"
        description="Inspection only. Import, migration, repair, and deletion remain explicit CLI responsibilities."
      />
      <div className="dashboard-grid two-columns">
        <section className="panel detail-list">
          <h2>Database</h2>
          <dl>
            <dt>Status</dt>
            <dd>
              <StatusBadge value={diagnostics.database.status} />
            </dd>
            <dt>Path</dt>
            <dd>
              <code>{diagnostics.database.path}</code>
            </dd>
            <dt>Schema</dt>
            <dd>
              {diagnostics.database.schemaVersion ?? "unavailable"} /{" "}
              {diagnostics.database.latestMigration}
            </dd>
            <dt>foreign_keys</dt>
            <dd>
              {diagnostics.database.foreignKeys ? "enabled" : "unavailable"}
            </dd>
            <dt>query_only</dt>
            <dd>
              {diagnostics.database.queryOnly ? "enabled" : "unavailable"}
            </dd>
            <dt>quick_check</dt>
            <dd>{diagnostics.database.quickCheck ?? "unavailable"}</dd>
            <dt>Privacy mode</dt>
            <dd>{diagnostics.privacyMode}</dd>
            <dt>CodeOutcome</dt>
            <dd>{diagnostics.version}</dd>
          </dl>
        </section>
        <section className="panel detail-list">
          <h2>Record health</h2>
          <dl>
            <dt>Accounting warnings</dt>
            <dd>{diagnostics.accountingWarningCount ?? "unavailable"}</dd>
            <dt>Ambiguous sessions</dt>
            <dd>{diagnostics.ambiguousSessionCount ?? "unavailable"}</dd>
            <dt>Active tracking runs</dt>
            <dd>{diagnostics.activeTrackingRunCount ?? "unavailable"}</dd>
            <dt>Running test runs</dt>
            <dd>{diagnostics.runningTestRunCount ?? "unavailable"}</dd>
            <dt>Latest import</dt>
            <dd>
              {diagnostics.latestImport === null ? (
                "unavailable"
              ) : (
                <>
                  <StatusBadge value={diagnostics.latestImport.status} />{" "}
                  <LocalTime
                    value={
                      diagnostics.latestImport.completedAt ??
                      diagnostics.latestImport.startedAt
                    }
                  />
                </>
              )}
            </dd>
          </dl>
        </section>
      </div>
      <section className="panel">
        <h2>Provider log directories</h2>
        <div
          className="table-scroll"
          role="region"
          aria-label="Provider log directory status table"
          tabIndex={0}
        >
          <table>
            <caption className="sr-only">
              Read-only status of configured Provider log directories
            </caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Readable</th>
                <th scope="col">Path</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.providerLogs.map((provider) => (
                <tr key={provider.provider}>
                  <td>{provider.provider}</td>
                  <td>
                    <StatusBadge value={provider.status} />
                  </td>
                  <td>{provider.readable ? "yes" : "no"}</td>
                  <td>
                    <code>{provider.path}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>CLI suggestions</h2>
        <p className="muted">
          The dashboard never runs these actions automatically.
        </p>
        <ul>
          {diagnostics.suggestions.map((suggestion) => (
            <li key={suggestion}>
              <code>{suggestion}</code>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
