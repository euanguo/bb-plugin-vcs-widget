// The optimistic tick, on its own: what the panel shows between a click and
// the server's own view of the tree arriving.
import { describe, expect, it } from "vitest";
import type { ChangeEntry, ChangesResult } from "../contracts";
import { applyOverrides } from "./use-changes";
import { diffSidesFor, stageState } from "../shared/model";

function entry(path: string, overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return { path, oldPath: null, index: ".", worktree: "M", kind: "tracked", ...overrides };
}

function changes(files: ChangeEntry[]): ChangesResult {
  return {
    ok: true,
    head: { kind: "branch", name: "main", sha: "abc1234" },
    operation: "none",
    indexLocked: false,
    truncated: false,
    lastCommit: null,
    files,
  };
}

const staged = (result: ChangesResult | null, path: string) =>
  result?.ok ? result.files.find((file) => file.path === path) : undefined;

describe("applyOverrides", () => {
  it("returns the server's list untouched when nothing is pending", () => {
    const before = changes([entry("a.txt")]);
    expect(applyOverrides(before, new Map())).toBe(before);
  });

  it("passes a null or failed result through", () => {
    expect(applyOverrides(null, new Map([["a.txt", true]]))).toBeNull();
    const failed: ChangesResult = { ok: false, error: { code: "not_a_repo", message: "nope" } };
    expect(applyOverrides(failed, new Map([["a.txt", true]]))).toBe(failed);
  });

  it("marks an unstaged file staged with a clean working tree", () => {
    // `git add` copies the working tree into the index, so afterwards the two
    // agree. Leaving `worktree` dirty would show the file as half-staged.
    const result = applyOverrides(changes([entry("a.txt", { index: ".", worktree: "M" })]), new Map([["a.txt", true]]));
    const file = staged(result, "a.txt");
    expect(file).toMatchObject({ index: "M", worktree: "." });
    expect(stageState(file!)).toBe("staged");
  });

  it("turns a staged file unstaged, moving the change into the working tree", () => {
    const result = applyOverrides(changes([entry("a.txt", { index: "M", worktree: "." })]), new Map([["a.txt", false]]));
    const file = staged(result, "a.txt");
    expect(file).toMatchObject({ index: ".", worktree: "M" });
    expect(stageState(file!)).toBe("unstaged");
  });

  it("keeps a file's own working-tree letter when it is staged", () => {
    // A file edited after being staged keeps both sides; staging again is a
    // no-op on the letters, not a flattening of them.
    const result = applyOverrides(changes([entry("a.txt", { index: "M", worktree: "M" })]), new Map([["a.txt", true]]));
    // Already staged, so the optimistic write leaves it alone.
    expect(staged(result, "a.txt")).toMatchObject({ index: "M", worktree: "M" });
  });

  it("staging an untracked file makes it a tracked add", () => {
    const result = applyOverrides(
      changes([entry("new.txt", { index: ".", worktree: "?", kind: "untracked" })]),
      new Map([["new.txt", true]]),
    );
    const file = staged(result, "new.txt");
    expect(file).toMatchObject({ kind: "tracked", index: "A", worktree: "." });
  });

  it("leaves a conflicted file alone: staging it resolves rather than stages", () => {
    const before = changes([entry("c.txt", { index: "U", worktree: "U", kind: "conflicted" })]);
    const result = applyOverrides(before, new Map([["c.txt", true]]));
    expect(staged(result, "c.txt")).toMatchObject({ kind: "conflicted" });
  });

  it("does not change which diff sides a file offers", () => {
    // The reason the override is a separate layer: rewriting the letters to
    // fake a side would make `diffSidesFor` claim a side the file has not got.
    const result = applyOverrides(changes([entry("a.txt", { index: ".", worktree: "M" })]), new Map([["a.txt", true]]));
    expect(diffSidesFor(staged(result, "a.txt")!)).toEqual(["index"]);
  });

  it("touches only the paths named", () => {
    const result = applyOverrides(
      changes([entry("a.txt"), entry("b.txt")]),
      new Map([["a.txt", true]]),
    );
    expect(staged(result, "b.txt")).toMatchObject({ index: ".", worktree: "M" });
  });
});
