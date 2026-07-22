# Privacy

CodeOutcome is local-first and has no telemetry. It does not send usage,
repository, test, or configuration data to CodeOutcome maintainers.

## What is read

By default, imports read `~/.claude/projects` and `~/.codex/sessions` in
read-only mode. Git tracking reads machine-readable repository state. Explicit
test wrappers observe aggregate process results; report import reads only the
selected local report. Paths can be overridden with the documented environment
variables.

## What is stored

SQLite stores session identifiers, Provider/model names, timestamps, Token
counts, sanitized local paths, repository/branch metadata, aggregate observed
Git change metadata, aggregate test outcomes, import state, accounting evidence,
and irreversible fingerprints used for deduplication. On macOS the default is
`~/Library/Application Support/CodeOutcome/codeoutcome.sqlite`; Linux uses the
documented XDG data directory.

CodeOutcome does not store Prompt or response bodies, source code, full diffs,
raw test output, stack traces, test case bodies, shell environment variables,
API keys, cookies, access tokens, or unredacted secret-like command arguments.

`codeoutcome feedback` prints an identifier-free questionnaire locally. It
does not read the database, inspect Provider logs, create a network request, or
submit anything. The optional GitHub form is public and the GitHub account is
visible; users choose whether and what to copy.

## Privacy modes

`git-metadata` stores repository-relative changed paths and sanitized command
metadata. `strict` stores fingerprints and aggregates for new Git snapshots and
projects paths/commands more conservatively in the Dashboard. Switching to
strict does not erase older rows; make a deliberate deletion if old metadata
must be removed.

The Dashboard binds only to a loopback address, uses an in-memory per-start
access token, checks Host and Origin, serves a read-only SQLite connection, and
provides no write API. Do not put it behind a public proxy or port forward it.

## Deletion and uninstall

Stop CodeOutcome first. After making any wanted backup, delete the local
`codeoutcome.sqlite`, `codeoutcome.sqlite-wal`, `codeoutcome.sqlite-shm`, and
`config.json` files from the CodeOutcome data directory. Uninstalling the CLI
does not delete local data automatically. Never attach a real database or raw
Provider log to a public issue.

The legacy migration command reads only the SQLite database and creates a
verified copy plus backup. It does not read Provider logs during migration and
does not delete or rewrite the legacy database.
