# ADR-023 — Canonical project roots

- Status: Accepted
- Date: 2026-07-23
- Deciders: project owner

## Context

A project row is minted per distinct session cwd (`UNIQUE (agent_id, path)`). Any session — or any
*spawned subagent* whose cwd points at a subdirectory — therefore mints a phantom "project"
(`repo/packages/x`, `repo/diagrams`, `ws/.local`, `repo/evals`). In the real archive, 8 of 38
project rows were such phantoms, polluting every project filter dropdown; two of them
(`…/evals`, `…/skills`) held *only* sidechain subagent sessions, so they also looked permanently
empty in the sessions list.

Naive fixes fail on real data:

- **Fold every path into its nearest observed ancestor**: a plain workspace folder that once hosted
  a session (`…/swestash`, 1 session) would swallow the independent repos nested under it
  (`…/swestash/agent-lens`, 112 sessions).
- **Git-root detection alone**: non-git workspaces (`swestash`, the deleted `dev-workflow-skills`)
  can't be resolved for their plain subdirs, and deleted directories resolve to nothing.

## Decision

**A re-runnable, global `canonicalizeProjects` step in ingest resolves every project path to its
canonical root and merges the rows** (`packages/ingest/src/canonicalize.ts`), ordered:

1. **Nearest git root wins** — walk up from the cwd (inclusive) looking for `.git` (dir *or* file,
   so worktrees count), never testing `$HOME` or above (a dotfiles repo in `~` must not swallow
   every non-repo path). Nearest match keeps nested repos distinct from their workspace.
2. **Fallback: nearest observed ancestor project**, resolved to *its* canonical root — gated:
   applies when the path still exists on disk, **or** when the project holds no main session.
   A vanished directory could be a deleted independent repo or a workspace subdir — we cannot
   tell — so a project a human actually opened (≥1 main session) keeps its identity, while
   subagent-only landing spots (spawn cwds, dead eval/worktree dirs) always fold.
3. **Neither → keep the raw cwd** (`$HOME` itself, deleted human-opened projects).

Merging repoints `sessions.project_id` and `file_changes.project_id`, mints the canonical row if
that cwd was never itself observed, refreshes `first_seen`/`last_seen` from the merged session set,
and deletes session-less project rows — sweeping true orphans out of every dropdown as a class.

The step runs on **every** ingest (and `agent-lens metrics`), before classify/detect/file-changes —
those passes consume the session's project path. The table is a few dozen rows, so a global pass is
effectively free, and an already-ingested DB heals on its next incremental run — no `--full`
required.

## Consequences

**Good**

- Real archive: 38 → 30 projects; all 8 phantoms fold into the projects the user expects; the two
  sidechain-only entries disappear from dropdowns entirely. Zero server/web changes — every filter
  is fixed at the source.
- `write_outside_project` (SA08) becomes *more* correct: with the repo root as the project, a
  session cwd'd in `repo/sub` writing `repo/other` no longer false-flags.
- Deleted subagent worktrees fold their sessions back into the spawning project.

**Bad / accepted**

- **Filesystem-dependent**: rule 1/2 consult the disk at ingest time, so results depend on the host
  (fine for a local-first tool; the committed corpus's fake paths exist nowhere, keeping CI
  deterministic). Moving/deleting a repo changes future resolution — historical rows persist until
  re-derived.
- A deleted *sidechain-only* independent repo (if one ever existed) would fold into an observed
  ancestor. Judged acceptable: it is indistinguishable from a spawn cwd, and nothing human-authored
  is mislabeled.
- Historical findings can shift on re-derive where the project root changed (the SA08 improvement
  above). Deterministic given the same disk state.

## Alternatives considered

- **Query-time folding** in `/projects` + every filter: no stored change, but every consumer must
  re-derive the mapping on every query, and session→project attribution in exports/API stays wrong.
- **`parent_project_id` grouping column**: keeps cwd fidelity but doubles the query complexity of
  every filter join for fidelity nobody consumes; the raw cwd survives in `events.raw_json` anyway.
- **Pure ancestor folding / pure git detection**: each fails on real data as described in Context.
