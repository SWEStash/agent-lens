# ADR-014 — Unified `agent-lens service` command (collector timer + server daemon)

- Status: Accepted
- Date: 2026-07-01
- Deciders: project owner
- Supersedes the command surface of [ADR-013](ADR-013-portable-collection-scheduling.md) (the
  `agent-lens schedule` name) and retires the legacy long-running server unit from the
  [ADR-002](ADR-002-collection-mechanism.md) / [ADR-005](ADR-005-privacy-posture.md) deployment story.

## Context

ADR-013 shipped `agent-lens schedule` to register a **periodic** `collect --then-ingest` job with
the OS scheduler (systemd timer / launchd `StartCalendarInterval` / schtasks `DAILY`). Two gaps
remained:

1. **The long-running web server had no cross-platform install.** Keeping the UI running after a
   reboot was only possible via the hand-written, Linux-only `systemd/agent-lens-server.service`
   (driven by `scripts/setup-systemd.sh`) — exactly the bash/systemd path ADR-012/013 set out to
   remove. macOS/Windows users had to run `agent-lens serve` under a process manager by hand.
2. **The verb was wrong.** A resident daemon is not "scheduled." `schedule` implies periodicity and
   cannot honestly name an always-on service, and setup required two disjoint steps (`schedule
   install` *plus* a manual server step) rather than one "make it work after reboot" command.

Nothing is published yet (`packages/cli` was `private:true`, pre-1.0), so the command could be
renamed with no back-compat cost.

## Decision

Replace `agent-lens schedule` with a single **`agent-lens service`** command group that manages both
OS integrations, across all three platforms:

```
agent-lens service install [collector|server|all]    # default: all
agent-lens service uninstall [collector|server|all]  # default: all; archive untouched
agent-lens service status [collector|server|all]     # default: all
agent-lens service install --times 8,12,18           # collector cadence (collector/all only)
```

Two **targets**:

- **collector** — the periodic `collect --then-ingest` job. Mechanism unchanged from ADR-013
  (systemd oneshot service + timer / launchd `StartCalendarInterval` / one schtasks `DAILY` task per
  hour; `--times`, default `09,13,17,21`).
- **server** — the long-running `serve` daemon, new. Per platform:
  - **Linux** → a systemd user service `agent-lens-server.service`, `Type=simple`,
    `Restart=always`, `RestartSec=5`, `WantedBy=default.target`. `Restart=always` (not
    `on-failure`): systemd counts a bare SIGTERM as a *clean* exit, so `on-failure` left the server
    dead after any external `kill`/`pkill` — in practice a `pkill -f 'agent-lens.js serve'` aimed at
    an ad-hoc test server, which matches this unit's `ExecStart` too. This also matches the launchd
    `KeepAlive` behaviour below; `systemctl --user stop` still stops it. The absolute `node` + CLI are
    baked into `ExecStart`, so no `WorkingDirectory` / `Environment=PATH=` mise hack is needed (that
    only existed because the legacy path ran `serve.sh`). `AGENT_LENS_PORT` / `AGENT_LENS_HOST` set at
    install time are baked in as `Environment=` lines.
  - **macOS** → a launchd LaunchAgent `org.agent-lens.server` with `RunAtLoad` + `KeepAlive`.
  - **Windows** → a Task Scheduler task `AgentLens\Server` with `/SC ONLOGON`, so it runs in the
    user session where the per-user data dir (`%LOCALAPPDATA%`) resolves.

A bare `agent-lens service install` (no target) installs **both** — one command makes Agent Lens
"just work" after reboot: periodic collection **and** the always-on UI at `http://127.0.0.1:4477`.
On Linux, linger is enabled once whenever any target is installed (so both the timer and the daemon
survive logout).

The pure unit/plist/command generators (`packages/core/src/service.ts`) are unit-tested; the
dispatch wraps them with `systemctl` / `launchctl` / `schtasks`.

## Consequences

- One cross-platform command installs the whole tool (collection + UI) as OS services; no bash,
  no manual per-OS server step.
- The legacy deployment bash is removed: `scripts/collect.sh`, `ingest.sh`, `serve.sh`,
  `setup-systemd.sh`, and the `systemd/` templates are deleted (the collector units are superseded by
  the ADR-013 generators; the server unit by the new `systemdServerService`). The dev/CI harness
  (`sandbox.sh`, `build-corpus.sh`, `sources.mjs`, `validate.mjs`, …) and the retention utility
  `prune.sh` (ADR-009) are kept.
- **Windows server has no crash-restart** (systemd/launchd do): a crashed `serve` returns on next
  logon, not immediately. Native crash-restart would require a service wrapper (nssm/WinSW) — rejected
  to preserve the no-extra-deps philosophy (ADR-013). Documented as a known caveat.
- Generated systemd units (collector service + timer, server service) pass `systemd-analyze verify`;
  the new server generators are unit-tested alongside the collector ones.

## Alternatives considered

- **Top-level `install` / `uninstall` verbs.** Simplest to type, but `status` collides conceptually
  with data status and the surface is less discoverable than a noun group.
- **Keep `schedule`, add `--server`.** Least churn, but keeps the misleading verb — conflating a
  periodic job and a resident daemon under a name that means "periodic."
- **Windows `sc.exe` service (+ wrapper) or `schtasks /SC ONSTART`.** `sc.exe` needs a native service
  wrapper (extra dependency); `ONSTART` runs as SYSTEM and can't see the per-user data dir. `ONLOGON`
  in the user session is the no-deps fit.
