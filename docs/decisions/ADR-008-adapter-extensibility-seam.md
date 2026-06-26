# ADR-008 — Adapter extensibility seam: adding an agent without schema changes

- Status: Accepted
- Date: 2026-06-26
- Deciders: project owner
- Extends: ADR-003 (data model), ADR-007 (labeled sources)

## Context

Agent Lens is meant to be agent-agnostic (ADR-003): Claude Code is the first agent, but others should
slot in later. The seam for that is the `SourceAdapter` interface
(`packages/core/src/types.ts`) plus a normalized, agent-neutral schema. Until now there has been
exactly one implementation (`ClaudeCodeAdapter`), so "another agent slots in without schema changes"
was an **unverified claim**. Phase 5 verifies it and documents the recipe, so the seam doesn't quietly
rot into a Claude-Code-only path.

## Decision

Treat the `SourceAdapter` contract as the **stable extension point**, and keep all agent-specific
parsing inside adapters — never in `packages/core` (`types.ts` / `schema.ts`).

**The contract** (`packages/core/src/types.ts`):

```ts
interface SourceAdapter {
  agentId: string;      // machine id, matches a source's `agent` value (e.g. "claude-code")
  agentName: string;    // human label
  discover(sourceArchiveDir, sourceId): SourceFile[];   // find this agent's transcript files
  parseLine(raw, file, seq): ParsedLine;                // one parsed line -> normalized rows
}
```

An adapter emits only **agent-agnostic rows**: `EventRow` (every line, keyed by a stable `uuid` —
the dedup/UPSERT key — with `raw_json` preserved verbatim for lossless re-derivation),
`TokenUsageRow`, `ToolCallRow`, `ToolResultPatch`, and `SessionMeta`. The schema tables those map to
(`agents`, `sources`, `sessions` with `agent_id`/`source_id`, `events`, `tool_calls`, `token_usage`)
carry no Claude-Code-specific columns; agent-specific fields are either nullable (`cli_version`,
`entrypoint`, `git_branch`, `encoded_dir`) or absorbed into `raw_json`.

**Recipe to add an agent (no DDL):**

1. Add `packages/ingest/src/adapters/<agent>.ts` implementing `SourceAdapter`.
2. Register it: add `new <Agent>Adapter()` to `adapterList` in `packages/ingest/src/index.ts`
   (the only wiring point — adapters are resolved by `agentId` against each source's `agent` value).
3. Add a source with the matching `agent` to `agent-lens.config.json` (ADR-007).

**Verification (this phase):** `packages/ingest/src/adapters/example-stub.ts` — a second adapter for a
hypothetical agent with a deliberately different on-disk layout (`logs/*.ndjson` rather than
`projects/<dir>/*.jsonl`), a different line envelope, and a flat tool-call array — was written against
the live interface. It type-checks under `pnpm -r build` with **no change to `packages/core`**, which
is the proof the seam admits a divergent agent. It is intentionally **not** registered and **not** run.

## Consequences

- The extension point is now exercised and documented; a future agent is a new file + one registration
  line + one config entry.
- Adapters own all format quirks; the schema stays clean (ADR-003 upheld).
- **Collection is not covered by this seam.** As ADR-007 already noted, `scripts/collect.sh` assumes
  the Claude-Code layout (`projects/**.jsonl`, `history.jsonl`, `settings`). An agent whose traces
  live elsewhere also needs per-agent **collection** logic — a separate change from adding an adapter.
  This remains a documented limitation, not solved here.
- The stub is dead code carried for documentation/regression value; it costs a few KB and one extra
  file the type-checker compiles.

## Alternatives considered

- **Document the seam without a stub.** Cheaper, but leaves the central claim unverified — exactly the
  gap this ADR closes. Rejected.
- **A fully wired, ingest-tested second adapter with fixtures.** Strongest proof, but needs a synthetic
  fixture corpus and test harness (no real second-agent data exists yet). Deferred until a real second
  agent is actually onboarded; the compile-time proof is sufficient for now.

## Revisit triggers

- A real second agent is onboarded → replace the stub with a real adapter and add collection logic.
- The schema gains an agent-specific column → re-evaluate whether the seam still holds.
