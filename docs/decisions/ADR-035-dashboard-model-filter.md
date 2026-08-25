# ADR-035 — Filtering the dashboard by model, at each aggregate's own grain

- Status: Accepted
- Date: 2026-08-24
- Deciders: project owner
- Extends [ADR-026](ADR-026-api-response-contracts.md) (`DashOverview.range` is a declared contract and gains a key)

## Context

Model was selectable only inside the "Model response latency" tile, so every other chart pooled every
model and "what did opus-5 cost me" had nowhere to be asked. The filter belongs beside source and
date range, applying to every chart at once.

The obstacle is that **`sessions` has no model column.** Model lives at three grains —
`token_usage.model`, `turns.model`, `events.model` — and a session routinely uses more than one (on
the corpus this was designed against, 220 of 7,365 sessions used two or more, one used four). So
"filter the dashboard by model" has no single meaning, and picking one meaning for all aggregates
would make most of them wrong.

## Decision

**1. Each aggregate filters at the grain where its own rows carry a model.**

| Aggregate | Filtered on |
|---|---|
| token totals, cost, `by_model`, burn heatmap, burn by source | `token_usage.model` |
| turn counts, turn duration, model latency, `turn_hours` | `turns.model` |
| tool counts, tool frequency, error types, skills, subagent fan-out | `events.model`, joined through `tool_calls.event_uuid` |
| session counts, session duration, category, complexity, source | no model dimension — see 2 |

`tool_calls` has no model column of its own. `events.model` is the attribution to use, **not
`tool_calls.resolved_model`**, which is NULL on all but 366 rows; the event join covers 68,301 of
68,301 tool calls.

**2. Aggregates with no model dimension restrict to sessions that used a selected model**, via a
correlated `EXISTS` over `token_usage` inside `sessionWhere`. A session is counted whole, including
the work it did with models you did not tick — there is no way to count a fraction of a session, and
the affected guides say so.

**3. An empty selection emits no predicate at all.** This is the load-bearing decision, and it is not
merely an optimization: listing every model is a *different query* from not filtering. `<synthetic>`
is deliberately not offered as an option (it marks replies generated without an API call and carries
0 work tokens), so an explicit all-models list drops the 1,880 sessions that never called a real
model, plus every row whose model is NULL. Omitting the parameter is what keeps the default honest —
and it also means a model ingested tomorrow is included rather than excluded by a stale URL.

**4. Null-model rows are dropped when a subset is selected.** An unattributable row cannot answer
"was this opus-5". By decision 3 the default keeps them. Note the shape of this: an `IN` list drops
NULLs *silently*, which elsewhere in this file was a bug — `modelLatency` needs `IS NOT '<synthetic>'`
rather than `<>` for exactly that reason. Here the drop is intended, and each site says so.

**5. Two aggregates opt out entirely.**

- **`reviewLatency`** takes the session restriction and never a per-turn model predicate. Its
  `LEAD(tn.started_at) OVER (PARTITION BY tn.session_id ORDER BY tn.seq)` reads "the next turn" from
  whatever rows survive the `WHERE`, so narrowing per turn would stitch together turns that were
  never adjacent and report turnarounds that never happened.
- **The workflow rollup** is not model-filtered at all. `workflow_results` has no session join to
  carry the restriction, and its only model column is `default_model` — the run's default, not what
  spent the tokens. Its KPIs therefore stay put while every other tile narrows.

**6. A selection of no models is not offered.** It admits no data, and every URL spelling of it
collides with the empty parameter that means "no filter". The last ticked box stays ticked.

## Alternatives rejected

**A `MATERIALIZED` CTE of session ids for decision 2.** This was the plan, by analogy with
`reviewLatency`, where a correlated `EXISTS` cost 5.7s against 0.02s. Measured rather than assumed,
the analogy does not hold: that case scans `file_changes`, which has no `turn_id` index, whereas
`token_usage` has `idx_token_usage_session`. On the same 1 GB corpus the `EXISTS` runs in **15ms**
and the materialized form in **21ms** — so the simpler query is also the faster one, and no new index
is needed.

**Filtering every aggregate on one grain.** Whichever grain were chosen, the others would answer a
question about a different set of rows while looking authoritative.

## Consequences

- **A session count and a token total respond differently to the same click**, by decision 2. The
  session-grain guides state this; it is the single most likely source of a "these numbers disagree"
  report.
- **The latency tile moves least.** A model is counted there once per turn it answered, not by what
  it spent — haiku is the third-largest consumer while contributing nine turns, so unticking it moves
  the token charts a great deal and that tile almost not at all.
- **`DashOverview.range` gains `models: string[] | null`**, where null means no filter was applied —
  which is not the same as every model being listed.
- **`/api/models` no longer returns `<synthetic>`**, by decision 3.
- **The static snapshot cannot honour it.** `resolveUrl` drops the query string and maps each
  endpoint to one pre-computed file, so the control is disabled there. Source and date range have
  always had this defect silently; this makes it visible for one filter rather than fixing it for all.
