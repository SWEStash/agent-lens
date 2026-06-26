# ADR-009 — Data retention window and at-rest encryption stance

- Status: Accepted
- Date: 2026-06-26
- Deciders: project owner
- Extends: ADR-005 (privacy posture); closes its retention open item

## Context

ADR-005 deferred a retention policy as an open item: the `data/` store grows unbounded and is as
sensitive as the original transcripts. It now holds ~448 MB (≈270 MB DB + ≈178 MB archive) for one
source. Three things accumulate, with very different roles:

- `data/archive/<label>/projects/` — the **mirror**. This is the durable raw archive and the source
  of truth (ADR-001); never deleted (no rsync `--delete`, ADR-002). It is the dataset we *want* to
  retain.
- `data/archive/<label>/.versions/<TS>/` — divergence/compaction **snapshots** (ADR-002). Created only
  on real divergence/compaction (rare; **zero so far** on this machine). Unbounded over years, and —
  unlike the mirror — safely discardable once old, because Stage 2 has already deduped their events
  into the DB by `uuid`.
- `data/agent-lens.db` — a **derived projection** (ADR-001/003), rebuildable any time with
  `pnpm ingest --full`.

We need a policy before the store grows large, without compromising the local-only privacy NFR.

## Decision

1. **Prune only `.versions/`, on an age window.** Delete snapshot dirs older than **N days
   (default 90)**; keep everything inside the window. Implemented as `scripts/prune.sh`
   (`--days N` / `AGENT_LENS_VERSIONS_KEEP_DAYS`). **Dry-run by default**; `--apply` deletes. It only
   ever touches `*/.versions/<TS>/` dirs (guarded), and logs to `data/archive/.prune.log`.
2. **Never prune the mirror.** It is the retained dataset and the whole point of the durable archive.
3. **Do not prune the DB independently.** It is derived: if pruning ever changes what's available,
   `pnpm ingest --full` re-derives the DB from the archive. No separate DB-retention mechanism.
4. **Pruning stays manual this phase.** `.versions/` is empty, so a scheduled job would be premature;
   run `prune.sh` occasionally. (A systemd timer is a trivial follow-up — see Revisit triggers.)
5. **At-rest encryption: volume-level, by recommendation, no code.** Agent Lens does not encrypt the
   store itself. Recommend placing `data/` on an encrypted volume — LUKS/dm-crypt on Linux, FileVault
   on macOS. The store stays gitignored and loopback-only (ADR-005).
6. **Containerization: deferred.** A strictly-local single-user tool that reads `~/.claude` and serves
   on `127.0.0.1` gains little from a container and complicates host-filesystem access (KISS/YAGNI).

## Consequences

- The only unbounded, discardable growth is bounded by a clear, configurable window; the valuable
  mirror and the rebuildable DB are left intact.
- `prune.sh`'s dry-run default and path guard make accidental data loss hard.
- No new runtime dependency and no encryption code to maintain; at-rest protection is delegated to
  the OS/filesystem, which is the right layer for a local single-user tool.
- Trade-off: volume-level encryption depends on the user actually configuring it — documented in
  `docs/USAGE.md`, not enforced by the tool.

## Alternatives considered

- **App-level DB encryption (SQLCipher).** Encrypts the DB at rest transparently, but requires
  recompiling `better-sqlite3` against SQLCipher, adds a key-management burden, and offers no
  protection for the raw archive files. Rejected — wrong cost/benefit for a local tool; full-volume
  encryption covers archive + DB + WAL uniformly.
- **Prune the mirror too (age-based).** Would cap total size hardest, but destroys the durable archive
  that ADR-001 exists to provide and that protects against parser bugs. Rejected.
- **No retention (unbounded).** Simplest, but defers an unbounded-growth problem indefinitely. Rejected
  for at least the cheap `.versions/` prune.

## Revisit triggers

- `.versions/` starts accumulating materially → wire `prune.sh` into a systemd user timer alongside
  the collector.
- The store outgrows comfort even after `.versions/` pruning → reconsider mirror compaction/archival
  or a stricter window.
- A multi-user or shared-host deployment appears → re-evaluate app-level encryption and access control.
