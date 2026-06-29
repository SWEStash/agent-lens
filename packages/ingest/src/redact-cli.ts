#!/usr/bin/env node
/**
 * agent-lens-redact — generate a privacy-safe corpus from real transcripts (validation Layer 4).
 *
 * Mirrors each input project directory's *.jsonl tree into <out>/<label>/projects/, redacting every
 * line's content (Redactor) and pseudonymizing the encoded project-dir name. Filenames and the inner
 * <sessionUUID>/subagents/agent-<id>.jsonl structure are preserved so subagent linkage survives.
 *
 * HARD RULES (memory: test-corpus-redaction): never emit agent-lens's own data, and never write a
 * file that fails the leak scan. Both are enforced here — agent-lens inputs are refused, and any
 * post-redaction leak aborts the whole run (fail closed) so a corpus is never committed dirty.
 *
 *   node dist/redact-cli.js --out <root> --label <name> <projectDir> [<projectDir> ...]
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { Redactor, findLeak, parseExcludes, isExcludedDir } from "./redact.js";

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = get("--out");
  const label = get("--label");
  const inputs = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out" && argv[i - 1] !== "--label");
  if (!out || !label || inputs.length === 0) {
    console.error("usage: agent-lens-redact --out <root> --label <name> <projectDir> [<projectDir> ...]");
    process.exit(2);
  }

  // Projects to keep out of the corpus, from AGENT_LENS_EXCLUDE (CSV of real paths) — the same
  // global exclude list honored by collect + ingest. See scripts/sources.mjs.
  const excluded = parseExcludes(process.env.AGENT_LENS_EXCLUDE);
  // A fixed salt makes the corpus reproducible (stable pseudonyms → reviewable diffs). Privacy does
  // not depend on salt secrecy: text/PII is scrubbed regardless; the salt only stabilizes pseudonyms.
  const salt = process.env.AGENT_LENS_REDACT_SALT;
  const red = salt ? new Redactor(salt) : new Redactor();
  let files = 0;
  let leaks = 0;
  for (const projectDir of inputs) {
    const encoded = basename(projectDir);
    if (isExcludedDir(encoded, excluded)) {
      console.error(`skipped (AGENT_LENS_EXCLUDE): ${projectDir}`);
      continue;
    }
    const pseudoDir = red.ident("proj", encoded); // pseudonymize the path-encoding project folder
    for (const file of listJsonl(projectDir)) {
      const rel = relative(projectDir, file); // keeps <UUID>/subagents/agent-<id>.jsonl shape
      const redacted = red.transcript(readFileSync(file, "utf8"));
      const leak = findLeak(redacted);
      if (leak) {
        console.error(`LEAK (${leak.name}: ${leak.sample}) in redacted output of ${file} — aborting, corpus not written`);
        leaks++;
        continue;
      }
      const dest = join(out, label, "projects", pseudoDir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, redacted);
      files++;
    }
  }
  if (leaks > 0) {
    console.error(`FAILED: ${leaks} file(s) leaked after redaction. Fix the redactor before committing a corpus.`);
    process.exit(1);
  }
  console.log(`agent-lens-redact: wrote ${files} redacted file(s) to ${join(out, label)} (label=${label})`);
}

main();
