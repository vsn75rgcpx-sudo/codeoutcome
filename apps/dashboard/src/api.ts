import { useEffect, useState } from "react";

import {
  DASHBOARD_TOKEN_HEADER,
  type DashboardEnvelope,
  type DashboardErrorEnvelope,
} from "@agentledger/shared/dashboard";

function dashboardToken(): string {
  return (
    document
      .querySelector<HTMLMetaElement>(
        'meta[name="agentledger-dashboard-token"]',
      )
      ?.getAttribute("content") ?? ""
  );
}

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly suggestion: string | null,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export async function apiGet<T>(
  path: string,
  signal?: AbortSignal,
): Promise<DashboardEnvelope<T>> {
  const response = await fetch(path, {
    signal,
    headers: { [DASHBOARD_TOKEN_HEADER]: dashboardToken() },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body as Partial<DashboardErrorEnvelope>;
    throw new DashboardApiError(
      error.error?.message ?? "The dashboard request failed.",
      error.error?.code ?? `http_${response.status}`,
      error.error?.suggestion ?? null,
    );
  }
  return body as DashboardEnvelope<T>;
}

export interface ApiState<T> {
  data: DashboardEnvelope<T> | null;
  loading: boolean;
  error: DashboardApiError | null;
}

export function useApi<T>(path: string, refreshKey = 0): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    void apiGet<T>(path, controller.signal)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          data: null,
          loading: false,
          error:
            error instanceof DashboardApiError
              ? error
              : new DashboardApiError(
                  "The local dashboard server could not be reached.",
                  "network_error",
                  null,
                ),
        });
      });
    return () => controller.abort();
  }, [path, refreshKey]);
  return state;
}

export function queryString(
  values: Record<string, string | number | boolean | null | undefined>,
): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      parameters.set(name, String(value));
    }
  }
  const query = parameters.toString();
  return query.length === 0 ? "" : `?${query}`;
}
