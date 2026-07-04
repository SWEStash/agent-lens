import { useState } from "react";
import ResultView from "./ResultView";
import CopyButton from "./CopyButton";
import { decodeEntities, deepParse, looseParse, prettyJson, splitTruncation } from "./jsonish";

/** Render a Workflow launch payload (the Workflow tool's `input_json`) as readable structure instead
 * of a truncated JSON dump. The payload is an object of launch metadata (scriptPath / script /
 * description) around a task list passed as a JSON-encoded *string* under `args`; we deep-parse that
 * string, surface the metadata compactly, and render each task as its own card. Unrecognized shapes
 * fall back to the generic browsable ResultView, and the raw JSON stays one click away. */

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isPrim = (v: unknown): boolean => v === null || typeof v !== "object";

/** Metadata keys handled specially (not treated as the task list); everything else scalar shows as a
 * key/value line. */
const META_KEYS = new Set(["script", "scriptPath", "description"]);
/** Fields preferred as a task card's title, in order. */
const TITLE_KEYS = ["skill", "name", "id", "title"];

function FieldValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if (typeof v === "string") return <span className="launch-text">{v}</span>;
  if (isPrim(v)) return <span className="json-number">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (v.every(isPrim))
      return (
        <ol className="launch-list">
          {v.map((x, i) => (
            <li key={i}>{x === null ? "—" : String(x)}</li>
          ))}
        </ol>
      );
    return <ResultView value={v} />;
  }
  return <ResultView value={v} />;
}

/** One task in the launch's task list, rendered as a titled card with each field labeled — the long
 * prompt reads as a paragraph and string-array fields (e.g. assertions) as a numbered list. */
function TaskCard({ rec, index }: { rec: Record<string, unknown>; index: number }) {
  const titleKey = TITLE_KEYS.find((k) => typeof rec[k] === "string");
  const title = titleKey ? String(rec[titleKey]) : `task ${index + 1}`;
  const fields = Object.entries(rec).filter(([k]) => k !== titleKey);
  return (
    <div className="launch-card">
      <div className="launch-card-head">
        <span className="launch-card-idx">{index + 1}</span>
        <span className="launch-card-title">{title}</span>
      </div>
      <dl className="launch-fields">
        {fields.map(([k, v]) => (
          <div className="launch-field" key={k}>
            <dt>{k}</dt>
            <dd>
              <FieldValue v={v} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function LaunchView({ raw }: { raw: string }) {
  const [showRaw, setShowRaw] = useState(false);

  const { body, note } = splitTruncation(decodeEntities(raw));
  const { value, repaired } = looseParse(body);
  if (value === undefined) {
    // Not parseable as JSON — show verbatim so nothing is lost.
    return (
      <div className="launch">
        <pre className="code">{raw}</pre>
      </div>
    );
  }
  const parsed = deepParse(value);
  // Split the payload once into: launch metadata (scalars — script/scriptPath/description get
  // dedicated treatment, the rest show as key/value lines) and container fields (arrays/objects,
  // rendered below). Non-object payloads (a bare array/scalar) render entirely as one container.
  const entries: [string, unknown][] = isObj(parsed) ? Object.entries(parsed) : [["", parsed]];
  // `script` is a long source blob shown as a collapsible, so it belongs to neither list.
  const scalars = entries.filter(([k, v]) => isPrim(v) && k !== "script");
  const containers = entries.filter(([, v]) => !isPrim(v));

  const scriptSrc = isObj(parsed) && typeof parsed.script === "string" ? parsed.script : null;
  const scriptPath = isObj(parsed) && typeof parsed.scriptPath === "string" ? parsed.scriptPath : null;
  const description = isObj(parsed) && typeof parsed.description === "string" ? parsed.description : null;
  const otherScalars = scalars.filter(([k]) => !META_KEYS.has(k));
  const hasMeta = description || scriptPath || scriptSrc || otherScalars.length > 0;

  const isTaskList = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every(isObj);

  return (
    <div className="launch">
      {hasMeta && (
        <div className="launch-meta">
          {description && <div className="launch-desc">{description}</div>}
          {scriptPath && (
            <div className="launch-metaline">
              <span className="muted">script</span> <code>{scriptPath}</code>
            </div>
          )}
          {otherScalars.map(([k, v]) => (
            <div className="launch-metaline" key={k}>
              <span className="muted">{k}</span> <code>{String(v)}</code>
            </div>
          ))}
          {scriptSrc && (
            <details className="launch-src">
              <summary>script source · {scriptSrc.length.toLocaleString()} chars</summary>
              <pre className="code">{scriptSrc}</pre>
            </details>
          )}
        </div>
      )}

      {containers.map(([key, val]) =>
          isTaskList(val) ? (
            <div className="launch-tasks" key={key || "tasks"}>
              <div className="launch-tasks-head">
                {val.length} {key || (val.length === 1 ? "task" : "tasks")} <span className="muted">launched</span>
              </div>
              {val.map((rec, i) => (
                <TaskCard key={i} rec={rec} index={i} />
              ))}
            </div>
          ) : (
            <div className="launch-section" key={key || "value"}>
              {key && <div className="launch-tasks-head">{key}</div>}
              <ResultView value={val} />
            </div>
          ),
        )}

      {(note || repaired) && (
        <div className="muted small wf-trunc">
          ⚠ {note ?? "Payload was truncated; showing the recoverable portion."}
        </div>
      )}

      <div className="launch-actions">
        <button
          type="button"
          className="ghost small"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((r) => !r)}
        >
          {showRaw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
        </button>
        <CopyButton text={prettyJson(body)} label="JSON" title="Copy raw launch JSON" />
      </div>
      {showRaw && <pre className="code launch-raw">{prettyJson(body)}</pre>}
    </div>
  );
}
