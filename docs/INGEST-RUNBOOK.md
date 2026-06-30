# Agent Lens — Ingest Runbook

Operational procedures for Stage 2 (ingest). For the conceptual design see
[ARCHITECTURE.md](ARCHITECTURE.md); for first-time setup, source config, and the env-var reference see
the [Operations Guide](USAGE.md). This runbook covers running, migrating, and troubleshooting ingest.

## How ingest runs

- **Scheduled.** The `agent-lens-collect.timer` user unit fires a oneshot `agent-lens-collect.service`
  that runs **`collect.sh` then `ingest.sh`** in sequence (collect must succeed first). Default
  schedule: `09,13,17,21:00` daily. See [USAGE.md → Stage 1](USAGE.md#stage-1--collect).
- **Manual.** `pnpm ingest` (incremental) or `pnpm ingest --full` (rebuild). Direct:
  `node packages/ingest/dist/index.js [--full] [--db <path>] [--archive <path>]`.
- **Inputs.** Reads `data/archive/` (the mirror + `.versions/` snapshots), writes `data/agent-lens.db`.
  Overridable via `AGENT_LENS_DATA`, `AGENT_LENS_ARCHIVE`, `AGENT_LENS_DB`
  ([env table](USAGE.md#environment-variables)). The archive is read-only to ingest — it is never
  mutated, so any run is safe to repeat.

A run prints: `files / skipped / new_events / malformed` (plus `excluded_pruned=N` when an excluded
project's sessions were removed — see *Excluding projects* in USAGE.md), then `sessions / turns /
events / tool_calls / classified`, then `tokens / est_cost / db`.

## Incremental vs. `--full`

| | Incremental (default) | `--full` |
|---|---|---|
| Files read | only changed (stat short-circuit) | every file |
| Derived rebuild | touched sessions + linkage neighborhood | all sessions |
| Schema | applied if missing (no column changes) | **drop + recreate** |
| Use for | the normal scheduled loop | migrations, parser/classifier changes, recovery |

Incremental is correct for new/changed transcripts. It deliberately does **not** rewrite existing rows
to reflect changed parser/classifier *logic* — use `--full` for that.

### When to run `--full`

- After a **`SCHEMA_VERSION` bump** (e.g. the ADR-011 BLOB migration — see below).
- After changing **parser or classifier** logic and you want it applied to all history.
- To **recover** from any suspected derived-table inconsistency — the archive is the source of truth, so
  `--full` re-derives a clean DB.

### ADR-011 compression migration (one-time)

`raw_json` is stored gzip-compressed as a BLOB ([ADR-011](decisions/ADR-011-compressed-raw-json.md)). On
upgrading to `SCHEMA_VERSION ≥ 5`, run once:

```bash
pnpm build
pnpm ingest --full     # drops, recreates with BLOB column, re-reads archive, compresses raw_json
```

A not-yet-migrated DB keeps working (the reader decodes legacy plain rows via `unpackRaw`), but stays
uncompressed until `--full` runs. Expect a sizeable DB shrink (~40% on a typical corpus).

## Verifying a run

- **No-op is fast.** A second consecutive run should report `skipped ≈ files`, `new_events=0`, and
  finish in well under a second (stat short-circuit + empty dirty set, per ADR-010).
- **Compression in effect.** `raw_json` should be a BLOB of gzip bytes:
  ```bash
  sqlite3 data/agent-lens.db "SELECT typeof(raw_json), length(raw_json) FROM events LIMIT 1;"
  ```
  (`blob`, and smaller than the original line). The transcript view in the web UI rendering text/thinking
  confirms the read path decodes correctly.
- **Tests.** `pnpm test` exercises incremental rebuild, cross-run subagent linkage, streaming parity, and
  the compression round-trip.

## Troubleshooting

- **`archive not found`** — Stage 1 hasn't run. Run `pnpm collect` (or the systemd unit) first.
- **`malformed=N` in the report** — N JSONL lines failed to parse and were skipped; the rest ingested.
  A handful is normal (partial last lines). A spike suggests a corrupt archive file — inspect it; the
  archive can be re-synced from source since collection is append-only.
- **A "phantom" empty session appears** — non-transcript `.jsonl` files under `projects/` (e.g. a
  Workflow `journal.jsonl`, whose lines carry no `uuid`) create a zero-event stub; `rebuildDerived`
  prunes any session with `event_count = 0`. If one persists, run `pnpm ingest --full`.
- **Subagent shows no parent (stale linkage)** — can happen transiently if a parent and its child
  transcript arrive in different runs; the dirty-set linkage expansion (ADR-010) fixes it on the run that
  ingests the second half. To force resolution now, run `pnpm ingest --full`.
- **`database is locked` / `SQLITE_BUSY`** — a checkpoint contended with the long-lived server reader.
  Rare with WAL and short incremental transactions; retry, or stop the server (`serve.sh`) during a
  `--full` rebuild.
- **Re-ingest didn't pick up a parser/classifier change** — expected; use `pnpm ingest --full`.
- **Recover from anything** — delete `data/agent-lens.db*` and run `pnpm ingest --full`; the archive
  rebuilds the DB completely.
