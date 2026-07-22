# Security policy

## Supported versions

Until a stable release, only the newest `0.1.0-alpha.x` revision is eligible for
security fixes. Alpha interfaces and local log compatibility may change.

## Reporting a vulnerability

Do not open a public issue for a vulnerability involving local data, path
disclosure, access control, or credentials. After the GitHub repository is
published, use its private **Security → Report a vulnerability** advisory form.
Before then, contact the maintainer through the private contact method on the
repository owner's profile. Include a minimal synthetic reproduction, affected
version, and impact. Allow maintainers time to acknowledge and investigate
before public disclosure.

Never submit real Provider JSONL, Prompt/response content, source code, API keys,
tokens, cookies, `.env` files, or an AgentLedger database. Use a manually
constructed redacted fixture and review `doctor --json` output for paths before
sharing it.

## Security boundary

The Dashboard is designed only for localhost. It is not supported behind a
reverse proxy, on a LAN address, through port forwarding, or on a shared host.
AgentLedger does not auto-update and performs no remote version check.
