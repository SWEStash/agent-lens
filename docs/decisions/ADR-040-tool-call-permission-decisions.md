# ADR-040 — Each tool call records how it was approved

- Status: Accepted
- Date: 2026-11-12
- Deciders: project owner
- Extends [ADR-003](ADR-003-data-model-and-store.md) (`tool_calls`) and [ADR-017](ADR-017-security-findings.md) (findings)
- Related: [ADR-008](ADR-008-adapter-extensibility-seam.md) (format knowledge stays in the adapter), [ADR-039](ADR-039-otel-is-enrichment-not-source.md) (mine transcript fields before OTEL)

## Context

The Security view shows what a tool call did, not why it was allowed to run. Recent Claude Code
versions write that answer on the transcript line that carries a tool result, as a top-level
`permissionDecision` object beside `toolUseResult`:

```json
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…"}]},
 "permissionDecision":{"decision":"accept","source":"config","reasonType":"classifier"}}
```

A scan of the real archive (field names and codes only) found:

- The object is on about a third of transcripts, subagent transcripts included. Each line that
  carries it carries exactly one `tool_result`, so the link to the tool call is unambiguous.
- Even in a transcript that has it, many results don't (most Bash results do, about half of Skill
  results do not). A missing object therefore means **not recorded**, not "allowed without asking".
- Every value is a closed code: `decision` (`accept` / `reject`), `source` (`config`,
  `user_temporary`, `user_reject`, `hook`), `reasonType` (`classifier`, `mode`, `rule`, `hook`,
  `subcommandResults`, `safetyCheck`, `other`, or absent), `ruleSource` (which settings file),
  `grantScope` (`once` / `session`), `reasonCode` (e.g. `rule:userSettings`, `hook:PreToolUse`,
  `subcommands:bashMiss:no-rule-match+rule:userSettings`), and the rare `classifierCategory` and
  `circuitBreaker`. No free text, paths or commands.

The format is internal to Claude Code and has already grown fields; nothing guarantees it is stable.

## Decision

1. **Five nullable columns on `tool_calls`** (SCHEMA_VERSION 17):

   | column | meaning |
   |---|---|
   | `permission_decision` | `accept` or `reject` |
   | `permission_via` | the channel that decided, agent-agnostic (below) |
   | `permission_scope` | how long a user grant lasts: `once` or `session` |
   | `permission_rule_source` | which settings source held the deciding rule |
   | `permission_reason` | the source's own fine-grained reason code, verbatim |

   Columns, not a side table: findings already join `tool_calls`, and the values are a few bytes on a
   row that averages kilobytes.

2. **`permission_via` is a closed, agent-agnostic set**: `user`, `rule`, `mode`, `classifier`,
   `hook`, `safety_check`, `other`. The Claude Code adapter maps its codes onto it, so another agent's
   adapter can fill the same column (ADR-003), and no reader parses Claude Code's shape (ADR-008):
   - `source` `user_temporary` / `user_reject` → `user`
   - `source` or `reasonType` `hook` → `hook`
   - `reasonType` `classifier` → `classifier`; `mode` → `mode`; `safetyCheck` → `safety_check`
   - `reasonType` `rule` or `subcommandResults` → `rule`
   - anything else, including an absent `reasonType` → `other`

   `permission_reason` takes `reasonCode`, else `classifierCategory`, else `circuitBreaker`.

3. **NULL is "not recorded", never a guess.** Older transcripts, and results the source did not
   annotate, keep all five columns NULL, and the UI says "not recorded". Nothing infers a decision
   from the permission mode or the tool.

4. **Parse defensively.** Only string values are read. An unknown code passes through in
   `permission_reason` and maps to `other`; it never fails ingest.

5. **Findings filter by approval** (`approval=` on the findings list and bulk dismiss, which share one
   WHERE builder, so their counts cannot drift). A `permission_via` value means *approved* through
   that channel, `rejected` is any rejected call, and `unknown` is not recorded. The buckets partition
   the findings: each falls in exactly one.

6. **The corpus redactor keeps the object**, restricted to its known keys and to values that match a
   closed-code pattern, so it can never carry text. The synthetic scenario `sc-approvals-0013` covers
   every channel end to end; the redacted real sessions predate the field.

7. **A store from an older build still serves.** Until `ingest --full`, the server selects NULLs in
   place of the missing columns, so the transcript and the Security view work and every call shows
   "not recorded".

## Consequences

- Upgrading needs `agent-lens ingest --full` to fill the columns (the schema banner already says so);
  until then nothing breaks, and nothing is recorded.
- The Security view can answer "was this risky command approved by me, a rule, or the classifier?"
  and list every rejected call.
- Rows labelled `other` are honest but coarse; the largest group is `accept` from `config` with no
  `reasonType`, shown as "allowed by settings".
- OTEL `tool_decision` events stay out of scope (ADR-039).
