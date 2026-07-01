# ADR-015 — Scoped write-action endpoint: `POST /api/refresh`

- Status: Accepted
- Date: 2026-07-01
- Deciders: project owner
- Amends [ADR-005](ADR-005-privacy-posture.md) (local-only, read-only posture) with one scoped exception.

## Context

The server is deliberately read-only (ADR-005): it opens the SQLite file with `{ readonly: true }`
+ `PRAGMA query_only = ON`, registers only GET routes, and binds loopback only. The web UI needed a
**"refresh data"** button so a user can pull in new transcripts on demand — running `collect` +
`ingest` on the host — instead of waiting for the scheduled/`watch` collector. That is a host
*action* (filesystem scan + DB write), which no read-only GET can express.

The tension: adding an action endpoint to an **unauthenticated** local server exposes it to
cross-site request forgery — any web page the user visits could `fetch('http://127.0.0.1:4477/…',
{method:'POST'})`. And running ingest in-process could block the server or, on a missing archive,
`process.exit(1)` and kill it.

## Decision

Add exactly one write-action route, `POST /api/refresh`, that runs a single collect + ingest pass on
the host and returns the new freshness time. Keep everything else read-only. Guard it:

- **CSRF (Origin allow-list).** Reject any request whose `Origin` is present and not a loopback host
  (`127.0.0.1` / `localhost` / `::1`) → `403 FORBIDDEN_ORIGIN`. Requests with no `Origin` (curl, the
  CLI — not a browser CSRF vector) are allowed. Same-origin POSTs from our own SPA carry a loopback
  `Origin` and pass; no custom request header is used, so the browser issues no CORS preflight.
- **Single-instance lock.** Take the shared `<dataDir>/.agent-lens.lock` (same lock as the CLI /
  scheduler / `watch`); if a run is already in progress → `409 REFRESH_IN_PROGRESS`. Never two
  collectors against one archive or two writers against one DB.
- **The server's own DB handle stays read-only.** Ingest opens its own short-lived read-write
  connection (WAL permits one writer alongside readers); the server's `openReadonly` handle is never
  used to write. Before calling `runIngest`, the archive dir is ensured to exist (it `process.exit`s
  on a missing archive — which would kill the server).
- **Loopback only** still holds (ADR-005): the endpoint is unreachable off-host by default.

The call is synchronous and briefly blocks the server during ingest — acceptable for a local,
single-user tool (the clicking user is waiting on it anyway). The SPA hides the button entirely in
static snapshot mode (no backend), disables it while running, and surfaces `409`/errors in the button.

## Consequences

- The server is no longer *purely* read-only: it has one action route. That action is
  **non-destructive** (collect never deletes; ingest is idempotent and rebuildable), **loopback-only**,
  **CSRF-guarded**, and **lock-serialized** — so the privacy/safety intent of ADR-005 (no data
  leaves the machine, nothing is destroyed) is preserved. Data still never leaves the host.
- The `server` package now depends on `@agent-lens/ingest` (and `@agent-lens/core`'s `collectAll` /
  `acquireLock`) — already co-bundled in the `agent-lens` CLI, no cycle (`ingest` doesn't depend on
  `server`).
- A large archive makes refresh block the server for the ingest's duration. If that becomes a
  problem, the in-process call can be swapped for a spawned `agent-lens collect --then-ingest` child
  (same guards, no event-loop block) without changing the endpoint contract.

## Alternatives considered

- **Child process instead of in-process.** Avoids blocking and the `process.exit` hazard, but needs
  the server to locate the CLI/node entry (awkward from the source-built server bin). Kept as the
  documented upgrade path if blocking bites.
- **Re-fetch only (no host run).** A button that just reloads current DB data — fully preserves the
  read-only posture but doesn't pick up new transcripts, so it doesn't meet the request.
- **No endpoint; rely on the scheduler/`watch`.** Freshness without a manual control; rejected
  because on-demand refresh was the explicit ask.
