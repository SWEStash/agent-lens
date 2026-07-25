/**
 * Shell-command line splitting (transcript/shell.ts) — pins the hand-rolled scanner that decides which
 * physical lines get a `$` prompt in the Bash card. It is the most fragile logic in the web package and
 * had no coverage, so these tests characterize the shipped behaviour before the SessionView split moves
 * it around. Imports SOURCE (packages/web has no per-module dist — it builds as a bundled SPA).
 */
import { describe, it, expect } from "vitest";
import { splitShellCommand } from "../src/transcript/shell";

/** The `cont` flags alone — what the renderer actually branches on. */
const conts = (cmd: string) => splitShellCommand(cmd).map((l) => l.cont);

describe("splitShellCommand", () => {
  it("returns one non-continuation line for a single command", () => {
    expect(splitShellCommand("ls -la")).toEqual([{ text: "ls -la", cont: false }]);
  });

  it("keeps the original text of every physical line, including blanks", () => {
    expect(splitShellCommand("a\n\nb").map((l) => l.text)).toEqual(["a", "", "b"]);
  });

  it("starts a new command per line when lines are independent", () => {
    expect(conts("echo one\necho two")).toEqual([false, false]);
  });

  describe("continuations", () => {
    it("continues after a trailing && / || / |", () => {
      expect(conts("a &&\nb")).toEqual([false, true]);
      expect(conts("a ||\nb")).toEqual([false, true]);
      expect(conts("a |\nb")).toEqual([false, true]);
    });

    it("continues after an odd number of trailing backslashes but not an even number", () => {
      expect(conts("echo a \\\nb")).toEqual([false, true]);
      expect(conts("echo a \\\\\nb")).toEqual([false, false]);
    });

    it("only continues the immediately following line", () => {
      expect(conts("a &&\nb\nc")).toEqual([false, true, false]);
    });

    it("ignores trailing whitespace when detecting the continuation", () => {
      expect(conts("a &&   \nb")).toEqual([false, true]);
    });
  });

  describe("quotes", () => {
    it("continues while a single quote is open", () => {
      expect(conts("echo 'one\ntwo'\nafter")).toEqual([false, true, false]);
    });

    it("continues while a double quote is open", () => {
      expect(conts('echo "one\ntwo"\nafter')).toEqual([false, true, false]);
    });

    it("treats a backslash-escaped quote inside double quotes as literal", () => {
      expect(conts('echo "a\\"b"\nafter')).toEqual([false, false]);
    });

    it("does not treat a quote inside single quotes as a double-quote opener", () => {
      expect(conts("echo 'a\"b'\nafter")).toEqual([false, false]);
    });
  });

  describe("subshells", () => {
    it("continues while $( … ) is open", () => {
      expect(conts("x=$(echo\nhi)\nafter")).toEqual([false, true, false]);
    });

    it("continues while a bare ( … ) subshell is open", () => {
      expect(conts("(cd /tmp\nls)\nafter")).toEqual([false, true, false]);
    });

    it("never lets paren depth go negative on an unbalanced )", () => {
      expect(conts("echo )\nafter")).toEqual([false, false]);
    });
  });

  describe("heredocs", () => {
    it("marks the body and the terminator as continuations, then resumes", () => {
      expect(conts("cat <<EOF\nline one\nEOF\nafter")).toEqual([false, true, true, false]);
    });

    it("honours a quoted delimiter", () => {
      expect(conts("cat <<'EOF'\nbody\nEOF\nafter")).toEqual([false, true, true, false]);
    });

    it("honours <<- with tab-stripped terminators", () => {
      expect(conts("cat <<-EOF\n\tbody\n\tEOF\nafter")).toEqual([false, true, true, false]);
    });

    it("does not strip tabs from the terminator for a plain <<", () => {
      // The tabbed EOF does not close the heredoc, so everything after stays body.
      expect(conts("cat <<EOF\n\tEOF\nafter")).toEqual([false, true, true]);
    });

    it("treats heredoc bodies as literal — quotes and operators inside do not leak out", () => {
      expect(conts("cat <<EOF\necho 'unclosed &&\nEOF\nafter")).toEqual([false, true, true, false]);
    });

    it("recognizes a heredoc opened inside a double-quoted substitution", () => {
      expect(conts("x=\"$(cat <<'EOF'\nbody\nEOF\n)\"\nafter")).toEqual([false, true, true, true, false]);
    });

    // KNOWN QUIRK (characterized, not endorsed): the `<<<` guard only looks forward, so the scanner
    // re-tests at the second `<` of a herestring, sees `<` + `'` and opens a bogus heredoc — swallowing
    // every following line as body. Fixed in the next commit; this test is updated there.
    it("mistakes a <<< herestring for a heredoc opener", () => {
      expect(conts("cat <<<'word'\nafter")).toEqual([false, true]);
    });

    it("ignores a << with no delimiter after it", () => {
      expect(conts("echo a <<\nafter")).toEqual([false, false]);
    });

    it("queues stacked heredocs and closes them in order", () => {
      expect(conts("cat <<A <<B\n1\nA\n2\nB\nafter")).toEqual([false, true, true, true, true, false]);
    });
  });

  describe("comments", () => {
    it("stops scanning at a trailing # comment", () => {
      expect(conts("echo hi # a 'comment\nafter")).toEqual([false, false]);
    });

    it("does not treat a # inside a word as a comment", () => {
      expect(conts("echo a#b\nafter")).toEqual([false, false]);
    });
  });

  it("handles an empty command", () => {
    expect(splitShellCommand("")).toEqual([{ text: "", cont: false }]);
  });
});
