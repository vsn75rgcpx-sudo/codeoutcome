# Architecture

AgentLedger separates parsing, import/accounting, storage, repository discovery,
and presentation:

```text
Claude JSONL -> Claude adapter --+
                                +-> core importer/accounting -> SQLite migrations
Codex JSONL --> Codex adapter ---+             |                      |
                                              +-> Git metadata         +-> CLI reports
```

## Packages

- `packages/shared`: normalized `Session` and `UsageEvent` contracts, canonical
  path handling, stable identifiers, hashing, and byte-offset JSONL streaming.
- `packages/adapters/claude-code`: Claude Code discovery and parsing only.
- `packages/adapters/codex`: Codex discovery and parsing only.
- `packages/core`: import orchestration, per-file error isolation, incremental
  checkpoint decisions, token accounting, time buckets, and local pricing.
- `packages/database`: versioned SQLite migrations, transactions, checkpoints,
  repositories, import runs, and filtered queries.
- `packages/git-tracker`: read-only Git enrichment and remote URL sanitization.
- `apps/cli`: argument validation and human/JSON presentation for `doctor`,
  `import`, `sessions`, and `usage`.

`doctor` uses read-only inspection and never constructs `SessionDatabase`, so it
cannot create a file or apply a migration. A non-dry-run import opens the
database, applies pending migrations transactionally, enables foreign keys and
WAL, and imports one source at a time.

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
