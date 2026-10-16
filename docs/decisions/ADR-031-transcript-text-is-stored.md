# ADR-031 — Transcript text is stored, not re-derived on read

- Status: Accepted
- Date: 2026-08-15
- Deciders: project owner
- Amends the read path of [ADR-011](ADR-011-compressed-raw-json.md); upholds [ADR-008](ADR-008-adapter-extensibility-seam.md) (adapter seam) and [ADR-024](ADR-024-shared-contract-types.md) (rows mirror the DDL)

## Context

Two packages independently knew how a Claude Code transcript record encodes its displayable text:

- `packages/ingest/src/adapters/claude-code.ts` flattened `message.content` at write time.
- `packages/server/src/db.ts` re-derived the same thing from `events.raw_json` at read time
  (`extractParts`), unpacking and JSON-parsing once per event.

They were not equivalent. Ingest merged reasoning into `text` and trimmed; the server kept the two
apart and did not trim. The cost showed up as a bug: Claude Code logs a message typed *while a turn is
running* as an `attachment` carrying `attachment.prompt` rather than a `user` event with a `message`.
Both extractors read only `message.content`, so such a message landed with `text: null` and rendered
as nothing — the user's own words silently absent from the session view. Fixing it required the same
change in both packages, and any future record-shape change would too.

It was also an architecture violation. ADR-008 is explicit: *"keep all agent-specific parsing inside
adapters — never in `packages/core`."* The server's `extractParts` was Claude-Code-specific parsing
living outside any adapter.

A related duplication sat alongside it: the `<command-*>` / `<task-notification>` markup vocabulary was
known in three packages, and the server's `xmlTag` and web's inner `pick` were the same regex
character for character.

## Decision

**1. Store both halves; never re-derive them.** `events` gains a `thinking` column beside `text`
(`SCHEMA_VERSION` → 15). The adapter writes both; every reader selects columns.

- `events.text` is now visible message text only — it no longer carries reasoning.
- `events_fts` indexes **both** columns. Reasoning was searchable before only because it was merged
  into `text`, and the search predicate is an unqualified `MATCH`, which spans every column — so
  indexing `thinking` is what makes the split invisible to search.
- `extractParts` is **deleted** from the server. `loadEvents` and the workflow-completion lookup read
  columns, so a transcript read no longer touches `raw_json` at all.

`raw_json` remains exactly what ADR-011 made it: the verbatim, gzip-compressed source of truth for
lossless re-derivation. What changes is that the *read path* no longer routes through it.

**2. Share the markup vocabulary, not the record shape.** New zero-dependency, node-free package
`@agent-lens/transcript-format` holds the tag names, `xmlTag`, `commandOutput`, and
`isCommandResultCarrier`; ingest, server, and web all import it.

The line between the two is deliberate. **Record shape** — where text, reasoning, or a queued prompt
live inside a transcript line — stays behind the `SourceAdapter` seam, because that is what ADR-008
protects. **Surface vocabulary** — strings appearing *within* message text that a browser must
re-recognize at render time — is not adapter work and cannot reach an adapter anyway: the web bundle
imports no Node code. `@agent-lens/contracts` could not host it either; it is a pure-types leaf whose
node-free guarantee is structural precisely because it exports no values.

## Consequences

- One owner for record-shape knowledge. A shape change is an adapter change, full stop.
- The transcript read path drops a gunzip + `JSON.parse` per event, and stops selecting a large BLOB
  it no longer needs.
- **A `SCHEMA_VERSION` bump means every existing DB must be rebuilt** with `agent-lens ingest --full`.
  The guard in `packages/ingest/src/run.ts` refuses an incremental run against a stale stamp and says
  so, rather than ingesting into a half-migrated schema.
- Adding an agent now means implementing `thinking` too — nullable, so an agent with no separate
  reasoning stream sets `null` (as `example-stub.ts` does). The stub needing that one line is the
  ADR-008 seam doing its job.
- The vocabulary package is named for Claude Code on purpose. A second agent brings its own vocabulary
  rather than inheriting this one.

## Alternatives considered

- **Share one extractor via a module in `packages/core`.** The obvious dedup, and the one ADR-008
  forbids by name — it would move agent-specific parsing *into* the package the seam exists to keep
  clean. Rejected.
- **Add `extractParts` to the `SourceAdapter` contract and have the server resolve an adapter by
  `sessions.agent_id`.** Architecturally pure and genuinely multi-agent, but it keeps the per-event
  parse and adds dependency-injection plumbing to a read path that no longer needs to parse anything.
  Rejected as more machinery for a strictly worse result.
- **Move the shared extractor into `packages/ingest/src/adapters/` and import it from the server.**
  Smallest change, and it does dedup the code — but the server would still hardcode one agent, so the
  ADR-008 leak would be relocated rather than closed. Rejected.
- **Put the tag vocabulary in `packages/contracts`.** Cheapest, but it requires the first value export
  in a package whose whole guarantee is that it has none. Rejected in favor of a separate leaf.

## Revisit triggers

- A second agent is onboarded → confirm `thinking` maps cleanly, and give that agent its own
  vocabulary module rather than extending this one.
- A reader needs something from a transcript line that is not a stored column → that is a new column
  and a version bump, not a return to parsing `raw_json` on read.
