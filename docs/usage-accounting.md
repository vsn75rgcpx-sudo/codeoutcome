# Usage accounting

This document defines the phase-two accounting rules. The rules are deliberately
conservative because Claude Code and Codex JSONL files are implementation
formats, not stable public accounting APIs.

## Normalized fields

`inputTokens` includes all input processed by the provider, including cached
input when that provider exposes cached input as a subset. `cachedInputTokens`
is the cached subset and is reported separately. `outputTokens` is generated
output. Consequently:

```text
totalTokens = inputTokens + outputTokens
```

Cached input is never added to `totalTokens` again. If a malformed record reports
more cached input than total input, accounting preserves the reported values,
sets Uncached Input to zero, and records a non-sensitive warning.

`reasoning_output_tokens` is treated as a subset of Output. It is available to
the accounting audit but is never added to Total a second time.

All parsed timestamps are converted to ISO 8601 UTC. Session start is the
earliest valid timestamp and end is the latest. Displayed duration is clamped at
zero so invalid ordering cannot produce a negative duration.

## Claude Code

Supported primary shape:

- project JSONL `user` and `assistant` records;
- session ID in `sessionId`, `session_id`, or `session`;
- model and token usage in `message.model` and `message.usage`;
- `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and
  `cache_creation_input_tokens`/`cache_write_input_tokens`;
- top-level timestamp, working directory, repository, and branch metadata, with
  conservative aliases for older records.

Claude usage records are treated as incremental. Normalized input is base input
plus cache-created/written input plus cache-read input. Cached-read input remains
available as the cached subset. Events belonging to one provider session are
summed.

Known risk: if the same incremental Claude history is copied into multiple
different source files for one session, the copies cannot always be
distinguished and may be double-counted. Reimporting the same file or appending
to it is idempotent.

## Codex

Supported primary shape:

- rollout JSONL `session_meta`, `turn_context`, and `event_msg` records;
- session ID, working directory, Git branch, and model under `payload` or
  `payload.thread_settings`;
- token events under `payload.info.total_token_usage` and
  `payload.info.last_token_usage`;
- conservative fallbacks to `payload.usage` or top-level `usage` for older
  records.

`total_token_usage` is a cumulative session snapshot. AgentLedger orders valid
snapshots by event time and selects the last one as canonical. Historical
snapshots remain in `usage_events` for audit and are never summed or combined by
taking independent per-field maxima.

Current Codex token-count records may contain both `total_token_usage` and
`last_token_usage`. In that shape, the last payload is stored as informational:
it commonly represents the most recent model call and may be repeated while the
cumulative snapshot is unchanged. It is therefore never added to the paired
cumulative total. Only when a session has no cumulative snapshot are standalone
last/legacy usage records classified as increments and deduplicated before
summing.

If standalone increments coexist with cumulative snapshots, or a cumulative
counter decreases, AgentLedger selects the final provider snapshot without
adding the uncertain range and marks the session `ambiguous`. The audit exposes
the exact reason instead of silently choosing a hybrid total.

Codex `input_tokens` is treated as already containing the cached subset;
`cached_input_tokens` is not added again. `cache_write_input_tokens`, when
present, is not separately added because current cumulative totals already
represent total input.

Each session records an accounting method (`cumulative_snapshot`,
`incremental_events`, `ambiguous`, or `unavailable`), status (`verified`,
`warning`, or `invalid`), accounting version, Uncached Input, and last canonical
usage time. Each event records its accounting role, canonical marker, optional
Provider event ID, deterministic source sequence, reasoning count, and reported
total. `audit-usage` explains the selection; `reconcile-usage` rebuilds totals
and canonical markers transactionally from events, never from the previous
session aggregate.

Known risk: an unknown historical format could label a cumulative field as an
increment or vice versa. Such a format requires a new synthetic compatibility
fixture before its results can be considered reliable.

## Incremental and idempotent imports

- JSONL is streamed by bytes and lines. The importer never loads the whole file.
- Each completed record is identified by provider, canonical source path, byte
  offset, and event type.
- The checkpoint advances only through complete JSON or harmless blank lines.
  An invalid final partial line is retained for the next append.
- Unchanged files are skipped. Appended files are read from the verified byte
  checkpoint. Changed prefixes and shorter files are re-read, and only that
  source's previous events are replaced.
- Source and event updates occur in SQLite transactions with foreign keys
  enabled. WAL is used for normal writable databases.

Source symlinks are resolved and traversal outside the configured log root is
ignored. Repository and source paths are canonicalized where possible. Path
case follows the filesystem result; AgentLedger does not force lowercase because
case-sensitive volumes are valid. Relative paths are resolved before storage.

## Stable identity

The normalized session ID is a SHA-256 digest of provider plus provider session
ID. If no provider session ID exists, the fallback ID is a SHA-256 digest of
provider plus canonical source path. This is stable across appends but changes
if a no-ID log is moved.

The database enforces uniqueness for provider/session ID, provider/source file,
event ID, and source path/offset/event type. These constraints supplement the
checkpoint logic rather than replacing it.

## Costs

Pricing is separate from parsing and accounting. The bundled catalog records a
version, update timestamp, description/source, currency, and per-model rates.
The current `local-unpriced-v1` catalog intentionally enables no rates. Unknown
models and unverified rates produce `unavailable`, not zero.

If a future versioned local catalog supplies a matching model, AgentLedger will
calculate Uncached Input, Cached Input, and Output separately. Reasoning is not
priced again because it is part of Output. The result is labeled `estimated`.
Mixed priced/unpriced summaries are labeled `partial`.
Neither estimated nor source-provided cost should be treated as a billing
statement.

## Remaining limitations

- Provider log formats can change without notice; unsupported variants may
  produce partial metadata or no usage events.
- A rewritten source can remove time metadata; token totals are recomputed, but
  session time bounds merged from other fragments may remain conservative.
- Missing-ID sessions are path-stable, not content-stable, when files move.
- Cross-file duplicate detection uses a Provider event ID when one exists.
  Formats without that ID cannot reliably identify copied incremental events.
- Source logs may omit cached-token or cost fields. AgentLedger does not infer
  values that are absent.
- The database stores canonical local paths internally even though CLI output
  replaces the current home directory with `~`.
