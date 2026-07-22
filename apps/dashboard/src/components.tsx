import type { ReactNode } from "react";
import { Link } from "react-router";

import type {
  DashboardDistribution,
  DashboardPagination,
} from "@agentledger/shared/dashboard";

import { formatDate, formatToken } from "./format.js";

export function PageHeader(props: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h1>{props.title}</h1>
        <p className="page-description">{props.description}</p>
      </div>
      {props.actions === undefined ? null : (
        <div className="page-actions">{props.actions}</div>
      )}
    </header>
  );
}

export function LoadingState({
  label = "Loading local data",
}: {
  label?: string;
}) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <div className="loading-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="muted">{label}…</p>
    </div>
  );
}

export function ErrorState(props: {
  message: string;
  suggestion?: string | null;
}) {
  return (
    <div className="state-panel error-panel" role="alert">
      <p className="state-title">Dashboard data unavailable</p>
      <p>{props.message}</p>
      {props.suggestion === null || props.suggestion === undefined ? null : (
        <code>{props.suggestion}</code>
      )}
    </div>
  );
}

export function EmptyState(props: { title: string; detail: string }) {
  return (
    <div className="state-panel">
      <span className="state-kicker" aria-hidden="true">
        —
      </span>
      <h2 className="state-title">{props.title}</h2>
      <p>{props.detail}</p>
    </div>
  );
}

export function StatusBadge({ value }: { value: string | null }) {
  const shown = value ?? "unavailable";
  const tone =
    shown === "passed" || shown === "verified" || shown === "completed"
      ? "positive"
      : shown === "failed" || shown === "errored" || shown === "invalid"
        ? "negative"
        : shown === "warning" ||
            shown === "ambiguous" ||
            shown === "interrupted"
          ? "warning"
          : "neutral";
  return (
    <span className={`status status-${tone}`}>
      <span aria-hidden="true" className="status-mark" />
      {shown}
    </span>
  );
}

export function LocalTime({ value }: { value: string | null }) {
  return value === null ? (
    <span className="muted">unavailable</span>
  ) : (
    <time dateTime={value} title={`UTC: ${value}`}>
      {formatDate(value)}
    </time>
  );
}

export function TokenNumber(props: { value: string; available?: boolean }) {
  const available = props.available ?? true;
  return (
    <span className="numeric" title={available ? props.value : undefined}>
      {formatToken(props.value, available)}
    </span>
  );
}

export function MetricCard(props: {
  label: string;
  value: ReactNode;
  detail?: string;
  accent?: boolean;
}) {
  return (
    <article
      className={`metric-card${props.accent === true ? " metric-accent" : ""}`}
    >
      <p>{props.label}</p>
      <strong>{props.value}</strong>
      {props.detail === undefined ? null : <small>{props.detail}</small>}
    </article>
  );
}

export function DistributionChart(props: {
  title: string;
  data: DashboardDistribution[];
  emptyText: string;
}) {
  const maximum = Math.max(1, ...props.data.map((item) => item.count));
  const summary = props.data
    .map((item) => `${item.label}: ${item.count}`)
    .join(", ");
  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <h2>{props.title}</h2>
      </div>
      {props.data.length === 0 ? (
        <p className="muted">{props.emptyText}</p>
      ) : (
        <>
          <svg
            className="bar-chart"
            viewBox={`0 0 100 ${props.data.length * 24}`}
            role="img"
            aria-label={`${props.title}. ${summary}`}
          >
            {props.data.map((item, index) => (
              <g key={item.key} transform={`translate(0 ${index * 24})`}>
                <rect
                  x="0"
                  y="4"
                  width="100"
                  height="12"
                  rx="3"
                  className="bar-track"
                />
                <rect
                  x="0"
                  y="4"
                  width={(item.count / maximum) * 100}
                  height="12"
                  rx="3"
                  className="bar-value"
                />
              </g>
            ))}
          </svg>
          <ul
            className="chart-legend"
            aria-label={`${props.title} text summary`}
          >
            {props.data.map((item) => (
              <li key={item.key}>
                <span>{item.label}</span>
                <strong>{item.count.toLocaleString()}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function Pagination(props: {
  pagination: DashboardPagination | null;
  onPage: (page: number) => void;
}) {
  if (props.pagination === null) return null;
  const { page, totalPages, totalItems } = props.pagination;
  return (
    <nav className="pagination" aria-label="Table pagination">
      <button disabled={page <= 1} onClick={() => props.onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {totalPages} · {totalItems.toLocaleString()} records
      </span>
      <button
        disabled={page >= totalPages}
        onClick={() => props.onPage(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

export function EntityLink(props: {
  kind: "session" | "tracking-run" | "test-run";
  id: string | null;
}) {
  if (props.id === null) return <span className="muted">unavailable</span>;
  const root =
    props.kind === "session"
      ? "sessions"
      : props.kind === "tracking-run"
        ? "tracking-runs"
        : "test-runs";
  return <Link to={`/${root}/${props.id}`}>{props.id.slice(0, 10)}</Link>;
}
