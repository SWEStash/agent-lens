# Agent Lens — Operations Guide

How to run the tool day to day. Agent Lens is a three-stage local pipeline:
**collect → ingest → browse**. Nothing leaves your machine.

```
sources (agent accounts)   Stage 1            Stage 2              Stage 3
  personal: ~/.claude  ──▶  collect.sh   ──▶  ingest        ──▶   serve (127.0.0.1)
  work:     ~/.claude2      (rsync/timer)     (SQLite)            browse + search + export
```

## Requirements

- Linux (developed on Ubuntu 24.04 LTS+)
- `rsync` 3.x, `systemd` (user instance), `node` >= 22, `pnpm`

## Install

```bash
cd /home/m4pre/git-projects/swestash/agent-lens
pnpm install
pnpm -r build
```

## Configure sources (which agent accounts to collect)

A **source** is a labeled agent instance: a `label` + the agent's `configDir`. Multiple local
accounts coexist; each is collected and tagged separately so you can filter/compare in the UI.

```bash
cp agent-lens.config.example.json agent-lens.config.json   # if not already present
```

```jsonc
// agent-lens.config.json  (gitignored — machine-specific)
{
  "sources": [
    { "label": "personal", "agent": "claude-code", "configDir": "~/.claude" },
    { "label": "work",     "agent": "claude-code", "configDir": "~/.config/claude-work" }
  ]
}
```

- `label` must be unique (it names the archive subdir and the UI source filter).
- `configDir` accepts `~` and `$HOME`.
- `agent` is `claude-code` (the only adapter today).

Verify what will be collected:

```bash
node scripts/sources.mjs        # prints: label <TAB> agent <TAB> configDir
```

## Stage 1 — Collect

Copies each source's transcripts into `data/archive/<label>/` before Claude Code prunes them
(rolling 30-day window). Never deletes, never copies secrets, keeps divergence/compaction backups
in `.versions/`.

```bash
scripts/collect.sh              # run one pass now
```

Run it automatically with a **user systemd timer** (a few times a day, even when logged out):

```bash
scripts/setup-systemd.sh install     # install + enable + start + enable-linger
scripts/setup-systemd.sh status      # show next scheduled run
scripts/setup-systemd.sh uninstall   # stop & remove the timer (archive untouched)
```

The schedule (09:00/13:00/17:00/21:00, with catch-up) lives in
`systemd/agent-lens-collect.timer`.

## Stage 2 — Ingest

Parses the archive (mirror **and** `.versions/` backups, deduped by event `uuid`) into
`data/agent-lens.db`.

```bash
pnpm ingest            # incremental — skips files unchanged since last run
pnpm ingest --full     # wipe and re-derive everything from the archive
```

Use `--full` after changing parser/classifier logic (an incremental run won't rewrite existing
rows). The archive is the source of truth, so rebuilding the DB is always safe.

It prints a summary: `files / skipped / new_events`, then `sessions / turns / events / tool_calls`,
then `tokens / est_cost`.

## Stage 3 — Browse

```bash
pnpm serve             # → http://127.0.0.1:4477   (read-only, loopback only)
```

Open the URL. You can:

- **Filter** sessions by source, model, and kind (main vs subagent).
- **Full-text search** across all transcripts.
- Open a session for the **transcript viewer**: turn-segmented, collapsible thinking, expandable
  tool calls, model/subagent tags.
- **Export** any session to Markdown (⬇ button, or `GET /api/sessions/:id/export.md`).

UI development with hot reload (proxies `/api` to the running server):

```bash
pnpm web:dev           # http://127.0.0.1:5173
```

## Typical daily loop

The timer collects in the background. To look at the latest:

```bash
pnpm ingest && pnpm serve
```

## Adding another account

1. Add an entry to `agent-lens.config.json` (`label` + `configDir`).
2. `scripts/collect.sh && pnpm ingest`.
3. It appears as a new **source** filter in the UI.

## Reference

### Environment variables

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `AGENT_LENS_DATA` | `<repo>/data` | all | base dir for archive + DB |
| `AGENT_LENS_ARCHIVE` | `$AGENT_LENS_DATA/archive` | collect, ingest | archive location |
| `AGENT_LENS_DB` | `$AGENT_LENS_DATA/agent-lens.db` | ingest, server | SQLite path |
| `AGENT_LENS_CONFIG` | `<repo>/agent-lens.config.json` | collect, ingest | sources config path |
| `AGENT_LENS_PORT` | `4477` | server | HTTP port |
| `AGENT_LENS_HOST` | `127.0.0.1` | server | bind host (loopback) |
| `AGENT_LENS_ALLOW_NONLOCAL` | _(unset)_ | server | required to bind a non-loopback host |
| `CLAUDE_DIR` | _(unset)_ | collect, ingest | legacy single-source override |

### Paths

| Path | Contents | Tracked? |
|---|---|---|
| `data/archive/<label>/` | raw transcript mirror + `.versions/` backups | no (gitignored) |
| `data/agent-lens.db` | normalized SQLite store | no |
| `agent-lens.config.json` | your sources | no (`.example` is tracked) |
| `.local/decisions/`, `.local/plans/` | ADRs and plans | no |

### HTTP API (read-only, `127.0.0.1`)

| Method · Path | Returns |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/sources` | configured sources + session counts |
| `GET /api/projects` | projects (cwd) + session counts |
| `GET /api/models` | distinct model ids |
| `GET /api/sessions` | filtered, paginated session list (see query params) |
| `GET /api/sessions/:id` | session meta + turns + events (transcript) |
| `GET /api/sessions/:id/export.md` | Markdown export (attachment) |

`/api/sessions` query params: `source`, `project`, `model`, `kind` (`main`\|`subagent`),
`q` (full-text), `from`, `to` (ISO timestamps), `limit` (≤200), `offset`.

## Troubleshooting

- **`ingest` says "archive not found"** — run `scripts/collect.sh` first (or check
  `AGENT_LENS_DATA`).
- **`serve` says "db not found"** — run `pnpm ingest` first.
- **Timer not firing while logged out** — confirm linger: `loginctl show-user $USER -p Linger`
  should print `Linger=yes`; if not, `loginctl enable-linger $USER`.
- **Re-ingest didn't pick up a parser change** — use `pnpm ingest --full`.
- **A source shows nothing** — check `node scripts/sources.mjs` resolves its `configDir`, and that
  `data/archive/<label>/projects/` has files.

## Privacy

- Collection only copies between local paths; the server binds `127.0.0.1` and refuses a routable
  host unless `AGENT_LENS_ALLOW_NONLOCAL=1`. No outbound network calls anywhere.
- Secrets (e.g. `~/.claude/.credentials.json`) are never copied.
- `data/` and `agent-lens.config.json` are gitignored — the local store is as sensitive as the
  original transcripts. See `.local/decisions/ADR-005-privacy-posture.md`.
