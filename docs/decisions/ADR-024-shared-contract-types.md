# ADR-024 — Shared contract types package

- Status: Accepted
- Date: 2026-07-24
- Deciders: project owner

## Context

The normalized DB row shapes (`SessionRow`, `TurnRow`, `EventRow`, …) are declared once in
`packages/core/src/types.ts` and surfaced through the `@agent-lens/core` barrel, which `ingest` and
`server` consume. The browser `web` package, however, **cannot** import from `@agent-lens/core`: the
core barrel `export *`s from Node-only modules (`paths.ts`, `service.ts`, `collect.ts`, `config.ts`,
`redact-export.ts`, … all import `node:fs`/`node:os`/`node:child_process`), so pulling core into the
web bundle would drag Node code into the browser.

So `web` re-declares the entire API/data contract by hand in `packages/web/src/api.ts` (33 interfaces),
a mirror of what the server emits with **no compile-time link** to the source shapes. A column rename
in `schema.ts` → `db.ts` type-checks clean and only breaks the UI at runtime; this drift is the
mechanism behind the schema→db→api→web co-churn (those four are among the highest-churn files). The
slop audit flagged it as the top type-safety issue (P2/P3, SLOP-016/048).

A related bug lives in the source-of-truth types themselves: `SessionRow` had drifted stale — it was
missing `spawn_parent_id` and `workflow_run_id`, two columns added to the `sessions` DDL (schema v6+).
A contributor typing an insert against it would silently drop two linkage columns.

## Decision

**Introduce a `@agent-lens/contracts` leaf package that owns the cross-boundary DB row shapes as pure
types** — zero runtime, zero `node:` imports — and have every package share it instead of re-declaring.

- `packages/contracts/src/index.ts` holds the nine DDL-mirror row interfaces (`SourceRow`,
  `ProjectRow`, `SessionRow`, `TurnRow`, `EventRow`, `TokenUsageRow`, `ToolCallRow`, `SkillRow`,
  `ClassificationRow`). The stale `SessionRow` is corrected here (adds `spawn_parent_id`,
  `workflow_run_id`) as part of the move.
- `core/src/types.ts` **re-exports** the row shapes from contracts (`export type { … } from
  "@agent-lens/contracts"`) and keeps the ingest **adapter-seam** types (`SourceAdapter`, `SourceFile`,
  `ParsedLine`, `SessionMeta`, `ToolResultPatch`) — those are an ingest boundary, not consumed by web.
  So `ingest`/`server` imports stay on `@agent-lens/core` unchanged (lowest blast radius).
- `web` depends on `@agent-lens/contracts` and consumes the shapes via `import type`, so nothing but
  type declarations enters the bundle.

Dependency direction: `contracts` is a leaf (depended on by `core`; later by `server` and `web`
directly). It never depends on anything, so the graph stays acyclic and points toward the most stable
component (SDP).

## Consequences

**Good**

- One source of truth for the row shapes; a schema change now type-errors at every consumer that
  hasn't been updated, including `web` — closing the silent-drift gap.
- `web` gets a browser-safe import target without the Node-barrel problem, and without a bundler hack.
- Fixing `SessionRow` drift at the move means the typed server query layer (built next) rests on
  correct shapes.
- Re-exporting through `core` means `ingest`/`server`/`cli` need no import churn.

**Bad / accepted**

- One more workspace package to build (a fast, dependency-free `tsc` step; it must build before core,
  which `pnpm -r build`'s topological order handles automatically).
- The API **response** shapes (`SessionSummary`, `DashOverview`, …) are still hand-declared in
  `web/api.ts` for now; only the primitive row shapes and shared unions (`Severity`) are unified in
  this ADR. Migrating the response contract is incremental follow-on work as the server adopts explicit
  return types — deferred to avoid a large, risky change to dynamically-built server responses.

## Alternatives considered

- **Types-only subpath export from `core`** (add a `./types` export, consume via `import type`): no new
  package, but `web` then depends on `@agent-lens/core` and relies on type-only erasure to keep Node
  code out of the bundle — one accidental value import re-introduces the problem. A dedicated leaf makes
  the node-free guarantee structural, not a convention.
- **Keep web's hand-typed contract, dedupe only within web**: lowest effort, but leaves the
  server↔web drift risk — the actual defect — unaddressed.
- **Generate the types from the DDL**: heavier tooling than a few dozen hand-kept rows warrant today;
  the shared package plus a schema-vs-contract test (future) covers the same risk more simply.
