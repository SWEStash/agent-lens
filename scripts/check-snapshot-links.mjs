#!/usr/bin/env node
/**
 * Link-coverage gate for the static Pages demo.
 *
 * `export-snapshot.mjs` succeeding only proves that every URL the EXPORTER chose to fetch returned
 * 200. It says nothing about whether every URL the SPA actually LINKS TO was written — and that gap
 * is what keeps 404ing the demo: a snapshot file is addressed by a hash of its query params, so a
 * link that passes different params than the exporter used resolves to a filename nobody created.
 * (Twice now: the Files pages in PR #17, and the transcript's "history →" link, which passes
 * `?path=` alone where FilesView passes `?path=&project=`.)
 *
 * So this walks the EXPORTED snapshot the way the SPA walks it — following the links each payload
 * would render — and asserts the destination file exists. It needs no browser and no server: the
 * snapshot is the same data the SPA would fetch.
 *
 * Usage: node scripts/check-snapshot-links.mjs   (run it after scripts/export-snapshot.mjs)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(REPO, "packages/web/public/snapshot");

/**
 * Mirror of snapshotFileKey in packages/web/src/api.ts and export-snapshot.mjs — a third copy, but
 * deliberately: if someone changes the hash in one place, this check going red is the point.
 */
function snapshotFileKey(path, project) {
  const s = `${project ?? ""}\n${path}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const readSnap = (rel) => JSON.parse(readFileSync(join(SNAP, rel), "utf8"));

const missing = [];
let checked = 0;
/** Assert `rel` was exported; `where` names the link that would have gone there. */
function expect(rel, where) {
  checked++;
  if (!existsSync(join(SNAP, rel))) missing.push(`${rel}  ← ${where}`);
}

if (!existsSync(SNAP)) {
  console.error("check-snapshot-links: no snapshot found — run `node scripts/export-snapshot.mjs` first");
  process.exit(1);
}

// FilesView row → /file?path=…&project=…  (packages/web/src/FilesView.tsx)
const files = readSnap("files.json");
for (const f of files.files) {
  expect(`file/${snapshotFileKey(f.file_path, f.project_id)}.json`, `FilesView row ${f.file_path}`);
}

// Session transcript "history →" → /file?path=…  with NO project (transcript/FilesChanged.tsx),
// and the subagent/workflow links each session detail renders.
const sessions = readSnap("sessions.json");
for (const s of sessions.sessions) {
  const detailRel = `sessions/${s.id}.json`;
  expect(detailRel, `Sessions row ${s.id}`);
  if (!existsSync(join(SNAP, detailRel))) continue;
  const d = readSnap(detailRel);
  for (const c of d.file_changes ?? []) {
    expect(`file/${snapshotFileKey(c.file_path, null)}.json`, `session ${s.id} "history →" ${c.file_path}`);
  }
  for (const w of d.workflow_runs ?? []) {
    expect(`workflows/${w.run_id}.json`, `session ${s.id} workflow ${w.run_id}`);
  }
  for (const child of d.children ?? []) {
    expect(`sessions/${child.id}.json`, `session ${s.id} subagent ${child.id}`);
  }
}

// Security findings link back to their session (SecurityView row → /session/<id>#ev-<uuid>).
const findings = readSnap("security/findings.json");
for (const f of findings.findings ?? []) {
  expect(`sessions/${f.session_id}.json`, `security finding ${f.id}`);
}

if (missing.length) {
  console.error(`check-snapshot-links: ${missing.length} of ${checked} SPA links have no exported snapshot:\n`);
  for (const m of missing.slice(0, 40)) console.error("  " + m);
  if (missing.length > 40) console.error(`  … and ${missing.length - 40} more`);
  console.error("\nAdd the missing endpoint/key variant to scripts/export-snapshot.mjs.");
  process.exit(1);
}

console.log(`check-snapshot-links: OK — all ${checked} SPA links resolve to an exported snapshot`);
