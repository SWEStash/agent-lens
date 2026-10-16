# ADR-020 — Redacted, export-only session sharing

- Status: Accepted
- Date: 2026-07-18
- Deciders: project owner

## Context

Users want to share a session transcript (a bug repro, a "look what my agent did" security example)
without hand-scrubbing secrets first. Agent Lens already renders a session to Markdown
(`sessionToMarkdown`, served at `GET /api/sessions/:id/export.md`) but **verbatim** — it emits message
text, thinking, and tool `input_json` (bash commands, Write/Edit content) as-is, including secrets,
tokens, emails, and `/home/<user>/…` paths.

We also already have a redactor — `packages/ingest/src/redact.ts` — but it is the wrong tool here:

- It is **deny-by-default**: it scrubs *all* narrative text to `[redacted]` because its job is a
  metric-preserving validation *corpus*, not a readable share. Applied to a share it produces a wall
  of `[redacted]` — useless for "show what happened".
- It lives in `packages/ingest` and operates on **raw JSONL objects**, so `core`/`server` (which
  render from DB rows) can't reuse it.

Hard product constraints (the local-only line): **no server-side share links, no upload, no outbound
calls.** The output must be a local file the human decides what to do with. Redaction defaults ON.

## Decision

Add a **selective, export-only sanitizer in `packages/core`** (colocated with `markdown.ts`,
importable by `server` and `cli`), with three levels chosen by the caller:

- **`secrets` (default)** — keep the narrative readable; mask only secret *values* (PEM, AWS, GitHub,
  Slack, `sk-` keys) and PII (email → `[EMAIL]`, IPv4 → `[IP]`), and strip the home **username** only
  (`/home/alice/x` → `/home/user/x`, rest of the path kept). This covers **both** the slash form and
  the Claude Code **encoded** form (`-home-alice-proj` → `-home-user-proj`), which appears verbatim in
  scratchpad/task paths in transcript text and would otherwise leak the username past the slash strip.
  Ordinary URLs stay readable.
- **`structure`** — aggressive scrub: narrative → `[redacted]`, tool inputs → `{}`, paths fully
  pseudonymized. For maximum-paranoia shares.
- **`off`** — explicit verbatim opt-out (the old behavior).

Mechanics:

- **Canonical patterns live in `packages/core/src/secrets.ts`** — the single source of truth. The
  corpus redactor's fail-closed scan (`LEAK_PATTERNS` / `findLeak`) **moved here** and is re-exported
  from `redact.ts` so that module's API is unchanged. (`detect.ts` keeps its own FP-tuned v8
  patterns for now; a later cleanup can dedupe against `secrets.ts`.)
- **Fail-closed, per level.** After field-level masking and rendering, a post-render scan runs and
  masks any survivor inline, guaranteeing the emitted file passes the scan. The `secrets` level uses
  `SHARE_LEAK` (secret values + email + home-path-with-user, **excluding** generic URLs so doc links
  survive); `structure` uses the strict corpus `LEAK_PATTERNS`.
- **Best-effort disclaimer.** Every redacted export is prepended with a header stating the redaction
  is best-effort/pattern-based, **not a guarantee**, and was generated locally / never uploaded.
- **Surfaces.** `GET /api/sessions/:id/export.md?redact=secrets|structure|off` (default `secrets`;
  filename `session-<id8>.redacted.md` vs `.md`); a web `<details>` export menu (redacted / structure
  / verbatim); and `agent-lens export <id> [--out] [--level] [--no-redact] [--db]`. The route and CLI
  share `renderSessionExport` (server) so the DB-row → Markdown mapping exists once.
- The static-snapshot demo (`scripts/export-snapshot.mjs`) calls the endpoint with no param, so it now
  publishes the redacted default automatically.

## Audit hardening (2026-07-18, same day)

An empirical sweep exported ~250 real sessions at `secrets` level and scanned the *redacted* output
for residual leaks. It confirmed the base masking is clean (email / home-path / AWS-key residuals all
zero) and drove these additions, all with regression tests and re-verified to zero on real data:

- **Username derive-&-scrub.** The home-dir owner(s) are derived from the session's own paths
  (`/home/<u>/`, `-home-<u>-`, `C:\Users\<u>\`) and scrubbed as whole tokens **everywhere** → `[USER]`,
  catching bare occurrences no path pattern would (e.g. `github.com/<u>/repo`, prose, git remotes).
  A stoplist (`ubuntu`, `root`, `runner`, …) and a ≥3-char floor avoid mangling common/OS words.
- **URL-embedded credentials.** `scheme://user:pass@host` → keep the host; secret query params
  (`?token=`, `?api_key=`, …) → mask the value. Needed because the policy keeps URLs readable.
- **More token formats:** Google `AIza…`, Stripe `sk_live_…`, OpenAI `sk-proj-…`, Anthropic
  `sk-ant-…`, GitHub fine-grained `github_pat_…`, npm `npm_…`, Slack `xapp-…`, and JWTs.
- **Conservative env-var assignments.** `NAME=<literal>` where NAME is secret-shaped (`*_SECRET`,
  `*_TOKEN`, `*_KEY`, `PASSWORD`, …) and the value is **not** a `$VAR`/`${VAR}` reference.

Deliberately NOT added (false-positive-prone on real data): aggressive IPv6 masking (ffmpeg
`crop=…`), tilde-user (`~5min` approximations), and bare `?key=` query params (sort/pagination).

## Consequences

- The default download is safe-by-default; leaking raw content requires an explicit `redact=off`.
- Redaction is pattern-based and **not exhaustive** — docs and launch copy must not claim guaranteed
  redaction (same honesty stance as detector coverage). The disclaimer says so in-band.
- `secrets.ts` is now the home for shareable secret/PII patterns; `detect.ts` duplication is a known,
  deliberate follow-up, not an oversight.
- The corpus redactor (ADR path, validation Layer 4) is untouched behaviorally — its `findLeak` is the
  same function, now imported from core.
