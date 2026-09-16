import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../contracts";
import { groupByDirectory, groupByStatus, groupChanges, isGroupingMode, sortGroupsByWeight } from "./grouping";

function entry(path: string, overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return { path, oldPath: null, index: ".", worktree: "M", kind: "tracked", additions: null, deletions: null, ...overrides };
}

describe("grouping modes", () => {
  it("recognizes only the modes it defines", () => {
    expect(isGroupingMode("status")).toBe(true);
    expect(isGroupingMode("directory")).toBe(true);
    expect(isGroupingMode("flat")).toBe(true);
    expect(isGroupingMode("worktree")).toBe(false);
    expect(isGroupingMode(undefined)).toBe(false);
  });
});

describe("groupByStatus", () => {
  it("splits into the three buckets git users expect, in order", () => {
    const groups = groupByStatus([
      entry("a.txt"),
      entry("new.txt", { worktree: "?", kind: "untracked" }),
      entry("both.txt", { index: "U", worktree: "U", kind: "conflicted" }),
      entry("b.txt"),
    ]);
    expect(groups.map((group) => group.title)).toEqual(["Conflicts", "Changes", "Unversioned files"]);
    expect(groups[0]?.entries.map((item) => item.path)).toEqual(["both.txt"]);
    expect(groups[1]?.entries.map((item) => item.path)).toEqual(["a.txt", "b.txt"]);
    expect(groups[2]?.entries.map((item) => item.path)).toEqual(["new.txt"]);
  });

  it("omits a bucket with nothing in it", () => {
    const groups = groupByStatus([entry("a.txt")]);
    expect(groups.map((group) => group.title)).toEqual(["Changes"]);
  });
});

describe("groupByDirectory", () => {
  it("groups files by the directory that holds them", () => {
    const groups = groupByDirectory([entry("src/a.ts"), entry("src/b.ts"), entry("README.md")]);
    const byKey = new Map(groups.map((group) => [group.key, group.entries.map((item) => item.path)]));
    expect(byKey.get("src")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(byKey.get(".")).toEqual(["README.md"]);
  });

  it("nests a subdirectory under its parent, with a depth to indent by", () => {
    const groups = groupByDirectory([entry("src/a.ts"), entry("src/deep/b.ts")]);
    const src = groups.find((group) => group.key === "src");
    const deep = groups.find((group) => group.key === "src/deep");
    expect(src?.depth).toBe(0);
    expect(deep?.depth).toBe(1);
    expect(deep?.entries.map((item) => item.path)).toEqual(["src/deep/b.ts"]);
  });

  it("emits no header for a directory that only holds other directories", () => {
    // `a/b/c.txt` has no file directly in `a`, so `a` must not appear as an
    // empty group.
    const groups = groupByDirectory([entry("a/b/c.txt")]);
    expect(groups.map((group) => group.key)).toEqual(["a/b"]);
  });

  it("orders a directory's own files before its children, and children by name", () => {
    const groups = groupByDirectory([entry("src/z.ts"), entry("src/a/x.ts"), entry("src/a.ts")]);
    expect(groups.map((group) => group.key)).toEqual(["src", "src/a"]);
  });

  it("groups a rename by the path it now stands for", () => {
    const groups = groupByDirectory([entry("new/dir/moved.ts", { index: "R", oldPath: "old/dir/moved.ts" })]);
    expect(groups.map((group) => group.key)).toEqual(["new/dir"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupByDirectory([])).toEqual([]);
  });
});

describe("groupChanges", () => {
  it("answers each mode, and flat keeps one group", () => {
    const entries = [entry("src/a.ts"), entry("README.md")];
    expect(groupChanges(entries, "status").map((group) => group.key)).toEqual(["changes"]);
    expect(groupChanges(entries, "directory").map((group) => group.key)).toEqual([".", "src"]);
    const flat = groupChanges(entries, "flat");
    expect(flat).toHaveLength(1);
    expect(flat[0]?.title).toBe("All changes");
    expect(flat[0]?.entries).toHaveLength(2);
  });

  it("returns nothing for an empty list in every mode", () => {
    for (const mode of ["status", "directory", "flat"] as const) {
      expect(groupChanges([], mode)).toEqual([]);
    }
  });
});

describe("sortGroupsByWeight", () => {
  it("puts the group with the most files first, ties broken by key", () => {
    const groups = groupByDirectory([entry("a/1.ts"), entry("b/1.ts"), entry("b/2.ts"), entry("c/1.ts")]);
    const sorted = sortGroupsByWeight(groups);
    expect(sorted.map((group) => group.key)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate its input", () => {
    const groups = groupByDirectory([entry("a/1.ts"), entry("b/1.ts"), entry("b/2.ts")]);
    const before = groups.map((group) => group.key);
    sortGroupsByWeight(groups);
    expect(groups.map((group) => group.key)).toEqual(before);
  });
});
