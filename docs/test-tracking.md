# Local test run tracking

CodeOutcome records **Test results recorded during an AI coding session**. A
recorded result describes a command or imported report; it does not prove that
the code is correct and does not attribute a test change to Claude Code or
Codex.

## Why an explicit wrapper

CodeOutcome cannot safely and transparently intercept every shell command run by
an AI coding tool. Test tracking is therefore explicit. The short form treats
everything after optional CodeOutcome flags as the test command:

```sh
codeoutcome test pytest -q
codeoutcome test --stage baseline pnpm test
codeoutcome test --stage final pnpm test
codeoutcome test cargo test
codeoutcome test go test ./...
```

The longer `codeoutcome test run [options] -- <command>` form remains available
for scripts and for commands that need an explicit separator.

The wrapper launches an executable with an argument array and `shell:false`.
It neither builds a shell command string nor modifies test configuration,
installs reporters, or retries failures. Terminal output remains visible. The
wrapper returns the child process exit code even if CodeOutcome finalization
fails.

Output is captured only in a bounded in-memory buffer for aggregate parsing.
After the limit is reached, output continues to the terminal but is no longer
added to the buffer; the record is marked `output_truncated`. Raw stdout,
stderr, failures, stack traces, and test case names are never persisted.

## Frameworks and fallback behavior

Wrapped-command parsers are independent and versioned:

- pytest summary lines;
- Jest `Tests:` summaries;
- Vitest `Tests` summaries;
- Go verbose `--- PASS`, `--- FAIL`, and `--- SKIP` lines;
- Cargo `test result:` summaries;
- generic exit-code fallback.

Automatic detection uses the executable and explicit arguments, not merely a
configuration file. Its non-content detection reason is recorded in warnings
metadata. Unknown or changed output falls back to `exit_code_only`.
Exit zero can then be recorded as a passed command with all test counts
`unknown`; a non-zero unparsed command is `errored`, not a fabricated failed
test count. Cache, prompt, source, and token accounting are unrelated to test
counts.

## Structured report import

Existing reports can be imported without changing a test runner:

```sh
codeoutcome test import --file report.xml --format junit
codeoutcome test import --file pytest-report.json --format pytest-json
codeoutcome test import --file jest-report.json --format jest-json
codeoutcome test import --file vitest-report.json --format vitest-json
codeoutcome test import --file report.xml --format auto
```

CodeOutcome supports aggregate JUnit XML, pytest JSON, Jest JSON, and Vitest
JSON. JSON files have a hard size limit. XML declarations that could enable a
DTD, external entity, or entity expansion are rejected before parsing. Imports
are transactional. The report itself is not copied: only a fingerprint, size,
parser metadata, optional path metadata, and aggregate counts are saved.

Importing an unchanged format/path/fingerprint is idempotent. Rewriting the
same report path updates the existing test run and adds a non-content recovery
event; it does not create a second cumulative result.

## Stages and comparison

Stages are `baseline`, `intermediate`, `final`, and `unspecified`:

```sh
codeoutcome test compare <baseline-id> <final-id>
codeoutcome test compare --tracking-run <tracking-run-id>
codeoutcome test compare --session <session-id>
```

For tracking-run or session comparison, CodeOutcome chooses the earliest
explicit baseline and latest explicit final. If stages are absent, it uses the
earliest and latest eligible runs and marks the choice as inferred. One run
cannot produce a delta.

Results are `comparable` when the framework and command fingerprint match and
both sides contain structured counts. The result is `partially_comparable`
when the framework matches but the command scope differs or either side is
exit-code-only. Different frameworks are `not_comparable`. Unknown counts stay
unknown rather than becoming zero. Output describes observed result changes;
it makes no causal claim about a Provider.

## Tracking-run and session links

`test run` canonicalizes the current directory and looks for active tracking
runs in the same directory or Git worktree. A single reliable match is linked;
no match becomes standalone; multiple matches become ambiguous and remain
unlinked. `codeoutcome run codex` passes the new tracking ID to nested processes
as `CODEOUTCOME_TRACKING_RUN_ID`. An existing value is preserved with a warning.

When a tracking run later links to an imported Provider session, its test runs
with no session link are backfilled. Manual corrections are append-only:

```sh
codeoutcome test link <test-run-id> --tracking-run <tracking-run-id>
codeoutcome test link <test-run-id> --session <session-id>
codeoutcome test unlink <test-run-id>
```

Automatic, manual, and unlink events remain in `test_run_links`. A future
Provider hook or shim can use the documented tracking environment contract, but
transparent command interception is not implemented in this phase.

## Stored and excluded data

The default `git-metadata` privacy mode may save the executable basename, a
redacted display command, argument count, irreversible command fingerprint,
framework, aggregate counts, exit status, signal, duration, parser status, and
report path metadata. Secret-like arguments are redacted before persistence.

`strict` saves only the executable basename for `command_display`, never saves
argument text, and replaces a report path with an irreversible path
fingerprint. Both modes exclude raw output, failure messages, stack traces,
environment variables, authentication arguments, API keys, cookies, prompts,
AI replies, source code, and full Git diffs.

## Recovery and deletion

An abnormal CodeOutcome wrapper exit can leave a `running` row:

```sh
codeoutcome test recover --list
codeoutcome test recover <test-run-id>
codeoutcome test abandon <test-run-id>
```

Recovery records an append-only event and leaves the unavailable exit code and
test counts as `NULL`. `doctor` warns about stale rows.

Test metadata can be reviewed and deleted independently:

```sh
codeoutcome data delete-tests --dry-run
codeoutcome data delete-tests --before 2026-07-01 --dry-run
codeoutcome data delete-tests --tracking-run <id> --yes
```

Actual deletion requires `--yes`. It cascades only through test report, link,
and recovery metadata. Sessions, Token accounting, Git snapshots, tracking
runs, configuration, and original report files remain untouched.

## Current limits

- CodeOutcome records only explicitly wrapped commands and explicitly imported
  reports; it cannot transparently see every command that Codex or Claude Code
  runs.
- Human, editor, CI, and other tool activity can occur in the same tracking
  interval. A link establishes context, not causality.
- Text output formats can change. Safe fallback preserves exit status while
  leaving counts unknown.
- A passing command is evidence about that invocation, not a guarantee that the
  code is correct or complete.
