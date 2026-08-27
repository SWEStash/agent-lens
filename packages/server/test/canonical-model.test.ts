/**
 * The canonical model key (ADR-037) exists in two copies — `canonicalModel` in core, for values, and
 * `canonModelSql` in the server, for columns. Two copies can drift, so this pins them against each
 * other on the same inputs, the way `pricing-sql.test.ts` pins the two cost formulas.
 *
 * Imports the BUILT dist, like the rest of the server suite.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { canonicalModel } from "@agent-lens/core";
import { canonModelSql } from "../dist/sql-util.js";

const db = new DatabaseSync(":memory:");

/** Evaluate the SQL twin on one value. The expression names its column three times, so it is fed
 *  through a subquery rather than three separate placeholders. */
function viaSql(model: string | null): string | null {
  const row = db.prepare(`SELECT ${canonModelSql("m")} AS c FROM (SELECT ? AS m)`).get(model) as { c: string | null };
  return row.c;
}

/** [input, expected]. Everything here is a rule the ADR commits to, not an accident of the regex. */
const CASES: Array<[string | null, string | null]> = [
  // The whole of the observed problem: a dated snapshot resolves to its minor version.
  ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
  ["claude-opus-4-8-20260101", "claude-opus-4-8"],
  // Idempotent — canon(canon(x)) === canon(x), so re-canonicalizing an already-canonical filter
  // value (which the server does on every request) is a no-op.
  ["claude-haiku-4-5", "claude-haiku-4-5"],
  // A different price point: merging it into the base model would make a cost chart wrong.
  ["claude-opus-4-8[1m]", "claude-opus-4-8[1m]"],
  // Not a model at all. It must survive untouched — the sessions list filters on it for real.
  ["<synthetic>", "<synthetic>"],
  // The minor version is never stripped; these two are different models.
  ["claude-opus-4-8", "claude-opus-4-8"],
  ["claude-opus-4-7", "claude-opus-4-7"],
  // Digits in the middle, none at the end.
  ["claude-3-5-haiku", "claude-3-5-haiku"],
  // Boundary: the hyphen must sit exactly at length-9, so neither 7 nor 9 trailing digits qualifies.
  ["claude-x-1234567", "claude-x-1234567"],
  ["claude-x-12345678", "claude-x"],
  ["claude-x-123456789", "claude-x-123456789"],
  // `_` is a LIKE wildcard; the SQL twin uses GLOB precisely so an id carrying one is not mangled.
  ["claude_x-20251001", "claude_x"],
  ["claude_x", "claude_x"],
  // Degenerate input must not throw on either side.
  ["", ""],
  ["-20251001", ""],
  [null, null],
];

describe("canonicalModel", () => {
  it.each(CASES)("maps %j to %j", (input, expected) => {
    expect(canonicalModel(input)).toBe(expected);
  });
});

describe("canonModelSql", () => {
  it.each(CASES)("maps %j to %j, agreeing with the JS twin", (input, expected) => {
    expect(viaSql(input)).toBe(expected);
    expect(viaSql(input)).toBe(canonicalModel(input));
  });

  it("groups a family into one bucket in SQL", () => {
    const t = new DatabaseSync(":memory:");
    t.exec("CREATE TABLE u (model TEXT, n INTEGER)");
    t.exec(`INSERT INTO u VALUES ('claude-haiku-4-5-20251001', 2), ('claude-haiku-4-5', 3), ('claude-opus-5', 5)`);
    const rows = t
      .prepare(`SELECT ${canonModelSql("model")} AS m, SUM(n) n FROM u GROUP BY 1 ORDER BY 1`)
      .all() as Array<{ m: string; n: number }>;
    expect(rows).toEqual([
      { m: "claude-haiku-4-5", n: 5 },
      { m: "claude-opus-5", n: 5 },
    ]);
  });
});
