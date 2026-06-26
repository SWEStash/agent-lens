/** Shared chart theming so Recharts matches the app's dark palette (styles.css :root vars). */
import type { ReactNode } from "react";

export const C = {
  bg: "#0f1115",
  panel: "#171a21",
  panel2: "#1e222b",
  border: "#2a2f3a",
  text: "#e6e8ec",
  muted: "#8b93a3",
  accent: "#6ea8fe",
  green: "#7ee0a0",
  gold: "#e0b85a",
  red: "#ff6b6b",
  violet: "#b98cff",
  teal: "#4fd1c5",
};

/** Token series colors. Cache-read is intentionally muted — it dominates and misleads. */
export const TOKEN_COLORS = {
  input: C.green,
  output: C.accent,
  cache_creation: C.gold,
  cache_read: C.muted,
};

/** Categorical palette for bar/pie slices. */
export const PALETTE = [C.accent, C.green, C.gold, C.violet, C.teal, C.red, C.muted, "#d98c5f", "#5f9ed9"];

export const axisProps = {
  stroke: C.muted,
  tick: { fill: C.muted, fontSize: 11 },
  tickLine: false,
};

export const gridProps = { stroke: C.border, strokeDasharray: "3 3", vertical: false };

export const tooltipStyle = {
  contentStyle: { background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 },
  labelStyle: { color: C.text },
  itemStyle: { color: C.text },
};

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

export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub != null && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
