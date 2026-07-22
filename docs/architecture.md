# Architecture

CodeOutcome separates parsing, import/accounting, storage, repository discovery,
and presentation:

```text
Claude JSONL -> Claude adapter --+
                                +-> core importer/accounting ----+
Codex JSONL --> Codex adapter ---+                               |
                                                                +-> SQLite migrations
Git executable -> git-tracker -> core tracking/link scoring ----+          |
Test executable/report -> core test parsers/association --------+          |
                                                                           +-> CLI reports
                                                                           |
                                            read-only SQLite connection ----+-> dashboard-server -> React UI
```

## Packages

- `packages/shared`: normalized `Session` and `UsageEvent` contracts, canonical
  path handling, stable identifiers, hashing, and byte-offset JSONL streaming.
- `packages/adapters/claude-code`: Claude Code discovery and parsing only.
- `packages/adapters/codex`: Codex discovery and parsing only.
- `packages/core`: import orchestration, per-file error isolation, incremental
  checkpoint decisions, canonical token audit/reconciliation, time buckets,
  local pricing, tracking lifecycle, explainable session linking, privacy
  configuration, provider runner orchestration, bounded-output test command
  execution, versioned test/report parsers, and result comparison.
- `packages/database`: versioned SQLite migrations, transactions, checkpoints,
  repositories, import runs, Git snapshots, tracking runs, link history, and
  test runs, report fingerprints, append-only test link/recovery history, and
  filtered queries.
- `packages/git-tracker`: read-only Git enrichment, machine-readable porcelain
  and numstat parsing, snapshot capture/comparison, and remote URL sanitization.
- `packages/dashboard-server`: parameterized, paginated read-only SQLite
  queries plus the loopback-only Hono API. It validates query parameters,
  whitelists sort fields, applies privacy projection, and never runs migrations.
- `apps/cli`: argument validation and human/JSON presentation for `doctor`,
  usage accounting, Git snapshots, tracking, recovery, configuration, and the
  Codex provider runner.
  It also presents explicit test wrapping, report import, comparison, recovery,
  test-only deletion commands, and the Dashboard process lifecycle.
- `apps/dashboard`: Vite-built React client with lazy routes, native CSS/SVG
  charts, local theme preference, manual/limited refresh, and shared API types.
  It never opens SQLite directly.

`doctor` uses read-only database inspection and a read-only `SessionDatabase`
only when the schema is current, so it cannot create a file or apply a migration.
Writable commands apply pending migrations transactionally, enable foreign keys
and WAL, and keep Token accounting rows separate from Git tracking rows.

## Dashboard read path

`codeoutcome dashboard` selects loopback and a random port by default, creates a
random in-memory access token, then opens a dedicated SQLite connection with
`readOnly: true` and `PRAGMA query_only=ON`. The API performs SQLite aggregation
for Overview data and pages all entity lists; it does not return raw
`usage_events`, source file paths, raw process output, source bodies, or full
diffs. Token integers cross the API as decimal strings so values above
`Number.MAX_SAFE_INTEGER` remain exact.

The initial HTML receives the per-process token in a fixed meta element. Browser
requests send it in `X-CodeOutcome-Dashboard-Token`; the server additionally
checks Host and any supplied Origin, sets a restrictive CSP and framing policy,
and does not enable CORS. A restart invalidates the old token. API errors use a
stable envelope and redact paths and SQL details.

When the database is missing, locked, or older than migration 5, the server
returns an explanatory read-only state. It neither creates the file nor applies
migrations. `strict` privacy mode is projected at the query boundary: API path
fields become unavailable and test command display is reduced to the executable
basename.

## Storage flow

Each source file has a canonical path, byte checkpoint, verified prefix hash,
full-file hash, size, modification time, and parser format in `source_files`.
An unchanged size/mtime pair is skipped. A longer file whose verified prefix is
unchanged is parsed only from the checkpoint. A shorter or changed prefix is
treated as a rewrite: that source's events are replaced and the session total
is recomputed transactionally.

Usage-event IDs and unique constraints prevent the same source offset from
being applied twice. Session IDs are derived from provider plus provider session
ID. When the provider ID is missing, the adapter derives a stable fallback from
provider plus canonical source path.

## Accounting reconciliation

Provider adapters classify usage payloads as cumulative snapshots, standalone
increments, or informational records. Core selects canonical events and derives
all session totals without consulting the previous aggregate. Database applies
canonical markers and session totals in one transaction, so a failure rolls the
whole reconciliation back.

Historical cumulative snapshots and paired informational payloads stay in
`usage_events` for audit. Only the final reliable snapshot, or deduplicated
increments when snapshots are absent, is marked canonical. Decreasing snapshots
or mixed ranges become `ambiguous` and carry explicit reason codes.

## Git tracking flow

`track start` canonicalizes the current directory, identifies the worktree root,
captures a Git start snapshot, and inserts the snapshot and active tracking run
in one transaction. A partial unique index prevents two active runs for the same
canonical working directory.

`track stop` captures an end snapshot, compares it with the start, imports the
selected Provider's latest logs, and applies the centralized explainable session
score. The end snapshot and run summary are transactional. Automatic and manual
links are recorded as append-only `session_git_links` history; unlinking marks a
record inactive instead of deleting it.

Git is executed directly with an executable and argument array, `shell:false`,
and machine-readable NUL-delimited output. Snapshots contain repository state,
relative-path metadata or fingerprints, and numstat counts—not file bodies,
environment variables, or complete diffs.

## Test tracking flow

`test run` creates a `running` row before spawning the requested executable with
an argument array and `shell:false`. Stdout and stderr are forwarded to the
terminal and copied only into a bounded, non-persistent memory buffer. A
versioned framework parser extracts aggregate counts when possible; otherwise
the result falls back to exit-code-only semantics. Finalization records normal,
non-zero, signal, and failed-to-start outcomes without changing the child exit
code.

An association resolver canonicalizes the current directory and Git worktree.
Exactly one active tracking run produces an automatic link; zero produces a
standalone record; multiple candidates remain ambiguous. When tracking later
links to a session, test rows without a session are backfilled. Every automatic,
manual, and unlink decision is appended to `test_run_links`.

Structured report import rejects oversized JSON and XML DTD/entity constructs,
parses only aggregate metadata, and uses a format/path uniqueness key plus file
fingerprint for idempotent rewrites. Comparison is dynamic: explicit baseline
and final stages take precedence, with visibly inferred earliest/latest
fallbacks when stages are absent.
