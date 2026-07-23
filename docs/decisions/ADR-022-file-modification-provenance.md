# ADR-022 — File-modification provenance from tool calls (level 1)

- Status: Accepted
- Date: 2026-07-22
- Deciders: project owner

## Context

Agent Lens can answer "what happened in that session?" but not the inverse: **"this file changed —
which session, and which turn, did it?"** Today that question means remembering which session to
open and scrolling its transcript for Edit/Write calls. For a solo maintainer auditing or reviewing
after the fact, the file (or the commit built from it) is the natural entry point, not the session.

The transcript data already contains the answer. Every `Edit`/`Write` tool call's verbatim
`input_json` is stored per `tool_calls` row — full `file_path`, `old_string`/`new_string`/`content` —
keyed to session, turn, event, and timestamp. In the current archive that is ~8.4k Edit/Write calls,
all attributable to a project via `sessions.project_id`. Like classification (ADR-004) and security
findings (ADR-017), provenance can therefore be a **deterministic, re-runnable derivation** over data
already ingested — no new collection, retroactive over the whole archive, no AI, local-only
(ADR-005).

What the transcript does *not* contain is a complete write history of the filesystem. Human edits in
an editor, formatters, `git checkout`/`merge`/`rebase`, CI, other machines, and most Bash-driven
writes (`sed -i`, heredocs, codegen) are invisible or only partially visible. Any design that
pretends to *replay* file history from tool calls diverges from reality quickly and cannot be
presented honestly.

This frames a scope ladder, from cheap-and-deterministic to inference:

1. **File-touch index** — which sessions/turns touched which files, from Edit/Write calls.
2. **Commit ↔ session mapping** — hashes extracted from agent-run `git commit` output (observed
   present in `result_summary`, e.g. `[main e79e246] …`), later inference for human-made commits.
3. **Line-level blame** — compose `git blame` (line → commit) with level 2 (commit → session),
   rather than rebuilding line tracking ourselves.

## Decision

**Ship level 1 only: a `file_changes` table derived from successful `Edit`/`Write`/`NotebookEdit`
tool calls, surfaced as a per-session roll-up plus a file-centric browse (`/files` list and `/file`
timeline). Levels 2–3 are recorded as the roadmap, pending their own technical validation.**

- A new derivation pass (alongside `classify`/`detect`) parses each file-modifying tool call's
  `input_json`, normalizes the path (absolute, `.`/`..` resolved), and emits one row per
  `(tool_call, file)` into `file_changes` — schema v14. Incremental runs are scoped by the dirty
  session set `rebuildDerived` returns, delete-then-insert per session, exactly like findings.
- **Row key** is `hash(tool_call_id, file_path)` (the findings pattern), so a future multi-file
  source (e.g. a Bash-write heuristic) is additive rather than a schema break.
- **Failed calls are excluded at derivation** (`status = 'error'` — 306 rows in the current
  archive): a failed edit did not change the file, and storing it would push the filter onto every
  consumer.
- Rows carry denormalized `session_id` / `turn_id` / `project_id` / `event_uuid` / `timestamp`
  (immutable post-ingest, same justification as findings) plus `lines_added` / `lines_removed`
  newline-count deltas, NULL where the prior state is unknown (Write over unseen content).
- Only the **absolute path** is stored; project-relative display is computed at render time, because
  files can legitimately live outside the project root (the SA08 detector exists precisely because
  of such writes).
- The UI states the contract plainly: *tracked from Edit/Write tool calls; changes made via shell
  commands or outside sessions are not captured.* Determinism is the trust story — no
  fake precision (e.g. no created-vs-modified guess for `Write`, which the trace cannot
  reliably distinguish).

### Out of scope (recorded, not forgotten)

- **Deletions and renames.** No Delete tool exists; all deletions are Bash (`rm`, `git rm`, `mv`,
  globs, variables) — a strictly lower confidence class that cannot be resolved after the fact in
  general (`rm *.log`, `rm $FILE`). Tracked-file deletions and renames arrive *authoritatively* in
  level 2 via `git log --diff-filter=D` / `-R`, which also repairs rename-fragmented timelines. When
  they land, an additive `op` column (default `'modify'`) extends `file_changes` without migration
  pain.
- **Bash-write heuristics** (literal-path `rm`/`tee`/redirect parsing): parked; serves the same need
  level 2 serves better, and it is the first crack in the determinism claim.
- **Git command execution at ingest.** Level 1 runs zero git commands. Level 2's design must bound
  git usage to per-repo batch reads (`git log --since=<last ingest>`), never per-edit calls, and
  degrade gracefully when a repo is missing — that validation is a precondition for level 2, not an
  assumption of this ADR.

## Consequences

**Good**

- The provenance question gets a first-class entry point (`/files`) instead of transcript
  spelunking; sessions gain a "what did this change" summary; both retroactive over the entire
  archive on the next `--full` ingest.
- Deterministic and explainable end to end — every row traces to one verbatim tool call, and jumps
  to it in the transcript.
- The schema and UI are deliberately shaped so levels 2–3 (commits, blame) extend rather than
  rework: the file timeline later gains commit markers; the session roll-up later gains "resulted in
  commit X".

**Bad / accepted**

- The index is knowingly incomplete (Bash writes, human edits, other machines). Accepted: the
  caveat is stated in-UI, and completeness for *tracked* files is exactly what the git-composed
  levels add later.
- `lines_added`/`lines_removed` are newline-count deltas, not diff hunks — magnitude signal, not a
  diff. Accepted for v1; the verbatim strings remain in `input_json` for anything richer.
- One more derived table to rebuild on `--full` ingest. Negligible: single JSON parse per
  Edit/Write row, no I/O beyond the DB.

## Alternatives considered

- **Replay tool-call edits into a shadow file history** to answer line-level questions directly.
  Rejected as technically inviable: unobserved writes (humans, formatters, git operations, Bash)
  make the replayed state diverge from reality within days, and line numbers drift constantly. Git
  already solves line tracking; level 3 composes with `git blame` instead of competing with it.
- **`file:` search operator on the Sessions page instead of dedicated pages.** Lightweight but
  undiscoverable, and provides no per-file aggregation or timeline. May still be added later as a
  complement.
- **A denormalized per-file aggregate table.** The `/files` list is a `GROUP BY (project_id,
  file_path)` over ~10⁴ rows with a covering composite index — measured need for denormalization is
  absent (KISS/YAGNI).
- **Real-time capture via PostToolUse hooks** instead of derivation. Would observe writes the
  transcript misses, but breaks the passive, zero-config collection model (ADR-003 posture) and
  captures nothing retroactively.
