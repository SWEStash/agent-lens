# Validation

How we check that Agent Lens computes its numbers correctly: token accounting, cost, session, turn,
and subagent aggregates, and the classifier. The checks cover exact formulas on small fixtures and
self-consistency on full real data.

## Layers

| Layer | Question | Where | Expected values written by hand? | Data |
|------|----------|-------|---|-------|
| 0. Type gate | Do the tests still typecheck against the code? | `pnpm typecheck` | No | every `src` and `test` file |
| 1. Golden fixtures | Are the formulas exactly right? | vitest | Yes | tiny fixtures |
| 2. Invariants | Does real data stay self-consistent? | `scripts/validate.mjs` | No | your real store |
| 3. Determinism | Does incremental ingest equal a full rebuild? | vitest | No | committed corpus |
| 4. Redaction oracle | Does the corpus give the same metrics as the real data it came from? | `scripts/oracle.mjs` | No | committed corpus |
| 5. Sandbox | Does the whole CLI to API path work? | `scripts/sandbox.sh` | spot checks | committed corpus |

**Why the oracle works.** Tokens, cost, durations, counts, subagent linkage, and the complexity
score come only from structural fields: usage objects, timestamps, ids, models, tool names, edit line
counts, file extensions. So a redactor that scrubs text but keeps those fields preserves every metric
by construction, and `metrics(redacted) == metrics(raw)` becomes something we can check. The
classifier's category comes from message text, so Layer 1 fixtures cover it instead.

## Run it

```bash
pnpm build && pnpm typecheck                # Layer 0 (tests import ../dist, so build first)
pnpm test                                   # Layers 1, 3, 4 unit tests, corpus scenarios, web tests
cp data/agent-lens.db /tmp/al-validate.db   # copy the store; never read the live WAL database
pnpm validate --db /tmp/al-validate.db      # Layer 2 on your real data
pnpm build-corpus                           # regenerate the redacted corpus and run the oracle
pnpm sandbox                                # Layer 5 over the corpus
```

## What each layer covers

- **Layer 0: type gate.** Each package typechecks `src` with its `tsconfig.json` and `test/` with a
  sibling `tsconfig.test.json`, because the main configs' `rootDir` is `./src`. It proves only that
  fixtures match their declared types. It exists because a stale fixture once kept passing when no
  config compiled the tests. CI runs it after `pnpm build`, since tests import each package's
  `../dist`.
- **Layer 1: golden fixtures** (`packages/*/test/`), with hand-computed numbers:
  - `core/test/pricing.test.ts`: the cost formula, longest-prefix model matching, cache rates, and
    unknown models costing 0.
  - `server/test/dashboard.test.ts`: every dashboard aggregate, the model filter at each aggregate's
    own grain, the audit aggregates, and a model ingested under both a dated id and its alias
    (ADR-037).
  - `ingest/test/classify.test.ts`: complexity sub-scores and totals, line counts, and category
    signals.
  - `ingest/test/ingest.test.ts`: deduplication, linkage, pruning, streaming, malformed and meta
    lines, cross-file duplicates, and orphan subagents.
  - `ingest/test/detect.test.ts` and `sanitize.test.ts`: the security rules, severities, and the
    command sanitizer, including the gaps we accept.
  - `web/test/`: transcript logic, hooks, components, the session view's deep links, search, time
    range, and keyboard, plus chart visibility and every chart's explanation panel.
    `packages/web/vitest.config.ts` defines the web project and the root config includes it.
- **Layer 2: invariants** (`scripts/validate.mjs`). Deduplication, conservation (the dashboard total
  equals a direct `SUM`), cost additivity, linkage integrity, and recomputed aggregates, through the
  same query code the server runs. Orphans, unpriced models, and unattributed rows are reported
  without failing.
- **Layer 3: determinism** (`ingest/test/determinism.test.ts`). A full rebuild equals a chunked
  incremental ingest (mains first, then subagents), and re-ingesting adds nothing.
- **Layer 4: redaction** (`packages/ingest/src/redact.ts`, `test/fixtures/corpus/`). The committed
  corpus is real sessions (not from this project) passed through the redactor. `redact.test.ts`
  proves preservation and leak-freedom on synthetic data; the oracle proves it on the real sessions.
- **Layer 5: sandbox** (`scripts/sandbox.sh`). Runs `ingest --full`, the server, and the HTTP API
  over the corpus in a temp directory, and checks the API against known numbers.

## Results

Layers 0, 1, 3, 4, and 5 run on the committed corpus and are deterministic; all pass in CI. The
Layer 2 numbers below are a snapshot from a real store of about 630 sessions, so yours will differ.

```
[1] dedup                each (session_id, message_id) appears once
[2] conservation         overview tokens == direct SUM (input 2,669,921; cache_read 2,327,763,568)
[3] cost additivity      Σ costForUsage(row) == overview.cost ($1912.90, drift $0.000015)
[4] linkage integrity    0 dangling spawns, 0 broken parent_turn links
[6] aggregate recompute  event_count/turn_count == COUNT(*) for every session
report: cache_read_ratio = 95.7% · 239 linked + 249 orphan subagents · 0 unattributed token rows · all models priced
```

The orphan count predates workflow linkage (see [Findings](#findings)). After `ingest --full`, only
subagents whose parent transcript was never collected stay orphaned.

The oracle found every metric identical between the raw sessions and the redacted corpus, and the
redacted sources pass the leak scan.

### Scenarios

The corpus has three sources: `team-a` and `team-b` (redacted real sessions) and `scenarios`
(hand-written synthetic sessions), so every case below is covered end to end.

| Scenario | Unit test | In the corpus |
|----------|----------|-----------------|
| Plain session: turns and token accounting | `ingest.test.ts` | `sc-plain-0001` |
| Subagents: child tokens not double-counted | `ingest.test.ts`, `redact.test.ts` | `sc-sub-parent-0002` and `agent-c0ffee01` |
| Workflow fan-out: agents grouped by run and linked to the launching turn | `ingest.test.ts`, `api.test.ts` | `sc-workflow-0003` and 2 agents under `subagents/workflows/wf_*/` |
| Slash command with local output and no assistant turn | `corpus-scenarios.test.ts` | `sc-command-0006` |
| Several sources, no cross-source bleed | `dashboard.test.ts` | the 3 sources |
| Compaction and meta lines create no turn | `ingest.test.ts` | `sc-plain-0001` (2 turns) |
| Resumed session: duplicate uuids deduplicated | `ingest.test.ts` | `sc-resumed-0005` (mirror and `.versions`, 3 events) |
| Cache tokens, read and write | `pricing.test.ts`, `classify.test.ts` | corpus totals |
| Malformed or partial JSONL | `ingest.test.ts` | `sc-malformed-0004` (1 malformed line) |

`corpus-scenarios.test.ts` checks all of these in CI, and `scripts/sandbox.sh` checks them again
through the API.

To regenerate the corpus, run `pnpm build-corpus` (redacted sessions and the oracle) and
`node scripts/build-scenarios.mjs` (synthetic sessions). `build-corpus` reads which sessions to
redact from `scripts/corpus-sessions.local`, one `<srcLabel>|<encodedDir>|<sessionUUID>|<outLabel>`
per line. That file names real projects and sessions, so it's gitignored.

## Findings

No computation bug was found. Worth knowing:

- **Cost is mostly cache reads.** They were 95.7% of all tokens in the snapshot, so cost accuracy
  depends almost entirely on each model's cache-read rate. Keep the price table current.
- **The `<synthetic>` model has no tokens.** It marks replies Claude Code generated without calling
  a model. If it ever carries tokens, `validate.mjs` check [8] reports it as unpriced.
- **Workflow subagents link to their parent.** A workflow run's agents are stored under
  `subagents/workflows/<runId>/`, and the launching tool call's result carries the same run id, so
  each agent gets its parent session and launching turn.
- **The turns KPI includes subagent turns**, while category and complexity cover main sessions only.
  Under a model filter the KPI counts turn rows instead
  ([ADR-035](decisions/ADR-035-dashboard-model-filter.md)).

## Corpus safeguards

- The corpus holds no data from this project and no real personal data. The redactor scrubs text,
  paths, usernames, project names, branches, emails, URLs, and secrets, and the generator fails on
  any leak it finds after redaction (`findLeak`). A fixed `AGENT_LENS_REDACT_SALT` makes the corpus
  byte-for-byte reproducible. Only redacted output is committed.
- The generator honors the same [exclude list](USAGE.md#exclude-projects) as the rest of the
  pipeline, and `build-corpus` excludes this repo by default.
