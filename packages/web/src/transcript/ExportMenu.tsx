import { exportUrl } from "../api";
import { useDetailsAutoClose } from "../useOutsideClick";

/** Export-to-Markdown control. A <details> menu (shares the `.col-customizer`/`.col-menu` styles)
 * offering the redacted default, an aggressive structure-only scrub, and an explicit verbatim
 * opt-out. Redaction is best-effort — the exported file carries that disclaimer. */
export function ExportMenu({ id }: { id: string }) {
  const ref = useDetailsAutoClose();
  return (
    <details className="export-menu col-customizer" ref={ref}>
      <summary className="export" title="Export this session as Markdown">⬇ Export Markdown</summary>
      <div className="col-menu" role="group" aria-label="Export options">
        <a href={exportUrl(id)} download>Redacted <span className="muted small">(secrets masked)</span></a>
        <a href={exportUrl(id, "structure")} download>Structure only <span className="muted small">(scrubbed)</span></a>
        <a className="export-verbatim" href={exportUrl(id, "off")} download>Verbatim <span className="muted small">(unredacted)</span></a>
      </div>
    </details>
  );
}
