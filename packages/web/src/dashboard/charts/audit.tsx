import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { ChartCard, useChartTokens } from "../../charts/theme";
import { CHART_MARGIN, RankedBars, Y_AXIS_W, unitLabel, useBarsFit, type ChartProps } from "./common";

/**
 * The four audit tiles (ADR-036) — how the work went, all fed by `/api/dashboard/audit`.
 *
 * None of them is an efficiency measure and none may become one. The corpus analysis behind this
 * endpoint tested the obvious framings — tokens per line of churn, a composite "struggle" score over
 * errors and rework — and they are respectively sign-inverted and flat. What is left is descriptive:
 * counts the reader interprets, with the confounds named in the guide rather than adjusted away.
 */

/** Severity stacking order, least to most severe, so the worst band sits on top of the stack. */
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const pct1 = (v: number) => `${v.toFixed(1)}%`;

/**
 * Share of file-writing calls that came back as an error, by the model that issued them.
 *
 * Ordered by call volume, not by failure rate: rate-ordering puts whichever model made nine calls at
 * the top of the chart, and the ranking a reader takes from a bar chart is the one that matters. The
 * sample size travels with every bar in the tooltip for the same reason.
 */
export function EditReliability({ hidden, audit }: ChartProps) {
  const { C, axisProps, tooltipStyle } = useChartTokens();
  const data = (audit?.edit_reliability ?? []).map((r) => ({
    name: r.model,
    rate: pct(r.errors, r.calls),
    calls: r.calls,
    errors: r.errors,
  }));
  return (
    <ChartCard
      title="Edit failures by model"
      hint="share of Edit/Write/NotebookEdit calls that errored · ordered by call volume"
      guide={
        <>
          <p>How often a model's attempt to write a file came back as an error.</p>
          <dl>
            <dt>bar length</dt>
            <dd>errored calls as a share of that model's file-writing calls.</dd>
            <dt>rows</dt>
            <dd>one per model, ordered by how many such calls it made.</dd>
          </dl>
          <p>
            A failed Edit usually means the model got the file's existing contents wrong, so this is a{" "}
            <strong>capability signal</strong> rather than a speed one. Both main and subagent sessions
            count — a subagent's edits are real edits.
          </p>
          <p>
            <strong>Confounded by era and task mix.</strong> Older models ran on older sessions doing
            different work, so read this within a date range rather than as a standing leaderboard. The
            model comes from the event that issued the call.
          </p>
        </>
      }
      hidden={hidden}
    >
      <RankedBars
        data={data}
        left={8}
        xAxisProps={{ tickFormatter: (v: number) => `${v}%` }}
        yAxis={<YAxis type="category" dataKey="name" {...axisProps} width={150} />}
      >
        <Tooltip
          {...tooltipStyle}
          formatter={(v: number, _n: string, p: { payload?: { calls: number; errors: number } }) =>
            [`${pct1(v)} — ${p.payload?.errors ?? 0} of ${(p.payload?.calls ?? 0).toLocaleString()} calls`, "failure rate"]
          }
        />
        <Bar dataKey="rate" fill={C.red} />
      </RankedBars>
    </ChartCard>
  );
}

/**
 * How often the user sent a plan or a question back, per bucket.
 *
 * A bucket with no calls of a kind plots as a gap rather than as 0%, so the line does not claim a
 * perfect week that simply had no plans in it.
 */
export function PlanRejections({ hidden, audit }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = (audit?.plan_rejections ?? []).map((r) => ({
    bucket: r.bucket,
    plans: r.plan_calls ? pct(r.plan_rejected, r.plan_calls) : null,
    questions: r.question_calls ? pct(r.question_rejected, r.question_calls) : null,
    plan_calls: r.plan_calls,
    question_calls: r.question_calls,
  }));
  return (
    <ChartCard
      title="Plans & questions sent back"
      hint="main sessions only · a bucket with none of that kind plots as a gap, not as 0%"
      guide={
        <>
          <p>Share of plans and questions put to you that you rejected rather than approved.</p>
          <dl>
            <dt>x-axis</dt>
            <dd>time bucket — day, week or month.</dd>
            <dt>y-axis</dt>
            <dd>rejected as a percentage of that bucket's calls of that kind.</dd>
          </dl>
          <p>
            This is <strong>alignment measured at the cheapest possible moment</strong> — before the
            work happens. A rising line means briefs are getting worse or the model is drifting;
            nothing here says a rejection was wrong, and a healthy rate is not zero.
          </p>
          <p>
            <strong>Not the same number as the rejection-rate KPI.</strong> That one is every rejected
            or blocked tool call over every tool call, a far larger denominator. This counts only
            ExitPlanMode and AskUserQuestion, and only where the result was recorded as a user
            rejection rather than a genuine failure.
          </p>
          <p>
            <strong>Main sessions only</strong>, and the model filter attributes each call to the event
            that issued it — a subagent has no human to reject it.
          </p>
        </>
      }
      hidden={hidden}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={Y_AXIS_W} tickFormatter={(v: number) => `${v}%`} label={unitLabel("rejected", C.muted)} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => pct1(v)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="plans" name="plans" stroke={C.violet} dot={false} strokeWidth={2} connectNulls={false} />
          <Line type="monotone" dataKey="questions" name="questions" stroke={C.accent} dot={false} strokeWidth={2} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/**
 * How often a session goes back to the same file, as a histogram over (session, file) pairs.
 *
 * Both series are plotted because they answer different questions and disagree: most pairs are edited
 * once, while a large share of all edits land on files that were already edited many times.
 */
export function FileRework({ hidden, audit }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = audit?.file_rework ?? [];
  return (
    <ChartCard
      title="Repeat edits per file"
      hint="(session, file) pairs banded by how many times that session touched that file"
      guide={
        <>
          <p>How often a session came back to a file it had already edited.</p>
          <dl>
            <dt>x-axis</dt>
            <dd>times that session touched that file — 1, 2–3, 4–6, 7–12, 13+.</dd>
            <dt>y-axis</dt>
            <dd>two counts per band: the number of (session, file) pairs in it, and the number of
              individual edits those pairs account for.</dd>
          </dl>
          <p>
            The two series disagree on purpose. Most pairs sit in the left band, while a large share of
            all edits lands in the right ones — a small number of files absorbing a lot of rework.
          </p>
          <p>
            <strong>A count and a list, never a score.</strong> Rework was tested against session cost
            in both directions and the relationship is flat; it correlates with total tokens only
            because bigger sessions edit more files. Both populations count, and the model filter
            attributes each edit to the event that made it.
          </p>
        </>
      }
      hidden={hidden}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data as object[]} margin={CHART_MARGIN}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="band" {...axisProps} />
          <YAxis {...axisProps} width={44} allowDecimals={false} label={unitLabel("count", C.muted)} />
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="pairs" name="file/session pairs" fill={C.teal} />
          <Bar dataKey="changes" name="edits they account for" fill={C.gold} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/**
 * Security findings per bucket, stacked by severity — the dashboard's only security chart.
 *
 * The /security page remains the surface for reading individual findings; a trend is the one thing
 * that page cannot show, which is what makes a single chart here worth the exception.
 */
export function FindingsOverTime({ hidden, audit }: ChartProps) {
  const { C, SEVERITY_COLORS, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = audit?.findings_over_time ?? [];
  const [ref, asBars] = useBarsFit(data.length);
  const common = (
    <>
      <CartesianGrid {...gridProps} />
      <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
      <YAxis {...axisProps} width={Y_AXIS_W} allowDecimals={false} label={unitLabel("findings", C.muted)} />
      <Tooltip {...tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  );
  return (
    <ChartCard
      title="Findings over time"
      hint="detector findings per bucket, stacked by severity · dated by the finding, not its session"
      guide={
        <>
          <p>Security findings the detector raised, over time and by severity.</p>
          <dl>
            <dt>x-axis</dt>
            <dd>time bucket — day, week or month.</dd>
            <dt>y-axis</dt>
            <dd>findings raised in that bucket, stacked with the most severe on top.</dd>
          </dl>
          <p>
            <strong>Dated by the finding's own moment</strong>, not by when its session started — the
            only series on this dashboard that is. A finding belongs to the tool call that triggered
            it, and a long session can raise one hours after it began.
          </p>
          <p>
            A rising low-severity band is usually the detector getting better, not the work getting
            worse; a new critical is the line worth reading. Both populations count. Individual
            findings, their evidence and their mute state live on the Security page.
          </p>
        </>
      }
      hidden={hidden}
    >
      <div ref={ref} style={{ width: "100%", height: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          {asBars ? (
            <BarChart data={data as object[]} margin={CHART_MARGIN}>
              {common}
              {SEVERITIES.map((s) => (
                <Bar key={s} dataKey={s} name={s} stackId="f" fill={SEVERITY_COLORS[s]} />
              ))}
            </BarChart>
          ) : (
            <AreaChart data={data as object[]} margin={CHART_MARGIN}>
              {common}
              {SEVERITIES.map((s) => (
                <Area key={s} dataKey={s} name={s} stackId="f" stroke="none" fill={SEVERITY_COLORS[s]} fillOpacity={1} />
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
