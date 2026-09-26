/**
 * Dynamic context injection in skill bodies. A SKILL.md line like !`git diff --staged --stat` is run
 * by Claude Code at skill load and REPLACED by the command's output in the injected body, so one
 * skill file renders differently on every firing (and the render carries the user's working-tree
 * data). The command itself never reaches the transcript, but empty output renders as the literal
 * EMPTY_OUTPUT marker — which pins where the slot sits. A slot is remembered by the unique static
 * lines around it, and masking replaces whatever sits between them with DYNAMIC_PLACEHOLDER. Stored
 * bodies keep the placeholder, so they teach the same slots back on later (incremental) runs.
 */

/** Claude Code's formats for appending a skill's arguments to its body; add new ones here as the harness grows them. */
export const ARG_TRAILERS = ["\nARGUMENTS:", "\n## User Request\n"];

export const EMPTY_OUTPUT = "(Bash completed with no output)";
export const DYNAMIC_PLACEHOLDER = "(dynamic context: command output omitted)";

export interface Slot {
  before: string;
  after: string;
}

const isMarker = (t: string) => t === EMPTY_OUTPUT || t === DYNAMIC_PLACEHOLDER;

/** Index of the single line equal to `text` (trimmed), or -1 when absent or ambiguous. */
function uniqueLine(lines: string[], text: string): number {
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== text) continue;
    if (at >= 0) return -1;
    at = i;
  }
  return at;
}

/** Slots revealed by a body: each run of marker/blank lines, anchored by the nearest static lines. */
export function learnSlots(body: string): Slot[] {
  const lines = body.split("\n");
  const trimmed = lines.map((l) => l.trim());
  const slots: Slot[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isMarker(trimmed[i])) continue;
    let b = i - 1;
    while (b >= 0 && trimmed[b] === "") b--;
    let a = i + 1;
    while (a < lines.length && (trimmed[a] === "" || isMarker(trimmed[a]))) a++;
    i = a - 1; // the whole run is one slot
    if (b < 0 || a >= lines.length) continue;
    const slot = { before: trimmed[b], after: trimmed[a] };
    if (uniqueLine(lines, slot.before) < 0 || uniqueLine(lines, slot.after) < 0) continue;
    if (!slots.some((s) => s.before === slot.before && s.after === slot.after)) slots.push(slot);
  }
  return slots;
}

/** Add the slots `body` reveals to `into` (skipping ones already known); returns `into`. */
export function mergeSlots(into: Slot[], body: string): Slot[] {
  for (const s of learnSlots(body)) if (!into.some((x) => x.before === s.before && x.after === s.after)) into.push(s);
  return into;
}

/** Replace the content of every slot whose anchors appear exactly once, in order, with the placeholder. */
export function maskDynamic(body: string, slots: Slot[]): string {
  let lines = body.split("\n");
  for (const { before, after } of slots) {
    const b = uniqueLine(lines, before);
    const a = uniqueLine(lines, after);
    if (b < 0 || a <= b) continue;
    lines = [...lines.slice(0, b + 1), "", DYNAMIC_PLACEHOLDER, "", ...lines.slice(a)];
  }
  return lines.join("\n");
}

/** Args shorter than this are left alone: they would match ordinary words in the skill text. */
const MIN_MASKED_ARGS = 8;

/**
 * Put the template placeholders back where the harness substituted per-firing values the firing
 * itself tells us — the Skill call's args ($ARGUMENTS), the skill's base dir (${CLAUDE_SKILL_DIR})
 * and the session id (${CLAUDE_SESSION_ID}) — whatever syntax the skill used to request them.
 * Longest value first, so a value containing another is masked whole.
 */
export function maskKnownValues(body: string, known: { args?: string | null; baseDir?: string | null; sessionId?: string | null }): string {
  const subs: Array<[string, string]> = [];
  const args = known.args?.trim();
  if (args && args.length >= MIN_MASKED_ARGS) subs.push([args, "$ARGUMENTS"]);
  if (known.baseDir) subs.push([known.baseDir, "${CLAUDE_SKILL_DIR}"]);
  if (known.sessionId) subs.push([known.sessionId, "${CLAUDE_SESSION_ID}"]);
  subs.sort((x, y) => y[0].length - x[0].length);
  return subs.reduce((out, [value, placeholder]) => out.split(value).join(placeholder), body);
}
