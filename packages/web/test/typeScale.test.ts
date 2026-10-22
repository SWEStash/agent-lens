// @vitest-environment node
/**
 * The type scale is the only source of font sizes: styles.css sets every size through a `--fs-*`
 * token, and components never hard-code one. A literal size slipping back in is how the app drifted
 * to 17 distinct rendered sizes before the scale existed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const css = readFileSync(join(SRC, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe("type scale", () => {
  it("declares the scale tokens once, in :root", () => {
    const tokens = [...css.matchAll(/(--fs-[\w-]+):\s*([^;]+);/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("sets every font-size in styles.css through a token (or an em step in the markdown body)", () => {
    const literal = [...css.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => !/^var\(--fs-[\w-]+\)$/.test(v) && !/^[\d.]+em$/.test(v));
    expect(literal).toEqual([]);
    // The body shorthand is the one `font:` that names a size.
    const shorthand = [...css.matchAll(/(?<![\w-])font:\s*([^;]+)/g)].map((m) => m[1]).filter((v) => /\d+px/.test(v));
    expect(shorthand).toEqual([]);
  });

  it("never hard-codes a font size in a component", () => {
    const offenders = sources(SRC).flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [...text.matchAll(/fontSize[=:]\s*\{?\s*[\d.]+/g)].map((m) => `${f.slice(SRC.length)}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});
