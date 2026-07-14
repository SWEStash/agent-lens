/** Shared severity presentation for security findings (ADR-017) — used by the /security page, the
 * transcript's inline finding badges, and the Dashboard KPI so severity always looks the same. Colors
 * live in styles.css (.sev-* classes, theme-aware); this module owns order + labels only. */
import type { Severity } from "./api";

/** Most-severe first — the order the UI lists severities in. */
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/** A colored severity pill (className drives the color via .sev-<severity>). */
export function SeverityTag({ severity, count }: { severity: string; count?: number }) {
  return (
    <span className={"tag sev sev-" + severity}>
      {severity}
      {count != null ? ` ${count}` : ""}
    </span>
  );
}
