# ADR-028 — Model pricing: derived at read time, overridable in config, never silently missing

- Status: Accepted
- Date: 2026-08-01
- Deciders: project owner
- Extends: [ADR-003](ADR-003-data-model-and-store.md) (traces record no cost), [ADR-027](ADR-027-runtime-diagnostics-surface.md) (the diagnostics surface this reports on)

## Context

Every session recorded from 2026-07-24 onward showed **$0 cost**. Nothing had broken: Claude Code
moved to `claude-opus-5`, and `PRICE_TABLE` in `packages/core/src/pricing.ts` had no entry for it.
`rateForModel()` returns `null` for an unmatched prefix, `costForUsage()` returns `0` for a null
rate, and $0 is a perfectly ordinary-looking number. Re-deriving over the real store afterwards
showed **$712.34** of Opus 5 usage that had been reported as free for a week.

Transcripts do not record cost — they record token counts and a model id. Cost is therefore always
*derived*, and its correctness rides entirely on a table of rates that a human maintains. That table
has two failure modes, and the incident was both at once:

1. **It goes stale by construction.** A new model ships whenever Anthropic decides, not whenever we
   cut a release. Between those two moments every session using it is mispriced.
2. **It fails silently.** A missing rate is indistinguishable, in the UI, from a genuinely free
   session. The dashboard KPI already listed `unpriced_models`, but nothing said so at ingest, on the
   About page, or next to the per-session cost figure — which is where the $0 was actually read.

A third constraint frames the whole decision: **there is no such thing as effective cost here.**
Usage is drawn against subscription quota whose internals are not observable from a transcript. Any
number this tool shows is a list-price estimate of what the same tokens would have cost on the API.
That is genuinely useful — for attributing spend across projects, or feeding an invoice — but it is
an estimate, and the design should stop pretending otherwise rather than chase an accuracy it cannot
reach.

## Decision

### 1. Cost stays derived at read time. It is not frozen at ingest.

The incident is the argument. Because cost is computed from `token_usage` on each query, the fix was
two entries in a table: no migration, no re-ingest, and $712 of previously-invisible spend appeared
the moment the server restarted. Had cost been materialized at ingest, those 4,532 rows would hold a
permanent $0 and correcting them would need a backfill pass over historical data.

This is the same invariant the rest of the store already rests on: `events.raw_json` keeps every line
verbatim for lossless re-derivation ([ADR-011](ADR-011-compressed-raw-json.md)), `rebuildDerived`
recomputes the derived tables, and the stamped engines (`classifications.classifier_version`,
`findings.detector_version`) exist precisely so a superseded derivation can be re-run. Pricing is the
same shape of problem and gets the same answer.

Freezing at ingest also does not buy what it appears to. "The price when it ran" is not "the price in
the table on the day we happened to ingest it" — those differ for any backfill, re-ingest, or archive
ingested later. Point-in-time accuracy would need effective-dated rates, which is a different feature
(see Decision 5).

There is no performance case either: the aggregate is a `GROUP BY model` over ~37k rows.

### 2. The built-in table is a default, not the only source

`PRICE_TABLE` remains the shipped default. A `pricing` block in `agent-lens.config.json` overlays it,
keyed by the same model-id prefix:

```json
{
  "pricing": {
    "claude-opus-5": { "input": 5, "output": 25 },
    "claude-opus-5-internal": { "input": 0, "output": 0 }
  }
}
```

`cacheWrite` and `cacheRead` are optional and default to the convention the table already documents
(1.25× and 0.1× of input) — they are mechanical in every entry we ship and the easiest to mistype.

This does not remove the maintenance: the built-in table still wants updating, because most users
will never write a `pricing` block. It removes the *urgency*. A model that launches between releases
can be priced without one, a Bedrock or enterprise-agreement user can substitute their real rates,
and anyone who doesn't care is unaffected.

Resolution follows the existing idiom exactly (`resolvePricing(cfg)` beside `resolveDbPath` /
`resolveServerConfig`): a pure function over an injected config, tagged with a `ConfigOrigin`.
Deliberately narrower than the full precedence chain — like `resolveRetention`, only `file` and
`default` are reachable. Prices are a table, not a scalar; there is no sensible flag or env layer,
and inventing one would mean a second way to be wrong.

The merged table is installed process-wide once at startup (`usePricing`, called from the ingest and
server entry points). **Accepted trade-off:** module-level state rather than threading a table
through `costOf` → `dashboard` → every route. It is a single-process CLI, set once before anything
derives a cost, and the diagnostics report the table actually in force rather than re-resolving.

### 3. A malformed override degrades the estimate. It does not stop the tool.

An entry with a non-numeric or negative `input`/`output` — or a mistyped optional cache key — is
reported and dropped, leaving the built-in rate in place. This is deliberately unlike `validatePort`,
which throws on a bad value from any layer.

The asymmetry is the point. A bad port means the server cannot do its job. A bad price means one
number in a labelled estimate is off, and refusing to start would deny the operator access to every
trace they have over a typo in an optional cosmetic field. Silence would be the other failure though,
so the rejected keys are surfaced on stderr at startup, in `agent-lens config`, and on the About
page.

### 4. Unpriced models are reported wherever the cost they distort is shown

The rule: **a cost figure that is missing a rate says so.** Four surfaces, ordered by when they catch
it:

| Surface | What it shows | Why there |
|---|---|---|
| Ingest report | `unpriced=1 model(s): claude-opus-5 (4532 records)` | New model ids enter the system here, with a human watching |
| `agent-lens config` | `models priced N [origin]`, plus overrides and rejected keys | Mirrors the About page (ADR-027 keeps the two in step) |
| `/api/about` → About page | The same, plus every unpriced model found in this store | The diagnostics surface; answers "why is my cost low?" |
| Sessions list + transcript header | `$0.79 ⚠` with a tooltip naming the models | Where the misleading number is actually read |

The dashboard KPI already carried `unpriced_models` and is unchanged.

Per-session scope is carried by a single `unpriced_models: string[]` on `SessionSummary` and
`SessionDetailData`, produced by the one `attachSessionCost` path both share. `<synthetic>` — Claude
Code's stamp for locally-generated messages — is excluded everywhere: it made no API call, so it is
correctly unpriced and reporting it would train the operator to ignore the warning.

`WorkflowView` and `AgentRow` also render costs and are deliberately **not** marked in this change,
to keep the contract surface small; they are a follow-up if the marker proves useful.

### 5. Current list price is the permanent semantics. Effective-dated rates are deferred.

The table holds one rate per model prefix, which is today's list price. Two consequences accepted
explicitly:

- **Introductory pricing is not modelled.** Sonnet 5 runs an introductory $2/$10 through 2026-08-31;
  we bill the $3/$15 list price. A date-dependent rate would silently change a past session's cost
  when the window closes, which is worse than being consistently approximate.
- **A mid-generation price change for the same model id cannot be represented.** The table comment
  already records one such event (Opus 4.5 cut the Opus tier from $15/$75 to $5/$25); it is handled
  only because the change came with new model ids.

Revisit if — and only if — someone needs per-period historical accuracy. The trigger is a concrete
request to reconcile a specific month against a real invoice, not the general observation that prices
move.

## Consequences

- The price table is now two things: a shipped default, and a user-owned overlay. Both are reported
  with provenance, so "which rates am I using?" is answerable without reading source.
- A new model still needs a table entry to be priced — but it is now *loud* while it isn't, and the
  operator can fix it themselves without waiting for a release.
- No schema change, no migration, no new table. Cost remains absent from the store by construction
  ([ADR-003](ADR-003-data-model-and-store.md)).
- The corpus guard in `packages/core/test/pricing.test.ts` asserts every model id in the committed
  fixture corpus resolves to a rate. When the corpus is refreshed from newer transcripts, an unpriced
  new model fails the build instead of quietly zeroing out — the closest thing to an automatic
  early-warning available without network access.
- `unpriced_models` is optional-chained in the two UI call sites: a newer SPA served by an older
  server (the mismatch the About page already warns about) degrades to no marker rather than
  crashing the header.

## Alternatives considered

- **Fetch prices from the API and refresh automatically.** Rejected, primarily because *there is no
  machine-readable price source*. `GET /v1/models/{id}` returns `max_input_tokens`, `max_tokens` and
  a capability tree — no pricing. Automation would mean scraping a docs page, which fails by
  returning **wrong** numbers rather than missing ones: strictly worse than the failure this ADR
  exists to fix. It would also put a network call into a tool that is local-only and loopback-bound
  by design ([ADR-005](ADR-005-privacy-posture.md)), for a cosmetic estimate. The one thing the
  Models API could tell us — "a model exists that you don't know about" — we already learn from our
  own ingested data, offline.
- **Freeze cost at ingest time.** Rejected — Decision 1. Would have made this very incident
  unfixable without a backfill.
- **Store cost with a `pricing_version` stamp**, mirroring `classifier_version`. Rejected: the stamp
  pattern exists so an expensive derivation need not be recomputed. This one is a multiplication over
  a `GROUP BY` — the bookkeeping would cost more than the arithmetic it saves.
- **Fail startup on a malformed `pricing` entry**, consistent with `validatePort`. Rejected —
  Decision 3.
- **Effective-dated rates now.** Rejected as speculative — Decision 5 records the trigger to revisit.
- **A `agent-lens pricing check` command.** Rejected: the ingest report and the About page already
  answer the question at the moments it arises, and a command only helps someone who already
  suspects the problem.
- **Marking cost everywhere it appears** (workflow view, agent rows). Deferred — Decision 4.

## Related

- [ADR-003](ADR-003-data-model-and-store.md) — the normalized store; no cost is recorded in traces
- [ADR-005](ADR-005-privacy-posture.md) — local-only posture, which the auto-refresh option violated
- [ADR-011](ADR-011-compressed-raw-json.md) — lossless re-derivation, the invariant Decision 1 rests on
- [ADR-026](ADR-026-api-response-contracts.md) — where `AboutResponse.pricing` and `unpriced_models` are declared
- [ADR-027](ADR-027-runtime-diagnostics-surface.md) — the About page, and its rule that it mirrors `agent-lens config`
