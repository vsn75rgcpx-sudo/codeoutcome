# Installation

AgentLedger is currently an unpublished alpha. Do not use an unverified npm or
Homebrew package with the same name.

## Developer checkout

```sh
git clone <future-agentledger-repository-url>
cd agentledger
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm cli doctor
pnpm cli dashboard
```

The placeholder clone URL becomes concrete only after the repository is
published. Existing contributors can use their current local checkout.

## Local tarball

From a trusted checkout:

```sh
pnpm install --frozen-lockfile
pnpm package:pack
pnpm package:inspect
pnpm package:test-install
npm install -g ./artifacts/package/agentledger-cli-0.1.0-alpha.1.tgz
agentledger --version
agentledger doctor
```

The package contains compiled CLI code and Dashboard assets. It does not require
the monorepo at runtime. Remove it with `npm uninstall -g @agentledger/cli`.
Uninstall does not delete the local SQLite database.

Requirements: macOS or Linux, Node.js 22.13 or newer, and Git. pnpm is needed to
develop or build the tarball, not to run an installed package. Windows has not
been validated in this alpha.
