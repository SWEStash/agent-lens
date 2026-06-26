# ADR-006 — Implementation stack: TypeScript/Node, SQLite, Vite+React

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner

## Context

The tool is a local single-user app: parse JSONL → store → browse + dashboards on localhost. We want
one language end-to-end where practical and low operational burden.

## Decision

- **Language:** TypeScript on Node (>= 22) across ingest, server, and web.
- **Store:** SQLite via `better-sqlite3` + FTS5 (see ADR-003).
- **Server:** a small HTTP API (Fastify or Express) bound to `127.0.0.1` (see ADR-005).
- **Web:** Vite + React SPA; charting library chosen at Phase 4 (Recharts vs ECharts — open item).
- **Monorepo:** pnpm workspaces — `packages/core` (shared schema/types), `ingest`, `server`, `web`.
- **Collection** (Stage 1) stays a POSIX shell + rsync + systemd unit (ADR-002) — not TS — because
  it is plumbing best expressed with native tools.

## Consequences

- One language for the application tier; strong JSONL/data ergonomics; great webapp DX.
- Weaker OLAP than a dedicated analytics DB, accepted at this scale (ADR-003).
- `better-sqlite3` is a native module (needs build toolchain on install).

## Alternatives considered

- **Python + DuckDB + FastAPI/Streamlit.** Excellent for analytics, but a second language vs the web
  tier and less seamless SPA story. Reasonable; not chosen.
- **Python backend + React frontend.** Most capable UI, most setup/overhead. Rejected for now.
