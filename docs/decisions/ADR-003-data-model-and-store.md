# ADR-003 — Agent-agnostic normalized data model in SQLite + FTS5, adapter pattern

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner

## Context

We start with Claude Code but must stay extensible to other agents (NFR). Dashboards need analytical
queries over time; the browser needs full-text search over transcripts. Single local user.

## Decision

- **Store:** a single SQLite database file (`data/agent-lens.db`) accessed via `better-sqlite3`
  (synchronous, fast, zero-server). FTS5 virtual table for transcript search.
- **Model:** normalized, **agent-agnostic** hierarchy `agents → projects → sessions → turns → events`,
  with `tool_calls`, `token_usage`, `classifications`, and `ingest_state`. Every transcript line is an
  `event` keyed by stable `uuid` (the dedup/UPSERT key). `raw_json` preserves each line verbatim for
  lossless re-derivation. See `packages/core/src/schema.ts`.
- **Extensibility:** a `SourceAdapter` interface (`discover()` → files, `parse(file)` → normalized
  rows). `ClaudeCodeAdapter` is the first implementation; another agent = another adapter, no schema
  change.

## Consequences

- Excellent analytical-query ergonomics for one local user; no DB server to operate.
- Agent-specific quirks are isolated in adapters, not leaked into the schema.
- SQLite single-writer is fine (one ingester). Concurrent heavy writes are not a goal.

## Alternatives considered

- **DuckDB.** Stronger OLAP, but heavier for embedded transactional upserts + FTS; SQLite is enough at
  this scale and pairs naturally with the TS/Node stack (ADR-006).
- **Flat files / Parquet.** Poor for interactive filtered browsing + FTS. Rejected.
