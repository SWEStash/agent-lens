# Agent Lens

> Passively collect, browse, and analyze your Claude Code CLI session traces — **100% local**.

[![npm](https://img.shields.io/npm/v/agent-lens)](https://www.npmjs.com/package/agent-lens)
![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)
![Platform: Linux · macOS · Windows](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Claude Code records rich per-session telemetry under `~/.claude/`, but prunes it on a rolling
**30-day window**. Agent Lens continuously copies that data out before it's lost, normalizes it into
a queryable SQLite store, and gives you a browsable transcript viewer plus analytics dashboards —
**without a single byte leaving your machine**.

## Install

```bash
npm install -g agent-lens          # or run ad-hoc:  npx agent-lens <command>
```

Requires **Node.js ≥ 24**. The only native dependency, `better-sqlite3`, installs a prebuilt binary
for Node 24 across Linux (glibc + musl), macOS, and Windows; if no prebuild matches your platform it
is compiled from source (needs a C++ toolchain).

## Quick start

Agent Lens runs a three-stage local pipeline — `collect → ingest → serve`:

```bash
# Configure which accounts to collect (defaults to one: ~/.claude).
#   → agent-lens.config.json next to your data dir, or set AGENT_LENS_CONFIG

agent-lens collect --then-ingest   # Stages 1–2: mirror transcripts to the archive, build the DB
agent-lens serve                   # Stage 3: browse → http://127.0.0.1:4477

# Make it permanent — install as OS services (survives reboot):
agent-lens service install         # periodic collect+ingest AND the always-on UI
# ...or keep it fresh in the foreground instead:
agent-lens watch                   # a resident process that collects+ingests on file change
```

### Commands

| Command | What it does |
| --- | --- |
| `agent-lens collect [--then-ingest]` | Mirror each configured account's transcripts into the local archive (never deletes, never copies secrets). |
| `agent-lens ingest` | Normalize the archive into the SQLite store. |
| `agent-lens serve` | Serve the web UI + read-only API at `http://127.0.0.1:4477`. |
| `agent-lens watch` | Foreground resident: collect + ingest on file change. |
| `agent-lens metrics` | Print store metrics to the terminal. |
| `agent-lens service <install\|uninstall\|status> [collector\|server\|all]` | Install/manage OS services (systemd / launchd / Windows Task Scheduler). |

## Privacy

Everything stays on your machine — no telemetry, no network calls, no accounts. The collector copies
transcript files only and skips anything that looks like a credential. See the
[privacy posture](https://github.com/SWEStash/agent-lens#privacy) for details.

## Documentation

Full docs, configuration reference, screenshots, architecture decisions, and the read-only demo live
in the repository: **https://github.com/SWEStash/agent-lens**

## License

[MIT](https://github.com/SWEStash/agent-lens/blob/main/LICENSE) © SWEStash
