import { CUSTOM_VIEW, PRESETS } from "./presets";

/**
 * The dashboard view switcher. A segmented control, sharing `.format-toggle`'s styling (the transcript's
 * Markdown/Raw switch) — it is the same widget, so it should not look like a new one.
 *
 * Kept always visible on purpose: the active view persists across reloads, and a curated view that has
 * quietly hidden nine charts reads as "the charts are gone" unless something on screen says otherwise.
 *
 * The "Custom" entry appears only once the user has actually forked one, so the control never offers a
 * view that would be empty.
 */
export function PresetPills({ active, hasCustom, onSelect }: { active: string; hasCustom: boolean; onSelect: (view: string) => void }) {
  const views = [...PRESETS.map((p) => ({ id: p.id, label: p.label })), ...(hasCustom ? [{ id: CUSTOM_VIEW, label: "Custom" }] : [])];
  return (
    <div className="views view-toggle" role="group" aria-label="Dashboard view">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          className={"ghost" + (v.id === active ? " is-active" : "")}
          aria-pressed={v.id === active}
          onClick={() => onSelect(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
