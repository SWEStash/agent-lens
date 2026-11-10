# ADR-038 — History shared between sessions has one owner, and the copy links to it

- Status: Accepted
- Date: 2026-11-08
- Deciders: project owner
- Extends [ADR-003](ADR-003-data-model-and-store.md) (`events` keyed by `uuid`, the dedup key)
- Amends [ADR-032](ADR-032-per-event-token-attribution.md): its `(session_id, message_id)` dedup index becomes `message_id` alone (decision 5)
- Related: [ADR-010](ADR-010-incremental-scalable-ingest.md) (incremental == full)

## Context

`events.uuid` is the dedup key, and ADR-003 chose it so a session's mirror plus its `.versions/`
backups collapse to one history. Every copy of a line was assumed to belong to the **same** session.

Claude Code 2.1.318 (first seen 2026-11-04) broke that assumption. Continuing a session writes a new
transcript that **repeats the old one's lines under the same `uuid`s**, with only `sessionId`
rewritten, and appends a pointer to the old file:

```json
{"type":"continued-in","sessionId":"<old>","continuedInSessionId":"<new>"}
```

Forks and worktree agents copy history the same way **without** any pointer. A scan of the real
archive found 11 session pairs sharing line uuids; 6 had a pointer and 5 did not.

Ingest then did three wrong things:

1. **Ownership followed file order.** Whichever file was ingested first kept the shared events; the
   other's copies were dropped by `ON CONFLICT(uuid) DO NOTHING`. Readdir order decided.
2. **Dependent rows did not follow the owner.** `token_usage` and `tool_calls` were written with the
   *file's* session id. `token_usage` dedups on `event_uuid` or `(session_id, message_id)`, so the
   loser's copies inserted fresh rows under the loser's id: 160 rows (26.9M tokens) **counted twice**
   in the store as of 2026-11-07.
3. **A loser with nothing of its own crashed every ingest.** It ended with zero events, so
   `pruneOrphans` deleted it as a phantom, orphaning its `token_usage` rows. The deferred foreign key
   failed at `COMMIT` and the whole run rolled back, every four hours, from 2026-11-04 on.

## Options considered

**A. Keep one owner per event; derive everything from the owner (chosen).** A line's dependent rows
are written only by the session that owns its event. Within a run, files are ingested oldest-first by
their own content timestamps, so the original claims the history before its copy. The copy keeps its
own lines and records a link to the original.

**B. Store each session's copy of a line (`events` keyed by `(session_id, uuid)`).** Every transcript
stays complete. But `uuid` is referenced by `token_usage`, `tool_calls`, `findings`, `file_changes` and
FTS; all of them would rekey, copied history doubles storage, and cost still needs a global dedup by
`message_id`, which is option A's ownership question again. Large, hard to reverse, and it does not
remove the decision.

**C. Order files by mtime.** Free (already `stat`ed), and wrong: Claude Code keeps appending
`cost-state` lines to the *old* file. The original in the incident was modified two days after its
continuation was created, so mtime would have handed the history to the copy.

## Decision

**1. One owner per event, and dependent rows follow it.** `ingestFile` writes a line's `token_usage`
and `tool_calls` only when this session inserted the line's event. A copied line contributes nothing
to the copy's rows, so no row can reference a session that does not own its event, and nothing is
counted twice. The invariant `token_usage.session_id = events.session_id` (same for `tool_calls`)
joins Layer 2 validation.

**2. The original owns shared history, decided by content order, not file order.** Within one run,
files are ingested by `(isVersion, first timestamp, hands off, last timestamp, path)`, read from the
file's head and tail (`ingestorder.ts`). A copy repeats its original's opening lines, so the first
timestamps tie. A file whose tail holds a `continued-in` pointer is the original and goes first.
Without a pointer, the earlier last timestamp goes first: the original stopped at the handoff while
its copy went on. That order leaves each session the lines the other lacks, so neither is pruned
unless their spans are identical. Across runs the original was usually ingested earlier anyway, so
incremental and full agree (ADR-010).

**3. The copy links to its original.** Evidence is kept in `session_continuations` (no foreign keys;
either side may arrive first): `pointer` rows from `continued-in` lines, and `shared-history` rows
recorded when a file's lines are found already owned by another session. `rebuildDerived` sets the
derived `sessions.continued_from_session_id`, preferring a pointer and otherwise the origin with the
most shared lines, and only when that session exists.

**4. A foreign-key violation names its rows.** Every ingest runs `PRAGMA foreign_key_check` before
committing (1.5 s on the 3 GB store) and fails with the table, the parent, and the offending session
ids, instead of SQLite's bare `FOREIGN KEY constraint failed` at `COMMIT`.

**5. A response is charged once across sessions.** A fork subagent opens with a `fork-context-ref`
line and re-emits its parent's spawning reply under a **new** uuid with the same message id and
usage, so decision 1 cannot see it. The unique index on `token_usage` moves from
`(session_id, message_id)` to `message_id` (renamed `idx_token_usage_message`), and the first session
to store the response, in decision 2's order, is charged. The full archive held one such copy
(218k cache-read tokens), found by the new cross-session invariant after decisions 1 to 4 landed.

`SCHEMA_VERSION` goes to 16. The next ingest refuses and asks for `--full`, which is also what
removes the double-counted rows already in the store.

## Consequences

- A continuation's transcript starts where its original stopped; the copied prefix is shown once, in
  the original, and reached through the link.
- Ordering reads up to 64 KB from each end of every file ingested in the run. Incremental runs touch
  few files; `--full` already reads everything.
- If two sessions start and stop at identical timestamps, path order decides. That is deterministic,
  if arbitrary.

**Revisit if** Claude Code starts writing a back-pointer in the continuation (`continuedFrom…`), which
would make the link explicit both ways, or if it copies lines *without* their original timestamps,
which would break the ordering in decision 2.
