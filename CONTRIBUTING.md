# Contributing

CodeOutcome welcomes small, privacy-preserving changes. Before starting a large
feature, open a proposal describing the user need, local-data implications, and
test plan. Current scope excludes cloud sync, accounts, remote dashboards,
productivity scores, and exact AI code attribution.

## Development

Use Node.js 22.13+, pnpm 11, and Git. Then run:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm e2e
```

Fixtures must be manually constructed and fully synthetic. Do not commit real
Codex or Claude Code JSONL, a real database, Prompt/response text, source code,
credentials, or identifying absolute paths. Follow
[the redaction guide](docs/redaction-guide.md).

Keep module boundaries intact: adapters parse, database stores, core imports and
accounts, Dashboard server projects read-only views, and CLI handles arguments
and presentation. Add focused tests and update relevant documentation. Commits
should be scoped and explain the user-visible outcome.
