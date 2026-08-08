# ADR-030 — Find-in-session: client-side, highlight-and-navigate, reveals what the view hides

- Status: Accepted
- Date: 2026-08-08
- Deciders: project owner

## Context

The sessions list searches transcripts with FTS5 ([ADR-003](ADR-003-data-model-and-store.md)), but
`listSessions` only ever answers *which session* matched — it returns no per-event hits, no snippets,
and no ranking. Landing on a 400-message session left the reader with no way to find the term that
brought them there.

The browser's own find doesn't fill the gap, because this view hides text structurally:

- A collapsed turn renders **no children at all** (`TurnSection` only maps its events while open), so
  matches inside it aren't in the DOM.
- Long bodies are **clamped** above 1400 characters / 18 lines by `CollapsibleText`.
- **Thinking** blocks are collapsed behind a toggle.
- **"Hide tool messages"** suppresses tool cards — and a message whose only content is a tool call
  disappears entirely.

So the feature is only worth building if it *reveals* those, rather than re-implementing Ctrl+F.

## Decision

**Search the loaded session in the client, highlight every hit, navigate message by message, and
override whatever is hiding the active match.**

**Client-side, no endpoint.** `GET /api/sessions/:id` already returns the whole `SessionDetail` —
every body, thinking block and tool payload is in the browser before the reader types anything. A
`/search` endpoint would have to be query-keyed in the static snapshot (the `snapshotFileKey` hashing
that `/file` needs, triplicated across `api.ts`, `export-snapshot.mjs` and `check-snapshot-links.mjs`)
for no gain. Nothing in `packages/server`, `packages/contracts` or the snapshot export changed.

**Literal substring, not the list's FTS grammar.** `toFtsQuery` tokenizes and ANDs; in-page find is
expected to behave like the browser's and hit mid-word, so `AWS_SECRET` is found inside
`export AWS_SECRET=`. The two matchers therefore disagree, which is visible in one place: the sessions
list hands its term to the session as `?q=`, and a row that matched on its *title* or *project* can
legitimately show no in-session matches. A two-character minimum keeps a stray keystroke from painting
the entire transcript.

**Highlight and navigate, not filter to matching messages.** A transcript is a causal narrative; a
match matters because of the messages around it, and collapsing the view to hits alone destroys turn
grouping and adjacency — the thing this tool exists to show. Navigation steps **per matching message**
rather than per occurrence: matches inside a collapsed turn have no DOM position to step through, so
an occurrence-level counter would promise positions it couldn't deliver.

**Painted with the CSS Custom Highlight API**, not by wrapping matches in `<mark>`. Message bodies
render through unrelated paths — a react-markdown AST, a raw `<div>`, the thinking `<pre>`, the shell
console, the Edit diff, six tool renderers — and marking up each would mean a matching change in every
one. Ranges over the rendered text nodes cover all of them from one hook and mutate no DOM, so React
never sees it. A `MutationObserver` on the transcript repaints after any reveal. Where the API is
absent the counter, badges, expansion and flash still work; only the tint is missing.

**The active match overrides whatever hides it.** Its turn expands, its clamped body unclamps, its
thinking opens — and a tool call holding it renders even with "hide tool messages" on. That toggle is
about reading the conversation, not about narrowing an audit: tool payloads are exactly where the
paths and secrets an audit looks for live, so they are always searched and always counted. Only the
*active* match is revealed; opening every message containing the term would expand half the
transcript. Collapsed turns instead carry a count badge on the header — while collapsed, that badge is
the only possible evidence that anything in there matched.

**Floating navigator over a sticky bar.** Stepping scrolls the toolbar's search box off screen, so a
pill (term, position, ◂/▸, clear) follows the reader, appearing only once the box is actually out of
view — observed on the box itself, not a scroll offset. `.turn-head` already holds the sticky top slot
and which turn you're reading is worth keeping; a second sticky layer would need a height-coupled
offset that breaks when the bar wraps.

## Consequences

- Search cost is a substring scan over per-event haystacks built once per session, so it stays a web
  concern: `search.ts` is pure and unit-tested, and the DB, the API contract and the demo snapshot are
  untouched.
- Two search grammars now exist in the product. The difference is invisible except on the list→session
  hand-off, where the "No matches" state covers it. Unifying them would mean either giving the list
  substring semantics (losing FTS5's index) or giving the session token semantics (losing mid-word
  hits); neither is worth it.
- A term split across element boundaries by markdown (`**AWS**_SECRET`) is counted but not tinted —
  each range must live inside a single text node.
- An un-expanded `full_result` is searched and counted, but its text isn't in the DOM to paint. The
  message still flashes.
- Scoping search to what renders means it follows the view: `renderable` excludes messages with no
  body at all, so a counted match is always one the reader can be taken to.

## Alternatives rejected

- **A `/api/sessions/:id/search` endpoint using `events_fts`.** The index is external-content over
  `events.text` only — no `session_id`, no per-event ranking — and `events.text` excludes tool
  payloads ([ADR-011](ADR-011-compressed-raw-json.md)), which is most of what an audit searches. It
  would also need snapshot key hashing for a result the client can compute locally.
- **Filtering the transcript to matching messages.** Loses the surrounding turn, which is the context
  that makes a match mean anything. Reconsider only if a triage use case appears that reads hits as a
  list rather than in place.
- **Wrapping matches in `<mark>` via a rehype plugin.** Would cover markdown bodies but not the
  `<pre>`, the diffs or the tool cards without touching every renderer.
