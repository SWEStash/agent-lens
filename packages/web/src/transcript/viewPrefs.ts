/** Transcript view preferences (message format, hide-tools). These go through the shared prefs module
 * like every other UI pref: localStorage for instant first paint, written through to the server's
 * writable sidecar so a choice survives a cache-clear and follows the same server across browsers.
 * They used to hand-roll `localStorage` and were the only prefs that silently did NOT sync. */
import { fetchPref, loadPrefLocal, savePref } from "../prefs";
import type { MsgFormat } from "./contexts";
import type { TokenMetric } from "./timeline/marks";

const FORMAT_KEY = "msgFormat";
const HIDE_TOOLS_KEY = "hideTools";
const AXIS_MODE_KEY = "timelineAxis";
const METRIC_KEY = "timelineMetric";

/** Compressed by default: a main session runs at a median 92% idle, so a literal wall-clock axis
 *  spends ~98% of its width on ~2% of the events. Literal is the niche, not the default. */
export type AxisMode = "compressed" | "literal";

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
const asAxisMode = (v: unknown): AxisMode => (v === "literal" ? "literal" : "compressed");
const asMetric = (v: unknown): TokenMetric => (v === "output" || v === "total" ? v : "work");

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

export function loadAxisMode(): AxisMode {
  return asAxisMode(readPref(AXIS_MODE_KEY));
}

export function loadTimelineMetric(): TokenMetric {
  return asMetric(readPref(METRIC_KEY));
}

export function saveAxisMode(m: AxisMode): void {
  savePref(AXIS_MODE_KEY, m);
}

export function saveTimelineMetric(m: TokenMetric): void {
  savePref(METRIC_KEY, m);
}

/** Reconcile both prefs with the server's stored values (the source of truth when a writable store is
 * configured). Mirrors how Dashboard and SessionsView reconcile theirs after first paint; resolves to
 * the values to apply, omitting whichever the server has no opinion on. */
export async function fetchViewPrefs(): Promise<{
  format?: MsgFormat;
  hideTools?: boolean;
  axisMode?: AxisMode;
  metric?: TokenMetric;
}> {
  const [format, hideTools, axisMode, metric] = await Promise.all([
    fetchPref<unknown>(FORMAT_KEY),
    fetchPref<unknown>(HIDE_TOOLS_KEY),
    fetchPref<unknown>(AXIS_MODE_KEY),
    fetchPref<unknown>(METRIC_KEY),
  ]);
  return {
    ...(format != null ? { format: asFormat(format) } : {}),
    ...(hideTools != null ? { hideTools: asHideTools(hideTools) } : {}),
    ...(axisMode != null ? { axisMode: asAxisMode(axisMode) } : {}),
    ...(metric != null ? { metric: asMetric(metric) } : {}),
  };
}
