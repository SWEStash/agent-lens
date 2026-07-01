# ADR-013 — Portable Node collection + cross-platform scheduling

- Status: Accepted
- Date: 2026-07-01
- Deciders: project owner
- Supersedes the mechanism (not the semantics) of [ADR-002](ADR-002-collection-mechanism.md)

## Context

ADR-002 implemented Stage 1 collection as bash + `rsync --append-verify` + a prefix-check pre-pass,
scheduled by a user **systemd** timer. That is Linux-only and depends on `rsync`/bash, which blocks the
cross-platform, installable distribution in ADR-012. The *semantics* of ADR-002 (append-verify, snapshot
only lossy cases, never delete, exclude secrets) are correct and must be preserved.

## Decision

Reimplement collection and scheduling in portable Node, shipped in the `agent-lens` CLI.

- **Collector (`packages/core/src/collect.ts`, `collectAll`).** A dependency-free `node:fs` port of the
  ADR-002 algorithm, identical semantics:
  - new file → copy whole; unchanged (size + mtime) → skip; source ≥ archive with a verified byte-prefix
    → **append** the tail; source shorter → **compaction** (snapshot the source, keep the longer
    archive); same-or-longer but prefix differs → **divergence** (snapshot the old archive, overwrite).
  - Always verifies the full prefix before appending (never trusts size alone); preserves source mtime
    on write (like `rsync -a`) so the steady state skips without a read and an existing rsync-built
    archive continues seamlessly. Improvement over the bash pre-pass: a stuck-compacted file is not
    re-snapshotted every run (skipped if byte-identical to the latest snapshot).
  - Secrets (`.credentials.json`, `*.lock`) are never copied; a post-pass sweeps any stray credential
    from the archive. Excluded projects (ADR + `AGENT_LENS_EXCLUDE`) are never mirrored. POSIX file
    perms `0600`/dirs `0700` (bash used `umask 077`); a no-op on Windows.
- **Single-instance lock (`core/lock.ts`).** A stale-aware PID lock (`<dataDir>/.agent-lens.lock`) so a
  scheduled run and a `watch` cycle — or a too-frequent schedule — never run two collectors against the
  same archive or two writers against the same SQLite DB.
- **`watch` mode.** A resident process (chokidar) that collects+ingests on file change, debounced, with
  an in-process guard; the Node-native periodic option.
- **Cross-platform scheduling (`core/schedule.ts`, `agent-lens schedule`).** Node can time work but not
  survive reboot alone, so register a periodic `collect --then-ingest` with the OS scheduler:
  **systemd** user timer (Linux, + linger), **launchd** LaunchAgent (macOS), **Task Scheduler**
  (Windows). Absolute `process.execPath` + CLI path are baked into every unit/plist/task (schedulers
  don't inherit the interactive PATH). Default cadence `09,13,17,21`; `--times` overrides.

## Consequences

- Collection and scheduling work on Linux/macOS/Windows with no `rsync`/bash.
- The legacy `scripts/collect.sh` + `scripts/setup-systemd.sh` + `systemd/` templates remain for the
  Linux bash flow and the long-running web-ui server unit, but are superseded for the data-load job.
- Generated systemd units pass `systemd-analyze verify`; the generators are unit-tested; collector
  semantics are covered by unit tests (append/compaction/divergence/secret exclusion/skip).

## Alternatives considered

- **Keep bash + rsync, add per-OS shims.** Still needs rsync/bash on macOS/Windows; more moving parts
  than a single Node implementation.
- **Node-only scheduler (interval/cron) without OS registration.** Can't survive reboot/logout on its
  own; `watch` covers the resident case, OS registration covers persistence.
