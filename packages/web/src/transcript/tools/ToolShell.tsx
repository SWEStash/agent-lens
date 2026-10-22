import { useId, useState, type ReactNode } from "react";
import type { ToolCall } from "../../api";
import { fmtBytes, fmtDuration } from "../../format";
import { prettyJson } from "../../jsonish";
import CopyButton from "../../CopyButton";

/**
 * The collapsible container every transcript tool block shares: the header button (name, the block's
 * own header facts, status, duration, chevron), anything that shows even while collapsed (`links`),
 * and, when open, the block's body followed by the result, the full-result disclosure and, for blocks
 * that render their input in their own form, the raw input JSON behind a toggle.
 */
export function ToolShell({
  t,
  name,
  head,
  links,
  children,
  result = "prose",
  rawJson = false,
}: {
  t: ToolCall;
  /** The tool's icon + name, the first thing in the header. */
  name: ReactNode;
  /** Extra header content after the name; gets `open` for collapsed-only previews. */
  head?: (open: boolean) => ReactNode;
  links?: ReactNode;
  /** The block's own body, shown when open, above the result. */
  children?: ReactNode;
  /** The result summary as prose, or as console output under a command. */
  result?: "prose" | "shell";
  rawJson?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">{name}</span>
        {head?.(open)}
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {links}
      {open && (
        <div className="tool-body" id={bodyId}>
          {children}
          {t.result_summary &&
            (result === "shell" ? <pre className="shell-out">{t.result_summary}</pre> : <div className="result">{t.result_summary}</div>)}
          {t.full_result && <FullResult full={t.full_result} />}
          {rawJson && <RawJson json={t.input_json} />}
        </div>
      )}
    </div>
  );
}

function FullResult({ full }: { full: { text: string; bytes: number } }) {
  const [show, setShow] = useState(false);
  return (
    <div className="full-result">
      <button type="button" className="ghost small show-full" aria-expanded={show} onClick={() => setShow((s) => !s)}>
        {show ? "Hide" : "Show"} full result ({fmtBytes(full.bytes)})
      </button>
      {show && (
        <div className="code-block">
          <CopyButton text={full.text} className="copy-corner" title="Copy full tool result" />
          <pre className="code">{full.text}</pre>
        </div>
      )}
    </div>
  );
}

function RawJson({ json }: { json: string | null }) {
  const [raw, setRaw] = useState(false);
  const rawId = useId();
  const pretty = prettyJson(json ?? "{}");
  return (
    <>
      <div className="launch-actions">
        <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
          {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
        </button>
        <CopyButton text={pretty} label="JSON" title="Copy raw tool input JSON" />
      </div>
      {raw && (
        <pre id={rawId} className="code">
          {pretty}
        </pre>
      )}
    </>
  );
}
