/** Security findings (ADR-017) and their triage state (ADR-018). */
import { SECURITY_CATEGORIES } from "@agent-lens/core";
import type { FindingListRow, SecuritySummary, FindingsPage, FindingSort, FindingStatus } from "@agent-lens/contracts";
import { tableExists, queryAll, queryGet, orderBy, pushDateRange, whereClause, enumValues, type SortDir } from "../sql-util.js";
import type { CountRow } from "../rows.js";
import { type DB, severityRankSql } from "./common.js";

// The values this endpoint accepts for `?sort=` and `?status=`; see SESSION_SORTS in sessions.ts.
export const FINDING_SORTS = enumValues<FindingSort>({ severity: true, session: true, rule: true, category: true, time: true });
export const FINDING_STATUSES = enumValues<FindingStatus>({ open: true, dismissed: true, muted: true, all: true });

export interface FindingFilters {
  severity?: string;
  category?: string;
  rule?: string;
  session?: string;
  source?: string;
  project?: string;
  from?: string;
  to?: string;
  /** open (default; excludes dismissed + muted) | dismissed | muted | all. */
  status?: FindingStatus;
  /** Sort the whole filtered list before pagination. Defaults to "severity" (most-severe first). */
  sort?: FindingSort;
  dir?: SortDir;
  limit: number;
  offset: number;
}

// Rank severities inside SQL so the list can be severity-ordered and paginated without materializing
// everything.
const SEVERITY_RANK_SQL = severityRankSql("f.severity");

// A finding is muted when a muted_rules row matches its rule at global/project/source scope. Only valid
// when the triage DB is ATTACHed (createApp does this); guarded by triageAttached() everywhere it's used.
const MUTED_SQL = `EXISTS (SELECT 1 FROM triage.muted_rules m WHERE m.rule_id = f.rule_id
   AND (m.scope='global' OR (m.scope='project' AND m.scope_id = s.project_id) OR (m.scope='source' AND m.scope_id = s.source_id)))`;

/** Whether the writable triage store is ATTACHed to this (read) connection — gates all triage SQL. */
function triageAttached(db: DB): boolean {
  return queryAll<{ name: string }>(db, "PRAGMA database_list").some((r) => r.name === "triage");
}

/** The filter half of FindingFilters — what narrows the set, without status/sort/paging. */
export type FindingScope = Omit<FindingFilters, "status" | "sort" | "dir" | "limit" | "offset">;

/** WHERE fragments shared by list + summary: user filters (no status) over findings f / sessions s. */
function findingWhere(f: FindingScope): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (f.severity) (sql.push("f.severity = ?"), params.push(f.severity));
  if (f.category) (sql.push("f.category = ?"), params.push(f.category));
  if (f.rule) (sql.push("f.rule_id = ?"), params.push(f.rule));
  if (f.session) (sql.push("f.session_id = ?"), params.push(f.session));
  if (f.source) (sql.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (sql.push("s.project_id = ?"), params.push(f.project));
  // Compare on the DATE part so a picked day is inclusive on both ends — `to = 2026-07-14` must include
  // 2026-07-14 events (a plain `started_at <= '2026-07-14'` would exclude that whole day's timestamps).
  pushDateRange(sql, params, "s.started_at", f.from, f.to);
  return { sql, params };
}

/** The LEFT JOIN that `statusWhere` reads its `d` alias from. Empty when triage is absent. */
const dismissedJoin = (attached: boolean): string =>
  attached ? "LEFT JOIN triage.dismissed_findings d ON d.finding_id = f.id" : "";

/** Status → WHERE fragment over the dismissed LEFT JOIN (`d`) + MUTED_SQL. Empty when triage absent. */
function statusWhere(status: FindingFilters["status"], attached: boolean): string {
  if (!attached) return status === "dismissed" || status === "muted" ? "1 = 0" : ""; // no triage → nothing dismissed/muted
  switch (status) {
    case "dismissed":
      return "d.finding_id IS NOT NULL";
    case "muted":
      return `d.finding_id IS NULL AND ${MUTED_SQL}`;
    case "all":
      return "";
    default: // open
      return `d.finding_id IS NULL AND NOT ${MUTED_SQL}`;
  }
}

/**
 * The browsable findings list (GET /api/security/findings), filtered/sorted/paged. Each row carries
 * enough session context (title, project, source, when) to render and link without a second fetch, plus
 * its triage state (dismissed flag/note/when) when the triage store is attached. Default status hides
 * dismissed + muted so real, un-triaged findings surface. Guarded for a pre-ingest read-only DB.
 */
export function listFindings(db: DB, f: FindingFilters): FindingsPage {
  if (!tableExists(db, "findings")) return { total: 0, findings: [] };
  const attached = triageAttached(db);

  const w = findingWhere(f);
  const st = statusWhere(f.status ?? "open", attached);
  const where = [...w.sql, ...(st ? [st] : [])];
  const whereSql = whereClause(where);
  const dismissJoin = dismissedJoin(attached);
  const triageCols = attached
    ? `, (d.finding_id IS NOT NULL) AS dismissed, d.note AS dismiss_note, d.dismissed_at, ${MUTED_SQL} AS muted`
    : `, 0 AS dismissed, NULL AS dismiss_note, NULL AS dismissed_at, 0 AS muted`;

  const total = queryGet<CountRow>(
    db,
    `SELECT COUNT(*) n FROM findings f JOIN sessions s ON s.id = f.session_id ${dismissJoin} ${whereSql}`,
    ...w.params,
  )!.n;

  const ORDER = {
    severity: SEVERITY_RANK_SQL,
    session: "f.session_id",
    rule: "f.rule_id",
    category: "f.category",
    time: "s.started_at",
  };

  const findings = queryAll<FindingListRow>(
    db,
    `SELECT f.id, f.session_id, f.tool_call_id, f.event_uuid, f.turn_id, f.rule_id, f.category,
            f.framework_ref, f.severity, f.title, f.evidence, tc.tool_name,
            COALESCE(NULLIF(s.ai_title, ''), s.slug) AS session_title, s.source_id, s.is_sidechain,
            s.started_at, p.path AS project_path, s.project_id ${triageCols}
     FROM findings f
     JOIN sessions s ON s.id = f.session_id
     LEFT JOIN projects p ON p.id = s.project_id
     LEFT JOIN tool_calls tc ON tc.id = f.tool_call_id
     ${dismissJoin}
     ${whereSql}
     ORDER BY ${orderBy(ORDER, f.sort, "severity", f.dir)}, ${SEVERITY_RANK_SQL} DESC, f.id ASC
     LIMIT ? OFFSET ?`,
    ...w.params,
    f.limit,
    f.offset,
  );

  return { total, findings };
}

/**
 * Ids of every OPEN finding matching `f` — the id-only half of listFindings, for bulk dismiss
 * (POST /api/security/dismiss-matching). Shares findingWhere + statusWhere with the list so "what
 * matches" cannot drift between browsing and bulk-dismissing; only the projection differs, so this
 * skips the list's COUNT(*) pass, session/tool context columns, and ORDER BY. Status is fixed to
 * open: a bulk dismiss acts on what the user can currently see, never on dismissed or muted rows.
 */
export function openFindingIds(db: DB, f: FindingScope): string[] {
  if (!tableExists(db, "findings")) return [];
  const attached = triageAttached(db);

  const w = findingWhere(f);
  const st = statusWhere("open", attached);
  const where = [...w.sql, ...(st ? [st] : [])];

  return queryAll<{ id: string }>(
    db,
    `SELECT f.id
     FROM findings f
     JOIN sessions s ON s.id = f.session_id
     ${dismissedJoin(attached)}
     ${whereClause(where)}`,
    ...w.params,
  ).map((r) => r.id);
}

/**
 * Roll-up for the /security page header + the Dashboard KPI. Counts (by severity/category/rule,
 * sessions flagged) are computed over **open** findings — dismissed + muted excluded — so the KPIs show
 * what still needs review; `dismissed` and `muted` totals ride along for the triage affordances. The
 * framework reference content (core) powers the "what & why" explainers. Guarded for a pre-ingest DB.
 */
export function securitySummary(db: DB): SecuritySummary {
  const categories = SECURITY_CATEGORIES;
  if (!tableExists(db, "findings")) {
    return { total: 0, sessions_flagged: 0, dismissed: 0, muted: 0, by_severity: [], by_category: [], by_rule: [], categories };
  }
  const attached = triageAttached(db);
  const dismissJoin = dismissedJoin(attached);
  const base = `FROM findings f JOIN sessions s ON s.id = f.session_id ${dismissJoin}`;
  // The same statusWhere the list and bulk dismiss use, so the header counts cannot drift from them.
  const openWhere = whereClause([statusWhere("open", attached)]);

  const scalar = (sql: string): number => queryGet<CountRow>(db, sql)!.n;
  const total = scalar(`SELECT COUNT(*) n ${base} ${openWhere}`);
  const sessions_flagged = scalar(`SELECT COUNT(DISTINCT f.session_id) n ${base} ${openWhere}`);
  const dismissed = attached ? scalar(`SELECT COUNT(*) n FROM findings f ${dismissJoin} WHERE ${statusWhere("dismissed", attached)}`) : 0;
  const muted = attached ? scalar(`SELECT COUNT(*) n ${base} WHERE ${statusWhere("muted", attached)}`) : 0;

  const by_severity = queryAll<SecuritySummary["by_severity"][number]>(
    db,
    `SELECT f.severity AS severity, COUNT(*) n ${base} ${openWhere} GROUP BY f.severity ORDER BY ${SEVERITY_RANK_SQL} DESC`,
  );
  const by_category = queryAll<SecuritySummary["by_category"][number]>(
    db,
    `SELECT f.category AS category, COUNT(*) n ${base} ${openWhere} GROUP BY f.category ORDER BY n DESC`,
  );
  const by_rule = queryAll<SecuritySummary["by_rule"][number]>(
    db,
    `SELECT f.rule_id AS rule_id, f.category AS category, f.title AS title, COUNT(*) n, MAX(${SEVERITY_RANK_SQL}) AS rank
     ${base} ${openWhere} GROUP BY f.rule_id ORDER BY rank DESC, n DESC`,
  );
  return { total, sessions_flagged, dismissed, muted, by_severity, by_category, by_rule, categories };
}
