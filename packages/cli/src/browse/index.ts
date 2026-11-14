/**
 * `agent-lens browse`: pick a session, read its transcript, press `o` to open it in the web UI. A thin
 * driver over the pure screens in view.ts: it owns the terminal (raw keys, the alternate screen,
 * resizes) and always gives it back, on quit, Ctrl-C, a signal or an error (ADR-042).
 */
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { resolveServerConfig, UserError } from "@agent-lens/core";
import { getSession, listSessions } from "@agent-lens/server";
import type { SessionDetail } from "@agent-lens/contracts";
import { openStore, parseSince, resolveProject, type ReportOpts } from "../report.js";
import { reduce, renderList, renderPager, transcriptLines, type Key, type State } from "./view.js";

export type BrowseOpts = ReportOpts & { search?: string; pr?: string; kind?: string };

const ENTER_ALT = "\x1b[?1049h\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

/** The web UI's URL for a session. A wildcard bind is reached on loopback. */
export function sessionUrl(id: string, host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}/session/${encodeURIComponent(id)}`;
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
  const { sessions } = listSessions(db, {
    source: o.source,
    project: resolveProject(db, o.project),
    from: o.since ? parseSince(o.since) : undefined,
    q: o.search,
    pr: o.pr,
    kind: kind === "all" ? undefined : (kind as "main" | "subagent"),
    limit,
    offset: 0,
  });
  if (!sessions.length) {
    stdout.write("No sessions match.\n");
    return;
  }
  const { host, port } = resolveServerConfig();

  let state: State = { screen: "list", cursor: 0, top: 0 };
  let detail: SessionDetail | null = null;
  let lines: string[] = [];
  let message = "";
  const size = () => ({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const body = () => Math.max(1, size().height - 2);
  const current = () => sessions[state.screen === "list" ? state.cursor : state.list.cursor];

  const draw = () => {
    const { width, height } = size();
    const screen =
      state.screen === "list"
        ? renderList(sessions, state, width, height, message)
        : renderPager(current().title ?? current().id, lines, state, width, height, message);
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
      stdout.off("resize", onResize);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      process.off("exit", restore);
      restore();
      if (err) reject(err);
      else resolve();
    };
    const onResize = () => {
      if (state.screen === "pager" && detail) lines = transcriptLines(detail, size().width);
      draw();
    };
    const onKey = (_: string, key: Key) => {
      try {
        message = "";
        const count = state.screen === "list" ? sessions.length : lines.length;
        const { state: next, effect } = reduce(state, key ?? {}, count, body());
        state = next;
        if (effect?.type === "quit") return finish();
        if (effect?.type === "open-pager") {
          detail = getSession(db, current().id);
          lines = detail ? transcriptLines(detail, size().width) : ["This session is no longer in the store."];
          state = { screen: "pager", top: 0, list: state as Extract<State, { screen: "list" }> };
        }
        if (effect?.type === "open-web") {
          const url = sessionUrl(current().id, host, port);
          void serverUp(host, port).then(async (up) => {
            if (!up) message = `Start 'agent-lens serve', then press o again: ${url}`;
            else message = (await openUrl(url)) ? `Opened ${url}` : `Couldn't start a browser; open ${url}`;
            if (!restored) draw();
          });
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
    stdout.on("resize", onResize);
    stdout.write(ENTER_ALT + "\x1b[2J");
    draw();
  });
}
