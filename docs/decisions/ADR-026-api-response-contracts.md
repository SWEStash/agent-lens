# ADR-026 — API response contracts live in the shared package

- Status: Accepted
- Date: 2026-07-28
- Deciders: project owner
- Closes the deferral in [ADR-024](ADR-024-shared-contract-types.md)

## Context

ADR-024 gave the monorepo `@agent-lens/contracts`, a node-free leaf that owns the **DB row** shapes
(`SessionRow`, `TurnRow`, `EventRow`, …) so `core`, `ingest`, `server` and the browser `web` bundle
all read the same declarations. It deliberately stopped there, and said so:

> The API **response** shapes (`SessionSummary`, `DashOverview`, …) are still hand-declared in
> `web/api.ts` for now; only the primitive row shapes and shared unions (`Severity`) are unified in
> this ADR.

Phase 2 typed the other end — the **query** boundary — with `queryAll<T>` / `queryGet<T>` in
`sql-util.ts`, so a column a query doesn't select is a compile error rather than a runtime
`undefined`. But those helpers only reached the code written since; `db.ts` and `dashboard.ts` never
adopted them.

That leaves the response boundary — what an endpoint actually returns and what the SPA actually
consumes — unowned by either. Three symptoms:

- `packages/web/src/api.ts` hand-mirrored 36 response types (the audit's count of 33 predates a few
  additions). They were a description of the
  server's output maintained entirely by convention: nothing imported them on the server side, so
  nothing checked them.
- `packages/server/src/db.ts` carried 47 `any` and `dashboard.ts` 20, almost all of them
  `db.prepare(…).all(…) as any[]` or `params: any[]`. Rows entered the response assembly untyped, so
  even an explicit return type on the endpoint function would have absorbed the mismatch silently.
- The drift the ADR-024 context predicted had already happened. Auditing the two sides against each
  other found four fields the server returns that `web/api.ts` never declared — `/api/sources` emits
  `agent_id` and `config_dir`, `listSessions` emits `ended_at`, `getSkill`'s session rows emit
  `ai_title`, and `loadToolCalls` emits `error_type`. Three of them (`agent_id`, `config_dir`,
  `ai_title`) appear nowhere in `packages/web/src` at all: they are payload nobody reads.

Nothing was *broken* — extra fields are harmless on the wire — but the drift is one-directional
luck. The same mechanism that added an unread field would have dropped a read one.

## Decision

**Move the response contracts into `@agent-lens/contracts`, have the server declare them as return
types over typed rows, and have `web` consume them.** A field rename then fails to compile on both
sides.

### Where the types live

`packages/contracts/src` splits into `rows.ts` (ADR-024's DDL mirrors, unchanged) and `api.ts` (the
response shapes), with `index.ts` as a barrel. The leaf guarantee is unchanged and is what makes this
possible at all: zero runtime, zero `node:` imports, so `web` importing a response type pulls no Node
code into the bundle. `server` gains a direct dependency on `contracts` — it reaches the row types
through `core`'s re-export today, but responses have no such path and inventing one would put the
API contract behind a Node-only barrel again.

`packages/web/src/api.ts` keeps the fetch layer (`api`, `apiPost`, `resolveUrl`, `snapshotFileKey`,
`exportUrl`, `SNAPSHOT`) and re-exports the types, so the ~30 `import type { … } from "./api"` call
sites across `src/`, `src/transcript/`, `src/dashboard/` and `src/charts/` do not churn.

### Response types restate rows; they do not wrap them

Endpoints reshape. `listSessions` joins `projects` and computes four subquery roll-ups; `getSession`
attaches `full_result` to tool calls, groups findings under them, and nests events; `getWorkflow`
merges a `tool_calls` row, a `workflow_results` sidecar and a parsed `<task-notification>`. So
`Row[]` is almost never the answer, and a response type that tried to be `SessionRow & {…}` would
mostly be exclusions.

The one clean exception is `SessionDetailData extends SessionRow` — `getSession` does `SELECT s.*`,
so the whole row genuinely is in the payload, and the inheritance is kept. Everywhere else the
response type is written out in full, next to its sibling shapes, and named for the endpoint rather
than the table.

The counterpart lives on the server: projections that are neither a contracts row nor a response get
named shapes in the new `packages/server/src/rows.ts` — the file `sql-util.ts`'s own docstring
already referred to before it existed. `queryAll<SessionListRow>(…)` in, `SessionsPage` out, with the
transformation between them visible and checked.

### Derived and optional fields are optional in the type, and only where they are optional at runtime

- `ToolCall.full_result` is present only when the transcript truncated the result to a
  `…/tool-results/<name>.txt` marker *and* the spilled output was ingested. Optional.
- `agent_type` / `agent_description` / `spawn_depth` are `null`, never absent: `metaProjection()`
  emits `NULL AS agent_type, …` when `session_meta` doesn't exist, precisely so the row shape is
  stable across a pre-ingest DB. Typed `T | null`, not `T | undefined`.
- Triage state (`dismissed`, `dismiss_note`, `dismissed_at`, `muted`) follows the same rule for the
  same reason — `listFindings` emits `0 AS dismissed, NULL AS dismiss_note, …` when the triage store
  isn't ATTACHed.
- `Finding.signals` is present in the inline session projection and absent from the `/security` list
  projection, which doesn't select `signals_json`. Genuinely optional, and typed that way.

The rule: `?` means the key can be missing from the JSON, `| null` means the key is always there and
may hold null. The degraded-DB guards make the second case far more common here than the first, and
the tests in `packages/server/test` assert both paths.

### No runtime validation

Types are erased at runtime; a shared type is a compile-time agreement, not a wire check. That is
deliberate and sufficient here. Both ends of every response are in this repository, built together
by `pnpm -r build` in topological order, shipped as one npm package and one static snapshot. There is
no third-party producer, no version skew across a network, and no untrusted input on the response
path — the server reads a SQLite file that this repo's own ingest wrote.

So the JSON-blob columns keep their rich types (`FindingSignals`, `ClassificationSignals`,
`WorkflowProgressEntry`, `WorkflowRunResult.phases`/`logs`) even though `safeJson()` hands back
`unknown`. **These are asserted, not validated.** A malformed blob yields `null` (that is what
`safeJson` is for) rather than a throw, but a *well-formed blob of the wrong shape* would reach the
UI as declared. That is the accepted risk, and it is bounded: the only writer is
`packages/ingest/src/classify.ts` and the detector, in this repo, under test.

Adding zod or valibot would buy a guarantee against a producer that does not exist, at the cost of a
dependency, a per-request parse, and a second place every shape has to be declared. Revisit only if
the store ever accepts data this repo did not write.

### The trim is a separate change

The four undeclared fields above are removed by narrowing the SQL projections to match the contract,
**not** by widening the contract to match the SQL. But that changes response bodies, and therefore
the JSON that `scripts/export-snapshot.mjs` writes and `check-snapshot-links.mjs` gates. It is a
behaviour change and ships as its own commit and its own PR, after the type work has landed and made
the unread fields visible.

## Consequences

**Good**

- Renaming a field is a compile error at every consumer, `web` included — the drift that produced the
  four stray fields cannot recur silently.
- The `any` count in the two highest-churn server files goes to zero on the read path, so the
  response types are actually enforced rather than nominally declared.
- New endpoints have an obvious shape to follow: a row type in `server/src/rows.ts`, a response type
  in `contracts/src/api.ts`, `queryAll<Row>` between them.
- `packages/server/src/rows.ts` finally exists, so `sql-util.ts`'s docstring stops referring to a
  file that wasn't there.

**Bad / accepted**

- `contracts` now holds two kinds of thing (DDL mirrors and API responses). The `rows.ts` / `api.ts`
  split keeps them legible, but the package is no longer a single-purpose leaf.
- Response types are hand-maintained against SQL that TypeScript cannot see. `queryAll<T>` moves the
  unchecked cast to one place per query rather than eliminating it; a `SELECT` that stops emitting a
  column still type-checks. The endpoint key-shape tests in `packages/server/test` are what catch
  that, and they are part of this decision, not an optional extra.
- The contract describes the current payloads exactly, including anything unread. That is what makes
  the typing pass behaviour-preserving, and it means the contract is a description of reality first
  and a design second. Trimming is ongoing work, not a one-time cleanup.

## Alternatives considered

- **Infer the response types from the server's return types** (`ReturnType<typeof getSession>`) and
  have `web` import those. No hand-maintenance at all, but it makes `web` depend on
  `@agent-lens/server` — a Node package with `node:sqlite` and `fastify` in it — for types alone,
  which is exactly the barrel problem ADR-024 created `contracts` to avoid. It also inverts the
  dependency: the contract would be whatever the implementation happens to return, so an accidental
  extra field becomes part of the API rather than a diff to review.
- **Generate the types from the SQL** (a query-typing tool). Real coverage of the gap `queryAll<T>`
  leaves, but it wants a build step, a schema fixture, and a tool that understands SQLite's dynamic
  typing well enough to know that `COUNT(*)` is a number and `MAX(timestamp)` is `string | null`.
  Heavier than a few dozen hand-kept shapes with tests behind them.
- **Leave the responses in `web` and share nothing.** The status quo, and the thing that produced the
  drift this ADR documents.
