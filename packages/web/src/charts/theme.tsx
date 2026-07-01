/** Shared chart theming. Colors are read from the app's CSS custom properties (styles.css :root)
 * so Recharts follows the active light/dark theme — CSS stays the single source of truth. */
import { useMemo, type ReactNode } from "react";
import { useTheme } from "../theme";

export type ChartTokens = ReturnType<typeof useChartTokens>;

/** Read the current palette from CSS vars and derive Recharts style objects.
 * Recomputes whenever the theme changes (ThemeProvider sets `data-theme` during render, so the
 * computed values below already reflect the new theme on this pass). */
export function useChartTokens() {
  const { theme } = useTheme();
  return useMemo(() => {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string) => s.getPropertyValue(name).trim();
    const C = {
      bg: v("--bg"),
      panel: v("--panel"),
      panel2: v("--panel2"),
      border: v("--border"),
      text: v("--text"),
      muted: v("--muted"),
      accent: v("--accent"),
      green: v("--user"),
      gold: v("--gold"),
      red: v("--err"),
      violet: v("--violet"),
      teal: v("--teal"),
    };
    // Token series colors. Cache-read is intentionally muted — it dominates and misleads.
    const TOKEN_COLORS = {
      input: C.green,
      output: C.accent,
      cache_creation: C.gold,
      cache_read: C.muted,
    };
    // Categorical palette for bar/pie slices.
    const PALETTE = [C.accent, C.green, C.gold, C.violet, C.teal, C.red, C.muted, "#d98c5f", "#5f9ed9"];
    const axisProps = { stroke: C.muted, tick: { fill: C.muted, fontSize: 11 }, tickLine: false };
    const gridProps = { stroke: C.border, strokeDasharray: "3 3", vertical: false };
    const tooltipStyle = {
      contentStyle: { background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 },
      labelStyle: { color: C.text },
      itemStyle: { color: C.text },
    };
    return { C, TOKEN_COLORS, PALETTE, axisProps, gridProps, tooltipStyle };
  }, [theme]);
}

export function ChartCard({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {hint && <span className="card-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Kpi({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="kpi" title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub != null && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
