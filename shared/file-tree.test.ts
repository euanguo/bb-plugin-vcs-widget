import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../contracts";
import { buildChangeTree, flattenChangeTree, type ChangeListRow } from "./file-tree";

function file(path: string, extra: Partial<ChangeEntry> = {}): ChangeEntry {
  return { path, oldPath: null, index: ".", worktree: "M", kind: "tracked", additions: 1, deletions: 0, ...extra };
}

/** The rows as `kind:label` pairs, so an assertion reads as the list drawn. */
const rows = (entries: readonly ChangeEntry[], collapsed: string[] = []): string[] =>
  flattenChangeTree(buildChangeTree(entries), new Set(collapsed)).map((row) =>
    row.kind === "file" ? `file:${row.label}` : row.kind === "directory" ? `dir:${row.name}` : `group:${row.title}`,
  );

describe("buildChangeTree", () => {
  it("nests files under their directories, deepest last", () => {
    const tree = buildChangeTree([file("src/app/main.ts"), file("src/readme.md"), file("top.txt")]);
    expect(tree.children.map((node) => node.name)).toEqual(["src", "top.txt"]);
    const src = tree.children[0];
    expect(src?.kind).toBe("directory");
    if (src?.kind !== "directory") return;
    expect(src.children.map((node) => node.name)).toEqual(["app", "readme.md"]);
    // A directory carries every entry below it, which is what its header's
    // stage-all and discard-all act on.
    expect(src.entries.map((entry) => entry.path)).toEqual(["src/app/main.ts", "src/readme.md"]);
  });

  it("places a rename where the file is now, not where it was", () => {
    const tree = buildChangeTree([file("new/place.ts", { oldPath: "old/place.ts" })]);
    expect(tree.children.map((node) => node.name)).toEqual(["new"]);
  });
});

describe("flattenChangeTree", () => {
  const entries = [
    file("src/app/main.ts"),
    file("src/app/view.ts"),
    file("src/readme.md"),
    file("top.txt"),
  ];

  it("lists a directory then its contents, before the next sibling", () => {
    expect(rows(entries)).toEqual([
      "dir:src",
      "dir:app",
      "file:main.ts",
      "file:view.ts",
      "file:readme.md",
      "file:top.txt",
    ]);
  });

  it("leaves out everything below a collapsed directory", () => {
    expect(rows(entries, ["src"])).toEqual(["dir:src", "file:top.txt"]);
  });

  it("keeps a collapsed directory's own row, so it can be opened again", () => {
    const flattened = flattenChangeTree(buildChangeTree(entries), new Set(["src"]));
    const directory = flattened.find((row) => row.kind === "directory");
    expect(directory?.kind).toBe("directory");
    if (directory?.kind !== "directory") return;
    // The row still knows the folder and everything under it, so the header's
    // controls keep working while the folder is shut.
    expect(directory.path).toBe("src");
    expect(directory.entries).toHaveLength(3);
  });

  it("collapses only the directory named, not a child of the same name", () => {
    expect(rows(entries, ["src/app"])).toEqual([
      "dir:src",
      "dir:app",
      "file:readme.md",
      "file:top.txt",
    ]);
  });

  it("steps in by depth, and a file sits at its directory's depth", () => {
    const flattened: ChangeListRow[] = flattenChangeTree(buildChangeTree(entries), new Set());
    const depthOf = (key: string) => flattened.find((row) => row.key === key)?.depth;
    expect(depthOf("src")).toBe(0);
    expect(depthOf("src/app")).toBe(1);
    expect(depthOf("src/app/main.ts")).toBe(2);
    expect(depthOf("top.txt")).toBe(0);
  });

  it("labels a file by its basename and says so, so the row keeps the rename to itself", () => {
    const flattened = flattenChangeTree(buildChangeTree([file("src/app/main.ts", { oldPath: "src/old.ts" })]), new Set());
    const leaf = flattened.find((row) => row.kind === "file");
    expect(leaf?.kind).toBe("file");
    if (leaf?.kind !== "file") return;
    expect(leaf.label).toBe("main.ts");
    expect(leaf.labelKind).toBe("name");
    // The entry still carries the old path for the tooltip and the diff header.
    expect(leaf.entry.oldPath).toBe("src/old.ts");
  });

  it("keys a file row by its path, so a window can address it", () => {
    const flattened = flattenChangeTree(buildChangeTree(entries), new Set());
    const keys = flattened.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("src/app/main.ts");
  });

  it("handles an empty tree", () => {
    expect(flattenChangeTree(buildChangeTree([]), new Set())).toEqual([]);
  });
});
