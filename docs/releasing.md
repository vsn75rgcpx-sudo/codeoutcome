# npm release process

The public npm package is built from this repository and staged for explicit
2FA approval. Never publish from an uncommitted working tree and never add a
long-lived npm token to source control.

## Release gate

1. Confirm the version in package manifests and `CODEOUTCOME_VERSION`.
2. Run `pnpm install --frozen-lockfile`, all quality checks, E2E, package pack,
   package inspection, package install smoke, and `package:publish-audit`.
3. Merge only after Linux CI succeeds.
4. Create and push an annotated matching tag such as `v0.1.0-alpha.2`.
5. Dispatch `.github/workflows/npm-stage.yml` against that tag.
6. Download and inspect the staged package, then approve it on npm with 2FA.
7. Verify registry metadata, provenance, signature audit, global installation,
   doctor, import, usage, feedback, and Dashboard startup.

The workflow has only `contents: read` and `id-token: write`. Provenance is
generated on a GitHub-hosted runner and links the public source commit. Initial
publication may require a short-lived granular npm token stored only as the
`NPM_TOKEN` GitHub secret. Remove that secret after the first staged release,
configure `npm-stage.yml` as the package's trusted publisher, allow only staged
publishing, and disallow traditional publish tokens when npm settings permit.

Staging is not publication. A maintainer must inspect and approve the staged
artifact with 2FA before the version becomes installable. A published name and
version cannot be reused, even after unpublish, so the version is checked before
staging.
