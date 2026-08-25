# ADR-034 — The weekday × hour heatmap: what a cell counts, and how it becomes a colour

- Status: Accepted
- Date: 2026-08-24
- Deciders: project owner
- Extends [ADR-033](ADR-033-time-analytics-bucketing.md), which settled how this tile buckets and
  localizes its hours but neither what quantity a cell holds nor how that value is encoded

## Context

The tile shipped plotting mean work tokens per local weekday × hour. Reading it against the real
corpus turned up a cell nobody could explain: Sunday 07:00 and 08:00 carrying spend with zeros either
side.

The data was correct, denominator included. Both cells come from one Sunday whose entire usage falls
in twelve minutes, during which a single parent session fanned out **258 subagents** for 1.8M work
tokens, straddling the hour boundary.

What was wrong was the reading, in two independent ways.

**The quantity.** That cell rendered at 62,951 tokens/h; Sunday 21:00 — worked 5 of 14 Sundays —
rendered at 64,732. Same colour, with the accident ranking above the habit. Tokens per hour are
unbounded, so a cell's value is independent of how often the hour is worked, which is the one thing a
reader takes a heatmap cell to mean.

**The encoding.** Values were binned into seven colour steps, and under binning every non-zero cell
takes the lowest step's full colour however small the value. So empty→lowest was necessarily the
largest jump on the scale — ΔL 0.179 against ~0.065 between every other adjacent pair, and the only
pair also crossing from neutral into colour. Two rounds of re-picking colours each helped and neither
resolved it, because the cause is structural.

## Decision

**1. The default metric is turns started, main sessions only**, with tokens behind a toggle. A turn
count is bounded per hour, so a cell tracks how often the hour is worked; on the corpus this separates
the two cells above by 11× and reverses their order to the correct one. "When did the spend happen" is
still a real question — just not the one a reader assumes a heatmap answers.

**2. The population rule flips with the metric** (§13.1): tokens are spend and count both populations,
because a subagent's tokens come off the same quota; turns are human behaviour and restrict to
`is_sidechain = 0`. This is *why* a fan-out can no longer inflate a cell.

**3. `turn_hours` is a second raw-hourly series on `/api/dashboard/time`**, shaped like `burn_hours`.
Separate rather than a column on it because the population rule differs and a turn's time is its own
`started_at`, not an event join.

**4. Cells interpolate along the `--burn-*` stops rather than snapping to one**, and the gradient
starts at the empty cell's own colour, so a value 1% up the scale renders 1% up. Distinct cell colours
went from 8 to 71 (turns) / 104 (tokens). The vars are gradient anchors now, not a palette; what still
governs their shape is recorded in `styles.css`.

**5. The transform follows the metric**: `sqrt` for tokens (276× from smallest active cell to peak),
`linear` for turns (3.5× over the median). It is a property of the distribution, not of the chart.

**6. The legend is a gradient bar with value ticks**, positions even and values bending with the
transform. The card is retitled "When work happens"; the id stays `burn-heatmap`, because ids are
persisted per reader and renaming one would un-hide the card for anyone who had hidden it.

## What this gives up

**A cell with any work no longer clears 2:1 against an empty one.** That floor had been treated as an
accessibility requirement and was held through two rounds of re-colouring.

It was dropped because it is incompatible with the complaint rather than merely in tension with it: a
value of 0.07 against a peak of 5.0 cannot simultaneously look proportionally tiny and be clearly
visible. Four candidate ramps were rendered against the real corpus, and every one that softened the
jump enough also fell below the floor. The owner chose proportionality after seeing them side by side.

Value is never carried by colour alone — every cell has a hover tooltip with its exact figure, and the
legend's ticks map colour to number. **This does not generalise**: it is a judgement about a 168-cell
overview grid, not licence to drop contrast floors on marks a reader must identify individually.

## Alternatives rejected

- **Median over every calendar occurrence** — blanks 110 of 168 cells and darkens the whole Sunday
  row, asserting weekends are never worked when 8 of 14 were.
- **Median over worked days only** — lifts the one-off to 881,313, the loudest cell on the row, and
  reintroduces the divide-by-days-worked bias the calendar denominator exists to remove.
- **Session counts** — collapse the fan-out identically but discriminate less (2.7× peak-over-median
  against turns' 3.5×), and a six-hour session counts in every hour it touches.
- **Rolling subagent activity up to the parent** — changed exactly one cell in the grid.

## Consequences

- **Near-zero cells are close to invisible, deliberately.** Anyone "fixing" that by restoring a minimum
  step colour reintroduces the complaint this ADR answers.
- **The tile answers a different question than §14.2 specified.** Turns are still provider-neutral and
  the "when do I have headroom" motivation is served better by a rhythm than a spend total, but the
  change of question is deliberate and the guide says which metric is showing.
- **Turns cover 126 of 168 cells against tokens' 132** — six hours carry usage but no main-session turn
  *starting* in them (one beginning 13:50 and running past 14:00 counts once, at 13:00).
- **Support is still invisible.** 17 cells rest on a single observed day under every metric tested. The
  gradient makes that matter less; it does not make it visible. Putting it in the tooltip stays open.
- **The ordinal palette validator no longer governs the ramp end to end** — it checks discrete steps.
  The anchors still pass it, which is a cheap way to keep the curve well-formed, but that is no longer
  the reason they are shaped as they are.
- **Cell values are fractions**, so the heatmap formats decimals with precision following the peak
  rather than the value; `fmtTokens` would round every turn cell to "0".
- **`DashTime` gained a key** — an exact-key assertion in `packages/server/test/contract.test.ts` — and
  the payload roughly doubles, 71 KB to 104 KB on the full corpus. ADR-033's bound and its ~1 MB
  coarsening threshold are unchanged; there is simply a second series counting toward it.
