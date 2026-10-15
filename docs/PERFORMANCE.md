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

## Baseline — 2026-10-14

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

## Ingest write volume and the WAL — 2026-10-15

Measured on a `.backup` copy of the real store, with a read-only connection held open the way the
server holds one:

| run | wall | WAL peak | written (`write_bytes`) | read (`rchar`) |
|---|---:|---:|---:|---:|
| incremental, nothing new | 2.3 s | 0 | 0 | 0.4 GB |
| incremental, 5 changed files | 10–14 s | 16 MB | 0.1–0.4 GB | 13.5 GB |
| `--full` | 458 s | 1.7 GB | 144 GB | 53 GB |

SQLite reuses the WAL from its start after each checkpoint but never shrinks the file. The server's
open connection also keeps the file from being deleted when ingest closes. So the WAL stayed at the
size of the largest write ever made, which was the 1.5 GB a `--full` rebuild left behind.
`WAL_SIZE_LIMIT` (`packages/ingest/src/db.ts`) sets `journal_size_limit`, so the first ingest that
writes after a checkpoint cuts the WAL back to 64 MB. On the copy above, one incremental took it
from 1.3 GB to 64 MB. An ingest that writes nothing leaves the file as it is.

The read column is the open item. An incremental that re-reads five files still reads ~13.5 GB
through the page cache.
