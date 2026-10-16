# Agent Lens

Collect, search, and audit your Claude Code session traces. 100% local.

[![npm](https://img.shields.io/npm/v/@swestash/agent-lens)](https://www.npmjs.com/package/@swestash/agent-lens)
![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)
![Platform: Linux · macOS · Windows](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Claude Code prunes its session records after a rolling 30-day window. Agent Lens copies them into a
local archive first, and gives you a transcript browser, usage and cost dashboards, and a
deterministic, no-AI audit of what the agent did on your machine. Nothing leaves your machine.

## Install

Requires Node.js 24 or later.

```bash
npm install -g @swestash/agent-lens    # or run once: npx @swestash/agent-lens <command>
```

There are no compiled dependencies: SQLite comes from Node's built-in `node:sqlite`, so nothing is
built or downloaded at install time.

## Quick start

```bash
agent-lens collect --then-ingest   # copy your transcripts and build the database
agent-lens serve                   # open http://127.0.0.1:4477
agent-lens service install         # optional: keep collecting and serving across reboots
```

With no config file, Agent Lens collects `~/.claude`.

## Commands

| Command | What it does |
| --- | --- |
| `agent-lens collect [--then-ingest]` | Copy each account's transcripts into the archive. Never deletes, never copies credentials. |
| `agent-lens ingest [--full]` | Build or update the SQLite store from the archive. |
| `agent-lens serve` | Serve the web UI and API on `127.0.0.1:4477`. |
| `agent-lens watch` | Collect and ingest whenever a transcript changes. |
| `agent-lens metrics` | Rerun classification, security detection, error typing, and file indexing on the store. |
| `agent-lens export <sessionId>` | Write a session to Markdown, redacted by default. |
| `agent-lens service <install\|uninstall\|status> [collector\|server\|all]` | Manage the OS services (systemd, launchd, Task Scheduler). |
| `agent-lens config` | Print the effective configuration and where each value came from. |

## Where your data lives

In a per-user data directory (on Linux, `~/.local/share/agent-lens`). `agent-lens config` prints the
resolved paths, and `AGENT_LENS_DATA` moves them. All platforms are listed in the
[usage guide](https://github.com/SWEStash/agent-lens/blob/main/docs/USAGE.md#paths).

## Documentation

Configuration, screenshots, the [privacy posture](https://github.com/SWEStash/agent-lens#privacy),
and a live demo are in the repository: https://github.com/SWEStash/agent-lens

## License

[MIT](https://github.com/SWEStash/agent-lens/blob/main/LICENSE) © SWEStash
