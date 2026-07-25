/** Shell-command line splitting for the transcript's Bash renderer. Pure, no JSX — see shell.test.ts. */

/** A physical line of a shell command, tagged with whether it *starts* a new logical command (gets a
 * `$` prompt) or *continues* the previous one (heredoc body, open quote/`$(…)`, backslash or trailing
 * `|`/`&&`/`||` continuation → no prompt). */
export type ShellLine = { text: string; cont: boolean };

/** Parse a heredoc opener at `line[i]` (`<<` / `<<-`, optional spaces, optionally quoted delimiter),
 * push its delimiter onto `heredocs`, and return the index of its last consumed char. */
function scanHeredoc(line: string, i: number, heredocs: { delim: string; strip: boolean }[]): number {
  let j = i + 2; // past "<<"
  let strip = false;
  if (line[j] === "-") {
    strip = true;
    j++;
  }
  while (line[j] === " " || line[j] === "\t") j++;
  let q = "";
  if (line[j] === "'" || line[j] === '"') {
    q = line[j];
    j++;
  }
  let delim = "";
  if (q) {
    while (j < line.length && line[j] !== q) delim += line[j++];
    if (line[j] === q) j++;
  } else {
    while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) delim += line[j++];
  }
  if (delim) heredocs.push({ delim, strip });
  return j - 1; // caller's for-loop does i++
}

/** Split a (possibly multi-command, multi-line) shell command into physical lines, marking which start
 * a new command vs. continue the previous one — so each real command gets a `$` prompt and heredoc
 * bodies / continuations don't. A pragmatic scanner honoring single/double quotes, `$(…)`/subshell
 * depth, heredocs (incl. mid-command, e.g. `"$(cat <<'EOF'…)"`), backslash and trailing-operator
 * continuations. Control-structure bodies outside a heredoc (a bare multi-line `for`/`if`) aren't
 * tracked, so each of their lines gets its own `$` — acceptable since those are rare as a raw command. */
export function splitShellCommand(command: string): ShellLine[] {
  const lines = command.split("\n");
  const out: ShellLine[] = [];
  let mode: "NORMAL" | "SQUOTE" | "DQUOTE" = "NORMAL";
  let parenDepth = 0;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let pendingCont = false;

  for (const line of lines) {
    if (heredocs.length > 0) {
      out.push({ text: line, cont: true }); // heredoc body — literal, never a new command
      const hd = heredocs[0];
      const probe = hd.strip ? line.replace(/^\t+/, "") : line;
      if (probe.trimEnd() === hd.delim) heredocs.shift();
      continue;
    }

    out.push({ text: line, cont: mode !== "NORMAL" || parenDepth > 0 || pendingCont });

    pendingCont = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (mode === "SQUOTE") {
        if (c === "'") mode = "NORMAL";
        continue;
      }
      if (mode === "DQUOTE") {
        if (c === "\\") i++;
        else if (c === '"') mode = "NORMAL";
        else if (c === "$" && line[i + 1] === "(") (parenDepth++, i++);
        else if (c === ")") parenDepth > 0 && parenDepth--;
        else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") i = scanHeredoc(line, i, heredocs);
        continue;
      }
      // NORMAL
      if (c === "\\") i++;
      else if (c === "'") mode = "SQUOTE";
      else if (c === '"') mode = "DQUOTE";
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break; // trailing comment
      else if (c === "$" && line[i + 1] === "(") (parenDepth++, i++);
      else if (c === "(") parenDepth++;
      else if (c === ")") parenDepth > 0 && parenDepth--;
      else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") i = scanHeredoc(line, i, heredocs);
    }

    if (mode === "NORMAL" && parenDepth === 0 && heredocs.length === 0) {
      const t = line.replace(/\s+$/, "");
      const bs = t.match(/\\+$/);
      if (bs && bs[0].length % 2 === 1) pendingCont = true;
      else if (/(&&|\|\||\|)$/.test(t)) pendingCont = true;
    }
  }
  return out;
}
