/**
 * Assert the ingested store actually has data: every core table populated, the schema stamped,
 * and FTS5 answering a query. Used by scripts/sanity-e2e.sh; exits non-zero on an empty table.
 */
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const one = (sql) => db.prepare(sql).all()[0];

const schema = one("SELECT value FROM meta WHERE key = 'schema_version'")?.value;
console.log("schema_version:", schema ?? "MISSING");

let empty = 0;
for (const t of ["sessions", "turns", "events", "tool_calls", "findings", "file_changes", "token_usage"]) {
  const n = one(`SELECT COUNT(*) c FROM ${t}`).c;
  console.log(`${t.padEnd(14)} ${n}`);
  if (n === 0) empty++;
}

// FTS5 is a separate index from the events table; an empty result means it never got built.
const hits = one("SELECT COUNT(*) c FROM events_fts WHERE events_fts MATCH 'the'").c;
console.log("fts5 hits:", hits);
if (hits === 0) empty++;

process.exit(schema && empty === 0 ? 0 : 1);
