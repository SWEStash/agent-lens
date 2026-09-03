/**
 * Shell-write extraction (ADR-022) — parseShellWrites in shellwrites.ts. Pure string → targets, so
 * these are plain unit tests over the command shapes the corpus actually contains: heredoc writes,
 * tee, sed -i, and echo/printf redirects. Imports the BUILT dist.
 */
import { describe, it, expect } from "vitest";
import { parseShellWrites } from "../dist/shellwrites.js";

const paths = (cmd: string) => parseShellWrites(cmd).writes.map((w) => w.path);

describe("parseShellWrites — write constructs", () => {
  it("extracts a heredoc write target", () => {
    expect(paths("cat > /proj/notes.md <<'EOF'\nhello\nEOF")).toEqual(["/proj/notes.md"]);
  });

  it("counts the heredoc body's lines as the written magnitude", () => {
    const { writes } = parseShellWrites("cat > /proj/a.md <<'EOF'\none\ntwo\nthree\nEOF");
    expect(writes[0].linesAdded).toBe(3);
  });

  it("leaves lines unknown for constructs that carry no body", () => {
    expect(parseShellWrites("sed -i 's/a/b/' /proj/x.ts").writes[0].linesAdded).toBeNull();
  });

  it("extracts tee targets, appending or not", () => {
    expect(paths("echo hi | tee /proj/out.txt")).toEqual(["/proj/out.txt"]);
    expect(paths("echo hi | tee -a /proj/out.txt")).toEqual(["/proj/out.txt"]);
  });

  it("extracts sed -i targets across its flag spellings", () => {
    expect(paths("sed -i 's/a/b/' /proj/x.ts")).toEqual(["/proj/x.ts"]);
    expect(paths("sed -i -e 's/a/b/' /proj/y.ts")).toEqual(["/proj/y.ts"]);
    expect(paths("sed -i.bak 's/a/b/' /proj/z.ts")).toEqual(["/proj/z.ts"]);
  });

  it("ignores sed without -i, which writes nothing", () => {
    expect(paths("sed 's/a/b/' /proj/x.ts")).toEqual([]);
  });

  it("extracts echo and printf redirects, truncating or appending", () => {
    expect(paths("echo hi > /proj/a.txt")).toEqual(["/proj/a.txt"]);
    expect(paths("printf 'hi\\n' >> /proj/b.txt")).toEqual(["/proj/b.txt"]);
  });

  it("handles quoted targets", () => {
    expect(paths(`cat > "/proj/my notes.md" <<'EOF'\nx\nEOF`)).toEqual(["/proj/my notes.md"]);
    expect(paths("echo hi > '/proj/a b.txt'")).toEqual(["/proj/a b.txt"]);
  });

  it("collects every write in a compound command", () => {
    expect(paths("echo a > /proj/one.txt && sed -i 's/x/y/' /proj/two.ts")).toEqual([
      "/proj/one.txt",
      "/proj/two.ts",
    ]);
  });

  it("reports each target once even when written repeatedly", () => {
    expect(paths("echo a > /proj/one.txt; echo b >> /proj/one.txt")).toEqual(["/proj/one.txt"]);
  });
});

describe("parseShellWrites — what must not count", () => {
  it("ignores redirects written inside a heredoc body", () => {
    const cmd = "cat > /proj/doc.md <<'EOF'\nRun `echo hi > /etc/passwd` to break things.\nEOF";
    expect(paths(cmd)).toEqual(["/proj/doc.md"]);
  });

  it("ignores /dev/null and other device sinks", () => {
    expect(paths("make 2> /dev/null")).toEqual([]);
    expect(paths("echo x > /dev/stderr")).toEqual([]);
  });

  it("ignores targets holding an unexpanded variable, glob or substitution", () => {
    expect(paths("echo x > $OUT")).toEqual([]);
    expect(paths("echo x > /proj/$name.txt")).toEqual([]);
    expect(paths("echo x > /proj/*.txt")).toEqual([]);
    expect(paths("echo x > /proj/$(date).txt")).toEqual([]);
  });

  it("ignores a plain read pipeline", () => {
    expect(paths("grep -rn foo src | head -20")).toEqual([]);
  });
});

describe("parseShellWrites — cwd", () => {
  it("reports an absolute leading cd as the command's cwd", () => {
    expect(parseShellWrites("cd /home/me/proj && echo x > out.txt").cwd).toBe("/home/me/proj");
  });

  it("reports no cwd when the command does not cd, or cds relatively", () => {
    expect(parseShellWrites("echo x > out.txt").cwd).toBeNull();
    expect(parseShellWrites("cd sub && echo x > out.txt").cwd).toBeNull();
  });

  it("keeps relative targets relative — resolution is the caller's job", () => {
    expect(paths("cd /home/me/proj && echo x > out.txt")).toEqual(["out.txt"]);
  });
});
