/**
 * The timezone contract: compute in UTC, present in local time.
 *
 * Every stored timestamp is ISO-8601 UTC and every server aggregate groups on UTC, so hour-of-day
 * and day boundaries are a *presentation* concern — the server hands back raw hourly UTC rows and
 * this module folds them into local parts. That split is what lets one exported snapshot read
 * correctly in every viewer's zone, and it is why a fixed `±HH:MM` offset was not an option: an
 * offset cannot follow a DST transition, and `Intl` can.
 */
import { loadPrefLocal } from "./prefs";

/** Pref key for an explicitly pinned zone — set so a reader of someone else's snapshot can hold the
 *  author's zone. There is no picker UI yet; an unset pref means "follow this machine". */
export const TZ_PREF_KEY = "dashboard.timezone";

/** Explicit pref → the OS zone → UTC. */
export function resolveZone(pref?: string | null): string {
  const chosen = pref ?? loadPrefLocal<string | null>(TZ_PREF_KEY, null);
  if (chosen) return chosen;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface LocalParts {
  /** 0 = Sunday, matching `Date.getDay()` and the heatmap's row order. */
  weekday: number;
  hour: number;
  /** Local calendar day, `YYYY-MM-DD` — the denominator for "mean per active day". */
  dayKey: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One formatter per zone. Constructing an Intl.DateTimeFormat costs enough that doing it per row —
// and a wide range is thousands of rows — is the difference between instant and visibly slow.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * Map the server's `YYYY-MM-DDTHH` UTC hour key onto local weekday / hour / day.
 *
 * Returns null for a key that does not parse, so one malformed row cannot take the tile down.
 */
export function localParts(utcHourKey: string, zone: string): LocalParts | null {
  const at = Date.parse(utcHourKey + ":00:00Z");
  if (Number.isNaN(at)) return null;
  const parts = formatterFor(zone).formatToParts(new Date(at));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(get("weekday"));
  const hour = Number(get("hour"));
  const [y, m, d] = [get("year"), get("month"), get("day")];
  if (weekday < 0 || !Number.isFinite(hour) || !y || !m || !d) return null;
  // h23 still renders midnight as "24" in some ICU versions; normalize rather than trust it.
  return { weekday, hour: hour % 24, dayKey: `${y}-${m}-${d}` };
}

/** Short label for the active zone, e.g. "GMT-3" — shown on every hour-of-day tile, because a
 *  punchcard with an unstated zone is a wrong chart. */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}
