# ADR-001 — Two-stage collection: raw archive + re-runnable parser

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner

## Context

Claude Code writes session traces to `~/.claude/projects/**.jsonl` and prunes them on a rolling
30-day window. We must (a) never lose traces and (b) turn them into queryable insight. Parsing logic
will keep changing as we add metrics; collection logic should not.

## Decision

Separate the system into two independent stages:

1. **Stage 1 — Collection.** A dumb, frequent, append-only copy of the raw files into `data/archive/`.
   No parsing, no transformation, no deletion. Its only job is that data is never lost.
2. **Stage 2 — Ingest.** A re-runnable parser that reads the archive and (re)builds the normalized
   SQLite store. The archive is the source of truth; the database is a derived projection.

## Consequences

- A parser bug can never lose data — re-run Stage 2 against the untouched archive.
- Metrics/classification can be improved retroactively over all historical data.
- Two moving parts instead of one; the archive duplicates the on-disk footprint of the originals
  (acceptable: ~185 MB today, and it is the price of durability). Retention policy: see ADR-005.

## Alternatives considered

- **Single pass (parse on collect).** Simpler, but a parser change forces re-collection, which is
  impossible for already-pruned sessions. Rejected.
