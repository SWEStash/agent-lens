/**
 * Shared list pager: Prev/Next plus a page-number dropdown for jumping straight to a page when there
 * are many (dozens) of them. Page-agnostic — the caller owns how a page change maps to its data
 * (server offset for Sessions, an in-memory slice for Skills). 1-indexed pages.
 */
export function Pager({
  page,
  pages,
  total,
  unit,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  unit: string;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <span className="muted">
        page {page} / {pages} · {total} {unit}
      </span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
      {pages > 1 && (
        <label className="page-jump">
          <span className="sr-only">Jump to page</span>
          <select value={page} onChange={(e) => onPage(Number(e.target.value))}>
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <option key={p} value={p}>
                page {p} / {pages}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
