# Agent Lens

Local-only tooling that **passively collects, browses, and analyzes Claude Code CLI session
traces**. It never sends trace data off your machine.

Claude Code records rich per-session telemetry under `~/.claude/` but prunes it on a rolling
**30-day window**. Agent Lens continuously copies that data out before it's lost, normalizes it into
a queryable store, and gives a senior SWE a browsable transcript viewer plus performance dashboards
(tokens/cost, duration, task category/complexity, code impact, skills, model usage).

## Status

Early, built incrementally. Decisions are recorded as ADRs in
[`docs/decisions/`](docs/decisions/); the phased plan lives in `.local/` (gitignored).

- **Phase 0** — workspace scaffold + ADRs ✅
- **Phase 1** — passive collection (rsync + user systemd timer) ✅
- **Phase 2** — ingest/normalize into SQLite ✅
- **Phase 3** — browse webapp (localhost: list, filters, FTS search, transcript viewer, MD export) ✅
- **Phase 4** — dashboards + heuristic metrics ✅
- **Phase 5** — extensibility hardening + packaging — _next_

## Architecture (two stages)

```
sources (per label)                     archive (per label)
  personal: ~/.claude  ─┐                ┌─ data/archive/personal/ ─┐
  work:     ~/.claude2 ─┼─ Stage 1 ────▶ ┼─ data/archive/work/ ─────┼─ Stage 2 ─▶ SQLite + FTS5
  …                     ┘   rsync,timer  └─ …                       ┘   ingester        │
                                                                browse webapp + dashboards (127.0.0.1)
```

- **Sources.** Each local agent account is a labeled *source* (`label` + `configDir`), declared in
  `agent-lens.config.json`. Multiple Claude accounts (or, later, other agents) coexist; sessions are
  tagged with their source so you can filter/compare. The same resolver feeds both stages.
- **Stage 1 (collection)** is dumb, safe, and frequent — per source it only copies files, never
  deletes, and keeps the longest-seen version of each transcript plus divergence backups.
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

# Configure sources (which agent accounts to collect). Defaults to one: personal -> ~/.claude
cp agent-lens.config.example.json agent-lens.config.json   # then edit: add a label + configDir per account

# Stage 1 — collection. Install the user systemd timer (runs a few times a day, even logged out)
scripts/setup-systemd.sh install
# ...or run a collection pass manually:
scripts/collect.sh

# Stage 2 — ingest the archive into data/agent-lens.db (incremental; --full rebuilds)
pnpm ingest            # or: node packages/ingest/dist/index.js [--full]

# Stage 3 — browse: serve the webapp on 127.0.0.1 and open it
pnpm serve             # -> http://127.0.0.1:4477  (set AGENT_LENS_PORT to change)
# UI dev with hot reload (proxies /api to the running server): pnpm web:dev
```

Both collection and ingest are local-only and idempotent. Ingest skips unchanged files; `--full`
re-derives everything from the archive. The server is read-only and binds `127.0.0.1` only. See
`scripts/collect.sh --help` and the ADRs in [`docs/decisions/`](docs/decisions/).

## Documentation

- **[docs/USAGE.md](docs/USAGE.md)** — full operations guide: configuring sources, the three stages,
  daily loop, environment variables, HTTP API, troubleshooting.
- **[docs/decisions/](docs/decisions/)** — Architecture Decision Records (tracked in git).

## Requirements

- Linux (developed against Ubuntu 24.04 LTS+)
- `rsync` 3.x, `systemd` (user instance), `node` >= 22, `pnpm`

## Layout

```
packages/core     shared types + SQLite schema (agent-agnostic)
packages/ingest   Stage-2 parser; ClaudeCodeAdapter (extensible to other agents)
packages/server   localhost API over the store
packages/web      Vite + React SPA (browse + dashboards)
scripts/          collect.sh, setup-systemd.sh, sources.mjs (canonical source resolver)
systemd/          user service + timer units
agent-lens.config.json          sources to collect (gitignored; copy from .example)
data/             archive/<label>/ + agent-lens.db — collected data (contents gitignored; .gitkeep tracked)
docs/decisions/   Architecture Decision Records (ADRs, tracked)
.local/           phased plans (gitignored)
```
