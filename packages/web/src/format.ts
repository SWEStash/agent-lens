export function fmtDuration(ms: number | null): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

export function fmtCost(n: number): string {
  return n >= 0.01 ? "$" + n.toFixed(2) : n > 0 ? "<$0.01" : "$0";
}

/** Hover breakdown of a token total into its four categories (cache kept, not hidden). */
export function tokenSplitTitle(s?: { input: number; output: number; cache_creation: number; cache_read: number } | null): string {
  if (!s) return "";
  return `input ${fmtTokens(s.input)} · output ${fmtTokens(s.output)} · cache-write ${fmtTokens(s.cache_creation)} · cache-read ${fmtTokens(s.cache_read)}`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function shortModel(m: string | null): string {
  if (!m) return "";
  // Claude Code stamps "<synthetic>" on locally-generated messages (no API call, $0 cost). The raw
  // angle-bracket literal reads as a glitch in dropdowns/tags, so show a friendly label. The stored
  // value and its (unpriced) cost handling are untouched.
  if (m === "<synthetic>") return "local";
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
