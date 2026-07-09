# Data Validation — collect → ingest → compute

This documents how we verify that Agent Lens computes its metrics and indicators
correctly, end to end. The goal is confidence that token accounting, cost,
session/turn/subagent aggregates, and the heuristic classifier are right — at the
formula level (absolute correctness) **and** at full real-data scale
(self-consistency).

## Approach — five layers

Each layer answers a different question. Together they cover absolute
correctness, real-scale consistency, and the whole CLI→API path.

| Layer | Question | Where | Needs hand-authored expecteds? | Scale |
|------|----------|-------|-------------------------------|-------|
| 1. Golden fixtures | Are the *formulas* exactly right? | vitest | Yes | tiny |
| 2. Invariants | Does the *real* data stay self-consistent? | `scripts/validate.mjs` | No | full (your real DB) |
| 3. Determinism | Is incremental == full rebuild? | vitest | No | committed corpus |
| 4. Redaction oracle | Is the corpus metric-faithful to real data? | `scripts/oracle.mjs` | No (raw is its own oracle) | committed corpus |
| 5. Sandbox e2e | Does the whole CLI→API path work? | `scripts/sandbox.sh` | spot-check | committed corpus |

**Why the redaction oracle works.** Token accounting, cost, durations, counts,
subagent linkage, and the complexity *score* derive only from numeric/structural
fields (usage objects, timestamps, ids, models, tool names, `spawned_session_id`,
edit line-counts, file extensions). The classifier *category* derives from
message *text*. So a redactor that scrubs text/PII but preserves those structural
fields is **metric-preserving by construction** — and `metrics(redacted) ==
metrics(raw)` becomes a checkable property. Category is text-derived and is
covered by Layer 1 fixtures instead, never by the oracle.

## How to run

```bash
pnpm test                                   # Layers 1, 3, 4-unit + corpus scenarios (150 tests)
cp data/agent-lens.db /tmp/al-validate.db   # snapshot (never read the live WAL DB)
pnpm validate --db /tmp/al-validate.db      # Layer 2 invariants on the real corpus
pnpm build-corpus                           # regenerate the redacted corpus + run the oracle
pnpm sandbox                                # Layer 5 end-to-end over the corpus
```

## What each layer covers

- **Layer 1 — golden fixtures** (`packages/*/test/*.test.ts`):
  - `core/test/pricing.test.ts` — cost formula, longest-prefix model match
    (`claude-opus-4-8[1m]` → opus-4-8, dated haiku → `claude-haiku-4`), cache
    rates, unknown → 0.
  - `server/test/dashboard.test.ts` — every dashboard aggregate (token split,
    `total_tokens`, `cache_read_ratio`, cost, `unpriced_models`, p50/p95 turn
    duration, per-model/source/category breakdowns, subagent fan-out, source
    filter) with hand-computed numbers.
  - `ingest/test/classify.test.ts` — complexity sub-scores + weighted total
    (zero, all-ceilings → 100.0, exact half-ceilings), LoC parsing, category
    keywords + structural signals + subagent-role override.
  - `ingest/test/ingest.test.ts` — existing dedup/linkage/pruning/streaming plus
    new: malformed lines, meta/compaction lines (no turn), cross-file uuid dedup,
    and the **orphan subagent** case.
- **Layer 2 — invariants** (`scripts/validate.mjs`): dedup, conservation
  (`dashboardOverview` == direct SUM), cost additivity (row-sum == grouped),
  linkage integrity, aggregate recompute, plus report-only orphan/unpriced/
  unattributed counts. Cross-checks the *shipped* server query path.
- **Layer 3 — determinism** (`ingest/test/determinism.test.ts`): full rebuild ==
  chunked incremental (mains, then subagents — exercising linkage expansion), and
  idempotent re-ingest (0 new events, unchanged derived state).
- **Layer 4 — redactor + corpus** (`packages/ingest/src/redact.ts`,
  `test/fixtures/corpus/`): the committed corpus is real, non-agent-lens sessions
  run through the metric-preserving redactor; `redact.test.ts` proves
  preservation + leak-freedom on synthetic data, and the oracle proves it on the
  real subset the corpus was built from.
- **Layer 5 — sandbox** (`scripts/sandbox.sh`): `ingest --full` → server → HTTP
  API over the corpus, in a throwaway temp dir, asserting the API's aggregates
  match the corpus's known-correct numbers.

## Results

> The **Layer 2** and **Findings** figures below are a point-in-time snapshot from a real
> ~630-session DB — Layer 2 runs against your own `data/agent-lens.db`, so the numbers scale with
> your data. Layers 1/3/4/5 run on the committed corpus and are deterministic.

**Layer 1/3/4-unit + corpus scenarios — `pnpm test`:** 150 tests pass (16 files).

**Layer 2 — invariants on the live corpus (~632-session snapshot):** all hard invariants PASS.

```
[1] dedup                — each (session_id, message_id) appears once
[2] conservation         — overview tokens == direct SUM (input 2,669,921; cache_read 2,327,763,568)
[3] cost additivity      — Σ costForUsage(row) == overview.cost  ($1912.90, drift $0.000015)
[4] linkage integrity    — 0 dangling spawns, 0 broken parent_turn links
[6] aggregate recompute  — event_count/turn_count == COUNT(*) for every session
report: cache_read_ratio = 95.7% · 239 linked + 249 orphan subagents · 0 unattributed token rows · all models priced
```

> The `249 orphan subagents` line above is the pre-fix snapshot. After finding #1
> was fixed (structural `subagents/`-path linkage) those workflow agents attribute
> to their orchestrator; re-run `ingest --full` then `pnpm validate` to see the
> orphan count drop to the genuinely path-less remainder.

**Layer 4 — oracle (raw subset vs redacted corpus):** every metric identical —
sessions/turns/events/tool_calls, token split, cost ($0.632179), subagent
linkage, complexity scores. The redacted real sources (team-a/team-b) are
leak-scan clean.

**Layer 5 — sandbox e2e:** `ingest --full` over the 3-source corpus → every
scenario asserted through the DB and HTTP API (see table below); all pass.

### Scenario coverage

The committed corpus has three sources: `team-a`/`team-b` (redacted real, for the
oracle + realism) and `scenarios` (hand-authored synthetic, readable content) so
every scenario is represented end-to-end. Each is verified both as a unit
(deterministic golden fixture) and over the committed corpus (CI +
sandbox/API):

| Scenario | Golden fixture (unit) | Over the corpus |
|----------|----------------------|-----------------|
| Plain session — turns + token accounting | `ingest.test.ts` | `sc-plain-0001` |
| Subagents — child tokens not double-counted | `ingest.test.ts`, `redact.test.ts` | `sc-sub-parent-0002` + `agent-c0ffee01` (child=1500, parent=1300) |
| Workflow fan-out — agents grouped by run + linked to the launching turn (run id) | `ingest.test.ts` (workflow run-link + path-less orphan), `api.test.ts` (run grouping) | `sc-workflow-0003` (Workflow result carries `runId`/`workflowName`) + 2 agents under `subagents/workflows/wf_*/` |
| Slash command — `/cmd` invocation + local output, no assistant turn | `corpus-scenarios.test.ts` | `sc-command-0006` (`/plugin` + `<local-command-stdout>`) |
| Multi-source — no cross-source bleed | `dashboard.test.ts` | 3 sources (team-a/team-b/scenarios) |
| Compaction / meta — no spurious turn | `ingest.test.ts` | `sc-plain-0001` (turn_count=2) |
| Sidechain / resumed — dup-uuid dedup | `ingest.test.ts` (cross-file) | `sc-resumed-0005` (mirror + .versions → 3 events) |
| Cache tokens — read vs creation | `pricing.test.ts`, `classify.test.ts` | corpus cache_read + cache_creation > 0 |
| Malformed / partial JSONL | `ingest.test.ts` | `sc-malformed-0004` (malformed=1) |

CI coverage: `corpus-scenarios.test.ts` ingests the committed corpus and asserts
all of the above; `scripts/sandbox.sh` re-asserts them through the live API.
Regenerate the corpus with `pnpm build-corpus` (redacted real + oracle) and
`node scripts/build-scenarios.mjs` (synthetic).

## Findings

No computation bug was found — every hard invariant holds and the formulas match
hand-computed expecteds. Three things to be aware of:

| # | Finding | Evidence | Impact | Recommendation |
|---|---------|----------|--------|----------------|
| 1 | **Workflow subagents now link to their orchestrator (resolved).** Was: 249 of 488 subagent sessions had `parent_session_id = NULL` because the Workflow tool emits no `toolUseResult.agentId`, so the `tool_calls.spawned_session_id` link only covered `Agent`/`Task` spawns. | `validate.mjs` [5]; `ingest.test.ts` "workflow-linkage" + "path-less orphan"; `corpus-scenarios.test.ts` | Fan-out now rolls up workflow agents to their spawning session. | **Fixed:** the launching Workflow tool_call's result carries a run id (`wf_<id>`) + name, and the run's subagents nest under `…/subagents/workflows/<runId>/` — so `sessions.workflow_run_id` matches `tool_calls.workflow_run_id`, giving each workflow agent **both** its parent session **and** the exact launching turn (`parent_turn_id`). A path-based parent (`spawn_parent_id`) is the final fallback. The session view groups the fan-out by run (named, counted, linked to its turn). Tokens stay siloed → no double-count. Re-ingest with `ingest --full` to apply on an existing DB (SCHEMA_VERSION 11). |
| 2 | **Cost is cache-dominated.** cache_read = 2.33T tokens = **95.7%** of all tokens; total derived cost $1,912.90. | `validate.mjs` [2]/[3] | Cost correctness rides almost entirely on the cache-read rate, not input/output. | Already handled correctly (separate `cacheRead` rate per model; cache_read excluded from "work" tokens). Keep the pricing table current — a wrong cache-read rate would dominate the error. |
| 3 | **`<synthetic>` model carries 0 tokens.** It appears on 149 rows but sums to 0 tokens, so it never affects cost (hence "all models priced"). | `validate.mjs` [8]; direct query | None today. | No action; documented so a future non-zero `<synthetic>` (which *would* be unpriced) is expected to surface in `validate.mjs` [8]. |

Observation (by design, not a bug): the "turns" KPI sums `turn_count` over all
sessions including subagents (889 main + 506 subagent turns); category/complexity
breakdowns intentionally cover main sessions only.

## Guarantees & guardrails on the corpus

- The committed corpus contains **no agent-lens data** and **no real PII** — the
  redactor scrubs text, paths (usernames stripped), project names, branches,
  emails, URLs, secrets; the generator honors the global exclude list (which
  `build-corpus` defaults to this repo, so agent-lens is never emitted) and fails
  closed on any post-redaction leak (`findLeak`). A fixed `AGENT_LENS_REDACT_SALT`
  makes the corpus byte-reproducible. Raw subsets stay under gitignored `data/`
  and `/tmp`; only redacted output is committed.
- The same exclude list is a first-class pipeline feature (config `exclude` +
  `AGENT_LENS_EXCLUDE`): excluded projects are never collected, never ingested,
  and pruned from the DB on next ingest. See `docs/USAGE.md` → *Exclude projects*.

## Out of scope (follow-up)

None outstanding from the original validation: finding #1 (workflow subagent
attribution) has since been fixed via the structural (`subagents/`-path) linkage
pass; re-run `ingest --full` to apply it on an existing DB.
