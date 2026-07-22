# Fixtures

Every fixture in this directory is synthetic and redacted. Never place a real
Claude Code or Codex session log here. The repository ignores JSONL files by
default and only allows these reviewed fixture directories.

`test-results/` contains hand-authored aggregate JUnit, pytest JSON, Jest JSON,
and Vitest JSON examples. Test names and paths are synthetic; CodeOutcome uses
only aggregate counts and never persists case names or failure bodies.
