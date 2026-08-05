/**
 * Command sanitizer (detect.ts) — the regex stages that turn a verbatim Bash command into the two
 * views the rules match against. detect.test.ts covers these only indirectly, through whole rules;
 * this suite pins each stage on its own, because the sanitizer is where the detector's false
 * positives and false negatives are actually decided, and every rule inherits its holes.
 *
 * Cases marked KNOWN HOLE document behaviour we accept, not behaviour we want — they exist so a
 * future change to the pipeline is a conscious decision rather than a surprise. Imports the BUILT dist.
 */
import { describe, it, expect } from "vitest";
import { stripComments, neutralizeEcho, blankHeredoc, blankQuoted, codeOf, bareOf } from "../dist/detect.js";

describe("stripComments", () => {
  it("drops a trailing comment but keeps the command", () => {
    expect(stripComments("ls -la # rm -rf /")).toBe("ls -la "); // the separating space is kept
  });

  it("drops a whole-line comment, keeping the newline structure", () => {
    expect(stripComments("# sudo rm -rf /\nls")).toBe("\nls");
  });

  it("keeps a # that is not preceded by whitespace (not a comment)", () => {
    expect(stripComments("git checkout feature#123")).toBe("git checkout feature#123");
  });

  it("KNOWN HOLE: a # inside a quoted string is treated as a comment", () => {
    expect(stripComments(`grep "issue #42" log.txt`)).toBe(`grep "issue `);
  });
});

describe("neutralizeEcho", () => {
  it("reduces an echo's arguments to the bare builtin", () => {
    expect(neutralizeEcho("echo sudo rm -rf /")).toBe("echo");
    expect(neutralizeEcho("printf 'sudo rm -rf /'")).toBe("echo");
  });

  it("consumes a quoted argument whole, so separators inside it never split the command", () => {
    expect(neutralizeEcho(`echo "a; sudo rm -rf /"`)).toBe("echo");
  });

  it("keeps what runs after the echo's own segment", () => {
    expect(neutralizeEcho("echo hello && sudo reboot")).toBe("echo&& sudo reboot");
  });

  it("only neutralizes echo at command position, not the word echo as an argument", () => {
    expect(neutralizeEcho("grep echo sudo.log")).toBe("grep echo sudo.log");
  });

  it("is case-insensitive on the builtin", () => {
    expect(neutralizeEcho("ECHO sudo")).toBe("echo");
  });
});

describe("blankHeredoc", () => {
  it("replaces a heredoc body with a placeholder", () => {
    expect(blankHeredoc("cat <<EOF\nsudo rm -rf /\nEOF")).toBe("cat <<HEREDOC");
  });

  it("handles the <<- and quoted-delimiter forms", () => {
    expect(blankHeredoc("cat <<-'EOF'\nsudo\n  EOF")).toBe("cat <<HEREDOC");
    expect(blankHeredoc(`cat <<"END"\nsudo\nEND`)).toBe("cat <<HEREDOC");
  });

  it("keeps what follows the terminator", () => {
    expect(blankHeredoc("cat <<EOF > f\nx\nEOF\nsudo reboot")).toBe("cat <<HEREDOC\nsudo reboot");
  });

  it("leaves an unterminated heredoc alone (no delimiter line to close it)", () => {
    expect(blankHeredoc("cat <<EOF\nsudo rm -rf /")).toBe("cat <<EOF\nsudo rm -rf /");
  });
});

describe("blankQuoted", () => {
  it("empties both quote styles, keeping the quotes themselves", () => {
    expect(blankQuoted(`grep "sudo" 'rm -rf'`)).toBe(`grep "" ''`);
  });

  it("respects a backslash-escaped quote inside a double-quoted string", () => {
    expect(blankQuoted(`echo "a \\" sudo"`)).toBe(`echo ""`);
  });
});

describe("codeOf — the executed view (quotes intact)", () => {
  it("keeps executed code that lives inside quotes", () => {
    expect(codeOf(`psql -c "DROP TABLE users"`)).toBe(`psql -c "DROP TABLE users"`);
  });

  it("applies all three neutralizing stages together", () => {
    expect(codeOf("echo danger # sudo\ncat <<EOF\nrm -rf /\nEOF")).toBe("echo\ncat <<HEREDOC");
  });

  it("blanks the heredoc before stripping comments, so a # in the body cannot eat the terminator", () => {
    expect(codeOf("cat <<EOF\n# note\nEOF\nls")).toBe("cat <<HEREDOC\nls");
  });
});

describe("bareOf — the command-word view (quoted contents blanked)", () => {
  it("hides a dangerous token that is only a quoted argument", () => {
    expect(bareOf(`git commit -m "rm -rf everything"`)).toBe(`git commit -m ""`);
  });

  it("still exposes a dangerous command word outside quotes", () => {
    expect(bareOf(`sudo rm -rf /tmp/x`)).toBe(`sudo rm -rf /tmp/x`);
  });

  it("KNOWN HOLE: a command really executed via sh -c \"…\" is blanked out of view", () => {
    expect(bareOf(`sh -c "sudo rm -rf /"`)).toBe(`sh -c ""`);
  });

  it("is idempotent — sanitizing an already-sanitized command changes nothing", () => {
    const once = bareOf(`echo "x" # y\nsudo reboot`);
    expect(bareOf(once)).toBe(once);
  });
});
