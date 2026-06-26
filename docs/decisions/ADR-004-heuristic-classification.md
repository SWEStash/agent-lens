# ADR-004 — Heuristic (no-AI) classification for category & complexity, pluggable

- Status: Accepted
- Date: 2026-06-25
- Deciders: project owner

## Context

Dashboards want **task category** and **task complexity**, but neither exists in the traces — they
must be derived. The strict local-only privacy NFR rules out sending trace content to a cloud LLM.

## Decision

Derive both with **deterministic heuristics** over signals already present in the traces — no AI:

- `category = f(tool_mix, skills_invoked, keyword_rules)` → e.g. feature / bugfix / refactor / docs /
  ops / review.
- `complexity = f(loc_changed, files_touched, turn_count, tokens, duration)` → numeric score + band.

Outputs are stored in `classifications` with the `signals_json` used and a `classifier_version`, so
results are transparent and reproducible, and re-runnable when the rules change.

The classifier is **pluggable**: the same write path can later be fed by a local LLM (e.g. Ollama)
without schema changes, if richer labels are wanted while staying on-device.

## Consequences

- 100% local, deterministic, zero new runtime dependencies, instant.
- Coarser than semantic classification; mitigated by tunable rules and stored signals.

## Alternatives considered

- **Local LLM (Ollama).** Richer, on-device, but adds a heavy dependency + model weights. Deferred as
  a pluggable upgrade.
- **Cloud LLM (Claude API).** Best quality but **violates the local-only NFR**. Rejected.

## Update — v2 (2026-06-26)

`CLASSIFIER_VERSION = 2`, re-runnable via `agent-lens-metrics` (no re-ingest). Same design; tuned
against the real session distribution:

- **Complexity ceilings raised to realistic p90s** (LoC churn 2k→6k, files 20→40, work-tokens
  2M→40M, duration 120→600 min). v1 pegged most main sessions' subscores at 1.0, so two-thirds
  landed in "large"; the bands were re-cut (`22/40/55/68`) so main work now spreads across all five
  bands and subagent sessions fall into "trivial".
- **Subagent sessions are categorized by their spawner's role** (schema-v3 linkage: `Explore`/`Plan`/
  reviewer roles ⇒ `review`) instead of keyword-matching a read-only exploration transcript;
  general-purpose/unknown subagents still use the heuristic. The spawner role is recorded in
  `signals_json.subagent_role`. Dashboards already scope category/complexity to main sessions.
- **Category denoise:** dropped the over-eager `"new "` feature keyword; added an edit-dominated
  refactor signal so rework reads as `refactor`, not `feature`.
