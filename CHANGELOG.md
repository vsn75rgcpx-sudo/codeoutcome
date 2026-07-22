# Changelog

All notable changes to CodeOutcome are recorded here. The project follows
semantic versioning once a public release exists.

## 0.1.0-alpha.2 — 2026-07-22

First-use and distribution alpha:

- official npm package preparation with a staged 2FA approval workflow and
  GitHub Actions provenance;
- Codex-scoped `doctor` checks with clearer summaries and next actions;
- bounded 16 MiB JSONL lines and sampled append checkpoints for large logs;
- explicit Provider format/evidence reporting, with Claude Code honestly marked
  synthetic-fixture-only;
- shorter `codeoutcome test <command>` test tracking syntax;
- explicit legacy database preview, verified backup, copy migration, conflict
  refusal, and `quick_check` verification;
- an identifier-free, local voluntary feedback card with no automatic
  submission or telemetry;
- global-package acceptance on GitHub-hosted Ubuntu with Node.js 22.14 and 24.

The npm package supports macOS and Linux. Windows and real Claude Code logs are
not validated in this release. Provider formats remain unstable implementation
details, and Git/test links remain contextual rather than causal attribution.

## 0.1.0-alpha.1 — 2026-07-22

Initial source alpha:

- local-first Claude Code and Codex session import;
- canonical Token accounting with cumulative/incremental reconciliation;
- observed Git session changes without source bodies or full diffs;
- explicitly recorded aggregate test results and comparisons;
- read-only localhost Dashboard with strict privacy projection;
- deterministic synthetic Demo data, browser E2E, and accessibility checks;
- a locally verifiable single-package CLI tarball and checksum.

This is alpha software. Log formats and normalized metadata may change. The
Dashboard is local-only and read-only. There is no telemetry or cloud upload,
and the release does not claim exact AI authorship attribution. Provider formats
may change without notice. The package is not published to npm.
