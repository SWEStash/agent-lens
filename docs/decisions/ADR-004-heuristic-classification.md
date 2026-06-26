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
