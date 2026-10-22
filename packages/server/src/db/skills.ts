/** The Skills list and one skill's versions and firing sessions. */
import type { SkillDetail, SkillSummary, SkillSession, SkillVersion } from "@agent-lens/contracts";
import { queryAll } from "../sql-util.js";
import type { SkillListRow, SkillSessionRow } from "../rows.js";
import { type DB, displayTitle } from "./common.js";

export interface SkillFilters {
  q?: string;
  source?: string;
  project?: string;
}

/**
 * One row per fired skill (grouped by name), for the Skills list. `version_count` is the number of
 * distinct captured content versions (COUNT(DISTINCT skill_id) ignores firings with no body), while
 * `call_count` counts every firing — so a skill whose body was never captured still appears. Filters
 * (name search, source, project) mirror the sessions list and apply to the firing session.
 */
export function listSkills(db: DB, f: SkillFilters = {}): SkillSummary[] {
  const where = ["tc.tool_name = 'Skill'", "tc.skill_name IS NOT NULL"];
  const params: unknown[] = [];
  // Search matches the skill name OR any captured version body, so a query for a phrase that only
  // appears inside a SKILL.md still surfaces the skill. (skills.body is the normalized body; joined by
  // name rather than skill_id so firings with no captured body still match on name.)
  if (f.q && f.q.trim()) {
    const like = `%${f.q.trim()}%`;
    where.push("(tc.skill_name LIKE ? OR EXISTS (SELECT 1 FROM skills sk WHERE sk.name = tc.skill_name AND sk.body LIKE ?))");
    params.push(like, like);
  }
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (where.push("s.project_id = ?"), params.push(f.project));
  const rows = queryAll<SkillListRow>(
    db,
    `SELECT tc.skill_name AS name,
            COUNT(*) AS call_count,
            COUNT(DISTINCT tc.skill_id) AS version_count,
            MAX(e.timestamp) AS last_fired,
            GROUP_CONCAT(DISTINCT s.source_id) AS sources
     FROM tool_calls tc
     JOIN sessions s ON s.id = tc.session_id
     LEFT JOIN events e ON e.uuid = tc.event_uuid
     WHERE ${where.join(" AND ")}
     GROUP BY tc.skill_name
     ORDER BY call_count DESC, name`,
    ...params,
  );
  // GROUP_CONCAT hands back a comma-joined string; the response declares an array.
  return rows.map((r) => ({ ...r, sources: r.sources ? String(r.sources).split(",").filter(Boolean) : [] }));
}

/**
 * All data for one skill (by name): its content versions (most-recent first, each with body +
 * firing count) and the sessions that fired it, tagged with which version (`version_id`) so the UI
 * can map the session list to the selected version. Returns null (→ 404) when the name never fired.
 */
export function getSkill(db: DB, name: string): SkillDetail | null {
  const versions = queryAll<SkillVersion>(
    db,
    `SELECT sk.id, sk.base_dir, sk.summary, sk.body, sk.body_bytes, sk.first_seen, sk.last_seen,
            (SELECT COUNT(*) FROM tool_calls tc WHERE tc.skill_id = sk.id) AS call_count
     FROM skills sk WHERE sk.name = ? ORDER BY sk.last_seen DESC, sk.id`,
    name,
  );

  const sessionRows = queryAll<SkillSessionRow>(
    db,
    `SELECT s.id, s.ai_title, s.slug, s.source_id, s.started_at, p.path AS project_path,
            tc.skill_id AS version_id, MIN(e.timestamp) AS fired_at, COUNT(*) AS fire_count
     FROM tool_calls tc
     JOIN sessions s ON s.id = tc.session_id
     LEFT JOIN projects p ON p.id = s.project_id
     LEFT JOIN events e ON e.uuid = tc.event_uuid
     WHERE tc.tool_name = 'Skill' AND tc.skill_name = ?
     GROUP BY s.id, tc.skill_id
     ORDER BY fired_at DESC`,
    name,
  );

  if (!versions.length && !sessionRows.length) return null;
  const sessions: SkillSession[] = sessionRows.map(({ ai_title, slug, ...s }) => ({ ...s, title: displayTitle(ai_title, slug) }));
  const call_count = sessions.reduce((a, s) => a + s.fire_count, 0);
  return { name, versions, sessions, call_count };
}
