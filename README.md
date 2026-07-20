# AgentLedger

AgentLedger is a local-first CLI for reviewing Claude Code and OpenAI Codex
programming sessions. Phase one reads existing JSONL logs, normalizes session
metadata, stores that metadata in a local SQLite database, and reports session
and token-usage summaries.

The project is intentionally small at this stage: there is no web app, desktop
app, VS Code plugin, cloud sync, or remote telemetry.

## Requirements

- macOS, Linux, or another Node.js-compatible environment
- Node.js 22.13 or newer
- pnpm 11 or newer
- Git (recommended for repository and branch enrichment)

## Install and develop

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run the CLI from the workspace:

```sh
pnpm cli doctor
pnpm cli sessions
pnpm cli usage
```

After `pnpm build`, the compiled executable is at
`apps/cli/dist/index.js`. Published or linked packages expose it as the
`agentledger` command.

## Commands

- `agentledger doctor` checks Git, expected log paths, the AgentLedger SQLite
  destination, and read/write permissions. It does not create a database or
  alter user configuration.
- `agentledger sessions` scans logs read-only, updates the local metadata
  database, and lists normalized sessions.
- `agentledger usage` scans logs read-only and aggregates tokens by provider and
  model.
- Add `--json` to `sessions` or `usage` for machine-readable output.

Default input paths:

- Claude Code: `~/.claude/projects`
- Codex: `~/.codex/sessions`

Default database: `~/.agentledger/agentledger.sqlite`

Override these paths without changing the original tools:

```sh
AGENTLEDGER_CLAUDE_LOG_DIR=/path/to/claude/logs pnpm cli sessions
AGENTLEDGER_CODEX_LOG_DIR=/path/to/codex/logs pnpm cli sessions
AGENTLEDGER_DATA_DIR=/path/to/local/data pnpm cli sessions
```

## Privacy principles

- Claude Code and Codex logs are opened read-only. AgentLedger never edits,
  moves, or deletes original logs.
- The SQLite database stores normalized metadata only. Prompt text, response
  text, source code, tool payloads, and environment variables are not retained.
- Stored metadata can include local paths (`workingDirectory`,
  `repositoryPath`, and `sourceFile`). Keep the database private if those paths
  are sensitive.
- There is no network upload or telemetry in phase one.
- Repository fixtures are synthetic and redacted. Real user logs must never be
  copied into this repository.
- Unknown fields, malformed lines, and missing values degrade to safe defaults
  instead of exposing raw records.

## Current support

The Claude Code and Codex adapters are separate packages and understand a
conservative subset of their JSONL metadata and token-usage shapes. Log formats
are not guaranteed APIs, so unknown versions may produce partial metadata. Cost
is reported only when a source log contains a usable estimate; AgentLedger does
not guess prices.

SQLite currently retains previously indexed session metadata even if a source
log later disappears. Duplicate provider/session IDs are updated in place.

See [Architecture](docs/architecture.md) for package boundaries and the next
engineering steps.

## License

[MIT](LICENSE)
