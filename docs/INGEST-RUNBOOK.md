# Ingest runbook

How to run, rebuild, and troubleshoot ingest. The design is in [ARCHITECTURE.md](ARCHITECTURE.md);
setup and the environment variables are in the [usage guide](USAGE.md).

## How ingest runs

- **Scheduled.** `agent-lens service install collector` runs `collect --then-ingest` at 9, 13, 17,
  and 21 by default. Ingest runs only if collect succeeds. See [Collect](USAGE.md#collect).
- **By hand.** `agent-lens ingest`, or `agent-lens ingest --full` to rebuild. From a checkout:
  `node packages/ingest/dist/index.js [--full] [--db <path>] [--archive <path>]`.
- **Inputs and outputs.** Ingest reads `<dataDir>/archive/` (transcripts and `.versions/` snapshots)
  and writes `<dataDir>/agent-lens.db`. `AGENT_LENS_DATA` moves both; `AGENT_LENS_DB` or the config's
  `db` moves only the store. The archive has no setting of its own (ADR-021); `--archive` reads a
  copied archive for one run. Ingest never modifies the archive, so every run is safe to repeat.

Each run prints, in order:

1. `files`, `skipped`, `new_events`, `malformed`, and `excluded_pruned=N` when
   [excluded](USAGE.md#exclude-projects) sessions were removed.
2. `sessions`, `turns`, `events`, `tool_calls`, `classified`.
3. One line each for `workflow_results`, `session_meta`, and `tool_results`, with their own
   `upserted`, `skipped`, and `malformed` counts.
4. `tokens`, `est_cost`, `db`.
5. `unpriced=N model(s): …`, only when some model has usage but no price. `est_cost` leaves those
   out, so treat it as a lower bound until you [add a rate](USAGE.md#model-pricing).

## Incremental or `--full`

| | Incremental (default) | `--full` |
|---|---|---|
| Files read | only changed ones | all |
| Derived tables rebuilt | touched sessions and their linked sessions | all |
| Schema | created if missing; columns never change | dropped and recreated |
| What the server sees during the run | the previous state until commit | the same: one transaction, so a failed run leaves the old store |
| Free disk needed | little | about the size of the store, for the WAL |
| Use it for | the normal schedule | migrations, parser or classifier changes, recovery |

Incremental runs are correct for new and changed transcripts, but they don't rewrite existing rows
when parser or classifier logic changes. Run `--full` for that.

### When to run `--full`

- After a `SCHEMA_VERSION` change that alters existing tables. Examples: v5 compresses `raw_json`
  (below), v13 adds `tool_calls.error_type`
  ([ADR-019](decisions/ADR-019-tool-error-observability.md)), and v15 moves reasoning into
  `events.thinking` ([ADR-031](decisions/ADR-031-transcript-text-is-stored.md)); until you rebuild,
  transcripts show no reasoning. v16 links continued sessions and stops charging their copied
  history twice ([ADR-038](decisions/ADR-038-shared-session-history.md)); the rebuild also removes
  rows a v15 store already double-counted. v17 adds how each tool call was approved
  ([ADR-040](decisions/ADR-040-tool-call-permission-decisions.md)); until you rebuild, every call
  shows "not recorded". v18 adds the PRs and pushed branches each session recorded
  ([ADR-041](decisions/ADR-041-session-pr-and-branch-links.md)); until you rebuild, sessions list none.
- After a parser or classifier change that should apply to all history. This includes the ADR-019
  fix that maps a tool result's `is_error` to `status='error'`.
- To recover from any doubt about derived tables. The archive rebuilds a clean store.

### Compressing `raw_json` (one time)

`raw_json` is stored as a gzip BLOB ([ADR-011](decisions/ADR-011-compressed-raw-json.md)). When
upgrading to `SCHEMA_VERSION` 5 or later, run `agent-lens ingest --full` once. Until then the store
still works, uncompressed. Expect it to shrink by about 40%.

## Checking a run

- **A run with nothing new is fast.** A second run in a row reports `skipped` close to `files`,
  `new_events=0`, and finishes in well under a second.
- **Compression is on.** This should print `blob` and a length smaller than the original line:
  ```bash
  sqlite3 data/agent-lens.db "SELECT typeof(raw_json), length(raw_json) FROM events LIMIT 1;"
  ```
  A clean `--full` run also proves decoding works, since it reads every archived line back.
- **Tests.** `pnpm test` covers incremental rebuilds, subagent linkage across runs, streaming, and
  the compression round trip.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `archive not found` | Collect hasn't run. Run `agent-lens collect` first |
| `malformed=N` | N lines didn't parse and were skipped. A few is normal (a partial last line). A spike suggests a corrupt archive file; inspect it |
| An empty "phantom" session | A non-transcript `.jsonl` under `projects/` (such as a workflow `journal.jsonl`) made an empty stub. Ingest removes sessions with no events; if one stays, run `--full` |
| A subagent has no parent | The parent and child arrived in different runs. The run that ingests the second one links them, or run `--full` now |
| `the run would leave rows pointing at missing parents` | Ingest found a row whose parent is missing and rolled back the whole run; nothing was written. The message names the table, the missing keys and the archive files involved. It is an ingest bug: report it with those lines. Until it is fixed every run fails the same way, so adding the named project to `exclude` is the stopgap |
| `FOREIGN KEY constraint failed` at `COMMIT`, nothing else | A build older than schema v16, which did not check before committing. Upgrade; the new message names the rows |
| `database is locked` or `SQLITE_BUSY` | Another writer, such as a second ingest, holds the lock. The server only reads. Wait and retry |
| A parser or classifier change didn't apply | Expected for incremental runs. Run `--full` |
| Anything else | Delete `<dataDir>/agent-lens.db*` and run `agent-lens ingest --full`. The archive rebuilds everything |
