# Developing Agent Lens

A pnpm monorepo of TypeScript packages (ESM, `strict`): a CLI, an ingest engine, a local API server,
and a Vite + React web UI. How the pieces fit is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Set up

You need Node.js 24 or later and [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/SWEStash/agent-lens.git && cd agent-lens
pnpm install && pnpm build
node packages/cli/dist/agent-lens.js collect --then-ingest
node packages/cli/dist/agent-lens.js serve
```

From a checkout, the data directory is `<repo>/data` and the config file is
`<repo>/agent-lens.config.json` (copy it from `agent-lens.config.example.json`).

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Build every package. Tests import each package's `dist/`, so build first |
| `pnpm typecheck` | Type-check `src` and `test/` in every package |
| `pnpm test` | Build, then run the vitest suite |
| `pnpm web:dev` | The web UI with hot reload on http://127.0.0.1:5173, proxying `/api` to the running server |
| `pnpm validate --db <copy>` | Invariants on a copy of a real store ([VALIDATION.md](VALIDATION.md)) |
| `pnpm sandbox` | Ingest, server, and API end to end over the committed corpus |
| `pnpm build-corpus` | Regenerate the redacted corpus and run the oracle |
| `pnpm bench` | Time the dashboard queries ([PERFORMANCE.md](PERFORMANCE.md)) |

CI runs `build`, `typecheck`, `test`, and `sandbox`.

## Conventions

- **Stay local.** No outbound network calls. Never commit `data/` or `agent-lens.config.json`.
- **Record decisions.** A structural or data-model decision gets an ADR in
  [decisions/](decisions/).
- **Use [Conventional Commits](https://www.conventionalcommits.org/).** PRs are squash-merged, so
  the PR title becomes the commit subject, and releases are cut from it
  ([RELEASING.md](RELEASING.md)). CI rejects a title that isn't conventional.

## Change checklist

- **Parser change**: rebuild with `agent-lens ingest --full`.
- **Classifier change**: bump `CLASSIFIER_VERSION` in `packages/ingest/src/classify.ts` and run
  `agent-lens metrics`. No re-ingest is needed.
- **Detector change**: bump `DETECTOR_VERSION` in `packages/ingest/src/detect.ts` and add an entry
  to [DETECTOR-CHANGELOG.md](DETECTOR-CHANGELOG.md). Users relabel with `agent-lens metrics`; the
  About page tells them so once their stored findings are older.
- **Dashboard query change**: run `pnpm bench`; the query-plan guard in CI checks index use
  ([PERFORMANCE.md](PERFORMANCE.md)).
- **Metric or ingest change**: run the end-to-end checks in [VALIDATION.md](VALIDATION.md).

## Project layout

| Path | What it holds |
|---|---|
| `packages/contracts` | Types shared across packages: DB rows and API responses. No runtime code, so the browser can use them ([ADR-024](decisions/ADR-024-shared-contract-types.md), [ADR-026](decisions/ADR-026-api-response-contracts.md)) |
| `packages/transcript-format` | The markup Claude Code embeds in message text, shared by ingest, server, and web ([ADR-031](decisions/ADR-031-transcript-text-is-stored.md)) |
| `packages/core` | SQLite schema, paths and sources, the collector, the run lock, OS service install |
| `packages/ingest` | The parser, the classifier, and security detection |
| `packages/server` | The local API over the store |
| `packages/web` | The Vite + React web UI |
| `packages/cli` | The published `agent-lens` binary, bundling the packages above |
| `scripts/` | Maintenance and validation scripts |
| `test/fixtures/` | The committed, redacted and synthetic test corpus (no real data) |
| `docs/` | Guides and ADRs |

## Add another agent

The store and parser don't assume Claude Code, so a new agent needs no schema change
([ADR-008](decisions/ADR-008-adapter-extensibility-seam.md)):

1. Implement a `SourceAdapter` in `packages/ingest/src/adapters/<agent>.ts`. Start from
   [`example-stub.ts`](../packages/ingest/src/adapters/example-stub.ts).
2. Register it in `adapterList` in `packages/ingest/src/run.ts`.
3. Add a source with the matching `agent` value to the config.

This covers parsing only. The collector in `packages/core/src/collect.ts` assumes Claude Code's file
layout, so an agent that stores traces elsewhere also needs collection logic.
