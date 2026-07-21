import { DatabaseSync } from "node:sqlite";

import { SessionDatabase } from "@agentledger/database";

export function createDashboardTestDatabase(databaseFile: string): void {
  new SessionDatabase(databaseFile).close();
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    PRAGMA foreign_keys=ON;
    INSERT INTO repositories
      (id, canonical_path, name, remote_url, first_seen_at, last_seen_at)
      VALUES (1, '/private/test-repo', 'test-repo', NULL,
        '2026-07-20T00:00:00.000Z', '2026-07-20T01:00:00.000Z');
    INSERT INTO sessions (
      id, provider, provider_session_id, model, started_at, ended_at,
      working_directory, repository_id, repository_path, branch,
      input_tokens, output_tokens, cached_input_tokens, estimated_cost,
      source_file, source_file_hash, imported_at, accounting_method,
      accounting_status, accounting_version, uncached_input_tokens,
      last_usage_event_at
    ) VALUES (
      'session-1', 'codex', 'provider-1', 'gpt-test',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:10:00.000Z',
      '/private/test-repo', 1, '/private/test-repo', 'main',
      100, 10, 20, NULL, '/private/source.jsonl', 'hash',
      '2026-07-20T00:11:00.000Z', 'cumulative_snapshot', 'verified',
      'test-v1', 80, '2026-07-20T00:09:00.000Z'
    );
    INSERT INTO git_snapshots (
      id, repository_id, captured_at, trigger, privacy_mode,
      working_directory, head_commit, branch, is_detached_head,
      is_unborn_branch, is_dirty, staged_file_count, unstaged_file_count,
      untracked_file_count, conflicted_file_count, ahead_count, behind_count,
      git_version
    ) VALUES
      ('start', 1, '2026-07-20T00:00:00.000Z', 'tracking_start',
       'git-metadata', '/private/test-repo',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'main', 0, 0, 0,
       0, 0, 0, 0, 0, 0, 'fixture'),
      ('end', 1, '2026-07-20T00:12:00.000Z', 'tracking_end',
       'git-metadata', '/private/test-repo',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'main', 0, 0, 1,
       0, 1, 0, 0, 0, 0, 'fixture');
    INSERT INTO git_file_stats (
      id, snapshot_id, relative_path, previous_path, change_type, area,
      additions, deletions, is_binary, content_fingerprint, path_fingerprint
    ) VALUES ('file', 'end', 'src/artificial.ts', NULL, 'modified',
      'unstaged', 2, 1, 0, NULL, 'path-hash');
    INSERT INTO tracking_runs (
      id, provider, label, working_directory, repository_id, started_at,
      ended_at, status, start_snapshot_id, end_snapshot_id, linked_session_id,
      link_confidence, link_confidence_level, link_method, link_reasons_json,
      summary_json, warnings_json, created_at, updated_at
    ) VALUES ('tracking-1', 'codex', 'test tracking', '/private/test-repo', 1,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:12:00.000Z', 'completed',
      'start', 'end', 'session-1', 0.9, 'high', 'automatic',
      '["test association"]', '{"filesChanged":1,"additions":2,"deletions":1}',
      '[]', '2026-07-20T00:00:00.000Z', '2026-07-20T00:12:00.000Z');
    INSERT INTO test_runs (
      id, tracking_run_id, session_id, repository_id, working_directory,
      started_at, ended_at, duration_ms, stage, framework, framework_version,
      executable, command_display, command_fingerprint, argument_count,
      exit_code, termination_signal, status, outcome, total_tests, passed_tests,
      failed_tests, skipped_tests, todo_tests, errored_tests, parser_status,
      parser_version, output_truncated, source, warnings_json, created_at, updated_at
    ) VALUES
      ('baseline', 'tracking-1', 'session-1', 1, '/private/test-repo',
       '2026-07-20T00:02:00.000Z', '2026-07-20T00:02:01.000Z', 1000,
       'baseline', 'pytest', NULL, 'pytest', 'pytest -q', 'same', 1, 1, NULL,
       'completed', 'failed', 1, 0, 1, 0, 0, 0, 'parsed', 'test-v1', 0,
       'wrapped_command', '[]', '2026-07-20T00:02:00.000Z',
       '2026-07-20T00:02:01.000Z'),
      ('final', 'tracking-1', 'session-1', 1, '/private/test-repo',
       '2026-07-20T00:09:00.000Z', '2026-07-20T00:09:01.000Z', 1000,
       'final', 'pytest', NULL, 'pytest', 'pytest -q', 'same', 1, 0, NULL,
       'completed', 'passed', 1, 1, 0, 0, 0, 0, 'parsed', 'test-v1', 0,
       'wrapped_command', '[]', '2026-07-20T00:09:00.000Z',
       '2026-07-20T00:09:01.000Z');
  `);
  database.close();
}
