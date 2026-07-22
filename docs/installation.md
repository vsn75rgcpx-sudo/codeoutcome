# Installation

CodeOutcome is a source alpha and is not published to npm or Homebrew. Do not
install an unrelated package with the same name from a registry.

## Developer checkout

```sh
git clone https://github.com/vsn75rgcpx-sudo/codeoutcome.git
cd codeoutcome
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm cli doctor
pnpm cli dashboard
```

## Local tarball

From a trusted checkout:

```sh
pnpm install --frozen-lockfile
pnpm package:pack
pnpm package:inspect
pnpm package:test-install
npm install -g ./artifacts/package/codeoutcome-0.1.0-alpha.1.tgz
codeoutcome --version
codeoutcome doctor
```

The package contains compiled CLI code and Dashboard assets. It does not require
the monorepo at runtime. Remove it with `npm uninstall -g codeoutcome`.
Uninstall does not delete the local SQLite database.

Requirements: macOS or Linux, Node.js 22.13 or newer, and Git. pnpm is needed to
develop or build the tarball, not to run an installed package. Windows has not
been validated in this alpha.

## Legacy data location

If the CodeOutcome data directory does not exist but the former
`AgentLedger/agentledger.sqlite` database does, CodeOutcome reads that database
in compatibility mode and reports the legacy location. It does not move,
rename, delete, or overwrite the file. See the README for precedence and legacy
environment-variable details.
