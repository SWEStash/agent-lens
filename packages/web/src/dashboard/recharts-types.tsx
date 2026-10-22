/* Recharts hands its render-prop callbacks (tooltip `content`, axis `tick`, bar/legend `onClick`)
 * shapes its own exported types don't usefully narrow, which is how `any` had spread through this
 * file. Declared here instead are the shapes the dashboard actually reads. The inline
 * `formatter` props keep their annotations narrow for the same reason; note every field a formatter
 * reads off `payload` must stay OPTIONAL, or the function is no longer assignable to Recharts'
 * `Formatter` and the chart stops compiling. */
import type { DashBreakdowns } from "../api";

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
  if (!active || !payload?.length) return null;
  const name = String(payload[0]?.payload?.name ?? "");
  const total = Number(payload[0]?.payload?.n ?? 0);
  const versions = versionsByName.get(name) ?? [];
  return (
    <div className="skill-tip">
      <div className="skill-tip-name">{name}</div>
      <div className="skill-tip-total">{total} firing{total === 1 ? "" : "s"} total</div>
      {versions.map((v) => (
        <div key={v.version_id} className="skill-tip-row">
          <span>{v.version_id.slice(0, 8)}</span>
          <span>{v.n}</span>
        </div>
      ))}
      {versions.length > 0 && <div className="skill-tip-hint">click to open skill →</div>}
    </div>
  );
}

/** A clickable category-axis label for drill-down bar charts, so a bar too short to click is still
 * reachable via its label. Renders the tick text with a pointer cursor; clicking calls `onSelect` with
 * the label value. Styled via `.axis-link` (muted → accent + underline on hover). */
export function AxisLink({ x, y, payload, onSelect, title }: AxisTickProps & { onSelect: (value: string) => void; title?: string }) {
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      className="axis-link"
      onClick={() => payload?.value && onSelect(payload.value)}
      // `data-tip`, not an SVG <title>: that one is drawn by the browser, and these hints share the
      // app's tooltip (Tooltip.tsx) like every other one.
      data-tip={title}
    >
      {payload?.value}
    </text>
  );
}
