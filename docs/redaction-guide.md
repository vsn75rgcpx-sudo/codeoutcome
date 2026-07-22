# Redaction guide

Never attach a real Provider log or CodeOutcome database to an issue. Build the
smallest artificial reproduction from scratch.

Remove or replace:

- Prompt and response text, reasoning, tool payloads, and source snippets;
- names, email addresses, usernames, absolute paths, repository/branch names,
  commit IDs, remotes, issue links, and organization identifiers;
- API keys, access/refresh tokens, cookies, auth headers, `.env` values, command
  secrets, and private hostnames;
- raw test output, stack traces, test names, and proprietary dependencies.

Use obvious values such as `demo-session-01`, `/codeoutcome-demo/atlas-cli`,
`example.invalid`, and repeated non-real commit characters. Preserve only field
names, types, nesting, ordering, and minimal aggregate numbers needed to trigger
the behavior. Search the finished fixture for your username, home path, company,
repository, email domain, and common secret prefixes. Run the full privacy tests
before committing.

`doctor --json` is metadata-only, but may include redacted or configured paths.
Review it line by line before posting. Screenshots can reveal browser history,
window titles, paths, and other applications; crop by recapturing the app-only
viewport, not by obscuring sensitive data after the fact.
