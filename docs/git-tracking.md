# Local Git session tracking

AgentLedger records **Changes observed during an AI coding session**. It is not
an AI-code attribution system and does not claim that every observed line was
written by Claude Code or Codex.

## Tracking runs

A tracking run connects two read-only Git snapshots with an optional imported
AgentLedger session:

```text
track start -> start snapshot -> AI coding interval -> end snapshot
            -> Provider log import -> explainable session link
```

Manual use:

```sh
agentledger track start --provider codex --label "fix login timeout"
agentledger track status
agentledger track stop
agentledger track show <tracking-run-id>
```

`agentledger run codex -- <arguments>` performs the same start/stop lifecycle
around the local `codex` executable. It uses a direct child process with inherited
terminal input/output, `shell:false`, and an argument array. Normal exits,
non-zero exits, SIGINT, and SIGTERM all attempt finalization. No Codex settings or
permissions are changed.

The runner also passes its tracking ID to nested commands through the dedicated
`AGENTLEDGER_TRACKING_RUN_ID` environment value. An existing value is never
overwritten. Explicit `agentledger test run -- ...` commands can use this hint
for reliable association; AgentLedger does not transparently intercept every
test command executed by a Provider.

## Recorded Git metadata

Snapshots use `rev-parse`, `symbolic-ref`, porcelain v2 `-z`, numstat `-z`, and
upstream rev-list output. They may record:

- canonical worktree path, HEAD, branch, detached/unborn state, and Git version;
- dirty, staged, unstaged, untracked, and conflict counts;
- relative paths, change types, rename source paths, and available additions and
  deletions in `git-metadata` mode;
- binary markers, ahead/behind counts when an upstream exists, and irreversible
  SHA-256 path fingerprints.

AgentLedger does not save source text, ignored files, complete diffs, prompts,
responses, credentials, or environment variables. It does not read untracked
files to invent line counts. Binary and otherwise indeterminate counts remain
`unknown`.

## Snapshot comparison

When the baseline is clean, the branch is unchanged, and HEAD stays fixed, the
end working state can be described as observed changes. When HEAD advances,
AgentLedger uses `<start-head>..<end-head>` numstat as committed net change.

A dirty start is marked `baseline_dirty`; working-tree line contribution remains
unknown instead of subtracting two unrelated states. Automatic session-link
confidence is capped at medium. Branch switches, unreachable or rewound HEADs,
reset/rebase-like histories, overlapping staged/unstaged states, and unavailable
commit ranges produce explicit warnings. Counts describe observations, not AI
authorship.

## Session linking score

The score is deterministic and every contribution appears in `track show`:

| Evidence                               | Maximum |
| -------------------------------------- | ------: |
| Provider match                         |    0.15 |
| Canonical repository match             |    0.20 |
| Canonical working-directory match      |    0.20 |
| Tracking-interval overlap              |    0.20 |
| Start-time proximity within 30 minutes |    0.10 |
| End-time proximity within 30 minutes   |    0.05 |
| Branch match                           |    0.05 |
| Only viable candidate                  |    0.05 |

Thresholds are centralized in `SESSION_LINK_SCORING`: high `>=0.85`, medium
`>=0.65`, low below that, and automatic linking requires `>=0.65`. Two qualifying
candidates within `0.05` are `ambiguous` and are not automatically linked.
Candidates below the automatic threshold also remain unlinked. A branch change
subtracts `0.10`; rewritten or rewound history subtracts `0.15`. A dirty
baseline caps the final automatic level at medium.

Manual correction preserves history:

```sh
agentledger track link <tracking-run-id> --session <session-id>
agentledger track unlink <tracking-run-id>
```

## Privacy modes

`git-metadata` is the default. It stores repository-relative paths, change type,
and available line counts without file content or full diffs.

```sh
agentledger config set privacy strict
```

`strict` applies to new snapshots and stores no plaintext relative path; it keeps
path fingerprints and aggregate statistics. Switching modes does not erase old
records. See the README privacy section for manual local-data removal.

## Recovery

An abnormal terminal exit can leave a run `active`. `doctor` reports this as a
warning.

```sh
agentledger track recover --list
agentledger track recover <tracking-run-id>
agentledger track abandon <tracking-run-id>
```

Recovery captures the current state with trigger `recovery` and uses that
explicit capture time; it does not invent an earlier end time. Abandoning a run
keeps its start snapshot and history. Neither command modifies the Git working
tree.

## Known limits

- A session may touch the same repository concurrently with people, tools, or
  other agents; Git metadata cannot prove authorship.
- A dirty baseline, branch switch, rebase, reset, force operation, or deleted
  commit can reduce precision.
- Provider logs can be delayed or omit times and paths, reducing link confidence.
- Multiple equally plausible sessions remain ambiguous until manually linked.
- Test results are recorded only for explicit wrappers or imported reports.
  See [Local test run tracking](test-tracking.md); a test link describes context,
  not proof that the Provider caused the result.
