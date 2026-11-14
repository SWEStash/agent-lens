# ADR-042 — The CLI answers questions from the store

- Status: Accepted
- Date: 2026-11-13
- Deciders: project owner
- Extends [ADR-012](ADR-012-single-cli-distribution.md) (one bundled CLI)
- Related: [ADR-005](ADR-005-privacy-posture.md) (local only, read-only readers), [ADR-018](ADR-018-security-triage-store.md) (triage state), [ADR-026](ADR-026-api-response-contracts.md) (API response contracts)

## Context

Agent Lens is used through the web UI, but its users work in a terminal next to Claude Code. Quick
checks ("any new findings since yesterday?", "what did today cost?") needed a browser, and scripts
and cron jobs had no machine-readable way to ask. Issue #82 weighed three options: read-only report
commands; those plus a small interactive browser; or a full TUI mirroring the web UI. The maintainer
chose the second. A full TUI was ruled out because every UI feature would cost twice, and charts,
the heatmap and the timeline render poorly in a terminal.

## Decision

1. **Report commands: `agent-lens sessions`, `findings` and `cost`.** They open the store read-only
   with the server's own `openReadonly`, and call the server's query functions (`listSessions`,
   `listFindings`, `dashboardOverview`) in-process. No second implementation of any query exists, so
   the terminal and the web UI can't disagree.

2. **`--json` prints the API contract.** The payload is exactly what the matching endpoint returns
   (`SessionsPage`, `FindingsPage`, `DashOverview` from `@agent-lens/contracts`), so a script written
   against one works against the other. Tables are plain text with no colour, fitted to the terminal
   width, so they pipe.

3. **Triage is honoured read-only.** When `triage.db` exists beside the store it is ATTACHed to the
   read-only handle, so `findings` hides dismissed and muted findings like the Security view. Without
   it every finding is open. The CLI never writes triage state.

4. **`--since` is exact for relative windows.** `24h`, `7d` and `2w` become an exact ISO timestamp,
   and the shared date filter compares a full timestamp exactly while a bare date keeps the existing
   inclusive whole-day comparison. The web UI only sends dates, so its behaviour is unchanged.

5. **The interactive browser is our own module, not a TUI library.** It needs a session list, a
   transcript pager, and a key that opens the session in the web UI. Ink, the obvious candidate,
   would bundle React, `react-reconciler`, a WebAssembly layout engine and 23 direct dependencies
   into a CLI whose only runtime dependencies are fastify, @fastify/static and chokidar. Node already
   provides raw-mode keypress events, the alternate screen and resize events. The module keeps its
   layout and wrapping as pure functions so they are tested without a TTY.

## Consequences

- Every new query the web UI gains can reach the terminal by calling the same function; no
  terminal-only query is written.
- A report command fails with one line on a missing store or one that needs `ingest --full`, rather
  than showing empty results.
- The browser stays small by design. A request for charts or other views belongs in the web UI.
