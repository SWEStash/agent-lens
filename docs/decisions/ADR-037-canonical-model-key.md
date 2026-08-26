# ADR-037 — A model id resolves to its minor version for grouping and filtering

- Status: Accepted
- Date: 2026-08-26
- Deciders: project owner
- Extends [ADR-035](ADR-035-dashboard-model-filter.md) (the dashboard's model filter)
- Related: [ADR-028](ADR-028-model-pricing.md) (prefix-matched, config-overridable rates)

## Context

Every model aggregate grouped on the **raw** model id as the transcript carried it, and the shortened
label was applied afterwards, for display only. One model can arrive under two ids — a dated snapshot
`claude-haiku-4-5-20251001` and its alias `claude-haiku-4-5` — and both shorten to `haiku-4-5`.

**No arithmetic was ever wrong.** Shortening only relabels; it never merged rows, so no total moved.
Forcing the case in a fixture gives two rows, `calls=2 errors=1` and `calls=2 errors=0`, with the
totals still exact at 4 calls / 1 error / 440 tokens.

What broke was **identity**. `/api/models` returned both ids, so the filter offered two
identical-looking options, and ticking one admitted half the model's work with nothing on screen
saying so. The dashboard showed two bars with the same label and contradictory rates.

The corpus made this concrete rather than hypothetical: `claude-haiku-4-5-20251001` is a real id with
10,408 usage rows, and it is the *only* dated id present — its alias never appears, so no collision
exists yet. This is identity hygiene, done before the alias shows up, not an outage.

PR #48 fixed the *label* and said explicitly that the grouping key was unchanged. That fix makes the
collision case **less** visible, not more: two rows that used to show distinguishable raw ids now
show the same short name. That argues for this change, not for reverting the label.

## Decision

**1. Canonicalize at query time. Storage keeps the raw id.**

No schema change and no `SCHEMA_VERSION` bump. `token_usage.model`, `events.model` and `turns.model`
still hold exactly what was ingested — the only place full fidelity survives. Grouping and filtering
resolve to the canonical key as they read.

**2. Strip a trailing `-YYYYMMDD`, and nothing else.**

| Input | Result | Why |
|---|---|---|
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | A dated snapshot *is* that minor version. |
| `claude-opus-4-8` | unchanged | The minor version is the identity — `4-8` and `4-7` are different models and the charts must keep them apart. |
| `claude-opus-4-8[1m]` | unchanged | A **different price point**. Folding it into the base model would make a cost chart wrong. |
| `<synthetic>` | unchanged | Not a model at all. It carries no date, so the rule is a no-op on it — and ADR-035's split stands: `/api/models` still returns it (the sessions list filters on it for real, 2,094 sessions) while the dashboard drops it from its own options. |
| `claude-x-1234567` / `claude-x-123456789` | unchanged | The hyphen must sit exactly at `length - 9`. Seven or nine trailing digits is not a date. |

**3. Two copies of the rule, pinned against each other.**

`canonicalModel()` in `packages/core/src/pricing.ts`, beside `rateForModel` — the same "an id
resolves to a family" concept, one home rather than a second scheme. `canonModelSql()` in the
server's `sql-util.ts` is the SQL twin:

```sql
CASE WHEN col GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
     THEN substr(col, 1, length(col) - 9) ELSE col END
```

`GLOB` and `substr`, never `LIKE` — `_` is a LIKE wildcard and model ids contain them, the same trap
`ratesCte` documents. `canonical-model.test.ts` asserts the two agree on every case in the table
above, the way `pricing-sql.test.ts` pins the two cost formulas.

**It is not free, and it was measured rather than assumed.** On the 1GB corpus (61,447 usage rows,
250,326 events), evaluating the expression per row costs 10–20ms:

| Query | Raw | Canonical |
|---|---|---|
| `by_model` (tokens + session count) | 48ms | 67ms |
| `edit_reliability` | 74ms | 84ms |
| sessions-list model filter (`EXISTS`) | 20ms | 27ms |
| `listModels` | 21ms | 32ms → **11ms** |

`listModels` gets `ratesCte`'s "resolve once per distinct id" treatment — de-duplicate first, then
strip the eight survivors — which lands it *below* the original undecorated query. The same rewrite
applied to `by_model` (canonicalizing outside the heavy grouping, over distinct `(model, session)`
pairs) measured **75ms against 74ms** — no gain — so that query keeps the straightforward form. This
is ADR-035's rule again: measure the clever version before adopting it, because last time the clever
version lost.

**4. Cost keeps resolving the RAW id.**

This is the constraint that shapes the implementation. `rateForModel` matches by **longest prefix**
and the table is config-overridable (ADR-028), so a user can key an override to a dated id.
Canonicalizing before the rate lookup would silently bypass it — a behaviour that works today.

So `by_model` runs two aggregates rather than one: tokens and `COUNT(DISTINCT session_id)` group
canonically in SQL (the session count *must* be computed at the canonical grain, or a session that
used both ids of a family would be counted twice), while cost groups on the raw id and folds in JS.
`priced` is an AND over the family's raw ids — one unpriced member means the bucket's cost is
understated. `ratesCte()` and `COST_SORT_SQL` are untouched, and `unpriced_models` stays a list of
**raw** ids, because that is exactly what a reader would need to add a rate for.

**5. A raw dated id is still accepted on input.**

The model filter is a URL parameter and is shareable. Incoming filter values are canonicalized
server-side, so `?models=claude-haiku-4-5-20251001` still resolves and now admits the whole family.
Old links keep working and mean the more-inclusive thing; new links emit canonical values.

**6. `shortModel` keeps its date strip.**

The web helper still strips `-YYYYMMDD` for display. It is redundant now that the server never sends
a dated id, and harmless — removing it would make the label depend on the server having
canonicalized, which is a worse failure mode than a duplicated regex.

## Consequences

- The dashboard's filter can no longer offer two options that look identical, and one tick admits a
  model's whole body of work. That is the entire point.
- Model identity is now a **minor-version** concept everywhere a reader sees it: `by_model`,
  `edit_reliability`, the latency legend, `/api/models`, and the per-session model tags.
- On the real corpus **nothing moved**. 128 captured payloads — every aggregate under 10 filter
  states, three buckets, eight sort keys, and the sessions list — are byte-identical once the id
  string `claude-haiku-4-5-20251001` → `claude-haiku-4-5` is normalized out. An independent
  recomputation straight from SQLite, sharing no code with the server, agrees field by field on
  tokens, session counts, cost, and edit-reliability calls/errors.
- The fixture in `dashboard.test.ts` seeding one model under both ids is the regression guard this
  whole change exists for; without a collision in the corpus it is the only place the case is real.
- **Noted, not fixed:** `PRICE_TABLE` has no `[1m]` entry at all, so `claude-opus-4-8[1m]` currently
  prefix-matches the standard rate and is priced as though it were the base model. That is a latent
  pricing inaccuracy, independent of this change, and absent from the current corpus.

## Alternatives considered

- **Strip the date in `shortModel` only** — the state before this ADR. Rejected: it fixes the label
  and leaves the filter offering two identical options, which is the part that is not cosmetic.
- **Canonicalize on ingest, storing the stripped id.** Rejected: it throws away the only record of
  which snapshot actually served the request — permanently, and to save 10–20ms per aggregate on a
  1GB corpus. It would also need a schema version bump and a re-ingest to change the rule later,
  where a query-time expression is one edit.
- **Fold `[1m]` into its base model.** Rejected: a different price point, so a merged bucket's cost
  would be an average of two rates presented as one model's spend.
