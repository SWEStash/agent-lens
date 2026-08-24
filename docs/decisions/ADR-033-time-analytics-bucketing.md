# ADR-033 — Time analytics bucket by event time, and localize in the browser

- Status: Accepted
- Date: 2026-08-22
- Deciders: project owner
- Extends [ADR-026](ADR-026-api-response-contracts.md) (`DashTime` is a declared contract); diverges deliberately from the bucketing convention every other aggregate in `dashboard.ts` follows

## Context

The dashboard answers *how much* — tokens, cost, errors, counts — but nothing about *when*. Adding
that raised two questions the existing aggregates had never had to face.

**Bucketing.** Every series today groups on `sessions.started_at`. That is correct for "how many
sessions started this week" and quietly wrong for "when do tokens get spent": a main session runs at
a median 92% idle and routinely spans several hours, so its entire spend lands in the hour it began.
`token_usage` carries no timestamp of its own — its primary key is `event_uuid` — so the alternative
is a join to `events`.

**Timezone.** Every stored timestamp is ISO-8601 UTC and `strftime` with no modifier is UTC, so a
weekday × hour chart is UTC unless something introduces a zone. Bucketing a 21:00 session into the
next UTC day corrupts every per-day and per-hour number.

## Decision

**1. `burn_hours` buckets by event time.** It joins `events e ON e.uuid = t.event_uuid` — a primary
key lookup — and groups on `strftime('%Y-%m-%dT%H', e.timestamp)`. The other two series in the
payload (`latency`, `review`) stay on the session-start bucket, because they are per-turn measures
that follow the dashboard's global bucket control.

**2. The server returns raw hourly UTC rows; the browser folds them into local weekday/hour.**
`packages/web/src/tz.ts` resolves the zone as pinned pref → `Intl.DateTimeFormat().resolvedOptions().timeZone`
→ UTC, and maps each `YYYY-MM-DDTHH` key through a memoized `Intl.DateTimeFormat`.

**3. One endpoint, `/api/dashboard/time`, not one per tile.**

## Consequences

- **The burn heatmap will not tie out against "Tokens over time."** Same tokens, different
  attribution. This is the cost of the decision, it is deliberate, and the tile says so in its hint.
  Anyone reconciling the two numbers should reach for this ADR, not a bug report.
- **One exported snapshot reads correctly in every viewer's zone.** A `tz` query param was the
  obvious alternative and was rejected twice over: SQLite's `strftime` accepts only a fixed `±HH:MM`
  offset, so a range crossing a DST transition would be silently wrong, and the Pages snapshot would
  be baked at whichever offset the author exported from.
- **Payload size is bounded by hours-with-usage × sources, not by rows.** The full 1 GB corpus (90
  days) produces 994 rows / 71 KB. If a much longer range ever pushes this past ~1 MB, the fix is an
  explicit, documented coarsening — never a silent cap.
- **A single failing query blanks all four tiles**, the price of one endpoint. Acceptable because
  they already share one visibility gate: the dashboard skips the request entirely when every Part II
  tile is hidden.
- **`file_changes` has no index on `turn_id`.** The review-latency query resolves "did this turn
  write files" against a materialized set of turn ids rather than a correlated `EXISTS`, which is the
  difference between 5.7s and 0.02s on the real corpus. There is no migration mechanism (a
  `SCHEMA_VERSION` bump means a full re-ingest), so the query absorbs this rather than the schema.
