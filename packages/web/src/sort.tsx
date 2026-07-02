import { useState } from "react";

/** Sort direction for a table column. */
export type SortDir = "asc" | "desc";

/** A comparable value pulled from a row. `null`/`undefined` always sort last, regardless of dir. */
export type SortValue = string | number | null | undefined;

/**
 * Stable sort of a row list by an accessor. Nulls sort last in both directions; numbers compare
 * numerically, strings case-insensitively (with numeric-aware collation so "v2" < "v10"). Returns a
 * new array — the input is left untouched. Used by the client-side-sorted list pages (e.g. Skills,
 * whose whole list is already in memory) so sorting spans the entire list, not just a page.
 */
export function sortRows<T>(rows: T[], get: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const va = get(a.row);
      const vb = get(b.row);
      if (va == null && vb == null) return a.i - b.i;
      if (va == null) return 1; // nulls last regardless of direction
      if (vb == null) return -1;
      const c =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
      return c !== 0 ? c * sign : a.i - b.i; // original order breaks ties → stable
    })
    .map((x) => x.row);
}

/** Local sort state with click-to-toggle: clicking the active column flips direction, clicking a new
 * column adopts its default direction. For client-side-sorted pages; server-sorted pages keep the
 * state in the URL instead. */
export function useSort<K extends string>(initialKey: K, initialDir: SortDir) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>({ key: initialKey, dir: initialDir });
  const toggle = (key: K, defaultDir: SortDir = "desc") =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir }));
  return { sort, toggle };
}

/**
 * A sortable table header cell. Renders a button so the whole header is keyboard-activatable, exposes
 * `aria-sort` for screen readers, and shows a direction caret when active (a neutral glyph otherwise).
 * Column-key agnostic (generic K) so both list pages share it.
 */
export function SortHeader<K extends string>({
  label,
  sortKey,
  active,
  dir,
  onSort,
  defaultDir = "desc",
  className,
}: {
  label: string;
  sortKey: K;
  active: K | null;
  dir: SortDir;
  onSort: (key: K, defaultDir: SortDir) => void;
  defaultDir?: SortDir;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <th className={className} aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={"sort-th" + (isActive ? " is-active" : "")} onClick={() => onSort(sortKey, defaultDir)}>
        <span>{label}</span>
        <span className="sort-ind" aria-hidden="true">
          {isActive ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}
