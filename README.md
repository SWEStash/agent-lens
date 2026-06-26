# Agent Lens

Local-only tooling that **passively collects, browses, and analyzes Claude Code CLI session
traces**. It never sends trace data off your machine.

Claude Code records rich per-session telemetry under `~/.claude/` but prunes it on a rolling
**30-day window**. Agent Lens continuously copies that data out before it's lost, normalizes it into
a queryable store, and gives a senior SWE a browsable transcript viewer plus performance dashboards
(tokens/cost, duration, task category/complexity, code impact, skills, model usage).

## Status

Early, built incrementally. See the phased plan and decisions in `.local/` (gitignored).

- **Phase 0** — workspace scaffold + ADRs ✅
- **Phase 1** — passive collection (rsync + user systemd timer) ✅
- **Phase 2** — ingest/normalize into SQLite ✅
- **Phase 3** — browse webapp (localhost) — _next_
- **Phase 4** — dashboards + heuristic metrics
- **Phase 5** — multi-agent extensibility + packaging

## Architecture (two stages)

```
~/.claude/projects/*  ──Stage 1: rsync (timer)──▶  data/archive/  ──Stage 2: ingester──▶  SQLite + FTS5
                                                                                                   │
                                                                  browse webapp + dashboards (127.0.0.1)
```

- **Stage 1 (collection)** is dumb, safe, and frequent — it only copies files, never deletes, and
  keeps the longest-seen version of each transcript plus divergence backups.
- **Stage 2 (ingest)** is re-runnable — a parser change never loses data because the raw archive is
  the source of truth.

## Privacy

- Data is copied only between local paths; nothing is uploaded.
- The collector **excludes secrets** (e.g. `~/.claude/.credentials.json`).
- The webapp binds to `127.0.0.1` only.
- The `data/` store is as sensitive as the originals — its contents are gitignored and stay on your machine.

## Quick start

```bash
pnpm install && pnpm -r build

# Stage 1 — collection. Install the user systemd timer (runs a few times a day, even logged out)
scripts/setup-systemd.sh install
# ...or run a collection pass manually:
scripts/collect.sh

# Stage 2 — ingest the archive into data/agent-lens.db (incremental; --full rebuilds)
pnpm ingest            # or: node packages/ingest/dist/index.js [--full]
```

Both stages are local-only and idempotent. Ingest skips unchanged files; `--full` re-derives
everything from the archive. See `scripts/collect.sh --help` and the ADRs in `.local/decisions/`.

## Requirements

- Linux (developed against Ubuntu 24.04 LTS+)
- `rsync` 3.x, `systemd` (user instance), `node` >= 22, `pnpm`

## Layout

```
packages/core     shared types + SQLite schema (agent-agnostic)
packages/ingest   Stage-2 parser; ClaudeCodeAdapter (extensible to other agents)
packages/server   localhost API over the store
packages/web      Vite + React SPA (browse + dashboards)
scripts/          collect.sh, setup-systemd.sh
systemd/          user service + timer units
data/             archive/ + agent-lens.db — collected data (contents gitignored; .gitkeep tracked)
.local/           decisions/ (ADRs), plans  (gitignored)
```
