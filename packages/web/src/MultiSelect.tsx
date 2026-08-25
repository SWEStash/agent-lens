import { useDetailsAutoClose } from "./useOutsideClick";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/** What the button at the bottom of the panel does — and, because it restores the control's default,
 *  what counts as "not filtering". Both the count badge and the button itself appear only while the
 *  selection differs from `to`. */
export interface MultiSelectReset {
  label: string;
  to: string[];
}

/** A control whose default is nothing ticked: an empty selection is the no-filter state. */
const CLEAR: MultiSelectReset = { label: "clear", to: [] };

const sameSelection = (a: string[], b: string[]) => a.length === b.length && b.every((v) => a.includes(v));

/**
 * A labeled multi-select filter: a <details> dropdown of checkboxes. Mirrors the column-customizer
 * dropdown (shares the `.col-menu` panel styles).
 *
 * Two opposite conventions share this component, which is why the default state is a prop rather
 * than baked in. The session filters default to nothing ticked, where empty means "no filter". The
 * dashboard's model filter defaults to everything ticked, where empty would mean "admit nothing" —
 * so passing `reset` is what stops a control from reading its own default as a narrowing.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  reset = CLEAR,
  disabled,
  title,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  reset?: MultiSelectReset;
  /** Renders the control inert, for a surface that cannot honour the filter (the static snapshot). */
  disabled?: boolean;
  title?: string;
}) {
  function toggle(value: string, on: boolean) {
    const set = new Set(selected);
    if (on) set.add(value);
    else set.delete(value);
    // Preserve the option order so URL state is stable regardless of click order.
    onChange(options.map((o) => o.value).filter((v) => set.has(v)));
  }
  const ref = useDetailsAutoClose();
  const atDefault = sameSelection(selected, reset.to);
  // A selection of nothing is not offered: it admits no data, and every encoding of it collides with
  // the empty parameter that means "no filter". The last ticked box therefore stays ticked, and the
  // reset button is the way back.
  const last = (value: string) => selected.length === 1 && selected[0] === value && reset.to.length > 0;
  return (
    <details className="multi-select" ref={ref} title={title}>
      <summary aria-label={label}>
        {label}
        {atDefault ? "" : ` (${selected.length})`} ▾
      </summary>
      <div className="col-menu" role="group" aria-label={label}>
        {options.map((o) => (
          <label key={o.value}>
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              disabled={disabled || last(o.value)}
              onChange={(e) => toggle(o.value, e.target.checked)}
            />
            {o.label}
          </label>
        ))}
        {!atDefault && (
          <button type="button" className="ghost small ms-clear" onClick={() => onChange(reset.to)}>
            {reset.label}
          </button>
        )}
      </div>
    </details>
  );
}
