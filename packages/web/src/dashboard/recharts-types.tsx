/* Recharts hands its render-prop callbacks (tooltip `content`, axis `tick`, bar/legend `onClick`)
 * shapes its own exported types don't usefully narrow, which is how `any` had spread through this
 * file. Declared here instead are the shapes the dashboard actually reads. The inline
 * `formatter` props keep their annotations narrow for the same reason; note every field a formatter
 * reads off `payload` must stay OPTIONAL, or the function is no longer assignable to Recharts'
 * `Formatter` and the chart stops compiling. */
import type { DashBreakdowns } from "../api";
import { useChartTokens } from "../charts/theme";

/** A charted row, as Recharts hands it back — either the datum itself or wrapped in `payload`. */
export type ChartDatum = Record<string, unknown> & { payload?: Record<string, unknown> };

/** What a `content={<X />}` tooltip receives. */
export interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
}

/** What an axis `tick` render prop receives. */
export interface AxisTickProps {
  x?: number;
  y?: number;
  payload?: { value?: string };
}

export type SkillVersionRow = DashBreakdowns["skill_versions"][number];

/** Read a string field off a clicked datum, wherever Recharts put it. */
export function datumField(d: ChartDatum | undefined, field: string): string | null {
  const v = d?.payload?.[field] ?? d?.[field];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Read-only hover for the grouped skill bar: the skill's total + each version's firing count.
 * (Recharts tooltips aren't interactive, so the per-version links live on the skill page; click the
 * bar to go there.) */
export function SkillTooltip({ active, payload, versionsByName }: TooltipProps & { versionsByName: Map<string, SkillVersionRow[]> }) {
  const { C, tooltipStyle } = useChartTokens();
  if (!active || !payload?.length) return null;
  const name = String(payload[0]?.payload?.name ?? "");
  const total = Number(payload[0]?.payload?.n ?? 0);
  const versions = versionsByName.get(name) ?? [];
  return (
    <div style={{ ...tooltipStyle.contentStyle, padding: "8px 10px", maxWidth: 280 }}>
      <div style={{ color: C.text, fontWeight: 600, marginBottom: 4 }}>{name}</div>
      <div style={{ color: C.muted, marginBottom: versions.length ? 6 : 0 }}>{total} firing{total === 1 ? "" : "s"} total</div>
      {versions.map((v) => (
        <div key={v.version_id} style={{ color: C.text, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ color: C.muted }}>{v.version_id.slice(0, 8)}</span>
          <span>{v.n}</span>
        </div>
      ))}
      {versions.length > 0 && <div style={{ color: C.muted, marginTop: 6, fontSize: 11 }}>click to open skill →</div>}
    </div>
  );
}

/** A clickable category-axis label for drill-down bar charts, so a bar too short to click is still
 * reachable via its label. Renders the tick text with a pointer cursor; clicking calls `onSelect` with
 * the label value. Styled via `.axis-link` (muted → accent + underline on hover). */
export function AxisLink({ x, y, payload, onSelect, title }: AxisTickProps & { onSelect: (value: string) => void; title?: string }) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" className="axis-link" fontSize={11} onClick={() => payload?.value && onSelect(payload.value)}>
      {title && <title>{title}</title>}
      {payload?.value}
    </text>
  );
}
