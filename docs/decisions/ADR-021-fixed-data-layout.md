# ADR-021 — The archive and triage store are fixed to the data dir

- Status: Accepted
- Date: 2026-07-20
- Deciders: project owner

## Context

ADR-012 (`agent-lens config`) and the config-precedence work that followed made the server port/host
and the analytics DB path settable through a `flag > env > config file > default` chain. The obvious
next step looked like symmetry: give the archive and the triage sidecar the same treatment, so every
path in the layout is configurable the same way.

Investigating that surfaced a latent bug. `AGENT_LENS_ARCHIVE` was honored by `ingest`, `refresh`,
and `agent-lens config` — but **not** by `collectAll`, which resolved `<dataDir>/archive`
unconditionally. Setting the variable therefore split the pipeline: collect mirrored transcripts into
the default directory while ingest read the override, found nothing, and reported a *successful* run
with zero sessions. Nothing errored; the data simply stopped flowing.

That bug is easy to fix in either direction — teach collect the variable, or delete it. Choosing
required naming what the three stores actually are:

| Store | Rebuildable? | From what |
|---|---|---|
| `agent-lens.db` | **yes** | `ingest --full` re-derives every table from the archive |
| `archive/` | **no** | it *is* the source of truth; the agent's own transcripts are pruned on a rolling ~30-day window |
| `triage.db` | **no** | hand-authored triage state + UI prefs (ADR-018); nothing can regenerate a human's decisions |

A configuration key that repoints a *derived* store is cheap to get wrong: the worst case is a
rebuild. A key that repoints a store holding the only copy of its data is not — a typo, a stale
export in a shell rc, or a config file copied between machines silently strands it. The tool keeps
running and looks healthy, which is precisely the failure mode we already saw with the split archive.

There is also a coherence argument. If every path inside the data dir can be individually relocated,
`AGENT_LENS_DATA` stops meaning anything — "the data dir" becomes a default for three independent
paths rather than a place.

## Decision

**The archive and the triage store are fixed relative to the data dir, and have no flag, env var, or
config key of their own.**

- `resolveArchiveDir()` → always `<dataDir>/archive`.
- `triageDbFor(db)` → always `triage.db` in the resolved db's directory.
- `AGENT_LENS_ARCHIVE` and `AGENT_LENS_TRIAGE_DB` are **removed**, not deprecated.
- The supported way to relocate raw data is `AGENT_LENS_DATA` — it moves the whole layout together.
- The db keeps its `--db` / `AGENT_LENS_DB` / config `db` chain: it is derived, so relocating it is
  recoverable, and the triage sidecar follows it so the pair never splits.
- `ingest --archive <path>` survives as an **explicit, per-run, read-only** override, for ingesting a
  copied archive from another machine. A flag is a deliberate act at the moment of use; it cannot sit
  forgotten in a shell rc or a config file and desync the pipeline.

This holds until the storage strategy is revisited for scale (multiple hosts, shared/remote stores),
at which point the question is not "which env var" but a real storage design.

## Consequences

**Good**

- Collect, ingest, refresh, and `agent-lens config` cannot disagree about where the archive is — one
  helper, one answer.
- The class of silent-data-stranding bugs is removed rather than fixed once.
- `AGENT_LENS_DATA` regains a single clear meaning; `agent-lens config` reports the two paths as
  `[fixed: …]` rather than implying a knob that doesn't exist.

**Bad / accepted**

- **Breaking change** for anyone who set `AGENT_LENS_TRIAGE_DB`, which did work: the server now reads
  `triage.db` beside the db and ignores the variable. The old file is not deleted or migrated —
  recovery is `mv <old> <dataDir>/triage.db`. Judged acceptable because the variable is undocumented
  in practice, local-only, and pre-1.0.
- `AGENT_LENS_ARCHIVE` users are unaffected in any *working* configuration, because there wasn't one
  — the variable produced the split described above. Repo scripts that used it (`sandbox.sh`,
  `screenshots.mjs`, `export-snapshot.mjs`) now pass `ingest --archive` instead.
- Relocating just the archive (e.g. onto a larger disk while keeping the db on SSD) is no longer
  possible without moving the whole data dir. Accepted: a symlink covers the rare case, and the
  storage design above is the real answer.

## Alternatives considered

- **Teach `collectAll` about `AGENT_LENS_ARCHIVE` (add the key everywhere).** Fixes the immediate
  split but keeps a permanent foot-gun aimed at the only non-rebuildable data, and multiplies the
  surface where two components can disagree.
- **Keep the variables, add a startup warning** when the configured archive is empty while the
  default one holds data. Strictly better than silence, but it is a guardrail around a feature nobody
  asked for, and warnings on a background collector timer are not read by anyone.
- **Fix `triage.db` to `<dataDir>/triage.db`** rather than to the db's directory. Simpler to state,
  but it splits the pair whenever `db` is relocated — the db moves and its triage state stays behind,
  which is the exact failure this ADR exists to prevent.
