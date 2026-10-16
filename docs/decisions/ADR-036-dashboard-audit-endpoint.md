# ADR-036 — One audit endpoint, and four tiles that refuse to score anything

- Status: Accepted
- Date: 2026-08-25
- Deciders: project owner
- Extends [ADR-035](ADR-035-dashboard-model-filter.md) (each aggregate filters at its own model grain)
- Related: [ADR-017](ADR-017-security-findings.md) (the findings the fourth tile trends)

## Context

The dashboard could say what the work cost and when it happened. It could not say anything about
**how it went** — whether a model gets file edits right, whether plans get sent back, whether the
agent keeps re-editing the same file, whether findings are trending.

Four aggregates answer those, and all four were verified against the corpus before any of them was
built. What the corpus mostly established, though, is what *cannot* be said. Two framings were tested
and rejected outright:

- **Tokens per line of churn**, as an efficiency measure. It is sign-inverted — a surgical three-line
  fix that resolves the problem scores as the worst possible outcome — and it is a lines-of-code
  productivity metric with a cost numerator, which the SPACE and DORA literature would classify as an
  activity metric misused as a performance one.
- **A composite "struggle" score** over tool-error density and rework concentration. Both directions
  were measured and both are flat: 440 / 568 / 609 / 579 tokens-per-line across error-density bands,
  535 / 570 / 573 across rework bands. The components do not combine into anything.

So the tiles report observables and let the reader interpret them. That constraint is the decision;
the endpoint is the easy part.

## Decision

**1. One endpoint, `GET /api/dashboard/audit`, not four.**

They share a shape, which is the only reason to bundle them: every one of the four reaches a model
through `events.model`, so all four are row-grain for the model filter and none needs ADR-035's
session-grain `EXISTS` fallback. `events.model` is populated on 100% of the rows each join reaches —
12,511 of 12,511 `file_changes`, 2,288 of 2,288 `findings`, 746 of 746 plan and question calls.

It follows the `/api/dashboard/time` delivery pattern exactly: a separate `useAsync` rather than a
fourth entry in the dashboard's `Promise.all` (one failing query must not blank the whole page), and
the fetch is skipped entirely while all four tiles are hidden.

**2. Each aggregate declares its population.**

| Aggregate | Population | Why |
|---|---|---|
| `edit_reliability` | both | A subagent's edits are real edits against real files. |
| `plan_rejections` | main sessions only | A subagent has no human to reject it — and all 746 such calls on the corpus are already `is_sidechain = 0`. |
| `file_rework` | both | Same as edits. |
| `findings_over_time` | both | A subagent's risky command is a real risky command. |

**3. A rejection is `error_type = 'user-rejected'`, not `status = 'error'`.**

Some AskUserQuestion calls fail for real and bucket as `other`; counting them as rejections would
attribute a tool failure to the user. On the corpus: ExitPlanMode 73 rejected of 317, AskUserQuestion
43 of 429.

This is deliberately **a different number from the `rejection-rate` KPI**, which is every rejected or
blocked tool call over every tool call — a far larger denominator. The tile is named "Plans &
questions sent back" rather than anything containing "rejection rate", and its guide points at the
KPI as the other number.

**4. `findings_over_time` buckets on the finding's own event timestamp.**

`findings` carries no time column. The alternative was its session's `started_at`, which every other
series on the dashboard uses — but a finding belongs to the tool call that triggered it, and a long
session can raise one hours after it began. Every row joins to a timestamped event, so the honest
time is available. This is the only series here whose x-axis is not `sessions.started_at`, and
`bucketExpr` takes a column parameter because of it.

**5. `file_rework` always emits all five bands, at zero when empty.**

A histogram whose x-axis changes shape under a filter is a different chart each time it is read.

**6. The dashboard gets a security chart; it still gets no Security view.**

The "No Security view" note in `presets.ts` reasoned that one security KPI over an empty grid is not
a view. A chart does not change that — one KPI beside one chart is still not a view, and `/security`
is where findings are actually read, dismissed and muted. The chart belongs on the dashboard because
a **trend** is the one thing that page cannot show.

## Alternatives considered

**Four endpoints, one per tile.** More `writeSnap` lines, four fetches to gate, and four places for
the model-grain rule to drift. They are one payload because they are one decision about grain.

**Ranking `edit_reliability` by failure rate.** Rate-ordering promotes whichever model made nine
calls to the top of the chart, and the ranking a reader takes from a bar chart is the one that
matters. It ranks by call volume, with the sample size in every tooltip.

**A rework score, or a "reworked" session badge.** See the struggle-score result above — it is flat.
The panel names the files and stops.

## Consequences

- **Every future aggregate on this endpoint must declare its model grain**, or it will silently
  ignore a control the reader believes is global. That failure is invisible: a plausible number, no
  error.
- **`edit_reliability` includes `NotebookEdit`**, which was parity with `file_changes.tool_name` when
  this shipped; that table also carries `Bash` shell writes since ADR-022's 2026-09-02 amendment,
  which this tile deliberately does not count — it measures the file-editing tools' failure rate.
  Earlier analysis in the design notes covered Edit and Write only, so its figures differ slightly
  from the shipped tile.
- **The tile is confounded by era and task mix** and says so in its guide: older models ran on older
  sessions doing different work. It is a comparison within a time window, not a leaderboard.
- **A bucket with no plans in it plots as a gap, not as 0%** — an empty week must not read as a
  flawless one.
- **`file_rework` is the one series that is never empty**, which is what the contract test uses to
  pin the row shape on a corpus with no Edit calls in it.
- **The static snapshot serves one pre-computed `dashboard/audit.json`**, so the filters do not reach
  it — the same limitation ADR-035 records for every other dashboard endpoint.
