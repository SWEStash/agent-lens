/**
 * Shell-write extraction (ADR-022) — pull the file paths a Bash command writes out of its verbatim
 * command string.
 *
 * Why this exists: the Edit/Write/NotebookEdit tools are not the only way a session changes a file.
 * Profiling the corpus found ~1,000 shell writes landing on source files inside a known project, of
 * which 83% had no `file_changes` row — a third of main sessions were changing files invisibly.
 * ADR-022 level 1 deliberately scoped Bash out as "lower confidence"; this narrows that gap to the
 * constructs that are unambiguous from the command text alone.
 *
 * Deliberately NOT covered — the path is not recoverable from the command string with any
 * confidence, so guessing would poison per-file grouping:
 * - interpreter-embedded writes (`p.write_text(...)`, `fs.writeFileSync(...)`) inside a heredoc
 * - any target carrying an unexpanded variable, glob or command substitution
 * - `cp`/`mv`/`rm` and other whole-file operations (level 2's git-composed territory)
 *
 * Pure and deterministic: string in, targets out. Resolving a relative target against a cwd is the
 * caller's job (see filechanges.ts) — this module only reports what the command says.
 */

export interface ShellWrite {
  /** The target exactly as written — absolute, or relative to the command's cwd. */
  path: string;
  /** Lines written, when the construct carries its own body (heredoc); null otherwise. */
  linesAdded: number | null;
}

export interface ShellWriteParse {
  /** Absolute directory from a leading `cd`, when the command starts by changing into one. */
  cwd: string | null;
  writes: ShellWrite[];
}

/** A target token: double-quoted, single-quoted, or bare up to the next shell delimiter. */
const TARGET = `"([^"]+)"|'([^']+)'|([^\\s;|&<>()]+)`;
/** `>` / `>>`, optionally preceded by a file descriptor (`2>`), then the target. */
const REDIRECT = new RegExp(`(?:^|[\\s;|&(])\\d?>{1,2}\\s*(?:${TARGET})`, "g");
const TEE = new RegExp(`(?:^|[\\s;|&(])tee\\s+(?:-a\\s+)?(?:${TARGET})`, "g");
/** `sed -i` (optionally with a backup suffix), any number of `-e`/script args, then the file. */
const SED_I = new RegExp(
  `(?:^|[\\s;|&(])sed\\s+(?:-[a-zA-Z]*i[a-zA-Z]*(?:\\.\\w+)?)\\s+(?:(?:-e\\s+)?(?:'[^']*'|"[^"]*"|\\S+)\\s+)+?(?:${TARGET})`,
  "g",
);
const CD = new RegExp(`^\\s*cd\\s+(?:${TARGET})`);
/** Heredoc opener: `<<` or `<<-`, delimiter optionally quoted. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
/** The redirect immediately feeding a heredoc, found by scanning back from the `<<`. */
const REDIRECT_BEFORE_HEREDOC = new RegExp(`\\d?>{1,2}\\s*(?:${TARGET})\\s*$`);

/** The captured target from a TARGET alternation, whichever quoting style matched. */
function target(m: RegExpMatchArray, first: number): string | null {
  return m[first] ?? m[first + 1] ?? m[first + 2] ?? null;
}

/**
 * A target is usable only when it names one concrete file. Anything the shell would still expand
 * (variables, globs, substitutions, `~`) or that is not a real file (device sinks, bare fd dups)
 * is dropped rather than guessed at.
 */
function usable(path: string | null): path is string {
  if (!path) return false;
  if (/[$*?`~]/.test(path)) return false;
  if (path.startsWith("&")) return false;
  if (path === "/dev/null" || path.startsWith("/dev/")) return false;
  return true;
}

/** Lines a heredoc body spans; 0 when the body is empty. */
function bodyLines(body: string): number {
  const trimmed = body.replace(/\n$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

/**
 * Blank out every heredoc body (same length, so match offsets stay meaningful) and return the
 * writes those heredocs performed. Bodies are documents, not shell — a `>` inside one is prose,
 * and scanning it would invent file changes out of example commands.
 */
function stripHeredocs(command: string): { scan: string; writes: Array<{ at: number; write: ShellWrite }> } {
  const writes: Array<{ at: number; write: ShellWrite }> = [];
  let scan = command;
  HEREDOC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEREDOC.exec(scan))) {
    const delim = m[2];
    const openerEnd = scan.indexOf("\n", m.index);
    if (openerEnd === -1) break;
    const terminator = new RegExp(`^[ \\t]*${delim}[ \\t]*$`, "m");
    const rest = scan.slice(openerEnd + 1);
    const end = rest.search(terminator);
    const bodyEnd = end === -1 ? rest.length : end;
    const before = scan.slice(0, m.index);
    const red = before.match(REDIRECT_BEFORE_HEREDOC);
    if (red) {
      const p = target(red, 1);
      if (usable(p)) writes.push({ at: red.index ?? m.index, write: { path: p, linesAdded: bodyLines(rest.slice(0, bodyEnd)) } });
    }
    // Blank the opener + body + terminator so later passes never see document text as shell.
    const stripEnd = end === -1 ? scan.length : openerEnd + 1 + bodyEnd + delim.length;
    scan = scan.slice(0, m.index) + " ".repeat(stripEnd - m.index) + scan.slice(stripEnd);
    HEREDOC.lastIndex = stripEnd;
  }
  return { scan, writes };
}

/** Every write the command performs, in the order the targets appear. */
export function parseShellWrites(command: string): ShellWriteParse {
  if (typeof command !== "string" || !command) return { cwd: null, writes: [] };

  const cdMatch = command.match(CD);
  const cdPath = cdMatch ? target(cdMatch, 1) : null;
  const cwd = cdPath && cdPath.startsWith("/") && !/[$*?`~]/.test(cdPath) ? cdPath : null;

  const { scan, writes: found } = stripHeredocs(command);
  for (const [re, group] of [
    [REDIRECT, 1],
    [TEE, 1],
    [SED_I, 1],
  ] as Array<[RegExp, number]>) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      const p = target(m, group);
      if (usable(p)) found.push({ at: m.index, write: { path: p, linesAdded: null } });
    }
  }

  // One row per file: earliest mention wins the ordering, and a known body length beats an unknown.
  const byPath = new Map<string, { at: number; write: ShellWrite }>();
  for (const entry of found) {
    const prev = byPath.get(entry.write.path);
    if (!prev) {
      byPath.set(entry.write.path, entry);
      continue;
    }
    byPath.set(entry.write.path, {
      at: Math.min(prev.at, entry.at),
      write: { path: entry.write.path, linesAdded: prev.write.linesAdded ?? entry.write.linesAdded },
    });
  }
  return { cwd, writes: [...byPath.values()].sort((a, b) => a.at - b.at).map((e) => e.write) };
}
