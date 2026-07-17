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

/** A dashboard chart card. The chart lives in a `.chart-body` whose height is governed by one CSS
 * variable (`--chart-h`) so every card in a grid row is the same height by default — pass an explicit
 * `bodyHeight` only to let a card grow on demand (the "show all" expansion). `actions` renders on the
 * right of the header (metric toggles, show-all buttons); charts inside use `height="100%"`. */
export function ChartCard({
  title,
  hint,
  actions,
  bodyHeight,
  hidden,
  children,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  bodyHeight?: number | string;
  hidden?: boolean;
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {hint && <span className="card-hint">{hint}</span>}
        {actions && <span className="card-actions">{actions}</span>}
      </div>
      <div className="chart-body" style={bodyHeight != null ? { height: bodyHeight } : undefined}>
        {children}
      </div>
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
