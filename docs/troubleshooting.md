# Troubleshooting

Start with `agentledger doctor` or `agentledger doctor --json`. The command is
diagnostic and does not change configuration, logs, or the database.

## Database missing or schema outdated

Run an explicit import when you are ready to create/migrate local data:
`agentledger import --provider all`. The Dashboard deliberately does not create
or migrate SQLite. Stop the Dashboard before maintenance and retain a backup if
the data matters.

## Provider logs unavailable

Claude Code defaults to `~/.claude/projects`; Codex defaults to
`~/.codex/sessions`. Confirm the tools have created local sessions and that the
directories are readable. Use `AGENTLEDGER_CLAUDE_LOG_DIR` or
`AGENTLEDGER_CODEX_LOG_DIR` for an intentional alternate location.

## Dashboard does not open

From source, run `pnpm dashboard:build`. Start with
`agentledger dashboard --no-open --port 0` and open the printed loopback URL.
Do not switch the host to a LAN address. A stale browser tab cannot reuse the
in-memory token after a server restart; open the newly printed URL.

## Totals look unexpected

Cached Input is already part of Input and is not added again. Total is Input +
Output. Use `agentledger audit-usage` and the accounting documentation; unknown
pricing is unavailable, not zero. If a Provider changed its log format, create a
synthetic fixture rather than sharing the source log.

## Test or tracking data is missing

Only explicitly wrapped/imported test runs are recorded. “No recorded test
runs” is different from zero failures. Git tracking observes an interval and
does not prove exact authorship. Check active/running rows with the CLI recovery
commands before starting another run.
