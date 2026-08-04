import { useDetailsAutoClose } from "../useOutsideClick";

export interface StripItem {
  id: string;
  label: string;
}

/**
 * Gear menu for one dashboard strip: a checkbox per entry to show/hide it, plus ↑/↓ to reorder.
 * Shares the Sessions column customizer's `.col-customizer`/`.col-menu` chrome and its native
 * `<details>` (keyboard and focus behaviour for free).
 *
 * Reordering is buttons, not drag: it works from the keyboard and on touch without a dependency, and a
 * pointer drag would need exactly this as its accessible alternative anyway.
 *
 * `items` arrives already ordered, and lists hidden entries too — moving operates on the full strip, so
 * a hidden neighbour never makes one click look like it skipped a place.
 */
export function StripCustomizer({
  label,
  items,
  hidden,
  onToggle,
  onMove,
}: {
  label: string;
  items: readonly StripItem[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string, visible: boolean) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const ref = useDetailsAutoClose();
  return (
    <details className="col-customizer" ref={ref}>
      <summary aria-label={`Customize ${label.toLowerCase()}`} title={`Show, hide and reorder ${label.toLowerCase()}`}>
        ⚙
      </summary>
      <div className="col-menu strip-menu" role="group" aria-label={`Customize ${label.toLowerCase()}`}>
        {items.map((it, i) => (
          <div className="strip-row" key={it.id}>
            <label>
              <input type="checkbox" checked={!hidden.has(it.id)} onChange={(e) => onToggle(it.id, e.target.checked)} />
              {it.label}
            </label>
            <button type="button" className="move" aria-label={`Move ${it.label} up`} disabled={i === 0} onClick={() => onMove(it.id, -1)}>
              ↑
            </button>
            <button
              type="button"
              className="move"
              aria-label={`Move ${it.label} down`}
              disabled={i === items.length - 1}
              onClick={() => onMove(it.id, 1)}
            >
              ↓
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
