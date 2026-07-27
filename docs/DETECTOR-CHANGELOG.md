# Security detector changelog

Version history for `DETECTOR_VERSION` in `packages/ingest/src/detect.ts` (ADR-017).
Bump the constant on any rule/severity change so a re-run is attributable to an engine
version (mirrors `CLASSIFIER_VERSION`); the value is recorded on every row and in
`signals_json`. Finding ids are independent of this version, so a bump does not
invalidate user triage state.

## v8 — obfuscation & traversal coverage

Closes two coverage gaps (SA10 obfuscated content, SA08 path traversal) from the
detector audit.

- **New rule `obfuscated.decode_exec`** (privilege.*): a decoder whose output is piped
  into an interpreter that executes it (`base64 -d | sh`, `xxd -r | bash`,
  `openssl … -d | sh`, `uudecode | sh`) — a decode-then-execute evasion primitive that
  hides its payload from a reader and from token-pattern rules. Matched on the executed
  view (`commandBare`) so a decode string that is only echoed/quoted/commented stays
  inert; requires the decoder UPSTREAM of a pipe INTO the interpreter (so
  `base64 -d f > out`, decode-to-file, does not flag), and reuses `curl_pipe_shell`'s
  node/python/perl/ruby carve-out (an inline program `-e`/`-c`/`-m`/`-p` consumes the
  decoded output as data, not a script). Piping to `sudo <shell>` escalates high→critical.
  Fills the gap `curl_pipe_shell` leaves when a decoder sits between the fetch and the
  shell (`curl … | base64 -d | sh`), with no double-count.
- **`write_outside_project`** now also flags a RELATIVE `../` write that escapes the
  project: `outsideProjectPath` resolves a `../`-bearing relative path against the
  session's project root (posix-normalized) and runs the existing owned/outside/
  `SYSTEM_PATH` checks on the resolved absolute path, so `../../../../etc/cron.d/x` lands
  as high (system) while a `../sibling` write stays low and a `../` that normalizes back
  inside the project does not flag. A finding raised via traversal carries
  `mods.traversal`. `secret_file_access` already matched `../../.env`/`../../id_rsa`
  (`SECRET_FILE` ignores the leading `../`), so it is unchanged.

## v7 — three destructive false positives cut

- **`sql_drop`** now requires a real database-client invocation (psql/mysql/sqlite3/…)
  for the Bash path, so a DROP/TRUNCATE keyword that only appears as text — a
  `grep "…\|truncate"` search pattern, an echoed string — no longer flags (the structured
  `input.query` path is unchanged).
- **`rm_rf`** no longer treats `git rm` (a tracked-file removal recoverable from history)
  as a filesystem `rm -rf`, and matches its recursive/force flags as whitespace-bounded
  letter clusters so a path token like `reports/…-software-engineer…` is never mistaken
  for `-fr` flags. An `rm -rf` whose targets are all under a temp dir (`/tmp`,
  `/var/folders`) drops from high to low — temp dirs are agent-owned scratch (writes
  there aren't flagged at all), so a cleanup delete is routine; a home/root/glob target
  still escalates to critical.

## v6 — exfil scoring by destination + medium-bucket re-tiering

- **`exfil.network_upload`** scores curl/wget uploads by destination scope instead of
  always-high — external host = high (critical with a file), private/internal host
  (RFC1918 / link-local / .local / bare service name) = low, loopback = info; a real file
  (`@file` / `-T` / `--upload-file`) bumps the internal/loopback tiers one step. The host
  is classified on the verbatim command (`commandBare` blanks quoted URLs, hiding the
  host) with `-H`/`--header` args stripped so a URL in an Origin/Referer header can't pose
  as the target; and the upload-flag match is case-SENSITIVE so curl's `-D`/`-f`/`-t`
  (dump-header/fail/…) no longer read as `-d`/`-F`/`-T` uploads.
- Re-tiers several routine ops out of the crowded medium bucket: `write_outside_project`
  (non-system) and `git_reset_hard` / non-protected `git_force_push` drop to low, and
  `overwrite_critical` splits — lockfile churn is low while a CI-config overwrite stays
  medium (poisoned pipeline is a supply-chain risk); system-path writes and
  protected-branch force-push keep their high.
- **`curl_pipe_shell`** no longer flags `curl … | node -e`/`python -c`/`python -m` (the
  interpreter runs inline code and the piped output is just data, e.g. parsing an API
  response) — only a shell or a bare node/python that executes the downloaded body flags.

## v5 — executed-view matching

- Match command-pattern rules against an "executed view" of the command (`codeOf` —
  comments stripped, echo/printf output neutralized) so a dangerous token that is only
  printed, commented, quoted (`node -e '… sudo …'`, `grep "sudo"`), or inside a heredoc
  body no longer flags; scope `sudo` to command position (ignores `apt install sudo`);
  add `privilege.exec_generated_script` for the write-a-script-then-run-it pattern that
  makes echoed/heredoc'd text live.

## v4 — pipeline-segment secret scoring

- Fix template exclusion when the path is followed by shell text (`.env.example | …`);
  score secret reads per pipeline segment so `file/ls … | grep` no longer counts as a
  content read; derive the agent-owned config roots from the configured sources'
  `config_dir` (covers `~/.claude-isf` and any relocated install) instead of a hardcoded
  `.claude` pattern.

## v3 — credential-access tightening

- Exclude `.env.example` / config templates from credential-access, require a real
  content-read verb (ls/file/stat no longer flag), raise `sudo` to high.

## v2 — agent-owned path allowlist

- Allowlist agent-owned paths so the agent writing to its own config/work dir (e.g. a
  plan file under `~/.claude/plans`) or a temp dir is not flagged as an out-of-project
  write.
