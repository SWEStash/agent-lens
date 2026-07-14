# ADR-018 — Security-finding triage in a separate writable store

- Status: Accepted
- Date: 2026-07-14
- Deciders: project owner

## Context

The security findings from ADR-017 are useful but noisy on real data (thousands of findings, mostly
benign). Users need to **triage** them — mark a finding safe, or mute a chronically-noisy rule — so a
new, real finding stands out. That triage state is **user-authored**: it is not derivable from the
archive, unlike everything else in the store.

This collides with two invariants:

1. **The analytics DB is a rebuildable projection.** `detect()` wipes and re-inserts `findings` on
   every ingest, and `ingest --full` drops every analytics table. Triage state stored there would
   vanish on the next rebuild.
2. **The server handle is read-only (ADR-005).** It opens the DB `readonly` / `query_only=ON`.

## Decision

Keep triage state in a **separate, writable `triage.db`** that ingest never touches:

- Two tables — `dismissed_findings` (keyed by the **stable finding id** `sha1(tool_call_id, rule_id)`,
  which survives re-detection) and `muted_rules` (rule + optional project/source scope).
- It sits beside the analytics DB (`AGENT_LENS_TRIAGE_DB` or `<dataDir>/triage.db`) and is **never
  opened by ingest**, so triage survives `ingest --full` automatically — no invariant to enforce.
- The server opens it **read-write** for writes and `ATTACH`es it to the read handle, so the findings
  list JOINs triage state in SQL (correct filtering, pagination, and counts). The analytics handle
  stays read-only; only the triage handle writes. This mirrors `POST /api/refresh` (ADR-015), where a
  separate connection writes while the main handle stays read-only.
- Writes go through **CSRF-guarded POSTs** (`/api/security/{dismiss,reopen,dismiss-matching,mute,
  unmute}`, `GET /mutes`) using the same `originAllowed` loopback guard as `/api/refresh`.

Findings counts and the Dashboard KPI are computed over **open** findings (dismissed + muted excluded)
so the numbers reflect what still needs review.

## Consequences

- Triage is durable across full rebuilds and detector-version bumps (finding ids are independent of
  `DETECTOR_VERSION`), with zero coupling to the ingest pipeline.
- The "DB is fully rebuildable from the archive" property now has one **explicit exception**: triage is
  the one piece of state authored by the user, deliberately kept in its own file so the exception is
  isolated and obvious. Backing up triage means copying `triage.db`.
- Cross-DB reads rely on `ATTACH`; the findings queries are guarded on the attach being present and
  degrade to the un-triaged (all-open) view when the triage store isn't configured (e.g. the static
  snapshot build).

## Alternatives considered

- **A preserved table inside the analytics DB** (excluded from `resetSchema`'s drop list). Rejected:
  it muddies the rebuildable-projection invariant and would still need a writable handle on the
  otherwise read-only analytics connection.
- **A JSON sidecar** in the data dir. Simpler to write, but loses SQL JOIN/pagination against the
  findings list and hand-rolls concurrency. Rejected in favor of a tiny SQLite file.
- **Suppress-at-detection (bake dismissals into `detect()`).** Rejected: detection is deterministic and
  archive-derived; injecting user state there breaks reproducibility and re-flags on every rule change.

## Related

Complements ADR-017 (which also gained a v2 path allowlist so the agent writing to its own config/work
dir — e.g. a plan file under `~/.claude/plans` — is no longer flagged as an out-of-project write).
