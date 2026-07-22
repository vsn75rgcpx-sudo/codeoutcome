# Installation

CodeOutcome is a public alpha. The supported end-user installation is the
public `codeoutcome` package from the official npm registry. It is not published
to Homebrew.

## npm installation

```sh
npm install --global codeoutcome
codeoutcome --version
codeoutcome doctor --provider codex
codeoutcome import --provider codex
codeoutcome usage --weekly
codeoutcome dashboard
```

An installed package does not require pnpm or the source repository. Do not use
`sudo npm install`; fix the npm global prefix if the installation directory is
not writable. Uninstall with `npm uninstall --global codeoutcome`. Uninstalling
does not delete the local SQLite database.

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
npm install -g ./artifacts/package/codeoutcome-0.1.0-alpha.2.tgz
codeoutcome --version
codeoutcome doctor
```

The tarball contains the same compiled CLI and Dashboard assets published to
npm and does not require the monorepo at runtime.

Requirements: macOS or Linux, Node.js 22.13 or newer, and Git. pnpm is needed to
develop or build the tarball, not to run an installed package. Windows has not
been validated in this alpha.

## Legacy data location

If the CodeOutcome database does not exist but the former
`AgentLedger/agentledger.sqlite` database does, CodeOutcome reads that database
in compatibility mode and reports the legacy location. It does not move,
rename, delete, or overwrite the file. See the README for precedence and legacy
environment-variable details.

Preview a migration to the new data location:

```sh
codeoutcome data migrate-legacy --dry-run
```

The apply command refuses to overwrite an existing CodeOutcome database. It
creates and verifies a pre-migration SQLite backup, migrates a separate copy,
runs `quick_check`, and retains the original legacy database:

```sh
codeoutcome data migrate-legacy
```

## Platform validation

- macOS arm64: manually validated.
- Linux x64: global package installation and CLI acceptance run on
  GitHub-hosted Ubuntu with Node.js 22.14 and 24.
- Windows: not yet validated and blocked by npm package OS metadata.

Claude Code log compatibility is synthetic-fixture tested only. Codex log
compatibility has local-log validation. Run `codeoutcome formats` for the exact
field markers and evidence level shipped in the installed version.
