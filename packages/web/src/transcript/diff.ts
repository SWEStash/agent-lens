/** Line-level diffing for the transcript's Edit renderer. Pure, no JSX — see diff.test.ts. */

export type DiffLine = { type: "ctx" | "add" | "del"; text: string };

/** Line-level LCS diff between two strings — the basis for rendering an Edit as a +/- diff with
 * unchanged context lines kept. Guards against pathological cost on very large edits by falling back to
 * a delete-all + add-all rendering. */
export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr === "" ? [] : oldStr.split("\n");
  const b = newStr === "" ? [] : newStr.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 250000)
    return [...a.map((t) => ({ type: "del" as const, text: t })), ...b.map((t) => ({ type: "add" as const, text: t }))];
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push({ type: "ctx", text: a[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) (out.push({ type: "del", text: a[i] }), i++);
    else (out.push({ type: "add", text: b[j] }), j++);
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}
