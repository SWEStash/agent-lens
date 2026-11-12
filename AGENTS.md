# Agent instructions

Read these before changing anything:

1. [docs/HOW-WE-WORK.md](docs/HOW-WE-WORK.md): how issues, PRs, and releases are run, what counts
   as done, and what an agent may post without approval. Bugs, features, and tasks, and whether
   each is open or done, live in GitHub Issues. Working plans in `.local/` refer to issues by
   number and never track their status.
2. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): commands, conventions, and the change checklist.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the ADRs in [docs/decisions/](docs/decisions/):
   how Agent Lens is built and why. A structural decision gets a new ADR, and an accepted ADR is
   changed only by a new one that supersedes it.

A session starts with `git status`, the issues assigned to the maintainer, and the working plan,
then picks the next issue as HOW-WE-WORK → *Planning and claiming* describes, or asks.

Issues and PRs are public. Never put transcript content, real home-directory paths, account or
source labels, or anything from `data/` in them.
