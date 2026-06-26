# ADR-002 — Collection mechanism: rsync --append-verify + backup-dir via user systemd timer

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner

## Context

Stage 1 (ADR-001) must copy `~/.claude/projects/**.jsonl` and `history.jsonl` into `data/archive/`
a few times a day, lose nothing, exclude secrets, and run unattended on Linux. Transcripts are
append-only during a session, but can be **compacted** (rewritten shorter) and then continue to grow.

## Decision

Update the mirror with `rsync --append-verify` (no `--delete`), and capture conflicting versions with
a **prefix-check pre-pass** — NOT rsync's own `--backup`. Driven by a **user** systemd timer.

```
# pre-pass (per changed *.jsonl): snapshot only the lossy cases into .versions/<ts>/
#   divergence (archive not a byte-prefix of a >= source) -> snapshot OLD archive
#   compaction (source shorter than archive)              -> snapshot the compacted SOURCE
# then mirror update:
rsync -a --append-verify --exclude='.credentials.json' --exclude='*.lock' \
      --include='*/' --include='*.jsonl' --exclude='*' \
      <sources> data/archive/
```

- `--append-verify` (not plain `--append`): per `rsync 3.2.7` man page, plain `--append` updates
  growing files in place **without verifying existing content** (corruption risk); `--append-verify`
  checksums old+new. Both modes **skip receiver files that are not shorter than the sender's**.
- **No `--delete`** so sources pruned at 30 days remain in the archive.
- **No rsync `--backup`.** Empirical testing (rsync 3.2.7) showed two flaws in the naive form:
  1. `--backup` backs up on *every append*, not just on divergence → `.versions/` bloats with
     near-duplicate growing copies every run.
  2. `--append-verify` *skips* a compacted (shrunk) source, so post-compaction **new** events (e.g. a
     summary event) would never be archived → maximal-history goal defeated.
  So a small pre-pass does the conflict capture deterministically (only on real divergence/compaction),
  and rsync handles the efficient, safe mirror update. `--append-verify` confirmed safe on divergence:
  it re-sends cleanly rather than corrupting (verified by test).
- Append semantics scoped to append-only files (`**.jsonl`); small mutable files (settings) copied
  latest-wins.
- **Scheduling:** a `--user` systemd service + timer (a few runs/day). `loginctl enable-linger $USER`
  so the timer fires even when not logged in.

Stage 2 reconciles by ingesting the mirror **and** all `.versions/` backups, deduping events by
`uuid` → maximal history.

## Consequences

- Cheap, native, no daemon to write. Secrets are explicitly excluded.
- `.versions/` accumulates only on real divergence (rare); it is dead weight unless Stage 2 reads it —
  so Stage 2 MUST ingest it (tracked in Phase 2).
- The mirror holds the longest-seen copy, which can mix pre/post-compaction prefixes for a file; this
  is why dedup-by-uuid at ingest (not the raw file) is the correctness boundary.

## Alternatives considered

- **Immutable hardlinked snapshots (`--link-dest`).** Strongest fidelity (every version kept), but
  more disk/inode churn and a snapshot-pruning policy. Heavier than needed now.
- **DB as source of truth (plain `rsync -a`, DB never deletes).** Simplest rsync, but the raw mirror
  stops being a durable archive and requires tight collect→ingest coupling. Rejected in favor of a
  durable raw archive (ADR-001).
- **Plain `--append`.** Faster but can silently corrupt on any non-append change. Rejected.
