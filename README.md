# AgentLedger

AgentLedger is a local-first CLI that imports Claude Code and OpenAI Codex
session metadata into SQLite and reports token usage. It reads JSONL logs
incrementally, keeps the two provider parsers independent, and stores only the
metadata needed for accounting.

There is no web app, desktop app, VS Code plugin, cloud sync, telemetry, or
network pricing lookup in the current phase.

## Requirements

- Node.js 22.13 or newer (for the built-in SQLite runtime)
- pnpm 11 or newer
- Git (used read-only for repository, branch, and sanitized remote metadata)

## Install and develop

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run the CLI from this workspace:

```sh
pnpm cli doctor
pnpm cli import --dry-run
pnpm cli import --provider all
pnpm cli sessions --limit 10
pnpm cli usage --weekly
```

After `pnpm build`, the executable is `apps/cli/dist/index.js`. A linked or
published package exposes the same program as `agentledger`.

## Commands

```text
agentledger doctor [--json]
agentledger import [--provider claude-code|codex|all] [--dry-run] [--since 7d] [--json]
agentledger sessions [--provider claude-code|codex] [--since 7d] [--repo name-or-path] [--limit 20] [--json]
agentledger usage [--daily|--weekly|--monthly] [--provider claude-code|codex] [--since 30d] [--json]
```

`doctor` is diagnostic only: it does not create the database, run migrations,
or modify user configuration. `import` is the only command that reads source
logs and writes imported metadata. `sessions` and `usage` query the persisted
database.

Default paths:

- Claude Code logs: `~/.claude/projects`
- Codex logs: `~/.codex/sessions`
- macOS database: `~/Library/Application Support/AgentLedger/agentledger.sqlite`
- Linux database: `$XDG_DATA_HOME/agentledger/agentledger.sqlite`, or
  `~/.local/share/agentledger/agentledger.sqlite`

Path overrides:

```sh
AGENTLEDGER_CLAUDE_LOG_DIR=/path/to/claude/logs pnpm cli import
AGENTLEDGER_CODEX_LOG_DIR=/path/to/codex/logs pnpm cli import
AGENTLEDGER_DATA_DIR=/path/to/local/data pnpm cli import
```

Durations such as `7d`, `24h`, and `4w` are supported by `--since`. Date
filtering and report buckets use UTC.

## Privacy principles

- Source logs are opened read-only. AgentLedger never edits, moves, truncates,
  or deletes files under `~/.claude`, `~/.codex`, or configured log roots.
- Prompt text, response text, source code, tool payloads, shell environment
  variables, API keys, cookies, and access tokens are not placed in normalized
  objects or SQLite.
- Local paths are stored because they are required for incremental imports and
  repository grouping. CLI output replaces the current home directory with
  `~`.
- Git remotes have credentials, query strings, and fragments removed before
  storage.
- There are no network requests or remote telemetry. Pricing uses only the
  bundled versioned local catalog.
- All committed fixtures are synthetic and redacted. Never copy real user logs
  into this repository.
- A malformed file is isolated to that provider and file; errors never include
  the source record body.

The SQLite database is private local data and may still reveal project names,
paths, models, branches, timestamps, and token counts. Protect it accordingly.

## Current format support

The Claude Code adapter supports project JSONL records containing session
metadata on top-level `user`/`assistant` objects and token counts under
`message.usage` (with conservative aliases for older field names).

The Codex adapter supports rollout JSONL records including `session_meta`,
`turn_context`, and `event_msg` records whose token data is under
`payload.info.total_token_usage` or `payload.info.last_token_usage`. It also
accepts conservative older `usage` locations.

Both adapters tolerate unknown fields, missing metadata, malformed complete
lines, and a truncated final line. Very large files are processed line by line
from the last verified byte checkpoint instead of being loaded into memory.

See [Usage accounting](docs/usage-accounting.md) for exact token semantics,
incremental-import behavior, and known risks. See
[Architecture](docs/architecture.md) for module boundaries.

## Cost status

The bundled catalog is `local-unpriced-v1`, updated 2026-07-20. It intentionally
contains no enabled model prices because no versioned rate source has been
verified for this repository. Costs are therefore `unavailable` unless a
supported source event contains a complete cost estimate. A future verified
local catalog will be labeled `estimated`; it will not be presented as billed
cost.

## License

[MIT](LICENSE)
