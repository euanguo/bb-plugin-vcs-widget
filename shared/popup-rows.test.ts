import { describe, expect, it } from "vitest";
import type { LocalBranch, Overview, RemoteBranch } from "../contracts";
import { groupBranches, quickActionsFor } from "./model";
import {
  buildPopupRows,
  firstSelectable,
  lastSelectable,
  popupSource,
  rowSelectable,
  stepSelectable,
  type PopupRow,
} from "./popup-rows";

function branch(name: string, extra: Partial<LocalBranch> = {}): LocalBranch {
  return {
    name,
    sha: "abc1234",
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    isCurrent: false,
    worktreePath: null,
    committedAt: 1,
    subject: "",
    ...extra,
  };
}

function remote(name: string): RemoteBranch {
  return { name, remote: "origin", branch: name.slice("origin/".length), sha: "abc1234", hasLocal: false, committedAt: 1, subject: "" };
}

function overview(extra: Partial<Overview> = {}): Overview {
  return {
    unavailableReason: null,
    unavailableKind: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "main", sha: "abc1234" },
    operation: "none",
    indexLocked: false,
    upstream: null,
    workingTree: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    local: [branch("main", { isCurrent: true }), branch("feature"), branch("release")],
    remote: [remote("origin/main"), remote("origin/hotfix")],
    recent: ["feature"],
    remotes: ["origin"],
    truncated: { local: false, remote: false },
    activeJob: null,
    ...extra,
  };
}

const sourceFor = (view: Overview, favourites: ReadonlySet<string> = new Set()) =>
  popupSource(view, groupBranches(view, favourites));

/** The label of every row, so an assertion reads as the list the reader sees. */
const labels = (rows: readonly PopupRow[]): string[] =>
  rows.map((row) => {
    if (row.kind === "heading") return `#${row.label}`;
    if (row.kind === "action") return `>${row.action.id}`;
    return `${row.prefix}:${row.entry.branch.name}`;
  });

describe("popup rows", () => {
  it("orders the groups and leaves a heading out when its group is empty", () => {
    const rows = buildPopupRows(sourceFor(overview()), "", new Set());
    expect(labels(rows)).toEqual([
      "#Actions",
      ">update",
      ">commit",
      ">log",
      ">fetch",
      ">push",
      ">new-branch",
      ">checkout-revision",
      "#Recent",
      "recent:feature",
      "#Local",
      "local:main",
      "local:feature",
      "local:release",
      "#Remote",
      "remote:origin/hotfix",
      "remote:origin/main",
    ]);
    // No favourites were starred, so that heading is absent rather than empty.
    expect(labels(rows)).not.toContain("#Favourites");
  });

  it("names a truncated list in its heading", () => {
    const view = overview({ truncated: { local: true, remote: true } });
    const rows = buildPopupRows(sourceFor(view), "", new Set());
    expect(labels(rows)).toContain("#Local (truncated)");
    expect(labels(rows)).toContain("#Remote (truncated)");
  });

  it("filters every group by the query and drops a group that matches nothing", () => {
    // "hotfix" reaches the branch and no action label, so the Actions group is
    // absent rather than empty.
    expect(labels(buildPopupRows(sourceFor(overview()), "hotfix", new Set()))).toEqual(["#Remote", "remote:origin/hotfix"]);
    // "hot" reaches two actions as a subsequence of their labels (Show Git Log,
    // Checkout Tag or Revision), which is the same loose match the popup made
    // before it was windowed; the action filter must keep running.
    expect(labels(buildPopupRows(sourceFor(overview()), "hot", new Set()))).toEqual([
      "#Actions",
      ">log",
      ">checkout-revision",
      "#Remote",
      "remote:origin/hotfix",
    ]);
    expect(labels(buildPopupRows(sourceFor(overview()), "comm", new Set()))).toEqual(["#Actions", ">commit"]);
    expect(buildPopupRows(sourceFor(overview()), "nothing-matches-this", new Set())).toEqual([]);
  });

  it("keeps the entry objects stable across a keystroke", () => {
    const source = sourceFor(overview());
    const before = buildPopupRows(source, "", new Set());
    const after = buildPopupRows(source, "e", new Set());
    const entryOf = (rows: readonly PopupRow[], key: string) => {
      const row = rows.find((candidate) => candidate.key === key);
      return row?.kind === "branch" ? row.entry : null;
    };
    // A memoized row only keeps its place if the entry it is handed is the
    // same object, so this is the difference between a cheap keystroke and a
    // full re-render of the list. "feature" survives both queries.
    const first = entryOf(before, "local:local:feature");
    const second = entryOf(after, "local:local:feature");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("gives every row a unique key, and the branch keys keep their old form", () => {
    const favourites = new Set(["local:feature", "remote:origin/hotfix"]);
    const rows = buildPopupRows(sourceFor(overview(), favourites), "", favourites);
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    // These exact strings are what the popup rendered before it was windowed;
    // React keys and the tests both depend on them not moving.
    expect(keys).toContain("fav:local:feature");
    expect(keys).toContain("recent:local:feature");
    expect(keys).toContain("local:local:feature");
    expect(keys).toContain("remote:remote:origin/hotfix");
    expect(keys).toContain("action:commit");
  });

  it("offers nothing to select before the overview arrives", () => {
    expect(buildPopupRows(popupSource(null, null), "", new Set())).toEqual([]);
  });
});

describe("row navigation", () => {
  const rows = buildPopupRows(sourceFor(overview()), "", new Set());
  const selectable = rows.filter(rowSelectable).length;

  it("never lands on a heading", () => {
    for (let index = 0; index < rows.length; index += 1) {
      if (!rowSelectable(rows[index]!)) continue;
      expect(rows[index]!.kind).not.toBe("heading");
    }
    expect(firstSelectable(rows)).toBe(1); // the row after "#Actions"
    expect(rows[firstSelectable(rows)]!.kind).toBe("action");
    expect(lastSelectable(rows)).toBe(rows.length - 1);
  });

  it("starts at the top going down and at the bottom going up", () => {
    expect(stepSelectable(rows, -1, 1)).toBe(firstSelectable(rows));
    expect(stepSelectable(rows, -1, -1)).toBe(lastSelectable(rows));
  });

  it("moves exactly one selectable row per press", () => {
    let at = firstSelectable(rows);
    const seen = [at];
    for (let press = 0; press < 5; press += 1) {
      at = stepSelectable(rows, at, 1);
      seen.push(at);
    }
    // Five presses, five rows: not six, and not four from a double-handled key.
    expect(new Set(seen).size).toBe(6);
    for (const index of seen) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(rowSelectable(rows[index]!)).toBe(true);
    }
  });

  it("clamps at both ends instead of wrapping", () => {
    const last = lastSelectable(rows);
    expect(stepSelectable(rows, last, 1)).toBe(last);
    const first = firstSelectable(rows);
    expect(stepSelectable(rows, first, -1)).toBe(first);
  });

  it("answers -1 when there is nothing to land on", () => {
    const headingsOnly: PopupRow[] = [{ kind: "heading", key: "heading:x", label: "X" }];
    expect(firstSelectable(headingsOnly)).toBe(-1);
    expect(lastSelectable(headingsOnly)).toBe(-1);
    expect(stepSelectable(headingsOnly, -1, 1)).toBe(-1);
    expect(stepSelectable([], -1, 1)).toBe(-1);
  });
});

describe("popup source", () => {
  it("carries the quick actions straight from the overview", () => {
    const view = overview();
    const source = popupSource(view, groupBranches(view));
    expect(source.actions).toEqual(quickActionsFor(view));
    expect(source.local.map((entry) => entry.branch.name)).toEqual(["main", "feature", "release"]);
    expect(source.remote.map((entry) => entry.branch.name)).toEqual(["origin/hotfix", "origin/main"]);
    expect(source.recent.map((entry) => entry.branch.name)).toEqual(["feature"]);
  });

  it("wraps each branch as the kind of entry it is", () => {
    const view = overview();
    const source = popupSource(view, groupBranches(view));
    expect(source.local.every((entry) => entry.kind === "local")).toBe(true);
    expect(source.remote.every((entry) => entry.kind === "remote")).toBe(true);
  });
});
