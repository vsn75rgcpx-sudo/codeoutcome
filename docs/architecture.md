# Architecture

AgentLedger separates parsing, import/accounting, storage, repository discovery,
and presentation:

```text
Claude JSONL -> Claude adapter --+
                                +-> core importer/accounting ----+
Codex JSONL --> Codex adapter ---+                               |
                                                                +-> SQLite migrations
Git executable -> git-tracker -> core tracking/link scoring ----+          |
                                                                           +-> CLI reports
```

## Packages

- `packages/shared`: normalized `Session` and `UsageEvent` contracts, canonical
  path handling, stable identifiers, hashing, and byte-offset JSONL streaming.
- `packages/adapters/claude-code`: Claude Code discovery and parsing only.
- `packages/adapters/codex`: Codex discovery and parsing only.
- `packages/core`: import orchestration, per-file error isolation, incremental
  checkpoint decisions, canonical token audit/reconciliation, time buckets,
  local pricing, tracking lifecycle, explainable session linking, privacy
  configuration, and provider runner orchestration.
- `packages/database`: versioned SQLite migrations, transactions, checkpoints,
  repositories, import runs, Git snapshots, tracking runs, link history, and
  filtered queries.
- `packages/git-tracker`: read-only Git enrichment, machine-readable porcelain
  and numstat parsing, snapshot capture/comparison, and remote URL sanitization.
- `apps/cli`: argument validation and human/JSON presentation for `doctor`,
  usage accounting, Git snapshots, tracking, recovery, configuration, and the
  Codex provider runner.

`doctor` uses read-only database inspection and a read-only `SessionDatabase`
only when the schema is current, so it cannot create a file or apply a migration.
Writable commands apply pending migrations transactionally, enable foreign keys
and WAL, and keep Token accounting rows separate from Git tracking rows.

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
