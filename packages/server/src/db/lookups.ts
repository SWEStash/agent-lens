/** The filter dropdowns' option lists: sources, projects, models. */
import type { Project, Source } from "@agent-lens/contracts";
import { canonModelSql, queryAll } from "../sql-util.js";
import type { ModelRow } from "../rows.js";
import type { DB } from "./common.js";

export function listSources(db: DB): Source[] {
  // Count MAIN sessions only (is_sidechain = 0): the dropdown filters the session list, which
  // defaults to main-only, so a source's count must match what you'd see — not be inflated by the
  // many subagent sidechains each task spawns.
  return queryAll<Source>(
    db,
    `SELECT s.id, s.label,
            (SELECT COUNT(*) FROM sessions x WHERE x.source_id = s.id AND x.is_sidechain = 0) AS session_count
     FROM sources s ORDER BY s.label`,
  );
}

export function listProjects(db: DB): Project[] {
  return queryAll<Project>(
    db,
    `SELECT p.id, p.path,
            (SELECT COUNT(*) FROM sessions x WHERE x.project_id = p.id AND x.is_sidechain = 0) AS session_count
     FROM projects p ORDER BY session_count DESC, p.path`,
  );
}

export function listModels(db: DB): string[] {
  // Every distinct model, `<synthetic>` included. It is not a model — it marks a reply generated
  // without an API call — but it IS a value the sessions list can usefully filter on, and 2,094
  // sessions carry it. The dashboard's model filter drops it from its own options instead
  // (ADR-035), which is where that judgement belongs.
  //
  // Canonical ids (ADR-037): a dated snapshot and its alias are one option, so the filter can never
  // offer two identical-looking choices that each admit half the model's work. `<synthetic>` carries
  // no date, so it survives this untouched.
  //
  // Canonicalize over the DISTINCT set, not per row — `ratesCte`'s lesson applied again. Stripping
  // 61,447 model strings and then de-duplicating measured 32ms; de-duplicating first and stripping
  // the 8 survivors measures 11ms, faster than the original undecorated query (21ms).
  return queryAll<ModelRow>(
    db,
    `SELECT DISTINCT ${canonModelSql("m")} AS model
     FROM (SELECT DISTINCT model m FROM token_usage WHERE model IS NOT NULL) ORDER BY 1`,
  ).map((r) => r.model);
}
