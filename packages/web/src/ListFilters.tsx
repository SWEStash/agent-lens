import { useState } from "react";
import type { Project, Source } from "./api";
import { FilterSelect } from "./FilterSelect";
import { projectLabel } from "./format";

/** The list pages' search form: type, submit to apply, and a clear button once a search is active.
 * The input is local until submitted, so typing never refetches. */
export function SearchBox({ q, onSearch, label, placeholder }: { q: string; onSearch: (q: string) => void; label: string; placeholder: string }) {
  const [input, setInput] = useState(q);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(input.trim());
      }}
      className="search"
      role="search"
    >
      <input type="search" aria-label={label} placeholder={placeholder} value={input} onChange={(e) => setInput(e.target.value)} />
      <button type="submit">Search</button>
      {q && (
        <button type="button" className="ghost" onClick={() => (setInput(""), onSearch(""))}>
          clear
        </button>
      )}
    </form>
  );
}

/** Source filter. `counts` appends each source's session count — only meaningful on a sessions list. */
export function SourceSelect({ value, sources, onChange, counts = false }: { value: string; sources: Source[]; onChange: (v: string) => void; counts?: boolean }) {
  return (
    <select aria-label="Filter by source" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">all sources</option>
      {sources.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
          {counts ? ` (${s.session_count})` : ""}
        </option>
      ))}
    </select>
  );
}

/** Searchable project filter, labelled by project basename. `counts` as for SourceSelect. */
export function ProjectSelect({ value, projects, onChange, counts = false }: { value: string; projects: Project[]; onChange: (v: string) => void; counts?: boolean }) {
  return (
    <FilterSelect
      ariaLabel="Filter by project"
      searchPlaceholder="Find project…"
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: "all projects" },
        ...projects.map((p) => ({ value: p.id, label: counts ? `${projectLabel(p.path)} (${p.session_count})` : projectLabel(p.path) })),
      ]}
    />
  );
}
