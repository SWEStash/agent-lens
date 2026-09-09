#!/usr/bin/env bash
# Build the committed, privacy-safe validation corpus (validation Layer 4).
#
# Stages a small RAW subset of real, NON-agent-lens sessions (one per source, each with its
# subagents) into a gitignored temp tree, redacts it into test/fixtures/corpus/, then runs the
# oracle to prove the redaction preserved every metric. The RAW subset stays out of git; only the
# redacted corpus is committed. See memory: test-corpus-redaction.
#
# Re-runnable: regenerates the corpus from scratch. Requires the archive at data/archive.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

RAW="${AL_CORPUS_RAW:-/tmp/al-corpus-raw}"
CORPUS="test/fixtures/corpus"
ARCHIVE="${AGENT_LENS_DATA:-data}/archive"

# Never emit this project's own data: default the exclude list to the repo root (computed, not a
# hardcoded name). Extend via AGENT_LENS_EXCLUDE; redact-cli enforces it. See memory test-corpus-redaction.
export AGENT_LENS_EXCLUDE="${AGENT_LENS_EXCLUDE:-$REPO}"
# Fixed salt so regenerating yields a byte-stable corpus (reviewable diffs); override to reshuffle.
export AGENT_LENS_REDACT_SALT="${AGENT_LENS_REDACT_SALT:-agent-lens-corpus-v1}"

# Chosen sessions: "<srcLabel>|<encodedDir>|<sessionUUID>|<outLabel>". Small, with subagents, no agent-lens.
#
# The selection is NOT committed: it names a real source label, a real project directory (which
# carries the operator's username) and real session ids — the very things the redactor exists to keep
# out of this repo. Keep it in scripts/corpus-sessions.local (gitignored), one spec per line, e.g.
#
#   work|-home-jdoe-git-projects-example-app|3d2f5a38-3e12-423e-870b-c1f402993a29|team-a
#
# Only whoever holds the matching archive can regenerate the corpus anyway, which is why nothing is
# lost by keeping the list beside it rather than in git.
SPEC_FILE="${AL_CORPUS_SESSIONS:-scripts/corpus-sessions.local}"
if [ ! -f "$SPEC_FILE" ]; then
  echo "build-corpus: no session list at $SPEC_FILE" >&2
  echo "  Write one spec per line: <srcLabel>|<encodedDir>|<sessionUUID>|<outLabel>" >&2
  echo "  (or point AL_CORPUS_SESSIONS at another file). See the comment in $0." >&2
  exit 1
fi
SESSIONS=()
while IFS= read -r line; do
  [ -z "${line%%#*}" ] && continue   # skip blanks and comment lines
  SESSIONS+=("$line")
done < "$SPEC_FILE"

# Regenerate only the redacted real sources; the synthetic scenarios source is rebuilt separately.
rm -rf "$RAW" "$CORPUS/team-a" "$CORPUS/team-b"
for spec in "${SESSIONS[@]}"; do
  IFS='|' read -r src enc uuid out <<<"$spec"
  srcdir="$ARCHIVE/$src/projects/$enc"
  stage="$RAW/$out/projects/$enc"
  mkdir -p "$stage"
  cp "$srcdir/$uuid.jsonl" "$stage/"          # main session transcript
  [ -d "$srcdir/$uuid" ] && cp -r "$srcdir/$uuid" "$stage/"  # its <uuid>/subagents/agent-*.jsonl
  node packages/ingest/dist/redact-cli.js --out "$CORPUS" --label "$out" "$stage"
done

# Synthetic scenarios source (hand-authored, no real data) — full scenario coverage for the sandbox.
node scripts/build-scenarios.mjs

echo
echo "=== oracle: raw subset vs redacted corpus (scenarios source excluded — it has no raw twin) ==="
node scripts/oracle.mjs --a "$RAW" --b "$CORPUS" --ignore "/scenarios/"

echo "corpus size: $(du -sh "$CORPUS" | awk '{print $1}')  files: $(find "$CORPUS" -name '*.jsonl' | wc -l)"
