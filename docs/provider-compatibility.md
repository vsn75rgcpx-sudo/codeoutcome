# Provider log compatibility

Provider JSONL files are implementation formats, not stable public APIs. This
report records exactly what the installed CodeOutcome version recognizes and
the evidence behind each claim. Run the machine-readable version locally:

```sh
codeoutcome formats --json
codeoutcome formats --provider codex
```

## Codex

| Field                 | Value                                                               |
| --------------------- | ------------------------------------------------------------------- |
| CodeOutcome format ID | `codex-rollout-jsonl-v1`                                            |
| Evidence              | `local-log-validated` plus synthetic fixtures                       |
| Session marker        | `session_meta.payload.id`                                           |
| Context markers       | `turn_context.payload.model`, `payload.cwd`, Git aliases            |
| Usage markers         | `event_msg.payload.info.total_token_usage`, `last_token_usage`      |
| Accounting            | cumulative snapshot preferred; unpaired legacy usage is incremental |

Conservative aliases under `payload.usage` and top-level `usage` are accepted.
Unknown records and unknown fields are ignored. Missing model, time, working
directory, repository, and branch fields degrade to `unknown` or `null` without
inventing values. Malformed complete lines are skipped; a truncated final line
is retained for the next append.

Local validation means the format was exercised against metadata structure
observed in local Codex logs. Prompt, response, tool payload, and source content
were not printed, copied to fixtures, or persisted during that validation.

## Claude Code

| Field                 | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| CodeOutcome format ID | `claude-code-project-jsonl-v1`                              |
| Evidence              | `synthetic-fixtures-only`                                   |
| Session markers       | `sessionId`, `session_id`, `session`                        |
| Context markers       | top-level timestamp/cwd/repository/branch aliases           |
| Usage markers         | `message.usage.input_tokens`, `output_tokens`, cache fields |
| Accounting            | recognized usage records are treated as incremental         |

No real Claude Code log or running Claude Code account was available for
`0.1.0-alpha.2`. The adapter is covered by manually constructed, redacted
fixtures for supported, missing-field, unknown, malformed, and truncated cases.
This is useful compatibility evidence but is not equivalent to real-version
validation. `doctor` reports this distinction as a warning rather than a pass.

Users who voluntarily validate Claude Code should report only field names,
record types, CodeOutcome counts, and manually redacted errors. Never submit a
real JSONL file, Prompt/response text, tool input, source code, credentials,
session IDs, or full paths.

## Version-change policy

- A newly observed record shape receives a new format ID or an explicit alias
  update plus a synthetic regression fixture.
- A field is not classified as cumulative or incremental without evidence.
- Unknown formats remain partial/unavailable instead of being silently mapped.
- `codeoutcome formats` reports declared support and the number of imported
  source files recorded under each format ID.
- Compatibility changes are documented in the changelog. CodeOutcome performs
  no remote format lookup and no network-based version check.
