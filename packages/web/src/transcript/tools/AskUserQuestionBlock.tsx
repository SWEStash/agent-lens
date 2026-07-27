import { useId, useState } from "react";
import type { ToolCall } from "../../api";
import { prettyJson } from "../../jsonish";
import CopyButton from "../../CopyButton";
import { parseAnswers, parseQuestions } from "../parse";
import { ToolChip } from "./ToolChip";

/** Render an AskUserQuestion exchange as the questions it posed, each option shown, the user's
 * selection(s) checked, custom ("Other") answers surfaced, and any written notes — with the raw JSON
 * one click away for advanced users. Far more legible than the raw tool-input JSON block. */
export function AskUserQuestionBlock({ t }: { t: ToolCall }) {
  const [raw, setRaw] = useState(false);
  const rawId = useId();
  const questions = parseQuestions(t.input_json);
  const { answers, annotations } = parseAnswers(t.result_summary);
  if (questions.length === 0) return <ToolChip t={t} />; // no question data → fall back to the chip
  return (
    <div className="qa-card">
      <div className="qa-card-head">🙋 Question{questions.length === 1 ? "" : "s"} for the user</div>
      {questions.map((q, qi) => {
        const ans = answers[q.question];
        const chosen = Array.isArray(ans) ? ans : ans != null ? [ans] : [];
        const chosenSet = new Set(chosen);
        const optionLabels = new Set(q.options.map((o) => o.label));
        const customs = chosen.filter((c) => !optionLabels.has(c));
        const note = annotations[q.question]?.notes;
        return (
          <div key={qi} className="qa-q">
            <div className="qa-q-head">
              {q.header && <span className="tag">{q.header}</span>}
              {q.multiSelect && <span className="muted small">multi-select</span>}
            </div>
            <div className="qa-question">{q.question}</div>
            <ul className="qa-options">
              {q.options.map((o, oi) => {
                const sel = chosenSet.has(o.label);
                return (
                  <li key={oi} className={"qa-opt" + (sel ? " is-selected" : "")}>
                    <span className="qa-mark" aria-hidden="true">{sel ? "☑" : "☐"}</span>
                    <span className="qa-opt-body">
                      <span className="qa-opt-label">{o.label}</span>
                      {o.description && <span className="qa-opt-desc muted">{o.description}</span>}
                    </span>
                  </li>
                );
              })}
              {customs.map((c, ci) => (
                <li key={"c" + ci} className="qa-opt is-selected">
                  <span className="qa-mark" aria-hidden="true">☑</span>
                  <span className="qa-opt-body">
                    <span className="qa-opt-label">{c}</span>
                    <span className="qa-opt-desc muted">custom answer</span>
                  </span>
                </li>
              ))}
            </ul>
            {note && <div className="qa-note">📝 {note}</div>}
          </div>
        );
      })}
      <div className="launch-actions">
        <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
          {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
        </button>
        <CopyButton
          text={prettyJson(t.input_json ?? "{}") + (t.result_summary ? "\n\n" + prettyJson(t.result_summary) : "")}
          label="JSON"
          title="Copy raw question JSON"
        />
      </div>
      {raw && (
        <pre id={rawId} className="code">
          {prettyJson(t.input_json ?? "{}")}
          {t.result_summary ? "\n\n" + prettyJson(t.result_summary) : ""}
        </pre>
      )}
    </div>
  );
}
