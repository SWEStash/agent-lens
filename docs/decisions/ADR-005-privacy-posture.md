# ADR-005 — Local-only privacy posture

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner

## Context

Traces contain full prompts, responses, code, and tool output — potentially secrets. The overriding
NFR is that **data never leaves the local environment**.

## Decision

- **No network egress of trace data.** Collection copies only between local paths. No telemetry, no
  analytics, no cloud calls anywhere in collect/ingest/serve.
- **Secret exclusion at the source.** The collector never copies `~/.claude/.credentials.json` (and
  other secret/lock/cache files); enforced by explicit rsync `--exclude` rules.
- **Loopback-only webapp.** The server binds to `127.0.0.1` exclusively; it must refuse to bind a
  routable interface.
- **The `data/` store is sensitive.** Its contents are gitignored, live only on the user's machine, and are as
  sensitive as the originals.
- **Retention (to finalize before the store grows large):** the archive + `.versions/` + DB grow
  unbounded. Define a pruning window and an optional at-rest encryption stance (e.g. keep N days of
  `.versions/`, or place `data/` on an encrypted volume). Tracked as an open item.

## Consequences

- Strong privacy guarantee; verifiable by inspecting process network activity.
- Optional AI enrichment is constrained to on-device only (see ADR-004).
- Unbounded growth must be actively managed (retention work item).

## Verification

- Grep running processes / sockets for outbound connections carrying trace payloads — expect none.
- Confirm no secret files land in `data/archive/`.
- Confirm binding to a LAN IP is refused.
