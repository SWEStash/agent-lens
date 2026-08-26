/**
 * The rework line in the "Files changed" roll-up. It is a count and a list, never a score — the
 * corpus analysis behind it tested rework against session cost in both directions and found the
 * relationship flat, so the panel must not grade a session for coming back to a file.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FilesChangedPanel } from "../src/transcript/FilesChanged";
import type { FileChangeRow } from "../src/api";

const edits = (path: string, n: number): FileChangeRow[] =>
  Array.from({ length: n }, (_, i) => ({
    file_path: path,
    tool_name: "Edit",
    lines_added: 1,
    lines_removed: 0,
    timestamp: `2026-04-0${(i % 9) + 1}T10:00:00Z`,
    event_uuid: `${path}-${i}`,
  }) as unknown as FileChangeRow);

/** The rework line, scoped by class: its text is split across spans, so a text matcher can match
 *  both the paragraph and an ancestor depending on how many files it names. */
const reworkLine = (c: HTMLElement) => c.querySelector(".files-rework");

const draw = (changes: FileChangeRow[]) =>
  render(
    <MemoryRouter>
      <FilesChangedPanel changes={changes} projectPath="/repo" />
    </MemoryRouter>,
  );

describe("FilesChangedPanel rework line", () => {
  it("stays silent when no file was touched enough times to be worth naming", () => {
    const { container } = draw([...edits("/repo/a.ts", 6), ...edits("/repo/b.ts", 3)]);
    expect(reworkLine(container)).toBeNull();
    expect(screen.queryByText(/edited 7\+ times/)).toBeNull();
  });

  it("names the reworked files, worst first, with their touch counts", () => {
    const { container } = draw([...edits("/repo/small.ts", 2), ...edits("/repo/mid.ts", 8), ...edits("/repo/worst.ts", 20)]);
    expect(screen.getByText(/2 edited 7\+ times/)).toBeTruthy();
    const line = reworkLine(container)!;
    expect(line.textContent).toContain("worst.ts (20×)");
    expect(line.textContent).toContain("mid.ts (8×)");
    // Under the threshold, so it belongs in the table rather than in the summary line.
    expect(line.textContent).not.toContain("small.ts");
    expect(line.textContent!.indexOf("worst.ts")).toBeLessThan(line.textContent!.indexOf("mid.ts"));
  });

  it("truncates a long list rather than reprinting the whole table", () => {
    const { container } = draw(["a", "b", "c", "d", "e", "f"].flatMap((n) => edits(`/repo/${n}.ts`, 9)));
    const line = reworkLine(container)!;
    expect(line.textContent).toContain("and 2 more");
  });
});
