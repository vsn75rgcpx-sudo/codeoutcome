import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { NavLink, Route, Routes, useLocation } from "react-router";

import { LoadingState } from "./components.js";

const OverviewPage = lazy(() => import("./pages/OverviewPage.js"));
const SessionsPage = lazy(() => import("./pages/SessionsPage.js"));
const SessionDetailPage = lazy(() => import("./pages/SessionDetailPage.js"));
const TrackingRunsPage = lazy(() => import("./pages/TrackingRunsPage.js"));
const TrackingDetailPage = lazy(() => import("./pages/TrackingDetailPage.js"));
const TestRunsPage = lazy(() => import("./pages/TestRunsPage.js"));
const TestDetailPage = lazy(() => import("./pages/TestDetailPage.js"));
const DiagnosticsPage = lazy(() => import("./pages/DiagnosticsPage.js"));

export type ThemePreference = "system" | "light" | "dark";

export function nextTheme(theme: ThemePreference): ThemePreference {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}

interface DashboardContextValue {
  refreshKey: number;
  refresh(): void;
}

const DashboardContext = createContext<DashboardContextValue>({
  refreshKey: 0,
  refresh: () => undefined,
});

export function useDashboard(): DashboardContextValue {
  return useContext(DashboardContext);
}

function initialTheme(): ThemePreference {
  const stored = localStorage.getItem("codeoutcome-theme");
  return stored === "light" || stored === "dark" ? stored : "system";
}

function RouteTitle() {
  const location = useLocation();
  useEffect(() => {
    const label =
      location.pathname === "/"
        ? "Overview"
        : location.pathname.startsWith("/sessions/")
          ? "Session detail"
          : location.pathname === "/sessions"
            ? "Sessions"
            : location.pathname.startsWith("/tracking-runs/")
              ? "Tracking detail"
              : location.pathname === "/tracking-runs"
                ? "Tracking runs"
                : location.pathname.startsWith("/test-runs/")
                  ? "Test detail"
                  : location.pathname === "/test-runs"
                    ? "Test runs"
                    : location.pathname === "/diagnostics"
                      ? "Diagnostics"
                      : "Page not found";
    document.title = `${label} · CodeOutcome`;
  }, [location.pathname]);
  return null;
}

export default function App() {
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshSeconds, setRefreshSeconds] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codeoutcome-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (refreshSeconds < 30) return undefined;
    const timer = window.setInterval(
      () => setRefreshKey((value) => value + 1),
      refreshSeconds * 1_000,
    );
    return () => window.clearInterval(timer);
  }, [refreshSeconds]);
  const context = useMemo(
    () => ({
      refreshKey,
      refresh: () => setRefreshKey((value) => value + 1),
    }),
    [refreshKey],
  );
  return (
    <DashboardContext.Provider value={context}>
      <RouteTitle />
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand" aria-label="CodeOutcome local dashboard">
            <strong>CodeOutcome</strong>
            <small>Local workspace</small>
          </div>
          <p className="nav-label">Workspace</p>
          <nav aria-label="Primary navigation">
            <NavLink to="/" end>
              Overview
            </NavLink>
            <NavLink to="/sessions">Sessions</NavLink>
            <NavLink to="/tracking-runs">Tracking Runs</NavLink>
            <NavLink to="/test-runs">Test Runs</NavLink>
            <NavLink to="/diagnostics">Diagnostics</NavLink>
          </nav>
          <div className="local-boundary">
            <span className="pulse" aria-hidden="true" />
            localhost only
          </div>
        </aside>
        <div className="content-shell">
          <header className="topbar">
            <p className="topbar-context">
              <span className="presence-dot" aria-hidden="true" />
              Read-only · this Mac
            </p>
            <div className="topbar-actions">
              <label>
                <span className="sr-only">Automatic refresh interval</span>
                <select
                  value={refreshSeconds}
                  onChange={(event) =>
                    setRefreshSeconds(Number(event.target.value))
                  }
                >
                  <option value="0">Auto refresh off</option>
                  <option value="30">Refresh 30s</option>
                  <option value="60">Refresh 60s</option>
                </select>
              </label>
              <button onClick={context.refresh}>Refresh</button>
              <button
                onClick={() => setTheme((value) => nextTheme(value))}
                aria-label={`Theme: ${theme}. Activate to change theme.`}
              >
                Appearance · {theme}
              </button>
            </div>
          </header>
          <main id="main-content" tabIndex={-1}>
            <Suspense
              fallback={<LoadingState label="Loading dashboard view" />}
            >
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/sessions/:id" element={<SessionDetailPage />} />
                <Route path="/tracking-runs" element={<TrackingRunsPage />} />
                <Route
                  path="/tracking-runs/:id"
                  element={<TrackingDetailPage />}
                />
                <Route path="/test-runs" element={<TestRunsPage />} />
                <Route path="/test-runs/:id" element={<TestDetailPage />} />
                <Route path="/diagnostics" element={<DiagnosticsPage />} />
                <Route
                  path="*"
                  element={
                    <section className="state-panel">
                      <p className="eyebrow">404</p>
                      <h1>Page not found</h1>
                      <p className="muted">
                        This local dashboard route does not exist.
                      </p>
                    </section>
                  }
                />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </DashboardContext.Provider>
  );
}
