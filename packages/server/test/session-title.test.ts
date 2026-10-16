/**
 * An empty `ai_title` falls back to the slug everywhere a session title is shown, and the title sort
 * key and the findings list's `session_title` follow the same rule.
 */
import { describe, it, expect } from "vitest";
import { listSessions, listFindings } from "../dist/db.js";
import { freshDb, addSession } from "./helpers/seed.js";

function seed() {
  const db = freshDb();
  addSession(db, "a", { title: "" });
  addSession(db, "b", { title: "beta" });
  db.exec(`UPDATE sessions SET slug = 'zeta' WHERE id = 'a'; UPDATE sessions SET slug = 'zzz' WHERE id = 'b'`);
  return db;
}

describe("session title fallback", () => {
  it("sorts a session with an empty ai_title by its slug, the title it displays", () => {
    // Sorting on the raw '' would put `a` first; its displayed title "zeta" sorts after "beta".
    const rows = listSessions(seed(), { sort: "title", dir: "asc", limit: 50, offset: 0 }).sessions;
    expect(rows.map((s) => [s.id, s.title])).toEqual([
      ["b", "beta"],
      ["a", "zeta"],
    ]);
  });

  it("labels a finding with the slug when its session's ai_title is empty", () => {
    const db = seed();
    db.exec(`INSERT INTO findings (id, session_id, rule_id, category, severity, title, evidence, detector_version)
             VALUES ('f1','a','R1','exec','low','t','e',1)`);
    const { findings } = listFindings(db, { limit: 50, offset: 0 });
    expect(findings.map((f) => f.session_title)).toEqual(["zeta"]);
  });
});
