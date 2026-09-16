import { describe, expect, it } from "vitest";
import { patchRows, quoteForRange } from "./diff-quote";

/** One hunk: a context line, a replacement, and a trailing context line. */
const PATCH = [
  "@@ -1,4 +1,5 @@",
  " keep",
  "-old",
  "+new",
  "+added",
  " tail",
  "",
].join("\n");

describe("patchRows", () => {
  it("numbers each row on both sides of the file", () => {
    expect(patchRows(PATCH)).toEqual([
      { prefix: " ", text: "keep", oldLine: 1, newLine: 1 },
      { prefix: "-", text: "old", oldLine: 2, newLine: null },
      { prefix: "+", text: "new", oldLine: null, newLine: 2 },
      { prefix: "+", text: "added", oldLine: null, newLine: 3 },
      { prefix: " ", text: "tail", oldLine: 3, newLine: 4 },
    ]);
  });

  it("drops the file headers, the git metadata and the no-newline marker", () => {
    const withHeaders = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/b.txt b/b.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    expect(patchRows(withHeaders)).toEqual([
      { prefix: "-", text: "old", oldLine: 1, newLine: null },
      { prefix: "+", text: "new", oldLine: null, newLine: 1 },
      { prefix: "-", text: "x", oldLine: 1, newLine: null },
      { prefix: "+", text: "y", oldLine: null, newLine: 1 },
    ]);
  });
});

describe("quoteForRange", () => {
  it("quotes an added line as a patch fragment an agent can read", () => {
    expect(quoteForRange(PATCH, "a.txt", { start: 2, end: 3, side: "additions" })).toBe(
      ["a.txt", "@@ -1,0 +2,2 @@", "+new", "+added"].join("\n"),
    );
  });

  it("quotes a removed line against the old file", () => {
    expect(quoteForRange(PATCH, "a.txt", { start: 2, end: 2, side: "deletions" })).toBe(
      ["a.txt", "@@ -2 +1,0 @@", "-old"].join("\n"),
    );
  });

  it("counts a single line the way git writes a hunk header", () => {
    expect(quoteForRange(PATCH, "a.txt", { start: 1, end: 1, side: "additions" })).toBe(
      ["a.txt", "@@ -1 +1 @@", " keep"].join("\n"),
    );
  });

  it("returns nothing for a line the patch does not hold", () => {
    expect(quoteForRange(PATCH, "a.txt", { start: 99, end: 99, side: "additions" })).toBeNull();
    expect(quoteForRange("", "a.txt", { start: 1, end: 1 })).toBeNull();
  });
});

