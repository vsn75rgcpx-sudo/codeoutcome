# Architecture

AgentLedger keeps provider parsing independent from storage and presentation:

```text
Claude Code logs -> Claude adapter --+
                                      +-> core collector -> Git enrichment
Codex logs ------> Codex adapter -----+                         |
                                                               v
                                                        SQLite metadata
                                                               |
                                                        CLI reports
```

## Packages

- `packages/shared`: normalized `Session` contract and read-only JSONL helpers.
- `packages/adapters/claude-code`: Claude Code discovery and parsing only.
- `packages/adapters/codex`: Codex discovery and parsing only.
- `packages/core`: adapter orchestration and per-file error isolation.
- `packages/database`: SQLite schema, metadata upserts, and integrity checks.
- `packages/git-tracker`: read-only repository and branch enrichment.
- `apps/cli`: `doctor`, `sessions`, and `usage` commands.

## Next phase candidates

1. Versioned parser compatibility fixtures for additional log variants.
2. Incremental indexing based on file identity and byte offsets.
3. Explicit retention and metadata deletion commands.
4. Configurable, versioned pricing tables with provenance.
5. More CLI filters and export formats before considering any graphical UI.
