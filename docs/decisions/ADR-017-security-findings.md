# ADR-017 — Retrospective security findings via a deterministic rule engine

- Status: Accepted
- Date: 2026-07-14
- Deciders: project owner

## Context

Agent Lens passively archives Claude Code sessions and lets you browse them *after* they run. Those
transcripts contain a full record of what the agent did on the host — including risky operations:
destructive/data-loss commands, reads of secrets, data exfiltration, and guardrail bypasses. Nothing
surfaces those today; a user would have to read every transcript to notice a breach, a leaked
credential, or a deleted database.

Runtime tools (PreToolUse hooks, endpoint agents like Sysdig) can *block* such actions live, but they
don't give you a browsable **history** of what agents did. That retrospective, forensic view is the
gap Agent Lens is positioned to fill. The strict local-only privacy NFR (ADR-005) rules out sending
trace content to a cloud LLM, exactly as for classification (ADR-004).

## Decision

Add a **security findings** feature that flags risky operations deterministically — no AI — mirroring
the classification design (ADR-004):

- A re-runnable post-process (`packages/ingest/src/detect.ts`) scans each `tool_calls` row's verbatim
  `input_json` / `result_summary` / `status` (plus the session's project path) against a rule set,
  emitting **0..N findings per tool call** into a new `findings` table.
- Each finding records `rule_id`, a framework-anchored `category`, `severity`
  (`info…critical`), the matched `evidence` (truncated — never a wholesale secret dump), and a
  `signals_json` explaining the match + any context modifiers — so a finding is transparent and the
  rules can be retuned. A `detector_version` lets a future engine supersede rows.
- **v1 categories & framework anchors** (OWASP Top 10 for Agentic Apps 2026 + MITRE ATLAS):
  - `destructive` — Tool Misuse (OWASP ASI02): `rm -rf`, `git reset --hard`, force-push,
    `DROP`/`TRUNCATE`, disk wipes, critical-file overwrites.
  - `credential-access` — reads of `.env`/ssh/cloud-cred files, secret-looking values in output.
  - `exfiltration` — Exfiltration via Tool Invocation (MITRE ATLAS AML.T0086): outbound uploads,
    pipe-to-network, reverse shells.
  - `privilege-bypass` — Excessive Agency (OWASP LLM06): `sudo`, `chmod 777`, `curl | sh`,
    `--dangerously-skip-permissions`, out-of-project writes, persistence.
- **Severity is context-aware**: a rule's base severity is escalated (e.g. a delete targeting `~`/`*`,
  a write under `/etc`) or de-escalated (a failed/`error` tool call is an *attempt*, one band lower),
  with the modifiers recorded in `signals_json`.
- **Surfacing** (all read-only): a browsable, filterable `/security` page (findings list + severity
  KPIs + framework "what & why" reference), inline per-tool severity badges in the transcript, a
  session-header banner, and a Dashboard KPI. Findings that fire on an otherwise-hidden tool override
  the "hide tool messages" toggle so a risky command is never hidden.

Findings are 0..N per tool call, so an incremental re-run **deletes the touched sessions' findings and
re-inserts** (delete-then-insert) rather than upserting one row per session as the classifier does.

## Consequences

- 100% local, deterministic, re-runnable, zero new runtime dependencies; a schema bump (v11 → v12)
  takes effect via the existing `ingest --full` migration path.
- **Retrospective, not preventive**: Agent Lens surfaces that something risky *happened* so the user
  can respond (rotate a secret, restore from backup, investigate an injection). It cannot block —
  that's a runtime concern, and the reference content points users at hooks for prevention.
- Rule-based detection is coarser than semantic analysis: it can miss novel patterns and raise false
  positives. Mitigated by explainable `signals_json`, tunable rules, the failed-attempt de-escalation,
  and `detector_version` for a future local-LLM pass.

## Alternatives considered

- **Local LLM (Ollama) scoring.** Richer nuance and fewer false positives, but adds a heavy dependency
  and latency the project has avoided. Deferred as a pluggable `detector_version` upgrade, exactly as
  ADR-004 defers it for classification.
- **Cloud LLM (Claude API).** Best quality but **violates the local-only NFR** (ADR-005). Rejected.
- **Runtime blocking (PreToolUse hooks).** Complentary, not a substitute — it prevents but keeps no
  browsable history, and lives in Claude Code, not in this retrospective analyzer. Out of scope; the
  reference content links users to it.

## Update — v2 (2026-07-14): path allowlist

`DETECTOR_VERSION = 2`. Real data showed the biggest false-positive source was the agent writing to
its **own** dirs — e.g. a plan file under `~/.claude/plans` — being flagged as an out-of-project write.
`detect.ts` now allowlists agent-owned paths (anything under `/.claude/` and temp dirs `/tmp`,
`/var/folders`, `$TMPDIR`), so `privilege.write_outside_project` no longer fires on them; genuine
system-dir writes (e.g. `/etc`) are still flagged. Finding ids are independent of `DETECTOR_VERSION`,
so the bump doesn't invalidate the triage state introduced in [ADR-018](ADR-018-security-triage-store.md).

## Update — v3 (2026-07-14): credential-access precision + severity tuning

`DETECTOR_VERSION = 3`. Tuning `credential-access` against real usage: config **templates**
(`.env.example`, `.sample`, `.template`, `.dist`) are excluded (reading a template exposes no secret),
and a Bash finding now requires a real **content-read** verb (`cat`, `less`, `grep`, …) — a bare
`ls`/`file`/`stat`/`find` that merely names a secret path no longer flags, since listing metadata isn't
reading the secret; a genuine `cat ~/.ssh/id_rsa` still does. `privilege.sudo` raised **medium → high**
(root escalation removes a real barrier). The findings list also carries the `tool_name` so path-only
evidence (e.g. a `Read`) reads as an operation. These are heuristic calibrations, not standard changes —
the category→framework anchoring is unchanged.
