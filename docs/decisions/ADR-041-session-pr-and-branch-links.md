# ADR-041 — Sessions record the PRs and branches they touched

- Status: Accepted
- Date: 2026-11-13
- Deciders: project owner
- Extends [ADR-003](ADR-003-data-model-and-store.md) (session-keyed tables)
- Related: [ADR-008](ADR-008-adapter-extensibility-seam.md) (format knowledge stays in the adapter), [ADR-022](ADR-022-file-modification-provenance.md) (commit links stay its level 2), [ADR-039](ADR-039-otel-is-enrichment-not-source.md) (mine transcript fields before OTEL), [ADR-040](ADR-040-tool-call-permission-decisions.md) (missing means not recorded)

## Context

A session view doesn't show the PR the session produced, and nothing finds the sessions that worked
on a PR. Agent Lens can't look this up anywhere else: it reads transcripts only, with no access to
repositories, `git`, `gh` or the network. Recent Claude Code versions write the link into the
transcript itself, in two places:

```json
{"type":"pr-link","sessionId":"…","timestamp":"…","prNumber":57,"prUrl":"https://github.com/o/r/pull/57","prRepository":"o/r"}
{"type":"user","message":{…},"toolUseResult":{"stdout":"…","gitOperation":{"push":{"branch":"feat/x"}}}}
{"type":"user","message":{…},"toolUseResult":{"stdout":"…","gitOperation":{"pr":{"number":57,"url":"…","action":"created"}}}}
```

A scan of the real archive (key names and counts only) found:

- `pr-link` has no `uuid`, so ingest dropped it as a meta-only line. It repeats many times per
  transcript, and one transcript can name several PRs. It never appears in subagent transcripts.
- Some URLs are GitLab merge requests (`…/-/merge_requests/<n>`), not GitHub pulls.
- `gitOperation` sits on Bash results. `pr.action` takes `created`, `edited`, `closed`, `merged` and
  `commented`; a close or merge carries no `url`. It also records `commit` and `branch` operations.
- One PR can be touched by several sessions.

## Decision

1. **Two session-keyed tables** (SCHEMA_VERSION 18):
   - `session_prs (session_id, repository, number, url, first_seen_at, opened_here)`, keyed by
     `(session_id, repository, number)`.
   - `session_branches (session_id, branch, first_pushed_at)`, keyed by `(session_id, branch)`.

   Tables, not columns: a session has any number of each. No foreign keys, like
   `session_continuations`.

2. **Keyed by repository and number, not URL.** A merge records only a number, and the redacted
   corpus keeps no URLs (point 6), so a URL key would drop both. `url` is nullable and filled by
   whichever record carries one. A number-only reference takes its repository from another reference
   in the same session with that number. It is dropped when there is none, or more than one, rather
   than guessed.

3. **The adapter is the only reader of the format.** `ClaudeCodeAdapter` turns both records into
   agent-agnostic `gitRefs` (`PrRef`, pushed branches), deriving the repository from the URL for
   GitHub and GitLab on any host. A URL is kept only when it is http(s), because the UI renders it
   as a link. Anything malformed records nothing.

4. **Rows only accumulate.** A session's mirror and its `.versions/` copies add to one set: the
   earliest sighting, any URL, and `opened_here` once a `created` action is seen are kept whatever
   the file order. Refs on history copied from another session stay with the session that owns that
   history ([ADR-038](ADR-038-shared-session-history.md)).

5. **Surfaced locally as recorded.** `GET /api/sessions/:id` returns `prs` and `branches`, the
   session header links each PR out and to its other sessions, and `GET /api/sessions?pr=` filters
   by a number (any repository), `owner/repo#n`, or the URL. The static demo hides the filter link
   because its lists don't filter.

6. **Privacy.** No new data is collected: everything comes from transcripts already archived.
   - Newly in the DB, API and UI: the `pr-link` URL, number and repository, which before this lived
     only in the archive.
   - Already in the DB, inside `raw_json`: the `gitOperation` branches and PR refs, now projected.
   - Markdown export is unchanged and includes none of it.
   - The corpus redactor keeps PR numbers and action codes, pseudonymizes repositories and branches,
     and drops every URL, which the leak scan also enforces. The demo snapshot is built from that
     corpus, so the only PR URLs it shows come from the synthetic scenarios.

7. **A store from an older build still serves.** The detail returns empty lists and a `pr` filter
   matches nothing until `ingest --full`.

## Consequences

- From a session you can open the PR it produced and see the branches it pushed; from a PR you can
  find every session that recorded it.
- Only PRs the agent touched through Claude Code appear. A PR opened by hand, or by another tool, is
  absent, and nothing checks a PR's current state.
- `commit.sha` and `branch` operations stay unread. Commit ↔ session mapping is ADR-022 level 2.
- Upgrading needs `agent-lens ingest --full`.
