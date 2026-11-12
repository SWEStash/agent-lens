# ADR-039 — OpenTelemetry is an optional enrichment signal; the transcript archive stays the system of record

- Status: Accepted (2026-11-12: Option C is not scheduled; no current feature needs OTEL-only data)
- Date: 2026-11-12
- Deciders: project owner
- Upholds [ADR-001](ADR-001-two-stage-collection.md) (raw archive + rerunnable parser) and
  [ADR-005](ADR-005-privacy-posture.md) (local only)
- Related: [ADR-008](ADR-008-adapter-extensibility-seam.md) (collection is outside the adapter seam),
  [ADR-022](ADR-022-file-modification-provenance.md) (provenance levels 2–3),
  [ADR-028](ADR-028-model-pricing.md) (derived cost), [ADR-038](ADR-038-shared-session-history.md)

## Context

Agent Lens collects sessions by copying Claude Code's transcript files
(`~/.claude/projects/**.jsonl`) into an append-verified archive and parsing them in a rerunnable
ingest (ADR-001, ADR-002, ADR-013). Claude Code now also exports OpenTelemetry. This ADR records
whether that changes how we collect. It is based on the current docs
(`code.claude.com/docs/en/monitoring-usage`, `/sessions`, `/claude-directory`, read 2026-11-12) and
on Claude Code 2.1.322, the version installed here.

### What Claude Code's OpenTelemetry provides

- **Signals.** Metrics (8 counters), events (OTLP logs: about 30 event types), and traces (beta,
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Exporters are `otlp` (`grpc`, `http/json`,
  `http/protobuf`), `console`, and `prometheus` (metrics only).
- **Content is off by default.** Prompts, responses, tool inputs, and tool output are reported as
  lengths and sizes. Four flags turn content on: `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, and `OTEL_LOG_TOOL_CONTENT` (spans only).
  Even with every flag on, content is truncated: `tool_input` keeps at most 512 characters per value
  and about 4 K in total, and span content is capped at 60 KB per attribute. Thinking is never
  exported. The docs say it is redacted even from the raw API bodies that `OTEL_LOG_RAW_API_BODIES`
  writes.
- **Join keys into the transcript.** Events carry `session.id`, `message.uuid` (the transcript
  `uuid`), `request_id` (the transcript `requestId`), `tool_use_id`, and `prompt.id`. The docs call
  these joins *version-specific*: the transcript format is internal, so a join can break on any
  release.
- **Configuration scope.** The `OTEL_*` variables are honored from the shell, user settings
  (`~/.claude/settings.json`), and managed settings. They are **ignored** in a repository's
  `.claude/settings*.json`, but a repository can still turn a signal *off*. Managed settings can lock
  the destination. Each signal has one endpoint.
- **Delivery is push and best-effort.** Nothing is backfilled, and the docs describe no persistent
  export queue. If no receiver is listening, the data is gone. Export failures appear only in the
  debug log.

### What the transcript already carries that we don't read yet

A scan of the archive (28,220 transcript files) and of the 150 most recent local transcripts found
fields Agent Lens does not ingest:

| Record / field | What it holds | Prevalence |
|---|---|---|
| `permissionDecision` on tool results | `decision`, `source` (`config` / `user_temporary` / `hook`), `reasonType` (`classifier` / `mode` / `hook` / `other`), `reasonCode`, `ruleSource`, `grantScope`, `classifierCategory` | 8,122 files |
| `system` / `turn_duration` | `durationMs`, `messageCount` per turn | 663 files |
| `cost-state` | `totalCostUSD`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, lines added/removed, `modelUsage` | 302 files (recent versions) |
| `pr-link`, `toolUseResult.gitOperation` | the PRs a session created or edited, and the branches it pushed | recent versions |
| `api-request` | `querySource` and request `params`: model, thinking config, `max_tokens`, effort | recent versions |

For permission decisions, which matter most to the security audit, this is the same information
OTEL's `tool_decision` event carries, and it covers the full history.

### What only one side has

| Capability | Transcript | OTEL events | OTEL traces (beta) |
|---|---|---|---|
| History from before enablement | ✅ 28 k files archived | ❌ none | ❌ |
| Thinking | ✅ | ❌ never | ❌ |
| Full tool input / output | ✅ (plus `tool-results/` spill) | ❌ truncated, off by default | ⚠️ 60 KB cap, flag, not for failed calls |
| Conversation structure (parent chain, sidechains, compaction, attachments, continuations) | ✅ | ⚠️ ids only | ⚠️ span tree |
| Persists when Agent Lens is not running | ✅ on disk | ❌ lost | ❌ lost |
| Permission decision and its source | ✅ `permissionDecision` | ✅ `tool_decision` | ✅ |
| **Per-tool execution time** | ❌ only the tool_use→result gap, which includes permission wait | ✅ `tool_result.duration_ms` | ✅ |
| **Time spent waiting on the user's approval** | ❌ | ❌ | ✅ `claude_code.tool.blocked_on_user` |
| **Per-request API latency, TTFT, retries, refusals** | ❌ session totals only (`cost-state`) | ✅ `api_request`, `api_error`, `api_refusal`, `api_retries_exhausted` | ✅ `ttft_ms` |
| **MCP connects, hook runs, plugin loads, auth, managed settings** | ⚠️ partial (hook attachments) | ✅ | ✅ hook spans (detailed beta only) |
| **What Claude Code's retention sweep deleted** | ❌ | ✅ `retention_sweep` | — |
| **Commit SHA of a `git commit` the agent ran** | ❌ push/PR only | ✅ with `OTEL_LOG_TOOL_DETAILS` | — |
| **Active time, user vs CLI** | ❌ | ✅ `active_time.total` metric | — |
| Trace context into Bash subprocesses | ❌ | ❌ | ✅ `TRACEPARENT` |
| Documented, supported schema | ❌ internal; ADR-038 records 2.1.318 breaking an assumption | ✅ (attributes keep gaining version gates) | ⚠️ beta, may change |

The rows in bold are what OTEL adds: **timing, operational events, and a record of deletions**.
None of it is content, and none of it covers history.

## Options

**A. Keep the transcript archive and read nothing new.** No cost, but it ignores data already on
disk (the permission-decision table above).

**B. Keep the transcript archive and ingest the fields it already carries.** Read
`permissionDecision`, `cost-state`, `turn_duration`, `pr-link`/`gitOperation`, and `api-request`
params inside `ClaudeCodeAdapter`. Needs no new infrastructure and covers the full history. Parsing
stays exposed to format churn, which is already contained: the adapter owns all parsing (ADR-008),
and `raw_json` is kept so a later re-derivation can recover a field (ADR-001).

**C. Do B, and add an opt-in OTEL *events* receiver as a second Stage-1 source.** A loopback
OTLP/HTTP-JSON listener appends each request body unparsed to the archive. Ingest then joins those
events to transcript rows on `session.id`, `tool_use_id`, and `request_id`. This adds the bold rows
above. It costs a resident listener, a write into the agent's user settings, and a threat model.

**D. Make OTEL the primary source.** Rejected. There is no history and no thinking. Content is
truncated and would need every content flag turned on, which sends prompts and commands over a local
socket. Delivery is best-effort, so the "never lose a trace" goal of ADR-001 fails, and a re-derive
over history is no longer possible. The retrospective security audit, file provenance, full-text
search, and redacted export all need the full content that only the transcript has.

Two smaller collection changes were also considered:

- **Event-driven collection through a `SessionEnd` or `PreCompact` hook** (the docs suggest
  "a SessionEnd hook can archive the transcript"). Not needed today. The timer and `watch` already
  collect well inside the 30-day sweep. Compaction and divergence are captured: 97 `.versions/`
  snapshots so far. Claude Code now also sets old transcripts aside itself (see Consequences).
- **Recommending a longer `cleanupPeriodDays`** in the usage guide is a free safety margin for users
  who don't run the collector every day.

## Decision

1. **The transcript archive stays the system of record.** ADR-001 and ADR-002 are unchanged.
   OTEL never becomes a required input, and no view may depend on it to be correct.
2. **Do B now.** The transcript fields listed above go into ingest, each with its own fixture test,
   starting with `permissionDecision`, because it serves the security audit directly.
3. **OTEL enters only as Option C, and only when a feature needs data that only OTEL has.** That
   means tool timing, permission-wait, API reliability, MCP or hook health, the retention-sweep
   audit, or commit SHAs. When that happens, the shape is fixed by this ADR:
   - **Stage 1 stays dumb.** The receiver authenticates the request, caps the body size, and
     appends the raw OTLP JSON to `data/archive/<label>/otel/<YYYY-MM-DD>.jsonl` (mode 0600). It
     never writes the DB. Ingest parses that file the way it parses transcripts, so OTEL data is
     rerunnable too.
   - **Events only, content off.** The receiver handles `/v1/logs` and nothing else at first.
     Metrics can be rebuilt from events. Traces wait until they leave beta, unless permission-wait
     time is the feature being built. Agent Lens takes content from the transcript, so it sets no
     `OTEL_LOG_*` content flag.
   - **`http/json` only.** `node:http` plus `JSON.parse` is enough, so the receiver is our own small
     module. No `@opentelemetry/*`, protobuf, or gRPC dependency (in the spirit of ADR-029).
   - **Loopback, with a token.** It binds `127.0.0.1` (ADR-005). It requires a bearer token,
     generated at enable time and passed through `OTEL_EXPORTER_OTLP_HEADERS`. Agent Lens is an
     audit tool, so injected fake events are an integrity risk, and a threat model is a
     precondition.
   - **Source labels come from resource attributes.** `agent-lens otel enable` writes the `env`
     block into each source's `<configDir>/settings.json`, with
     `OTEL_RESOURCE_ATTRIBUTES=agent_lens.source=<label>`. It shows the diff first and refuses to
     overwrite an existing OTEL destination, because there is one endpoint per signal and managed
     settings can lock it. `agent-lens otel disable` reverts the change. This is Agent Lens's first
     write into an agent's config, so it is explicit and reversible.
   - **Coverage is shown, never implied.** Each session records whether telemetry arrived for it. A
     metric built from OTEL is labeled with its coverage and is never presented as complete, since
     delivery is best-effort and a repository can turn signals off.
   - **One format for both inputs.** The archive stores OTLP JSON, which is also what an
     OpenTelemetry Collector's file exporter writes (verify when building). A user who already sends
     telemetry to a company backend can fan out through their own collector, and ingest reads its
     file the same way.

## Consequences

- No change to collection now. The first step (B) is ingest and schema work inside existing
  boundaries.
- The security audit can answer "was this command auto-approved by the classifier, by a user rule,
  or by the user once?" over the full history, with no telemetry setup.
- Features that depend on OTEL get a defined, ADR-001-compatible design instead of an improvised
  listener. Until one is chosen, we carry no resident receiver and write nothing into agent
  settings.
- **Gaps found during this review, still to verify with tests.** Claude Code may set a previous
  transcript aside as `<session>.orphaned-<ts>-<suffix>.jsonl` or
  `<session>.jsonl.superseded-<ts>`. The collector skips the second form (it is not `*.jsonl`).
  `ClaudeCodeAdapter.discover` would derive a wrong session id for the first
  (`basename(path, ".jsonl")`). Neither form exists on this machine today, so nothing has been lost
  yet.

## Revisit triggers

- **Claude Code ships a supported structured session export with full content.** The docs today
  point scripts to `/export`, `-p --output-format json`, hook `transcript_path`, and the Agent SDK.
  None of these is a full-fidelity, history-wide export. If one appears, reconsider Stage 1.
- **Traces leave beta.** Reconsider the "events only" rule.
- **A real second agent is onboarded and its OTEL is richer than its local files** (Codex CLI and
  Gemini CLI both export OTel). An OTLP receiver could then become the cross-agent *collection* seam
  that ADR-008 leaves open.
- **Sessions that leave no local transcript become in scope** (cloud sessions, CI,
  `--no-session-persistence`, other machines). OTEL is the only route for them, and receiving from
  other hosts would need ADR-005 revisited first.

## Verification (when C is built)

- With the receiver stopped, Claude Code still runs, and no view changes.
- A request without the token is rejected and nothing is appended.
- `agent-lens otel disable` restores the original `settings.json` byte for byte.
- `--full` re-ingest over the archived OTEL files reproduces the same rows.
