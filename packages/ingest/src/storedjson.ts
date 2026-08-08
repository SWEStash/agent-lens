/**
 * Reading back JSON that ingest itself wrote (`tool_calls.input_json`). A parse failure here is not a
 * malformed-input case — the transcript reader already counts those — it means a row in our own DB is
 * corrupt or truncated, which the derivation passes used to swallow silently: they returned "no data"
 * and the affected tool call quietly stopped being classified or scanned for findings.
 *
 * Swallowing is still right (one bad row must not abort a rescan of thousands), but it is now
 * counted, and the first failure per site is reported so a corrupt DB is visible rather than showing
 * up as findings that mysteriously don't fire.
 */
let malformed = 0;
const reported = new Set<string>();

/** Parse a JSON column, or null. `where` names the call site in the one-time warning. */
export function parseStored<T = unknown>(json: string | null | undefined, where: string): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    malformed++;
    if (!reported.has(where)) {
      reported.add(where);
      console.warn(`agent-lens: malformed stored JSON in ${where} — the affected rows are skipped; re-ingest with --full to rebuild`);
    }
    return null;
  }
}

/** How many stored-JSON parses have failed in this process. Zero on a healthy DB. */
export function malformedStoredJson(): number {
  return malformed;
}

/** Test helper: forget the counter and the one-time warnings. */
export function resetMalformedStoredJson(): void {
  malformed = 0;
  reported.clear();
}
