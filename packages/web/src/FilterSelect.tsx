import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * An accessible, type-to-filter dropdown — a drop-in replacement for a native `<select>` when the
 * option list is long enough that scanning it is painful (e.g. the project filter, which grows with
 * every project ever ingested). Closed, it's a button showing the current selection; open, it reveals
 * a search box that substring-filters the options plus a listbox navigable by keyboard (↑/↓/Enter/Esc)
 * or mouse. Options include the "all …" entry (value ""), so clearing is just selecting it.
 *
 * Follows the WAI-ARIA combobox-with-listbox pattern: the input is `role=combobox`, the popup is a
 * `role=listbox`, and the active option is tracked via `aria-activedescendant` (no roving tabindex).
 */
export function FilterSelect({
  value,
  options,
  onChange,
  ariaLabel,
  searchPlaceholder = "Filter…",
}: {
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optId = (i: number) => `${listId}-opt-${i}`;

  const selected = options.find((o) => o.value === value) ?? options[0] ?? { value: "", label: "" };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // On open: focus the search box and highlight the current selection.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    const i = filtered.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
    // filtered is recomputed from the (empty) query on open; value is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the active index in range as the filter narrows.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  function choose(opt: FilterOption | undefined) {
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="filter-select" ref={rootRef}>
      <button
        type="button"
        className="filter-select-btn"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={"filter-select-value" + (selected.value ? "" : " muted")}>{selected.label}</span>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="filter-select-pop">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered.length ? optId(active) : undefined}
            aria-label={ariaLabel}
            className="filter-select-search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul className="filter-select-list" role="listbox" id={listId} aria-label={ariaLabel}>
            {filtered.length === 0 ? (
              <li className="filter-select-empty muted" role="presentation">
                No matches
              </li>
            ) : (
              filtered.map((o, i) => (
                <li
                  key={o.value || "__all__"}
                  id={optId(i)}
                  role="option"
                  aria-selected={o.value === value}
                  className={"filter-select-opt" + (i === active ? " is-active" : "") + (o.value === value ? " is-selected" : "")}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus; select on mousedown before blur closes the popup
                    choose(o);
                  }}
                >
                  {o.value ? o.label : <span className="muted">{o.label}</span>}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
