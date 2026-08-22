import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";
import { ChartCard, useChartTokens } from "../../charts/theme";
import { fmtCost, fmtTokens, shortModel } from "../../format";
import { AxisLink, SkillTooltip, datumField, type AxisTickProps, type ChartDatum, type SkillVersionRow } from "../recharts-types";
import { CHART_MARGIN, RankedBars, unitLabel, type ChartProps } from "./common";

const BAND_ORDER = ["trivial", "small", "medium", "large", "xl"];

/** Heuristic error buckets, ranked. Rejections/blocks are coloured apart from genuine failures because
 * they are not agent errors; both the bar and its axis label drill into the matching sessions. */
export function ErrorTypes({ hidden, bd, expand, drill }: ChartProps) {
  const { C, tooltipStyle, axisProps } = useChartTokens();
  const data = (bd?.error_types?.by_type ?? []).map((e) => ({ name: e.type, n: e.n, kind: e.kind }));
  const rows = expand.topN(data, "errors");
  return (
    <ChartCard
      title="Error types"
      guide={
        <>
          <p>Which kinds of tool error occurred, ranked by count. Click a bar to open the sessions behind it.</p>
          <dl>
            <dt>bar length</dt>
            <dd>number of errored tool calls of that type.</dd>
          </dl>
          <p>
            The type buckets are a <strong>heuristic over the tool's result text</strong>: the totals
            are exact, the labels best-effort. Rejections and guardrail blocks are counted separately
            because they are not agent failures.
          </p>
        </>
      }
      hint="heuristic buckets from the tool result text · rejections/blocks are not agent failures · click a bar for those sessions"
      actions={expand.expandBtn("errors", data.length)}
      bodyHeight={expand.expandHeight("errors", data.length, 28)}
      hidden={hidden}
    >
      {bd && data.length === 0 ? (
        <div className="empty">No errored tool calls in range.</div>
      ) : (
        <RankedBars
          data={rows}
          xAxisProps={{ allowDecimals: false }}
          yAxis={
            <YAxis
              type="category"
              dataKey="name"
              {...axisProps}
              width={130}
              tick={(p: AxisTickProps) => <AxisLink {...p} title="click to filter sessions" onSelect={(v: string) => drill.drillFilter("error_type", v)} />}
            />
          }
        >
          <Tooltip {...tooltipStyle} formatter={(v: number | string, _n: string, p: { payload?: { kind?: string } }) => [`${v} (${p.payload?.kind})`, "count"]} />
          <Bar dataKey="n" cursor="pointer" onClick={drill.drillTo("error_type", "name")}>
            {rows.map((d, i) => (
              <Cell key={i} fill={d.kind === "rejection" ? C.muted : C.red} />
            ))}
          </Bar>
        </RankedBars>
      )}
    </ChartCard>
  );
}

/** Per-model totals, switchable between tokens and cost (both are already in the payload). Bars carry
 * the full model id so a click deep-links to the Sessions model filter, which matches on the full id. */
export function TokensByModel({ hidden, bd, drill }: ChartProps) {
  const { PALETTE, tooltipStyle, axisProps } = useChartTokens();
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const data = (bd?.by_model ?? []).map((m) => ({ name: shortModel(m.model), model: m.model, tokens: m.total_tokens, cost: m.cost }));
  return (
    <ChartCard
      title="Tokens by model"
      guide={
        <>
          <p>Which models the tokens went to. Switch between tokens and estimated cost — the ranking often differs, because models are priced very differently.</p>
          <dl>
            <dt>bar length</dt>
            <dd>tokens, or estimated US dollars at API list prices, depending on the toggle.</dd>
          </dl>
          <p>Counts both main and subagent sessions: a subagent's tokens come off the same quota. Click a bar to open that model's sessions.</p>
        </>
      }
      hint="click a bar for those sessions"
      hidden={hidden}
      actions={
        <span className="seg" role="group" aria-label="Metric">
          <button type="button" className={metric === "tokens" ? "on" : ""} onClick={() => setMetric("tokens")}>
            tokens
          </button>
          <button type="button" className={metric === "cost" ? "on" : ""} onClick={() => setMetric("cost")}>
            cost
          </button>
        </span>
      }
    >
      <RankedBars
        data={data}
        top={8}
        xAxisProps={{ tickFormatter: (v: unknown) => (metric === "cost" ? fmtCost(Number(v)) : fmtTokens(v as number)) }}
        yAxis={
          <YAxis
            type="category"
            dataKey="name"
            {...axisProps}
            width={120}
            tick={(p: AxisTickProps) => (
              <AxisLink {...p} title="click to filter sessions" onSelect={(v: string) => drill.drillFilter("model", data.find((m) => m.name === v)?.model)} />
            )}
          />
        }
      >
        <Tooltip
          {...tooltipStyle}
          formatter={(_v: number | string, _n: string, p: { payload?: { tokens?: number; cost?: number } }) => [
            `${fmtTokens(Number(p.payload?.tokens))} · ${fmtCost(Number(p.payload?.cost))}`,
            metric,
          ]}
        />
        <Bar dataKey={metric} cursor="pointer" onClick={drill.drillTo("model", "model")}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </RankedBars>
    </ChartCard>
  );
}

export function Category({ hidden, bd }: ChartProps) {
  const { PALETTE, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = (bd?.by_category ?? []).map((c) => ({ name: c.category, value: c.n }));
  return (
    <ChartCard
      title="Category distribution"
      guide={
        <>
          <p>What kind of work the sessions were, as judged by the classifier.</p>
          <dl>
            <dt>x-axis</dt>
            <dd>category — feature, bugfix, refactor, docs, ops, chore, review.</dd>
            <dt>y-axis</dt>
            <dd>number of sessions.</dd>
          </dl>
          <p>
            <strong>Main sessions only</strong>: subagents inherit their parent's task and would
            multiply-count it. The label is inferred from the transcript rather than declared by you,
            so read it as a rough shape, not a ledger.
          </p>
        </>
      }
      hint="main sessions only"
      hidden={hidden}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis {...axisProps} width={36} allowDecimals={false} label={unitLabel("sessions", axisProps.stroke)} />
          <Tooltip {...tooltipStyle} />
          <Bar dataKey="value">
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function Complexity({ hidden, bd }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = BAND_ORDER.map((band) => ({
    name: band,
    value: bd?.by_complexity.find((b) => b.band === band)?.n ?? 0,
  })).filter((d) => d.value > 0);
  return (
    <ChartCard
      title="Complexity bands"
      guide={
        <>
          <p>How involved each session was, banded by a score over signals like turn count, tools used and files touched.</p>
          <dl>
            <dt>x-axis</dt>
            <dd>band — trivial, small, medium, large, xl.</dd>
            <dt>y-axis</dt>
            <dd>number of sessions.</dd>
          </dl>
          <p>
            <strong>Main sessions only.</strong> Most sessions landing in the lower bands is the real
            shape of the corpus, not a bug. Complexity measures effort spent — not difficulty, and not
            quality.
          </p>
        </>
      }
      hint="main sessions only"
      hidden={hidden}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis {...axisProps} width={36} allowDecimals={false} label={unitLabel("sessions", axisProps.stroke)} />
          <Tooltip {...tooltipStyle} />
          <Bar dataKey="value" fill={C.violet} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function ToolFrequency({ hidden, bd, expand }: ChartProps) {
  const { C, tooltipStyle, axisProps } = useChartTokens();
  const total = bd?.tools.length ?? 0;
  return (
    <ChartCard
      title="Tool frequency"
      guide={
        <>
          <p>Which tools the agent reached for most.</p>
          <dl>
            <dt>bar length</dt>
            <dd>number of calls to that tool.</dd>
          </dl>
          <p>Every call counts, successful or not, across both main and subagent sessions. "show all" opens the full list beyond the top few.</p>
        </>
      }
      hint="top tools by call count"
      actions={expand.expandBtn("tools", total)}
      bodyHeight={expand.expandHeight("tools", total, 22)}
      hidden={hidden}
    >
      <RankedBars data={expand.topN(bd?.tools ?? [], "tools")} yAxis={<YAxis type="category" dataKey="name" {...axisProps} width={110} />}>
        <Tooltip {...tooltipStyle} />
        <Bar dataKey="n" fill={C.teal} />
      </RankedBars>
    </ChartCard>
  );
}

/** Firings per skill, all versions grouped. The hover breaks the total down by version; the bar and its
 * axis label open the skill page (Recharts tooltips aren't interactive, so the links live there). */
export function SkillActivation({ hidden, bd, expand }: ChartProps) {
  const { C, axisProps } = useChartTokens();
  const navigate = useNavigate();
  const total = bd?.skills.length ?? 0;
  // Group skill versions under each skill name for the bar's hover breakdown (bars show the per-name total).
  const versionsByName = new Map<string, SkillVersionRow[]>();
  for (const v of bd?.skill_versions ?? []) {
    const arr = versionsByName.get(v.name) ?? [];
    arr.push(v);
    versionsByName.set(v.name, arr);
  }
  return (
    <ChartCard
      title="Skill activation"
      guide={
        <>
          <p>Which skills actually fired, ranked by how often.</p>
          <dl>
            <dt>bar length</dt>
            <dd>number of activations, with every version of a skill grouped together.</dd>
          </dl>
          <p>Hover a bar for the per-version split, click one to open that skill. A skill that is installed but never invoked does not appear at all.</p>
        </>
      }
      hint="firings per skill (all versions grouped) · hover for versions · click to open"
      actions={expand.expandBtn("skills", total)}
      bodyHeight={expand.expandHeight("skills", total, 22)}
      hidden={hidden}
    >
      {bd && bd.skills.length === 0 ? (
        <div className="empty">
          No <code>Skill</code> tool calls in range. Skill usage is captured from <code>input.skill</code>;
          this fills in once skills are actually invoked in collected sessions.
        </div>
      ) : (
        <RankedBars
          data={expand.topN(bd?.skills ?? [], "skills")}
          yAxis={
            <YAxis
              type="category"
              dataKey="name"
              {...axisProps}
              width={140}
              tick={(p: AxisTickProps) => <AxisLink {...p} title="click to open skill" onSelect={(v: string) => v && navigate(`/skill/${encodeURIComponent(v)}`)} />}
            />
          }
        >
          <Tooltip cursor={{ fill: C.border, fillOpacity: 0.25 }} content={<SkillTooltip versionsByName={versionsByName} />} />
          <Bar
            dataKey="n"
            fill={C.gold}
            cursor="pointer"
            onClick={(d: ChartDatum) => {
              const nm = datumField(d, "name");
              if (nm) navigate(`/skill/${encodeURIComponent(nm)}`);
            }}
          />
        </RankedBars>
      )}
    </ChartCard>
  );
}

export function SubagentFanout({ hidden, bd, expand }: ChartProps) {
  const { C, tooltipStyle, axisProps } = useChartTokens();
  const total = bd?.subagent_fanout.by_type.length ?? 0;
  return (
    <ChartCard
      title="Subagent fan-out"
      guide={
        <>
          <p>Which kinds of subagent got spawned, and how often.</p>
          <dl>
            <dt>bar length</dt>
            <dd>number of spawns of that agent type.</dd>
          </dl>
          <p>
            Counted from the spawning side and <strong>main sessions only</strong>, so a subagent that
            spawns its own children cannot inflate the total. The subtitle carries the per-session
            average and the busiest single session.
          </p>
        </>
      }
      hint={
        bd
          ? `${bd.subagent_fanout.total_spawns} spawns · ${bd.subagent_fanout.sessions_with_subagents} sessions · avg ${bd.subagent_fanout.avg_per_session}, max ${bd.subagent_fanout.max_per_session}`
          : undefined
      }
      actions={expand.expandBtn("subagents", total)}
      bodyHeight={expand.expandHeight("subagents", total, 28)}
      hidden={hidden}
    >
      {bd && total === 0 ? (
        <div className="empty">No subagents spawned in range.</div>
      ) : (
        <RankedBars
          data={expand.topN(bd?.subagent_fanout.by_type ?? [], "subagents")}
          yAxis={<YAxis type="category" dataKey="type" {...axisProps} width={120} />}
        >
          <Tooltip {...tooltipStyle} />
          <Bar dataKey="n" fill={C.accent} />
        </RankedBars>
      )}
    </ChartCard>
  );
}
