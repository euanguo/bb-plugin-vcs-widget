import { describe, expect, it } from "vitest";
import {
  chunkDiffPaths,
  resolveDiffCollapsed,
  resolveDiffLoadMode,
  selectInitialPatchPaths,
  splitPatchIntoSections,
} from "./diff-tiering";

describe("diff tiering", () => {
  it("puts a file in the tier its size and kind earn", () => {
    expect(resolveDiffLoadMode({ changedLines: 0, binary: false })).toBe("auto");
    expect(resolveDiffLoadMode({ changedLines: 500, binary: false })).toBe("auto");
    // One line over the auto cap waits for a click.
    expect(resolveDiffLoadMode({ changedLines: 501, binary: false })).toBe("on_demand");
    expect(resolveDiffLoadMode({ changedLines: 20_000, binary: false })).toBe("on_demand");
    expect(resolveDiffLoadMode({ changedLines: 20_001, binary: false })).toBe("too_large");
    // A binary file has no patch to render, whatever its size.
    expect(resolveDiffLoadMode({ changedLines: 0, binary: true })).toBe("on_demand");
    expect(resolveDiffLoadMode({ changedLines: 5_000, binary: true })).toBe("on_demand");
  });

  it("inlines patches while the list is short, and none once it is long", () => {
    const auto = (path: string) => ({ path, loadMode: "auto" as const });
    const demand = (path: string) => ({ path, loadMode: "on_demand" as const });
    expect(selectInitialPatchPaths([auto("a"), auto("b")])).toEqual(["a", "b"]);
    // On-demand files are never inlined.
    expect(selectInitialPatchPaths([auto("a"), demand("b")])).toEqual(["a"]);
    // Past the threshold the reader scrolls, so nothing is inlined.
    const long = Array.from({ length: 11 }, (_, index) => auto(`f${index}`));
    expect(selectInitialPatchPaths(long)).toEqual([]);
  });

  it("chunks paths to the per-request cap", () => {
    expect(chunkDiffPaths([])).toEqual([]);
    expect(chunkDiffPaths(["a", "b"])).toEqual([["a", "b"]]);
    const many = Array.from({ length: 120 }, (_, index) => `f${index}`);
    const pages = chunkDiffPaths(many);
    expect(pages.map((page) => page.length)).toEqual([50, 50, 20]);
    expect(pages.flat()).toEqual(many);
  });

  it("starts a long list collapsed, and a deleted file collapsed", () => {
    expect(resolveDiffCollapsed({ fileCount: 3, changeKind: "modified" })).toBe(false);
    expect(resolveDiffCollapsed({ fileCount: 11, changeKind: "modified" })).toBe(true);
    expect(resolveDiffCollapsed({ fileCount: 3, changeKind: "deleted" })).toBe(true);
  });
});

describe("splitPatchIntoSections", () => {
  it("returns nothing for an empty patch", () => {
    expect(splitPatchIntoSections("")).toEqual([]);
  });

  it("splits a combined patch into one section per file", () => {
    const combined = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "index 333..444 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "",
    ].join("\n");
    const sections = splitPatchIntoSections(combined);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("diff --git a/a.txt b/a.txt");
    expect(sections[0]).toContain("+new");
    // A section carries only its own file's hunks.
    expect(sections[0]).not.toContain("b.txt");
    expect(sections[1]).toContain("diff --git a/b.txt b/b.txt");
    expect(sections[1]).toContain("+two");
  });

  it("keeps a rename's two paths in one section", () => {
    const combined = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");
    const sections = splitPatchIntoSections(combined);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("rename to new.txt");
  });

  it("keeps a binary section whole, with its trailing blank line", () => {
    const combined = ["diff --git a/img.png b/img.png", "GIT binary patch", ""].join("\n");
    const sections = splitPatchIntoSections(combined);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("GIT binary patch");
  });

  it("ignores text before the first header", () => {
    const sections = splitPatchIntoSections(["stray preamble", "diff --git a/a.txt b/a.txt", "+x"].join("\n"));
    expect(sections).toHaveLength(1);
    expect(sections[0]).not.toContain("stray preamble");
  });
});
