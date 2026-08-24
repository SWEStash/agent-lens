# ADR-032 — Per-event token usage is attributed to the message that renders it

- Status: Accepted
- Date: 2026-08-21
- Deciders: project owner
- Extends [ADR-026](ADR-026-api-response-contracts.md) (`EventNode` is a declared contract); depends on the storage decision in [ADR-003](ADR-003-data-model-and-store.md) (`token_usage` keyed by `event_uuid`)

## Context

`EventNode` carried no token usage. Putting it on the wire is what lets the transcript show a
per-message token chip and lets the session timeline band size a mark by the work behind it — one
server change serving both.

The obvious implementation is to join `token_usage` on `event_uuid` and ship the row as-is. Measured
against a 1 GB corpus, that turns out to attribute most of a session's spend to messages that draw
nothing on screen:

| | share |
|---|---|
| usage rows sitting on an event with no text, no thinking and no tool call | **52.2%** |
| work tokens carried by those rows | **75.2%** |

The cause is not a defect in collection or ingest. Two correct behaviours compose badly:

1. **Claude Code writes one transcript line per content block** of an assistant response, and every
   one of those lines repeats the same `usage` and the same `message.id`.
2. **Ingest deduplicates them** on the unique `(session_id, message_id)` index
   (`pipeline.ts`, `insTokens`), so a response contributes exactly one `token_usage` row — no
   double-counting. `ON CONFLICT DO NOTHING` means the surviving row keeps the **first** line's
   `event_uuid`.

That first block is almost always a `thinking` block, and thinking arrives with its text already
stripped — an empty string plus a signature. Sampling 1 050 thinking blocks found **0** with text in
the source and **0** cases where text existed in the source but was not stored: nothing is lost, and
`events.thinking` is empty across the corpus for this reason, not because of
[ADR-031](ADR-031-transcript-text-is-stored.md)'s read path.

So the anchor event is real, correct, and invisible — and a naive per-row join would have made the
token chip appear on a fifth of the messages it belongs on, and the timeline band's bar heights
describe a quarter of reality (measured: 136 of 157 marks pinned to the minimum height).

## Decision

**`EventNode.usage` is the usage of the assistant RESPONSE the event belongs to, not the raw
`token_usage` row keyed by its uuid.** `foldUsage` (`packages/server/src/db.ts`) walks each turn in
`seq` order, carries usage from non-rendering events forward, and attaches the accumulated total to
the next event that renders something. Usage still pending at the end of a turn folds back onto that
turn's last rendering event.

Forward, because the content follows the usage-bearing line in **91%** of cases corpus-wide (29 120
forward against 13 backward). Usage never crosses a turn boundary.

An event that receives no usage **omits the key entirely** rather than carrying `null`: most user and
meta events have none, so this keeps the payload from growing by `events x 4` integers for data that
mostly does not exist. Measured cost of the field: **+0.41%** on a typical session payload, **+2.40%**
on the largest in the corpus (1 632 events).

### Rejected alternatives

- **Ship the raw row and let each consumer compensate.** Two consumers already need this, and they
  would drift; it also leaves the contract meaning "an arbitrary line of the response".
- **Fold in the browser, for the timeline only.** The token chip would keep under-reporting, and
  `usage` would mean two different things in one codebase.
- **Draw a mark for every event, rendering or not.** Fixes the heights without any attribution logic,
  but roughly two thirds of the band's marks would then be click targets that scroll nowhere, which
  defeats its primary job.
- **Repair the attribution during ingest.** The stored rows are a faithful record of the transcript;
  re-anchoring them at write time would bake one presentation choice into the archive and lose the
  ability to re-derive. ADR-011's premise is that raw stays raw.

## Consequences

- **Totals are unaffected.** Session and dashboard figures aggregate `token_usage` directly and never
  pass through the fold. A test asserts that the folded per-event values still sum to the session
  total — the fold redistributes, it never creates or drops tokens.
- **`usage` is a derived, presentation-facing field.** Anything needing raw per-row attribution must
  query `token_usage`, not read it off `EventNode`.
- The fold depends on `events.seq` and `turn_id`, so `loadEvents` selects `seq` (server-internal; it
  is deliberately not on the wire).
- Because the invisible anchor events are thinking blocks with no text, the timeline band's
  `thinking` colour category can never fire on a Claude Code transcript. The band's legend lists only
  the types present in the session rather than advertising a category that cannot occur.
