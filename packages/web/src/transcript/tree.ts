/** Directory-tree shaping for the transcript's "files changed" panel. Pure, no JSX — see tree.test.ts. */
import type { FileChangeRow } from "../api";

/** One node of the files-changed tree: subdirectories + the files sitting directly in it. */
export interface FileTreeNode {
  dirs: Map<string, FileTreeNode>;
  files: Array<{ name: string; path: string; list: FileChangeRow[] }>;
}

/** Build a directory tree from per-file change lists (display paths), then compress single-child
 * directory chains (`src` → `components` with nothing else becomes one `src/components` row) so the
 * tree stays shallow. Out-of-project files keep their absolute path — their leading `/` segment
 * makes them visibly absolute in the tree. */
export function buildFileTree(
  entries: Array<{ display: string; path: string; list: FileChangeRow[] }>,
): FileTreeNode {
  const root: FileTreeNode = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const abs = e.display.startsWith("/");
    const segs = (abs ? e.display.slice(1) : e.display).split("/");
    if (abs && segs.length > 0) segs[0] = "/" + segs[0];
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      node = node.dirs.get(seg) ?? node.dirs.set(seg, { dirs: new Map(), files: [] }).get(seg)!;
    }
    node.files.push({ name: segs[segs.length - 1], path: e.path, list: e.list });
  }
  const compress = (node: FileTreeNode) => {
    for (const [name, child] of [...node.dirs.entries()]) {
      compress(child);
      if (child.files.length === 0 && child.dirs.size === 1) {
        const [subName, sub] = [...child.dirs.entries()][0];
        node.dirs.delete(name);
        node.dirs.set(name + "/" + subName, sub);
      }
    }
  };
  compress(root);
  return root;
}
