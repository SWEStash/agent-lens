/**
 * Files-changed tree shaping (transcript/tree.ts and transcript/group.ts) — the two pure structural
 * transforms behind the transcript header's file roll-up and its turn sections. Imports SOURCE (web has
 * no per-module dist).
 */
import { describe, it, expect } from "vitest";
import { buildFileTree, type FileTreeNode } from "../src/transcript/tree";
import { groupByTurn } from "../src/transcript/group";
import type { EventNode, FileChangeRow } from "../src/api";

const change = (over: Partial<FileChangeRow> = {}): FileChangeRow => ({
  id: "c1",
  tool_call_id: "tc1",
  turn_id: null,
  event_uuid: null,
  file_path: "/p/a.ts",
  tool_name: "Edit",
  lines_added: 1,
  lines_removed: 0,
  timestamp: null,
  ...over,
});

const entry = (display: string) => ({ display, path: "/abs/" + display, list: [change()] });

/** The tree as nested plain objects, so expectations don't wrestle with Maps. */
const shape = (n: FileTreeNode): unknown => ({
  dirs: Object.fromEntries([...n.dirs].map(([k, v]) => [k, shape(v)])),
  files: n.files.map((f) => f.name),
});

describe("buildFileTree", () => {
  it("returns an empty root for no entries", () => {
    expect(shape(buildFileTree([]))).toEqual({ dirs: {}, files: [] });
  });

  it("puts a bare filename at the root", () => {
    expect(shape(buildFileTree([entry("README.md")]))).toEqual({ dirs: {}, files: ["README.md"] });
  });

  it("nests files under their directory", () => {
    expect(shape(buildFileTree([entry("src/a.ts"), entry("src/b.ts")]))).toEqual({
      dirs: { src: { dirs: {}, files: ["a.ts", "b.ts"] } },
      files: [],
    });
  });

  it("compresses a single-child directory chain into one row", () => {
    expect(shape(buildFileTree([entry("src/components/x.tsx")]))).toEqual({
      dirs: { "src/components": { dirs: {}, files: ["x.tsx"] } },
      files: [],
    });
  });

  it("compresses a chain of several single-child directories", () => {
    expect(shape(buildFileTree([entry("a/b/c/d.ts")]))).toEqual({
      dirs: { "a/b/c": { dirs: {}, files: ["d.ts"] } },
      files: [],
    });
  });

  it("does not compress a directory that also holds files", () => {
    expect(shape(buildFileTree([entry("src/a.ts"), entry("src/sub/b.ts")]))).toEqual({
      dirs: { src: { dirs: { sub: { dirs: {}, files: ["b.ts"] } }, files: ["a.ts"] } },
      files: [],
    });
  });

  it("does not compress a directory with more than one child directory", () => {
    expect(shape(buildFileTree([entry("src/x/a.ts"), entry("src/y/b.ts")]))).toEqual({
      dirs: { src: { dirs: { x: { dirs: {}, files: ["a.ts"] }, y: { dirs: {}, files: ["b.ts"] } }, files: [] } },
      files: [],
    });
  });

  it("keeps an out-of-project absolute path visibly absolute", () => {
    expect(shape(buildFileTree([entry("/etc/hosts")]))).toEqual({
      dirs: { "/etc": { dirs: {}, files: ["hosts"] } },
      files: [],
    });
  });

  it("carries each file's real path and change list, not just its display name", () => {
    const rows = [change({ id: "c1" }), change({ id: "c2" })];
    const tree = buildFileTree([{ display: "src/a.ts", path: "/proj/src/a.ts", list: rows }]);
    expect(tree.dirs.get("src")!.files[0]).toMatchObject({ name: "a.ts", path: "/proj/src/a.ts", list: rows });
  });
});

const ev = (uuid: string, turn_id: string | null): EventNode => ({
  uuid,
  type: "message",
  role: "user",
  timestamp: null,
  model: null,
  is_sidechain: 0,
  turn_id,
  text: null,
  thinking: null,
  toolCalls: [],
});

describe("groupByTurn", () => {
  it("returns no groups for no events", () => {
    expect(groupByTurn([], [{ id: "t1" }])).toEqual([]);
  });

  it("groups consecutive events of the same turn and attaches the turn row", () => {
    const turns = [{ id: "t1", seq: 0 }];
    const groups = groupByTurn([ev("a", "t1"), ev("b", "t1")], turns);
    expect(groups).toHaveLength(1);
    expect(groups[0].turnId).toBe("t1");
    expect(groups[0].turn).toBe(turns[0]);
    expect(groups[0].events.map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  it("starts a new group at every turn boundary, preserving transcript order", () => {
    const groups = groupByTurn([ev("a", "t1"), ev("b", "t2"), ev("c", "t1")], [{ id: "t1" }, { id: "t2" }]);
    expect(groups.map((g) => g.turnId)).toEqual(["t1", "t2", "t1"]);
  });

  it("gives turn-less events a header-less group so they still render", () => {
    const groups = groupByTurn([ev("a", null), ev("b", "t1")], [{ id: "t1" }]);
    expect(groups[0]).toMatchObject({ turnId: null, turn: null });
    expect(groups[1].turnId).toBe("t1");
  });

  it("groups turn-less events together rather than one group each", () => {
    expect(groupByTurn([ev("a", null), ev("b", null)], [])).toHaveLength(1);
  });

  it("leaves turn null when the event references a turn that was not loaded", () => {
    const groups = groupByTurn([ev("a", "missing")], [{ id: "t1" }]);
    expect(groups[0]).toMatchObject({ turnId: "missing", turn: null });
  });
});
