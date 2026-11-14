/**
 * The read-only report commands: `agent-lens sessions`, `findings` and `cost`. They answer from the
 * store through the same queries as the web UI's API, so a terminal answer and the page always agree.
 * A table by default; `--json` prints the API's own payload (SessionsPage, FindingsPage, DashOverview)
 * for scripts.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { installPricing, resolveDbPath, triageDbFor, UserError } from "@agent-lens/core";
import {
  dashboardOverview,
  FINDING_STATUSES,
  listFindings,
  listProjects,
  listSessions,
  openReadonly,
  schemaStatus,
  type DB,
} from "@agent-lens/server";
import type { DashOverview, FindingsPage, FindingStatus, SessionsPage } from "@agent-lens/contracts";

/**
 * `--since` as the lower bound the queries take. `24h`, `7d`, `2w` (relative to `now`) become an
 * exact ISO timestamp; a `YYYY-MM-DD` date stays a date (that whole day onwards).
 */
export function parseSince(v: string, now: Date = new Date()): string {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) throw new UserError(`invalid --since '${v}' (use e.g. 24h, 7d, 2w, or a YYYY-MM-DD date)`);
  const hours = Number(m[1]) * { h: 1, d: 24, w: 168 }[m[2] as "h" | "d" | "w"];
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/** Local midnight today, as an exact timestamp — what "today" means to the person at the terminal. */
export function startOfToday(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: "right";
  /** Takes whatever width is left; truncated with "…" to fit the terminal. One per table. */
  flex?: boolean;
}

/** A plain-text table, fitted to `width` by truncating the flex column. No colours, so it pipes. */
export function formatTable<T>(rows: T[], columns: Column<T>[], width = 120): string {
  const cells = rows.map((r) => columns.map((c) => c.value(r).replace(/\s+/g, " ")));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i].length)));
  const flex = columns.findIndex((c) => c.flex);
  if (flex >= 0) {
    const fixed = widths.reduce((a, w, i) => (i === flex ? a : a + w), 0) + 2 * (columns.length - 1);
    widths[flex] = Math.max(columns[flex].header.length, Math.min(widths[flex], width - fixed));
  }
  const fit = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s);
  const line = (vals: string[]) =>
    vals
      .map((v, i) => {
        const s = fit(v, widths[i]);
        return columns[i].align === "right" ? s.padStart(widths[i]) : i === vals.length - 1 ? s : s.padEnd(widths[i]);
      })
      .join("  ");
  return [line(columns.map((c) => c.header)), ...cells.map(line)].join("\n");
}

/** `2026-11-13 14:05`, in the terminal's local time. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

const fmtTokens = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** The store, opened read-only. Triage state is attached when `triage.db` exists, so `findings`
 * hides what the web UI hides; without it every finding counts as open. */
export function openStore(dbFlag?: string): DB {
  const { path } = resolveDbPath(dbFlag);
  if (!existsSync(path)) throw new UserError(`no store at ${path} (run 'agent-lens ingest' first)`);
  const db = openReadonly(path);
  const s = schemaStatus(db);
  if (s.stale) throw new UserError(`the store is schema v${s.db_version}, this build expects v${s.expected}: run 'agent-lens ingest --full'`);
  const triage = triageDbFor(path);
  // ATTACH takes a literal; this is an operator-configured path, quotes doubled (same as the server).
  if (existsSync(triage)) db.exec(`ATTACH DATABASE '${triage.replace(/'/g, "''")}' AS triage`);
  installPricing();
  return db;
}

/** `--project` as a project id: an id, a full path, or a path's last segment when only one matches. */
export function resolveProject(db: DB, v: string | undefined): string | undefined {
  if (!v) return undefined;
  const projects = listProjects(db);
  const exact = projects.find((p) => p.id === v || p.path === v);
  if (exact) return exact.id;
  const byName = projects.filter((p) => p.path && basename(p.path) === v);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new UserError(`--project '${v}' matches ${byName.length} projects; use the full path`);
  throw new UserError(`no project '${v}' (use its path, or the last part of it)`);
}

export interface ReportOpts {
  db?: string;
  since?: string;
  source?: string;
  project?: string;
  json?: boolean;
  limit?: string | number;
}

function limitOf(v: string | number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UserError(`invalid --limit '${v}' (1 to 1000)`);
  return n;
}

const termWidth = (): number => process.stdout.columns || 120;
/** The first 8 characters of a session id, after a subagent's `agent-` prefix. */
export const shortId = (id: string): string => (id.startsWith("agent-") ? id.slice(0, 14) : id.slice(0, 8));
const more = (shown: number, total: number, noun: string): string =>
  shown < total ? `\n${shown} of ${total} ${noun}; raise --limit for more` : "";

export function sessionsReport(
  db: DB,
  o: ReportOpts & { search?: string; pr?: string; kind?: string },
): { page: SessionsPage; text: string } {
  const kind = o.kind ?? "main";
  if (!["main", "subagent", "all"].includes(kind)) throw new UserError(`invalid --kind '${kind}' (main, subagent or all)`);
  const page = listSessions(db, {
    source: o.source,
    project: resolveProject(db, o.project),
    from: o.since ? parseSince(o.since) : undefined,
    q: o.search,
    pr: o.pr,
    kind: kind === "all" ? undefined : (kind as "main" | "subagent"),
    limit: limitOf(o.limit, 20),
    offset: 0,
  });
  if (!page.sessions.length) return { page, text: "No sessions match." };
  const table = formatTable(
    page.sessions,
    [
      { header: "STARTED", value: (s) => fmtWhen(s.started_at) },
      { header: "SESSION", value: (s) => shortId(s.id) },
      { header: "TITLE", value: (s) => s.title ?? "", flex: true },
      { header: "PROJECT", value: (s) => (s.project_path ? basename(s.project_path) : "") },
      { header: "TURNS", value: (s) => String(s.turn_count), align: "right" },
      { header: "COST", value: (s) => fmtUsd(s.cost) + (s.unpriced_models.length ? "+" : ""), align: "right" },
      { header: "FINDINGS", value: (s) => (s.finding_count ? `${s.finding_count} ${s.worst_severity ?? ""}`.trim() : ""), },
    ],
    termWidth(),
  );
  const unpriced = page.sessions.some((s) => s.unpriced_models.length) ? "\n+ includes a model with no price; cost is a lower bound" : "";
  return { page, text: table + unpriced + more(page.sessions.length, page.total, "sessions") };
}

export function findingsReport(db: DB, o: ReportOpts & { severity?: string; status?: string }): { page: FindingsPage; text: string } {
  const status = (o.status ?? "open") as FindingStatus;
  if (!(FINDING_STATUSES as readonly string[]).includes(status)) {
    throw new UserError(`invalid --status '${o.status}' (${FINDING_STATUSES.join(", ")})`);
  }
  const page = listFindings(db, {
    severity: o.severity,
    source: o.source,
    project: resolveProject(db, o.project),
    from: o.since ? parseSince(o.since) : undefined,
    status,
    limit: limitOf(o.limit, 50),
    offset: 0,
  });
  if (!page.findings.length) return { page, text: `No ${status === "all" ? "" : status + " "}findings match.` };
  const table = formatTable(
    page.findings,
    [
      { header: "SEVERITY", value: (f) => f.severity },
      { header: "WHEN", value: (f) => fmtWhen(f.started_at ?? null) },
      { header: "SESSION", value: (f) => shortId(f.session_id) },
      { header: "RULE", value: (f) => f.rule_id },
      { header: "EVIDENCE", value: (f) => f.evidence ?? f.title ?? "", flex: true },
    ],
    termWidth(),
  );
  return { page, text: table + more(page.findings.length, page.total, "findings") };
}

export function costReport(db: DB, o: ReportOpts & { today?: boolean }): { overview: DashOverview; text: string } {
  if (o.today && o.since) throw new UserError("use --today or --since, not both");
  const from = o.today ? startOfToday() : o.since ? parseSince(o.since) : undefined;
  const ov = dashboardOverview(db, { source: o.source, from });
  const span = o.today ? "today" : o.since ? `since ${o.since}` : "all time";
  const t = ov.tokens;
  const lines = [
    `Cost ${span}${o.source ? ` (${o.source})` : ""}: ${fmtUsd(ov.cost)}${ov.unpriced_models.length ? " (lower bound)" : ""}`,
    `Sessions: ${ov.sessions_main} main, ${ov.sessions_subagent} subagent · ${ov.turns} turns`,
    `Tokens: ${fmtTokens(ov.total_tokens)} (input ${fmtTokens(t.input)}, output ${fmtTokens(t.output)}, cache write ${fmtTokens(t.cache_creation)}, cache read ${fmtTokens(t.cache_read)})`,
  ];
  if (ov.unpriced_models.length) lines.push(`No price for: ${ov.unpriced_models.join(", ")}`);
  lines.push("List-price estimate from token counts, not a bill.");
  return { overview: ov, text: lines.join("\n") };
}

/** Print a report: its JSON payload, or its table. */
export function printReport(json: boolean | undefined, payload: unknown, text: string): void {
  process.stdout.write(json ? JSON.stringify(payload, null, 2) + "\n" : text + "\n");
}
