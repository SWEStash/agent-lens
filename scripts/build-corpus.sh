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
ARCHIVE="${AGENT_LENS_ARCHIVE:-data/archive}"

# Never emit this project's own data: default the exclude list to the repo root (computed, not a
# hardcoded name). Extend via AGENT_LENS_EXCLUDE; redact-cli enforces it. See memory test-corpus-redaction.
export AGENT_LENS_EXCLUDE="${AGENT_LENS_EXCLUDE:-$REPO}"
# Fixed salt so regenerating yields a byte-stable corpus (reviewable diffs); override to reshuffle.
export AGENT_LENS_REDACT_SALT="${AGENT_LENS_REDACT_SALT:-agent-lens-corpus-v1}"

# Chosen sessions: "<srcLabel>|<encodedDir>|<sessionUUID>|<outLabel>". Small, with subagents, no agent-lens.
SESSIONS=(
  "isf|-home-m4pre|3d2f5a38-3e12-423e-870b-c1f402993a29|team-a"
  "personal|-home-m4pre-git-projects-saberes-monte-cms|a5723896-1f9a-4416-9f7d-f81844585ae8|team-b"
)

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
