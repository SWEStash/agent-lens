# ADR-010 — Incremental, volume-scalable ingest: stat short-circuit, dirty-session rebuild, streaming

- Status: Accepted
- Date: 2026-06-29
- Deciders: project owner
- Extends: ADR-001 (two-stage collection), ADR-003 (data model), ADR-004 (classification)

## Context

Stage 2 (`packages/ingest`) was incremental only for *raw-event writes*: events use `ON CONFLICT DO
NOTHING`, and a per-file `sha256` recorded in `ingest_state` let unchanged files be skipped. But every
launch still paid full cost in three places, so per-run time grew with the *total* archive/DB, not the
delta:

1. **I/O.** The skip check read **and hashed** every file before comparing (`index.ts`), even though
   `ingest_state` already stored `size` and `mtime_ms`. A no-op run re-read the entire mirror **and**
   every `.versions/<ts>/` snapshot — an unbounded, ever-growing set (ADR-002).
2. **Derived rebuild.** `rebuildDerived` deleted *all* turns, recomputed turns for *every* session, and
   ran full-table `UPDATE`s for turn-id propagation, subagent linkage, and session aggregates —
   regardless of what changed.
3. **Classification.** `classify` (ADR-004) reloaded the whole dataset into in-memory JS maps and
   re-derived every session each run.

Empirically (628 sessions / 68 k events / 636 files) a no-op run took ~32 s and held the full dataset
in memory. This does not scale as history accumulates.

The archive is the source of truth and the DB is a derived projection (ADR-001), which gives us a free
fallback: anything incremental can be made *exactly* correct by a full rebuild (`--full`).

## Decision

Make per-launch cost scale with the **delta**, via three changes. `--full` keeps the global path
unchanged (drop + re-read archive), so it remains the correctness backstop and migration path.

1. **Stat short-circuit (impact 1).** `getState` returns `size, mtime_ms, sha256`. The loop `stat`s
   first; if `size` **and** `mtime_ms` match `ingest_state`, the file is skipped without being read or
   hashed. Only on a mismatch is the file read + hashed; if the hash still matches (content unchanged,
   mtime moved), the row's mtime is refreshed so the next run short-circuits on `stat` alone. Unchanged
   files now cost one `stat`.

2. **Dirty-session derived rebuild (impacts 2, 3).** The ingest loop collects the set of session ids
   whose files were actually (re)ingested this run. `rebuildDerived(db, dirty)` and `classify(db, …)`
   restrict every statement to that set (materialized as a `temp._dirty` table; better-sqlite3 cannot
   bind arrays, and a temp table keeps the joins index-friendly at any set size).

   Because subagent linkage is **cross-session** — a parent session's `Task`/`Agent` `tool_call` links
   to a child sidechain session that lives in a *separate* file — the dirty set is first **fixpoint-
   expanded** to its linkage neighborhood: a dirty parent pulls in the children it spawned, and a dirty
   child pulls in its spawner parent. This keeps `sessions.parent_session_id` / `parent_turn_id` correct
   even when parent and child transcripts arrive in **different** ingest runs. `rebuildDerived` returns
   the expanded id set so `classify` reuses it without re-expanding.

   The FTS invariant is preserved: nulling/repopulating `events.turn_id` does not touch `events.text`,
   so the `events_au` trigger (guarded `WHEN old.text IS NOT new.text`) does not re-index FTS.

3. **Streaming large files (impact 4).** Files `> 8 MB` are read with a synchronous chunked reader
   (`fileread.ts`: 64 KB `readSync` loop, incremental SHA-256, `StringDecoder` for multibyte chars at
   chunk boundaries) that yields lines lazily, so ingest memory is bounded regardless of transcript
   size. Smaller files keep the whole-file `readFileSync` fast path. `ingestFile` now consumes an
   `Iterable<string>` of lines, so the engine never holds the full file as one string. The streaming
   hash is byte-identical to hashing a `readFileSync` buffer, so the skip check is path-independent.

## Consequences

- No-op runs drop from O(total) to ~O(file count): measured **~32 s → ~0.3 s** on the current corpus.
- Incremental rebuild touches only changed sessions + their linkage neighborhood; classification memory
  and work track the delta. The derived-rebuild write transaction is correspondingly shorter, reducing
  the WAL write-lock window seen by the read-only server.
- `--full` is unchanged and remains correct/complete; any doubt about incremental state is resolved by
  one `--full`. The incremental report's `classified=N` now reflects sessions *re-derived this run*,
  not the DB total (the other counts remain totals).
- More moving parts in `rebuildDerived`/`classify` (the `temp._dirty` scoping and expansion), justified
  by the scaling win and covered by tests (cross-run linkage expansion is the headline case).

## Alternatives considered

- **Strict dirty set, no linkage expansion.** Smallest code, but leaves subagent linkage stale when a
  parent and its child transcript land in different runs (only self-healing on the next `--full`).
  Rejected: silent staleness in the UI is worse than one extra bounded query.
- **Keep a global cross-session linkage pass each run.** Simpler than expansion, but reintroduces an
  O(total) step. Rejected once fixpoint expansion proved small and self-contained.
- **Always stream every file.** Uniform code, but adds per-file overhead to the common small-file case
  for no memory benefit. Rejected in favor of an 8 MB threshold.
- **Track dirty sessions in a persisted column/table.** Unnecessary — the touched-session set is a
  byproduct of the ingest loop; each `.jsonl` maps to exactly one session id.
