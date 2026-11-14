/**
 * `agent-lens browse`: pick a session, read its transcript, press `o` to open it in the web UI. A thin
 * driver over the pure screens in view.ts: it owns the terminal (raw keys, the alternate screen,
 * resizes) and always gives it back, on quit, Ctrl-C, a signal or an error (ADR-042).
 */
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { resolveServerConfig, UserError } from "@agent-lens/core";
import { getSession, listProjects, listSessions, listSources } from "@agent-lens/server";
import type { SessionDetail } from "@agent-lens/contracts";
import { openStore, parseSince, resolveProject, type ReportOpts } from "../report.js";
import { detectTheme, useColor } from "./style.js";
import {
  filterSessions,
  GUTTER,
  reduce,
  selectedIndex,
  sortSessions,
  renderList,
  renderPager,
  transcriptLines,
  type Ctx,
  type Key,
  type ListState,
  type PagerState,
  type PickerOption,
  type State,
  type Transcript,
} from "./view.js";

export type BrowseOpts = ReportOpts & { search?: string; pr?: string; kind?: string };

const ENTER_ALT = "\x1b[?1049h\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

/** The web UI's URL for a session. A wildcard bind is reached on loopback. */
export function sessionUrl(id: string, host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}/session/${encodeURIComponent(id)}`;
}

/** The OSC 52 sequence that asks the terminal to put `text` on the clipboard. Terminals that don't
 * support it ignore it. */
export const osc52 = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/** The subagent to open from a transcript: the first `[s]` call on screen, else the next one below. */
export function subagentAt(t: Transcript, top: number, height: number): string | null {
  const onScreen = t.subagents.find((s) => s.line >= top && s.line < top + height);
  return (onScreen ?? t.subagents.find((s) => s.line >= top))?.sessionId ?? null;
}

async function serverUp(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(sessionUrl("x", host, port).replace(/\/session\/x$/, "/api/health"), { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Hand a URL to the desktop's browser. Resolves false when no opener could start. */
function openUrl(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function runBrowse(o: BrowseOpts): Promise<void> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new UserError("browse needs an interactive terminal; use 'agent-lens sessions' (or --json) in scripts");
  }
  const db = openStore(o.db);
  const kind = o.kind ?? "main";
  if (!["main", "subagent", "all"].includes(kind)) throw new UserError(`invalid --kind '${kind}' (main, subagent or all)`);
  const limit = o.limit === undefined ? 500 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new UserError(`invalid --limit '${o.limit}' (1 to 5000)`);
  const from = o.since ? parseSince(o.since) : undefined;
  let state: State = {
    screen: "list",
    cursor: 0,
    top: 0,
    filter: "",
    search: o.search,
    source: o.source,
    project: resolveProject(db, o.project),
    sort: { column: "started", desc: true },
  };
  // The query the web UI's list runs, with the list's search, source, project and sort. The store
  // sorts by started, title and turns, so the rows are the true top `limit`; source and project
  // are sorted over the rows loaded.
  const load = (l: ListState) => {
    const page = listSessions(db, {
      source: l.source,
      project: l.project,
      from,
      q: l.search,
      pr: o.pr,
      kind: kind === "all" ? undefined : (kind as "main" | "subagent"),
      sort: l.sort.column === "source" || l.sort.column === "project" ? "started" : l.sort.column,
      dir: l.sort.desc ? "desc" : "asc",
      limit,
      offset: 0,
    });
    return { rows: sortSessions(page.sessions, l.sort), total: page.total };
  };
  let { rows: all, total } = load(state);
  if (!all.length) {
    stdout.write("No sessions match.\n");
    return;
  }
  const options: PickerOption[] = [
    { group: "source", value: null, label: "all sources" },
    ...listSources(db).map((x) => ({ group: "source" as const, value: x.id, label: x.label, count: x.session_count })),
    { group: "project", value: null, label: "all projects" },
    ...listProjects(db).map((x) => ({ group: "project" as const, value: x.id, label: x.path ?? x.id, count: x.session_count })),
  ];
  const { host, port } = resolveServerConfig();
  const color = useColor();
  const theme = detectTheme();

  let message = "";
  const details = new Map<string, SessionDetail | null>();
  const detailOf = (id: string): SessionDetail | null => {
    if (!details.has(id)) details.set(id, getSession(db, id));
    return details.get(id)!;
  };
  let cache: { key: string; t: Transcript } | null = null;
  const size = () => ({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const body = () => Math.max(1, size().height - 2);
  const visible = () => filterSessions(all, state.screen === "list" ? state.filter : state.list.filter);
  const transcript = (p: PagerState): Transcript => {
    const key = `${p.sessionId}|${size().width}|${p.thinking}|${p.results}|${p.expanded.join(",")}`;
    if (cache?.key !== key) {
      const d = detailOf(p.sessionId);
      cache = {
        key,
        t: d
          ? transcriptLines(d, size().width - GUTTER, p)
          : { lines: [[["This session is no longer in the store."]]], turns: [], items: [], subagents: [] },
      };
    }
    return cache.t;
  };
  const currentId = (): string | undefined => (state.screen === "pager" ? state.sessionId : visible()[state.cursor]?.id);
  const titleOf = (p: PagerState): string => {
    const t = detailOf(p.sessionId)?.session.title ?? p.sessionId;
    return p.parent ? `↳ subagent: ${t}` : t;
  };

  const draw = () => {
    const { width, height } = size();
    let screen: string[];
    if (state.screen === "list") {
      screen = renderList(visible(), state, width, height, message, color, total, theme, options, all.length);
    } else {
      const t = transcript(state);
      // A toggle, an expansion or a resize moves lines around; keep the selected item on screen.
      const it = t.items[selectedIndex(t.items, state.sel)];
      if (it && (it.end < state.top || it.start >= state.top + body())) state = { ...state, top: Math.max(0, it.start) };
      if (state.top > Math.max(0, t.lines.length - 1)) state = { ...state, top: Math.max(0, t.lines.length - body()) };
      screen = renderPager(titleOf(state), t, state, width, height, message, color, theme);
    }
    stdout.write("\x1b[H" + screen.join("\r\n"));
  };

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(LEAVE_ALT);
  };
  const onSignal = () => {
    restore();
    process.exit(130);
  };

  await new Promise<void>((resolve, reject) => {
    const finish = (err?: unknown) => {
      stdin.off("keypress", onKey);
      stdout.off("resize", draw);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      process.off("exit", restore);
      restore();
      if (err) reject(err);
      else resolve();
    };
    const ctx = (): Ctx => {
      if (state.screen === "list") return { count: visible().length, height: body(), options };
      const t = transcript(state);
      return { count: t.lines.length, height: body(), texts: t.lines.map((l) => l.map(([s]) => s).join("")), turns: t.turns, items: t.items };
    };
    const onKey = (_: string, key: Key) => {
      try {
        message = "";
        const { state: next, effect } = reduce(state, key ?? {}, ctx());
        state = next;
        switch (effect?.type) {
          case "quit":
            return finish();
          case "message":
            message = effect.text;
            break;
          case "reload": {
            ({ rows: all, total } = load(state as ListState));
            if (!all.length) message = "No sessions match; esc clears the search and filters";
            break;
          }
          case "open-pager": {
            const s = state as ListState;
            const id = visible()[s.cursor]?.id;
            if (id) state = { screen: "pager", sessionId: id, top: 0, list: s, expanded: [], find: "", thinking: false, results: false };
            break;
          }
          case "open-subagent": {
            const p = state as PagerState;
            const t = transcript(p);
            // The selected call's subagent, else the first [s] call on screen.
            const sub = t.items[selectedIndex(t.items, p.sel)]?.subagent ?? subagentAt(t, p.top, body());
            if (!sub) message = "No subagent call on screen; select an [s] line";
            else if (!detailOf(sub)) message = `Subagent ${sub} isn't in the store`;
            else state = { ...p, sessionId: sub, top: 0, parent: p, sel: undefined, expanded: [], find: "", prompt: undefined };
            break;
          }
          case "copy": {
            const id = currentId();
            if (id) {
              stdout.write(osc52(id));
              message = `Copied ${id} (if your terminal allows clipboard access)`;
            }
            break;
          }
          case "open-web": {
            const id = currentId();
            if (!id) break;
            const url = sessionUrl(id, host, port);
            void serverUp(host, port).then(async (up) => {
              if (!up) message = `Start 'agent-lens serve', then press o again: ${url}`;
              else message = (await openUrl(url)) ? `Opened ${url}` : `Couldn't start a browser; open ${url}`;
              if (!restored) draw();
            });
            break;
          }
        }
        draw();
      } catch (e) {
        finish(e);
      }
    };

    process.on("exit", restore);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    stdout.on("resize", draw);
    stdout.write(ENTER_ALT + "\x1b[2J");
    draw();
  });
}
