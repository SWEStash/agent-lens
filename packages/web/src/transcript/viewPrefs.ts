/** Transcript view preferences (message format, hide-tools). These go through the shared prefs module
 * like every other UI pref: localStorage for instant first paint, written through to the server's
 * writable sidecar so a choice survives a cache-clear and follows the same server across browsers.
 * They used to hand-roll `localStorage` and were the only prefs that silently did NOT sync. */
import { fetchPref, loadPrefLocal, savePref } from "../prefs";
import type { MsgFormat } from "./contexts";

const FORMAT_KEY = "msgFormat";
const HIDE_TOOLS_KEY = "hideTools";

/** Before these prefs moved onto `prefs.ts` they were stored UNENCODED under the same localStorage
 * keys ("raw"/"markdown", "1"/"0") rather than as JSON. Read that shape too, so an existing user's
 * choice isn't silently reset on upgrade; the next save rewrites it in the shared format. Note `"1"`
 * is valid JSON, so the legacy hide-tools value arrives already decoded, as the number 1. */
function readPref(key: string): unknown {
  const stored = loadPrefLocal<unknown>(key, null);
  if (stored != null) return stored;
  try {
    return localStorage.getItem("agentlens." + key); // unparsed legacy value, or null
  } catch {
    return null; // storage unavailable (private mode) — defaults apply
  }
}

const asFormat = (v: unknown): MsgFormat => (v === "raw" ? "raw" : "markdown");
const asHideTools = (v: unknown): boolean => v === true || v === 1 || v === "1";

export function loadFormat(): MsgFormat {
  return asFormat(readPref(FORMAT_KEY));
}

export function loadHideTools(): boolean {
  return asHideTools(readPref(HIDE_TOOLS_KEY));
}

export function saveFormat(f: MsgFormat): void {
  savePref(FORMAT_KEY, f);
}

export function saveHideTools(hide: boolean): void {
  savePref(HIDE_TOOLS_KEY, hide);
}

/** Reconcile both prefs with the server's stored values (the source of truth when a writable store is
 * configured). Mirrors how Dashboard and SessionsView reconcile theirs after first paint; resolves to
 * the values to apply, omitting whichever the server has no opinion on. */
export async function fetchViewPrefs(): Promise<{ format?: MsgFormat; hideTools?: boolean }> {
  const [format, hideTools] = await Promise.all([fetchPref<unknown>(FORMAT_KEY), fetchPref<unknown>(HIDE_TOOLS_KEY)]);
  return {
    ...(format != null ? { format: asFormat(format) } : {}),
    ...(hideTools != null ? { hideTools: asHideTools(hideTools) } : {}),
  };
}
