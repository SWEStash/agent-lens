/** Shared helpers for making sense of the JSON-ish payloads Claude Code emits — flattened transcript
 * text, truncated tool results, and doubly-encoded launch args. Used by the workflow page, the
 * transcript's Workflow block, and the generic result view. */

/** Flattened transcript text HTML-encodes a few characters (e.g. "->" → "-&gt;"); decode them so the
 * result reads correctly and JSON inside it parses. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3?9;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Claude Code truncates large task-notification results, appending a literal
 * "(truncated N chars, full result in <path>)" note. Peel that off so the JSON body can be parsed and
 * the note shown separately. */
export function splitTruncation(s: string): { body: string; note: string | null } {
  const m = s.match(/\s*\(\s*truncated[^)]*\)\s*$/i);
  if (!m || m.index == null) return { body: s, note: null };
  return { body: s.slice(0, m.index).trimEnd(), note: m[0].trim() };
}

/** Parse JSON that may be truncated mid-structure (Claude Code caps large results). Strict parse
 * first; on failure, recover the largest valid prefix by cutting back to the last completed element
 * boundary and closing the still-open brackets. Returns `{ value, repaired }`, or value=undefined if
 * nothing parseable could be recovered. String-aware so punctuation inside strings isn't miscounted. */
export function looseParse(body: string): { value: unknown; repaired: boolean } {
  try {
    return { value: JSON.parse(body), repaired: false };
  } catch {
    /* fall through to best-effort recovery */
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let safe = -1;
  let safeStack: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") (stack.pop(), (safe = i + 1), (safeStack = [...stack]));
    else if (c === ",") (safe = i, (safeStack = [...stack])); // cut before the dangling element
  }
  if (safe < 0) return { value: undefined, repaired: false };
  const candidate = body.slice(0, safe) + safeStack.reverse().join("");
  try {
    return { value: JSON.parse(candidate), repaired: true };
  } catch {
    return { value: undefined, repaired: false };
  }
}

/** Recursively parse string values that are themselves JSON. The Workflow tool passes its task list
 * as a JSON-encoded *string* under `args`, so a plain parse leaves it an opaque escaped blob; this
 * unwraps those so nested structure renders. Non-JSON strings are left untouched. */
export function deepParse(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    const looksJson = (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
    if (looksJson) {
      try {
        return deepParse(JSON.parse(t));
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(deepParse);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = deepParse(val);
    return o;
  }
  return v;
}

/** Pretty-print a JSON string, capped so a giant payload can't blow up the DOM. Falls back to the
 * raw (also capped) text when it isn't valid JSON. */
export function prettyJson(s: string, cap = 20000): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2).slice(0, cap);
  } catch {
    return s.slice(0, cap);
  }
}
