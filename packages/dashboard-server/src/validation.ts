import type {
  Provider,
  TestFramework,
  TestOutcome,
  TestParserStatus,
  TestStage,
  TrackingRunStatus,
} from "@agentledger/shared";

import type {
  SessionPageQuery,
  TestPageQuery,
  TrackingPageQuery,
} from "./store.js";

export class DashboardRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardRequestError";
  }
}

type QueryValues = Record<string, string>;

function allowed(query: QueryValues, names: readonly string[]): void {
  const supported = new Set(names);
  const unknown = Object.keys(query).find((name) => !supported.has(name));
  if (unknown !== undefined) {
    throw new DashboardRequestError(`Unsupported query parameter: ${unknown}`);
  }
}

function integer(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DashboardRequestError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function date(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DashboardRequestError(`${name} must be a valid date`);
  }
  return parsed.toISOString();
}

function text(value: string | undefined, maximum = 200): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    throw new DashboardRequestError(
      `Text filters must contain between 1 and ${maximum} characters`,
    );
  }
  return trimmed;
}

function enumeration<T extends string>(
  value: string | undefined,
  name: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) {
    throw new DashboardRequestError(`${name} has an unsupported value`);
  }
  return value as T;
}

function booleanFilter(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new DashboardRequestError(`${name} must be true or false`);
}

function base(query: QueryValues) {
  const page = integer(query.page, "page", 1, 1, 1_000_000);
  const pageSize = integer(query.pageSize, "pageSize", 25, 1, 200);
  const since = date(query.since, "since");
  const until = date(query.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new DashboardRequestError("since must be before until");
  }
  return { page, pageSize, since, until, search: text(query.search) };
}

const PROVIDERS = [
  "claude-code",
  "codex",
] as const satisfies readonly Provider[];

export function sessionQuery(query: QueryValues): SessionPageQuery {
  allowed(query, [
    "page",
    "pageSize",
    "since",
    "until",
    "search",
    "provider",
    "model",
    "repository",
    "accountingStatus",
    "sort",
    "order",
  ]);
  return {
    ...base(query),
    provider: enumeration(query.provider, "provider", PROVIDERS),
    model: text(query.model),
    repository: text(query.repository, 500),
    accountingStatus: enumeration(query.accountingStatus, "accountingStatus", [
      "verified",
      "warning",
      "invalid",
    ]),
    sort:
      enumeration(query.sort, "sort", [
        "startedAt",
        "provider",
        "model",
        "repository",
        "inputTokens",
        "outputTokens",
        "totalTokens",
      ]) ?? "startedAt",
    order: enumeration(query.order, "order", ["asc", "desc"]) ?? "desc",
  };
}

const TRACKING_STATUSES = [
  "active",
  "completed",
  "interrupted",
  "failed",
  "abandoned",
] as const satisfies readonly TrackingRunStatus[];

export function trackingQuery(query: QueryValues): TrackingPageQuery {
  allowed(query, [
    "page",
    "pageSize",
    "since",
    "until",
    "search",
    "provider",
    "repository",
    "status",
    "confidence",
    "hasGitChanges",
    "hasTests",
    "testChange",
    "sort",
    "order",
  ]);
  return {
    ...base(query),
    provider: enumeration(query.provider, "provider", PROVIDERS),
    repository: text(query.repository, 500),
    status: enumeration(query.status, "status", TRACKING_STATUSES),
    confidence: enumeration(query.confidence, "confidence", [
      "high",
      "medium",
      "low",
      "ambiguous",
      "unlinked",
    ]),
    hasGitChanges: booleanFilter(query.hasGitChanges, "hasGitChanges"),
    hasTests: booleanFilter(query.hasTests, "hasTests"),
    testChange: enumeration(query.testChange, "testChange", [
      "improved",
      "regressed",
      "unchanged",
    ]),
    sort:
      enumeration(query.sort, "sort", [
        "startedAt",
        "provider",
        "repository",
        "filesChanged",
        "additions",
        "deletions",
        "status",
      ]) ?? "startedAt",
    order: enumeration(query.order, "order", ["asc", "desc"]) ?? "desc",
  };
}

const FRAMEWORKS = [
  "pytest",
  "jest",
  "vitest",
  "junit",
  "go",
  "cargo",
  "generic",
] as const satisfies readonly TestFramework[];
const OUTCOMES = [
  "passed",
  "failed",
  "errored",
  "interrupted",
  "unknown",
] as const satisfies readonly TestOutcome[];
const STAGES = [
  "baseline",
  "intermediate",
  "final",
  "unspecified",
] as const satisfies readonly TestStage[];
const PARSER_STATUSES = [
  "parsed",
  "partially_parsed",
  "exit_code_only",
  "unsupported",
  "malformed",
] as const satisfies readonly TestParserStatus[];

export function testQuery(query: QueryValues): TestPageQuery {
  allowed(query, [
    "page",
    "pageSize",
    "since",
    "until",
    "search",
    "framework",
    "outcome",
    "stage",
    "parserStatus",
    "trackingRunId",
    "sessionId",
    "sort",
    "order",
  ]);
  return {
    ...base(query),
    framework: enumeration(query.framework, "framework", FRAMEWORKS),
    outcome: enumeration(query.outcome, "outcome", OUTCOMES),
    stage: enumeration(query.stage, "stage", STAGES),
    parserStatus: enumeration(
      query.parserStatus,
      "parserStatus",
      PARSER_STATUSES,
    ),
    trackingRunId: text(query.trackingRunId),
    sessionId: text(query.sessionId),
    sort:
      enumeration(query.sort, "sort", [
        "startedAt",
        "framework",
        "outcome",
        "stage",
        "duration",
        "failedTests",
      ]) ?? "startedAt",
    order: enumeration(query.order, "order", ["asc", "desc"]) ?? "desc",
  };
}
