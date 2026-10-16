# Performance

How the read path is measured, what it measured last, and what keeps it from regressing.

## Two guards

- **`scripts/bench.mjs`** is the timing half. It times every dashboard aggregate under three filter
  shapes (none, one model, last 30 days), plus the heaviest non-dashboard reads, against your real
  store or a seeded synthetic one. It can save the result as a JSON baseline and diff a later run
  against it. It runs locally only, because timings on a shared CI runner are too noisy to gate on.
- **`packages/server/test/query-plans.test.ts`** is the CI half. Every statement a dashboard
  aggregate runs, under each filter shape, must read `events` and `tool_calls` only through a
  covering index. Plan shape is deterministic, and on this data it is what decides speed: see
  *Why plan shape* below.

```sh
pnpm build
pnpm bench --db data/agent-lens.db                       # warm, 5 runs, median
pnpm bench --db data/agent-lens.db --cold                # evict this DB from the page cache first (Linux)
pnpm bench --synthetic 18000 --out .local/perf/synth.db  # build + bench a real-corpus-sized synthetic store
pnpm bench --db … --json .local/perf/base.json           # save a baseline
pnpm bench --db … --compare .local/perf/base.json --fail # exit 1 on a >25% (and >10ms) regression
```

`--verbose` prints the three slowest statements per case. The bench calls the query functions
directly, with no HTTP. node:sqlite is synchronous, so the server answers one request at a time,
and the dashboard's real wait is close to the **sum** of its five endpoints. That sum is reported
as `dashboard (serial)`.

Run `--cold` from a disk-backed path. A DB on tmpfs is always resident, so a "cold" number there
means nothing. Cold mode evicts before every case, which makes it a worst case: one page load
evicts once, and the later endpoints find the pages the earlier ones loaded.

## Why plan shape

An `events` row averages ~3.4 KB (raw_json + text) and a `tool_calls` row ~2.3 KB (input_json), so
about one row fits per page. A query that reads those rows, instead of an index carrying the
columns it needs, pays one random page read per row. With the pages cached that is merely slow.
After the page cache has been dropped (memory pressure, a reboot, an ingest churning the cache)
it reads close to the whole 1.7 GB table.

The dashboard joins `events` only for `timestamp` and `model`, and `tool_calls` only for a few short
columns. The covering indexes in `schema.ts` carry exactly those columns. Ingest runs `ANALYZE`
(`ANALYZE_SQL`) after each pass because without statistics the planner resolves the join through
the primary-key index and reads the row anyway.

## Baseline (2026-10-14)

Real store: 17.9k sessions, 512k events, 110k tool calls, 2.3 GB. Intel laptop, 8 cores, 45 GB RAM,
Node 24.15. Both columns were measured on fresh `.backup` copies, so file fragmentation is equal.
Times are the serial dashboard (all five endpoints), unfiltered unless noted.

| | before | after |
|---|---:|---:|
| warm, unfiltered | 2955 ms | 1363 ms |
| warm, one model | 2768 ms | 1584 ms |
| cold, unfiltered | 49.3 s | 11.3 s |
| cold, `/dashboard/time` alone | 28.5 s | 3.3 s |
| browser, cold → charts on screen | ~20 s | 7.8 s |
| browser, warm → charts on screen | 3.5 s | 2.4 s |

The index migration takes ~4 s once on the first ingest after upgrade and adds ~85 MB (~3.5%).
`ANALYZE` adds ~0.1 s per ingest.

## Ingest cost (2026-10-15)

Measured on a `.backup` copy of the real store, with a read-only connection held open the way the
server holds one. "Written" is physical (`write_bytes`), "read" includes page-cache hits (`rchar`).

| run | wall | WAL peak | written | read | peak RSS |
|---|---:|---:|---:|---:|---:|
| incremental, 5 changed files, before | 8–14 s | 16 MB | 0.1–0.4 GB | 13.5 GB | 345 MB |
| incremental, 5 changed files, after | ~3 s | 18 MB | n/a | 0.63 GB | 345 MB |
| `--full`, before | 444–458 s | 1.7 GB | 144–146 GB | 53 GB | n/a |
| `--full`, after | 301–330 s | 2.4 GB | 20 GB | 45 GB | 1.0 GB |
| `--full`, indexes built after the load | 294–395 s | 2.4 GB | 12.5–13 GB | 43 GB | 1.0 GB |
| `--full`, each turn_id written once | 347 s (vs 437 s same session) | 2.4 GB | 9.6 GB (vs 13.1) | 36 GB | 1.0 GB |
| incremental, 5 changed files, each turn_id written once | ~2 s | 5 MB (vs 11) | 18 MB (vs 47) | 0.5 GB | 310 MB |

What changed:

- **Foreign-key columns are indexed.** Deleting a row makes SQLite find the rows that reference it.
  `tool_calls.turn_id` and `token_usage.turn_id` had no index, so the incremental rebuild's
  `DELETE FROM turns` scanned both tables once per deleted turn: 12.9 GB of the 13.5 GB.
  `packages/core/test/schema-fk-indexes.test.ts` now fails on any unindexed foreign key.
- **A run is one transaction.** `--full` used to commit once per file, about 18k commits, each
  followed by a WAL checkpoint that copied the same index pages back into the main file. That was
  most of the 146 GB. One transaction also means the server keeps reading the previous state until
  the run commits, where before it saw empty and half-filled tables for minutes, and a failed run
  rolls back whole (`packages/ingest/test/full-atomic.test.ts`).
- **`--full` builds four `events` indexes and the full-text index once, after the load.** Each
  event insert used to update the row, seven indexes (two keyed on random UUIDs) and FTS, and with
  a small page cache the same index pages were written again and again: 37 GB of writes for a
  1.77 GB table. `resetSchema(db, { bulk: true })` drops what `BULK_DEFERRED` names and
  `finishBulkLoad` rebuilds it from `SCHEMA_SQL` after `rebuildDerived`. In a same-session A/B the
  old code took 460 s and wrote 20.8 GB (63 GB of write calls); the new one wrote 12.5–13 GB (25 GB)
  in 294–395 s, the wall time moving with machine load.
- **Each event's `turn_id` is written once.** An events row averages ~3.4 KB, and NULL to a value
  resizes it, so every write rewrote the whole row. Events used to be inserted with NULL, nulled
  again for the rebuild's scope, then set: twice per event of every session a run touched. Now
  `--full` inserts each event with the turn its line order implies, which is the final one for 99.4%
  of real events, and `rebuildTurns` writes only those that differ. The turn delete in between runs
  with foreign keys deferred to the commit. On a run that re-reads the whole archive through the
  incremental path, writes fell from 18.1 to 2.1 GB.
- **Turning the journal off was measured and rejected.** `journal_mode = OFF` with
  `synchronous = OFF` brings a rebuild's writes to ~13.5 GB, but SQLite refuses to leave WAL while
  the server has the store open (`database is locked`), and it gives up the rollback above.
- **A 256 MB page cache was tried and dropped.** On top of the single transaction it saved 4 s and
  3 GB of writes on `--full`, but cost 260 MB of memory there and 240 MB on incremental runs.

The WAL: SQLite reuses it from its start after each checkpoint but never shrinks it, and the
server's open connection keeps the file from being deleted when ingest closes. So it used to stay at
the largest size ever written, 1.5 GB after a `--full`. Each run now ends with a
`wal_checkpoint(TRUNCATE)`. That does not wait: if the server is mid-read it reports busy, and
`WAL_SIZE_LIMIT` (`journal_size_limit`, 64 MB) trims the file on the next run that writes. A
`--full` needs free disk of about the store's size again for the WAL while it runs.

## Serving (2026-10-15)

Real store, warm page cache, over HTTP to the running server unless noted.

| | before | after |
|---|---:|---:|
| five dashboard endpoints, one connection (direct calls) | 1.61–1.66 s | 1.28–1.36 s |
| dashboard, repeat of a URL already served (all five endpoints) | 1.46–1.89 s | 60–67 ms |
| largest session page (924 messages, 16k nodes), load to painted | 1.07–1.55 s | 0.81–0.96 s |

- **Read-connection page cache.** `openReadonly` sets 64 MB instead of SQLite's 2 MB, for ~75 MB
  of RSS. 256 MB was ~8% faster still for 225 MB.
- **Dashboard responses are kept until the store changes** (`response-cache.ts`). `PRAGMA
  data_version` changes on every commit from another connection, so the next request after an
  ingest recomputes. Only the dashboard endpoints use it; the triage store is ATTACHed and does not
  invalidate it.
- **Off-screen session messages skip layout** (`content-visibility: auto` on `.transcript .event`).
  Layout went from ~200 ms to ~50 ms. The nodes stay in the DOM, so `#ev-` links land where they
  did, and both find-in-session and the browser's find still see every message. React render, ~550
  ms of what is left, would need windowing, which those three depend on not having.
- **Not done: sending the time and audit requests after the main three.** The server answers in
  arrival order, and the main three are already sent first, so it measured no faster.
