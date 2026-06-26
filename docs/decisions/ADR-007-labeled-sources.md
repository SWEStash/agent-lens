# ADR-007 — Labeled sources: multiple agent instances (accounts) via external config

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner
- Extends: ADR-003 (data model), ADR-002 (collection)

## Context

A local setup can have several agent *instances*, each with its own config folder — e.g. two Claude
accounts at different `CLAUDE_CONFIG_DIR`s. ADR-003 modeled `agents` as a type ('claude-code'); that
can't distinguish accounts. We need to add accounts by specifying a config folder + a human label
(e.g. `personal` → `~/.claude`) without code changes, and to filter/compare by account downstream.

## Decision

Introduce a **source** = a labeled agent instance `{ label, agent, configDir }`, declared in an
external config file and resolved by a single canonical resolver used by both stages.

- **Config:** `agent-lens.config.json` (`{ "sources": [ { label, agent, configDir } ] }`), gitignored;
  `agent-lens.config.example.json` is shipped. Resolution order: `$CLAUDE_DIR` legacy override →
  `$AGENT_LENS_CONFIG` → repo `agent-lens.config.json` → example → built-in default
  (`personal`/`default` → `$HOME/.claude`). `~`/`$HOME` expanded.
- **Resolver:** `scripts/sources.mjs` (plain Node, no build) prints `label\tagent\tconfigDir`.
  `collect.sh` loops over it; the ingester calls the same script (one source of truth, no drift).
- **Schema:** new `sources` table (`id`=label, `agent_id`, `config_dir`); `sessions.source_id` FK.
  Agent *type* still lives in `agents`; a source references it. SCHEMA_VERSION → 2.
- **Archive layout:** per-label — `data/archive/<label>/{projects,history.jsonl,settings,.versions}`.
  Prevents sessionId collisions across accounts and records provenance. Ingester discovers under each
  source's dir and tags sessions/files with the source.

## Consequences

- Add an account by editing one JSON file — no code change. Dashboards filter/compare by source.
- Per-label archive means existing flat archives must move under a label (one-time migration).
- Schema change is additive but not auto-migrated; rebuild the DB (it's a derived projection, ADR-001).
- Collection currently assumes Claude-Code-style layout (`projects/**.jsonl`, `history.jsonl`); a
  genuinely different agent will need per-agent collection logic, not just a new adapter.

## Alternatives considered

- **Env vars / CLI flags per run.** No persistence, easy to forget an account. Rejected for a config file.
- **Single shared archive, distinguish by session metadata only.** Risks sessionId collisions and
  loses provenance; harder to reason about per account. Rejected for per-label dirs.
