# ADR-034 — The weekday × hour heatmap plots turns by default, not tokens

- Status: Accepted
- Date: 2026-08-24
- Deciders: project owner
- Extends [ADR-033](ADR-033-time-analytics-bucketing.md), which settled how this tile buckets and
  localizes its hours but not *what quantity* a cell holds

## Context

The tile shipped plotting mean work tokens per local weekday × hour. Reading it against the real
corpus turned up a cell nobody could explain: Sunday 07:00 and 08:00 carried real spend with zeros
on either side of them, on a row that was otherwise a quiet evening profile.

The data was correct. Both cells come from a single Sunday, 2026-08-16, whose entire usage falls
between 10:54 and 11:06 UTC — twelve minutes, in which one parent session fanned out **258
subagents** and burned 1.8M work tokens. It straddles the hour boundary, which is why exactly two
adjacent cells light up. 353 usage rows with 353 distinct timestamps: not duplicated data, not a
bucketing artefact.

The arithmetic was also correct, including the denominator: [ADR-033](ADR-033-time-analytics-bucketing.md)'s
fold divides by the calendar occurrences of each weekday, and all 14 Sundays in range were counted,
6 of them empty.

What was wrong was the **reading**. That cell rendered at 62,951 tokens/h. A different cell — Sunday
21:00, worked on 5 of the 14 Sundays — rendered at 64,732. Within 3% of each other, so the same
colour step: a twelve-minute accident and a five-week habit, indistinguishable.

The cause is a property of the quantity, not of the fold. **Tokens per hour are unbounded.** A
fan-out can put a month of evenings into one cell, so a cell's value is independent of how often
that hour is worked — while a heatmap reader takes intensity to mean exactly that frequency.

## Decision

**1. The default metric is turns started, main sessions only.** A turn count is bounded per hour —
there is a limit to how many times a person can prompt in sixty minutes — so a cell's value tracks
how often the hour is worked. On the corpus this separates the two cells above by **11×** (0.07
against 0.79 turns/day) where tokens separated them by 3%, and it reverses their order to the
correct one.

**2. Tokens remain available behind a metric toggle.** "When did the spend happen" is a real
question; it is simply not the one a reader assumes a heatmap answers. The toggle follows the
existing per-card pattern (`TokensByModel`): ephemeral `useState`, a `.seg` control in `actions`.

**3. The population rule flips with the metric,** per §13.1 of the design: tokens are a spend metric
and count both populations, because a subagent's tokens come off the same quota; turns are a
human-behaviour metric and restrict to `is_sidechain = 0`, because a subagent has nobody in it. This
is not incidental — it is *why* a fan-out can no longer inflate a cell.

**4. `turn_hours` is a second raw-hourly series on `/api/dashboard/time`,** shaped like `burn_hours`
and folded in the browser the same way. Separate rather than a column on the existing series because
the population rule differs and a turn's time is its own `started_at`, not an event join.

**5. The card is retitled "When work happens".** The chart id stays `burn-heatmap` — ids are
persisted per reader in `dashboard.layout`, and renaming one would un-hide the card for anyone who
had hidden it.

## Alternatives rejected

**Median instead of the mean.** Tested against the corpus in both forms, and both are worse:

- *Median over every calendar occurrence* blanks **110 of 168 cells**, up from 36. A specific hour on
  a specific weekday is worked on a minority of its occurrences almost everywhere, and a median needs
  majority support to be non-zero. The entire Sunday row goes dark — no Sunday hour is worked on more
  than half of the 14 Sundays — so the chart would assert weekends are never worked, when 8 of 14
  Sundays were. That is a worse falsehood than the one being fixed.
- *Median over worked days only* keeps all 132 cells but **amplifies** the problem: the one-off rises
  to 881,313 and outranks the recurring hour outright. It also reintroduces the divide-by-days-worked
  bias that the calendar denominator exists to remove.

**Session counts instead of turns.** Works — it collapses the fan-out identically — but discriminates
less (2.7× peak-over-median against turns' 3.5×), and a session spanning six hours counts in every
one of them, which turns do not.

**Rolling a subagent's activity up to its parent session.** Changed exactly one cell in the whole
grid: subagents almost always run inside an hour their parent is already active in. Not worth the
join.

**Keeping tokens and marking thin cells.** Considered and left open — it addresses a related but
distinct problem (17 cells rest on a single day under *every* metric) and does not fix the ordering.

## Consequences

- **The tile answers a different question than it was specified for.** §14.2 justified it as
  token-weighted and provider-neutral. Turns are still provider-neutral, and the "when do I usually
  have headroom" motivation is served better by a rhythm than by a spend total — but this is a
  deliberate change of question, and the guide says which metric is showing and what each counts.
- **Turns cover slightly fewer cells: 126 of 168, against tokens' 132.** Six hours carry token usage
  but no main-session turn *starting* in them — a turn that began at 13:50 and ran past 14:00 is
  counted once, at 13:00. This is correct for "when did work start" and is why the two metrics do not
  agree cell for cell.
- **Cell values are fractions.** 0.79 turns per Sunday is harder to read than 64.7k tokens, so the
  heatmap formats decimals rather than reusing `fmtTokens`, which would round every turn cell to "0".
  The precision follows the peak rather than the individual value (two places below a peak of 2, one
  above) so the legend's ticks read as one scale — a fixed single decimal printed the first two ticks
  on the small demo corpus as "0" and "0.0".
- **Support is still invisible.** 17 cells rest on a single observed day under every metric tested.
  Turns make that matter less — the value now correlates with frequency — but do not make it visible.
  Putting the support in the tooltip remains open.
- **`DashTime` gained a key**, which is an exact-key assertion in `packages/server/test/contract.test.ts`
  and a shape the empty-DB test also pins.
- **The payload roughly doubles**: 71 KB to 104 KB on the full corpus (`burn_hours` 1,011 rows / 56 KB,
  `turn_hours` 870 rows / 45 KB). [ADR-033](ADR-033-time-analytics-bucketing.md)'s bound still holds —
  size tracks hours-with-activity × sources, not row count — and its ~1 MB threshold for an explicit,
  documented coarsening is unchanged; there is simply a second series counting toward it now.
