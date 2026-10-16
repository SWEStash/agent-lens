# ADR-019 — Tool-error observability: is_error capture + a deterministic error taxonomy

- Status: Accepted
- Date: 2026-07-17
- Deciders: project owner

## Context

Agent Lens surfaced *what* the agent did (transcripts, cost, security findings) but not *where it got
stuck*. Two gaps:

1. **The failure signal was never captured.** A Claude Code tool call that fails carries `is_error: true`
   on its `tool_result` block. The adapter only mapped `toolUseResult.status` into `tool_calls.status` —
   and that field holds task/lifecycle states (`completed`, `async_launched`, …), **never `"error"`**. So
   `status` was empty for failures, which in turn made two consumers dead code: the transcript's
   `tool-err` styling (`t.status === "error"`) and `detect.ts`'s failed-attempt severity de-escalation
   (`row.status === "error"`, ADR-017) both never fired.
2. **No error visibility in aggregate or per session.** You couldn't see how often tools failed, of what
   kind, or filter sessions by it.

A subtlety governs the whole design: the **Messages API `tool_result.is_error` is a bare boolean with no
reason field** — the API does not distinguish a tool that genuinely failed from one the user or a
guardrail *rejected*. Claude Code sets `is_error` for both, and the only signal of which is the
human-readable result text (platform.claude.com tool-use docs; code.claude.com/docs/en/errors). On the
local corpus, **~17% of `is_error` calls are user-rejections / guardrail-blocks, not agent failures.**
The local-only, no-AI NFRs (ADR-005) apply exactly as for classification (ADR-004) and findings (ADR-017).

## Decision

1. **Capture the real signal.** Map `is_error` on the `tool_result` block → `tool_calls.status = 'error'`
   in `ClaudeCodeAdapter` (falling back to `toolUseResult.status` for non-error results). This revives the
   dead `tool-err` styling and the ADR-017 failed-attempt de-escalation for free.
2. **Classify deterministically.** A no-AI classifier (`packages/core/src/errors.ts`,
   `classifyToolError`) buckets an errored call from its verbatim `result_summary` into a `ToolErrorType`
   (`file-state`, `command-failed`, `string-not-found`, `token-limit`, `user-rejected`,
   `guardrail-blocked`, `other`) and a `ToolErrorKind` (`failure` vs `rejection`). `ERROR_CLASSIFIER_VERSION`
   lets a future engine supersede labels.
3. **Store it for querying.** A re-runnable derive pass (`packages/ingest/src/errors.ts`, `classifyErrors`),
   wired in after `detect` alongside `classify`, stamps `tool_calls.error_type` (schema **v12 → v13**: new
   nullable column + index). Storing it — rather than classifying at read time — lets the sessions filter
   and dashboard query/aggregate error kinds directly in SQL, with the core classifier as the single
   source of truth.
4. **Surface it, honestly.** Sessions list gains an **Errors** column (raw `is_error` count) and a
   multi-select **Errors** (by `error_type`) filter; the Dashboard gains *"Tool errors over time"*
   (failures vs rejections) and an *"Error types"* breakdown; the session detail shows the split
   *"X failed · Y declined/blocked of N tool calls"*.

**The authority boundary is explicit everywhere:** the raw `is_error` / `status='error'` **count is
authoritative** (documented API semantics); the **type buckets and the failure-vs-rejection split are a
versioned heuristic** over Claude Code's wording, labeled as such in the UI tooltips and code — never
presented as an API-reported fact.

## Consequences

- 100% local, deterministic, re-runnable, no new dependencies. The schema bump (v12 → v13) and the
  adapter fix both take effect via the existing `ingest --full` migration path (which backfills `status`
  and `error_type` on already-ingested rows).
- The `status` column now carries `'error'` for real failures, which **retroactively activates** the
  transcript `tool-err` styling and the ADR-017 de-escalation — a latent-bug fix, not just a new feature.
- The heuristic can drift if Claude Code changes its result wording; mitigated by keeping the raw count
  authoritative, the versioned classifier, and the "heuristic" labeling. ~14% of errors fall in `other`.

## Alternatives considered

- **Read-time classification (no stored column).** Avoids the schema bump, but can't be filtered or
  aggregated in SQL without replicating the classifier as `LIKE` clauses (drift risk). Rejected once the
  sessions error-type filter made SQL-queryable classification a requirement.
- **Treat all `is_error` as "failures".** Simpler, but overstates agent failures by ~17% (rejections and
  guardrail-blocks). Rejected on honesty grounds — the raw count stays, but the UI shows the split.
- **Local / cloud LLM classification.** Richer buckets, but violates the no-AI stance (ADR-004) and, for a
  cloud LLM, the local-only NFR (ADR-005). Deferred as a pluggable `ERROR_CLASSIFIER_VERSION` upgrade.
