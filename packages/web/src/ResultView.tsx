import { useState } from "react";

/** Make sense of a workflow's returned JSON the way the Claude Code workflows TUI presents structured
 * data — a browsable view rather than a text dump:
 *   • an object of scalars  → a key/value metrics grid
 *   • an object whose values are all objects (a "map", e.g. per-case results) → a table keyed by name
 *   • an array of objects   → a table (columns = union of keys)
 *   • nested containers      → collapsible sections you drill into
 * Anything that doesn't fit those shapes falls back to an inline scalar/badge. */

const isPrim = (v: unknown): boolean => v === null || typeof v !== "object";
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function Scalar({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="json-null">—</span>;
  const t = typeof v;
  if (t === "boolean") return <span className={v ? "rv-true" : "rv-false"}>{v ? "✓ true" : "✗ false"}</span>;
  if (t === "number") return <span className="json-number">{String(v)}</span>;
  return <span className="rv-str">{String(v)}</span>;
}

/** A table cell: primitives inline; arrays of primitives joined; deeper structure as a dim badge. */
function Cell({ v }: { v: unknown }) {
  if (isPrim(v)) return <Scalar v={v} />;
  if (Array.isArray(v)) {
    if (v.every(isPrim)) return <span className="rv-str">{v.map(String).join(", ") || "—"}</span>;
    return <span className="muted">[{v.length}]</span>;
  }
  return <span className="muted">{`{${Object.keys(v as object).length}}`}</span>;
}

/** Union of object keys across rows, in first-seen order. */
function columns(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r ?? {})) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return cols;
}

function RowTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = columns(rows);
  return (
    <div className="rv-table-wrap">
      <table className="rv-table">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c}><Cell v={r[c]} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MapTable({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  const cols = columns(entries.map(([, v]) => v as Record<string, unknown>));
  return (
    <div className="rv-table-wrap">
      <table className="rv-table">
        <thead><tr><th>key</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td className="rv-rowkey">{k}</td>
              {cols.map((c) => <td key={c}><Cell v={(v as Record<string, unknown>)[c]} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const count = Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value as object).length}}`;
  return (
    <div className="rv-section">
      <button className="rv-sec-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="json-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="rv-sec-name">{name}</span>
        <span className="muted small">{count}</span>
      </button>
      {open && <div className="rv-sec-body"><Value value={value} depth={depth + 1} /></div>}
    </div>
  );
}

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (isPrim(value)) return <Scalar v={value} />;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">empty</span>;
    if (value.every(isObj)) return <RowTable rows={value as Record<string, unknown>[]} />;
    return <ul className="rv-list">{value.map((x, i) => <li key={i}><Cell v={x} /></li>)}</ul>;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="muted">empty</span>;
  // Object whose values are all objects → a map → render as one table keyed by name.
  if (entries.every(([, v]) => isObj(v))) return <MapTable obj={value as Record<string, unknown>} />;

  const scalars = entries.filter(([, v]) => isPrim(v));
  const containers = entries.filter(([, v]) => !isPrim(v));
  return (
    <div className="rv-obj">
      {scalars.length > 0 && (
        <div className="rv-metrics">
          {scalars.map(([k, v]) => (
            <div className="rv-metric" key={k}>
              <span className="rv-mkey">{k}</span>
              <span className="rv-mval"><Scalar v={v} /></span>
            </div>
          ))}
        </div>
      )}
      {containers.map(([k, v]) => <Section key={k} name={k} value={v} depth={depth} />)}
    </div>
  );
}

export default function ResultView({ value }: { value: unknown }) {
  return <div className="rv-root"><Value value={value} depth={0} /></div>;
}
