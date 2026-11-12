# How we work

Agent Lens has one maintainer and is public. Anyone can file bug reports and feature requests.
Pull requests come only from the maintainer for now. GitHub holds what is planned and what is done.
The repository holds how and why.

| What | Where |
|---|---|
| Bugs, feature requests, tasks, and whether each is open or done | [Issues](https://github.com/SWEStash/agent-lens/issues) |
| How the project runs: filing, claiming, what counts as done, PRs, releases, what agents may post | This document |
| Structural and data-model decisions | An ADR in [decisions/](decisions/) ([DEVELOPMENT](DEVELOPMENT.md) → *Conventions*). A smaller decision goes in the issue comment that settles it |
| What a release ships | The GitHub Release that semantic-release writes from commit subjects ([RELEASING](RELEASING.md)) |
| How to build, test, and check a change | [DEVELOPMENT](DEVELOPMENT.md), [VALIDATION](VALIDATION.md), [PERFORMANCE](PERFORMANCE.md) |
| Anything else (usage, architecture, ingest) | The doc that the README's *Documentation* table lists for that topic |

Working plans stay outside the repository (`.local/`, git-ignored). They refer to issues by
number and never track an issue's status. The issue does that.

**When two documents disagree**, the owner in the table above wins, and the other document is
fixed in the same PR. When this document and practice disagree, fix this document first, in its
own PR, and then follow it.

## Writing

Write issues and comments like commit messages: short and precise, bullets and short lines, no
filler. Give enough context to understand the issue at a glance. Detail that matters only while
working stays in the working plan. Put files, commands, and functions in code spans. Refer to
commits by hash and to PRs and CI runs by link. Don't hard-wrap issue text, because GitHub keeps
every line break.

**Never paste private data.** Issues are public. Leave out raw transcripts, session contents, real
paths under a home directory, account or source labels, email addresses, and anything else from
`data/`. Describe the shape of the data instead: the record type, the field names, and an invented
example. When a real session is needed, use `agent-lens export <sessionId>`, which redacts by
default. Corpus-wide counts, such as "found in about a third of transcripts", are fine.

## Filing

One issue per problem or change.

- **Type**: *Bug*, *Feature*, or *Task*. These are the repository's issue types, not labels.
- **Title**: for a bug, the symptom ("`collect` skips set-aside transcripts"). For anything else,
  the outcome ("Show how each tool call was approved"). Keep it under about 70 characters, and
  name the command or view when there is one.
- **Body**, written for someone who doesn't know the code:
  - **Context**: the command, view, or package involved and why it matters, in one to three
    lines.
  - For a bug: *Steps*, *Expected*, *Actual*, *Environment* (`agent-lens --version`, OS, Node,
    and `agent-lens config` output, redacted), and *Impact* when known.
  - For a feature: *Problem*, plus *Proposal* and *Out of scope* when they help.
  - For a task: *Context* and *Proposal*.
  - **Done when**: a checklist of observable results. These are the issue's acceptance criteria.
    The project-wide definition of done is under [Closing](#closing).
  - *Notes*: leads, constraints, links to ADRs. Optional.

  The issue forms ask the public for the essentials. The maintainer adds Context and Done when
  during triage. Outside reporters use the *Bug* or *Feature request* form, whichever is closer,
  including for a question. The *Task* form is for the maintainer.
- An issue labelled `needs decision` lists the options instead of *Done when*. The decision is
  recorded in a comment, or in an ADR when it is structural, and *Done when* is added before the
  issue is claimed.
- Use labels only for what a type can't say:
  - `needs decision`: the maintainer chooses before work starts.
  - `priority: low`: worth doing, but only after every other pickable issue, or when related work
    touches it anyway.
  - `released` belongs to semantic-release. Don't set it by hand.
- Security problems never go in a public issue. Report them through
  [GitHub's security advisories](https://github.com/SWEStash/agent-lens/security/advisories/new).

**Found while working on something else.** A follow-up that is its own change is a new issue that
links the one it came from. A fact about the issue you're on is a comment there. A question that
blocks an issue is a comment on that issue. A choice the maintainer has to make is an issue
labelled `needs decision`.

**Scope changes.** Edit the issue body to the new scope, *Done when* included, and add a one-line
comment saying what changed and why.

**Work only the maintainer can do**, such as a secret, a repository or npm setting, or an
approval, is a *Task* assigned to the maintainer and written as a runbook: what is needed, where it
lives, what to run, what to look for, and what to send back.

## Planning and claiming

There are no milestones. semantic-release cuts a release from whatever merges. An issue that is
open and unassigned has not been started. An assigned issue is in progress. An issue is claimed
only once it has *Done when*. Nothing else marks progress, so don't post "working on it" comments.

**Picking the next issue.** Pick one that is unassigned, has *Done when*, and is not labelled
`needs decision`. Bugs come before features and tasks, then oldest first. `priority: low` comes
after every other issue that meets those conditions. A comment from the maintainer on an issue
overrides this order.

**Claiming.** The maintainer, and agents working for the maintainer, assign the issue when work
starts and unassign it when they stop working on it. That is when the work stops, not when a
session ends.

**Work in progress** lives on a branch, and in a draft PR that links the issue once there is
something to look at. Context for the next session goes in the working plan, never in a status
comment.

## Comments

Comments carry new facts only: a repro, a finding, a decision with its reason, or the commit, PR,
or run that changes things. Keep to one fact per comment, in a few lines. Never restate the issue
or report status.

## Closing

The PR that resolves an issue says so in its description: `Fixes #N` for a bug, `Closes #N`
otherwise. Merging the PR closes the issue. An issue closed without code is closed as *not planned*
with one line saying why. A duplicate links the other issue.

An issue is done when it is merged to `main` with CI green, and:

- a bug has a regression test that fails before the fix;
- a change covered by the [DEVELOPMENT](DEVELOPMENT.md) → *Change checklist* (parser, classifier,
  detector, dashboard query, metric or ingest) has had that checklist's steps run;
- a structural or data-model decision has an ADR;
- the docs that describe what changed are updated in the same PR.

The PR description carries the evidence: the commands run and their results.

## Pull requests

Pull requests come only from the maintainer, and agents working for the maintainer, for now.
Outside contributions are bug reports and feature requests ([CONTRIBUTING](../CONTRIBUTING.md)).
PRs are squash-merged, and the PR title is a Conventional Commit subject. That subject decides the
release ([RELEASING](RELEASING.md)), and `pr-title.yml` checks it.

## Releases

Every merge to `main` that carries a `feat:` or `fix:` subject is released by semantic-release
([RELEASING](RELEASING.md) → *What happens on merge*). A change is **released** once its version is
on npm (`npm view @swestash/agent-lens versions`). A closed issue alone means merged, not released.

## Agents

Agents follow this document and act through the maintainer's account (`gh`).

- **Needs no approval:** assigning or unassigning an issue when work on it starts or stops. Pushing
  branches and opening PRs for work the maintainer asked for, pushing to them, and editing their
  descriptions.
- **Needs the maintainer's approval first:** drafted issues, comments, label changes, and closes.
  Every post is public, PR comments included. A request from the maintainer to file specific issues
  counts as that approval.
- **Maintainer only:** merging a PR, which releases.
