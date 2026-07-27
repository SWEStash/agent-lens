/** Routes one tool call to its renderer, and answers whether it renders at all under the
 * hide-tools toggle. The rich cards (plan, Q&A, workflow launch) always show; the rest are chips. */
import type { ToolCall } from "../../api";
import { parseBashInput, parseEditInput, parsePlan } from "../parse";
import { ToolFindings } from "../Findings";
import { ToolChip } from "./ToolChip";
import { PlanBlock } from "./PlanBlock";
import { AskUserQuestionBlock } from "./AskUserQuestionBlock";
import { WorkflowLaunchBlock } from "./WorkflowLaunchBlock";
import { BashBlock } from "./BashBlock";
import { EditBlock } from "./EditBlock";

/** One tool call, routed to its renderer: approved plans, AskUserQuestion, and Workflow launches get
 * rich cards (always shown); Bash gets a shell-console card and Edit/MultiEdit/Write a colored diff;
 * every other tool is a generic chip that the "hide tool messages" toggle can suppress. */
export function ToolRender({ t, hideTools }: { t: ToolCall; hideTools: boolean }) {
  const findings = t.findings ?? [];
  // A flagged tool is always worth showing: findings override the "hide tool messages" toggle so a
  // risky command is never hidden behind it (the security signal is the whole point).
  const hide = hideTools && findings.length === 0;
  const inner = renderToolInner(t, hide);
  if (findings.length === 0) return inner;
  return (
    <>
      {inner}
      <ToolFindings findings={findings} />
    </>
  );
}

/** The tool card itself, routed to its renderer (no findings). Returns null when the current toggle
 * hides it. */
function renderToolInner(t: ToolCall, hide: boolean) {
  if (t.tool_name === "ExitPlanMode") {
    const plan = parsePlan(t.input_json);
    if (plan) return <PlanBlock plan={plan} />;
  }
  if (t.tool_name === "AskUserQuestion") return <AskUserQuestionBlock t={t} />;
  if (t.tool_name === "Workflow") return <WorkflowLaunchBlock t={t} />;
  if (t.tool_name === "Bash") {
    const bash = parseBashInput(t.input_json);
    if (bash) return hide ? null : <BashBlock t={t} bash={bash} />;
  }
  if (t.tool_name === "Edit" || t.tool_name === "MultiEdit" || t.tool_name === "Write") {
    const edit = parseEditInput(t.tool_name, t.input_json);
    if (edit) return hide ? null : <EditBlock t={t} edit={edit} />;
  }
  return hide ? null : <ToolChip t={t} />;
}

/** Whether a tool call renders anything under the current toggle — Plans/Q&A/Workflow launches always
 * do; generic chips only when tools aren't hidden. Used so an event with nothing left to show
 * collapses away entirely. */
export function toolVisible(t: ToolCall, hideTools: boolean): boolean {
  if (t.findings && t.findings.length) return true; // flagged tools always show (see ToolRender)
  if (t.tool_name === "AskUserQuestion") return true;
  if (t.tool_name === "Workflow") return true;
  if (t.tool_name === "ExitPlanMode" && parsePlan(t.input_json)) return true;
  return !hideTools;
}
