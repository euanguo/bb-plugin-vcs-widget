import { describe, expect, it } from "vitest";
import type { Overview } from "../contracts";
import { unavailableOverview } from "../contracts";
import {
  baseCandidates,
  channelsFor,
  compareRefKey,
  defaultBase,
  parseCompareRef,
  parseTargetKey,
  targetKey,
  targetLabel,
  UNCOMMITTED,
} from "./target";

function branch(name: string, isCurrent = false) {
  return {
    name,
    sha: "abc1234",
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    isCurrent,
    worktreePath: null,
    committedAt: 1,
    subject: "",
  };
}

function overview(extra: Partial<Overview> = {}): Overview {
  return {
    ...unavailableOverview(""),
    unavailableReason: null,
    unavailableKind: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "feature", sha: "abc1234" },
    upstream: null,
    remotes: ["origin"],
    local: [branch("feature", true), branch("main")],
    remote: [
      { name: "origin/main", remote: "origin", branch: "main", sha: "abc1234", hasLocal: true, committedAt: 1, subject: "" },
    ],
    ...extra,
  };
}

describe("compare refs as strings", () => {
  it("round-trips every kind", () => {
    const refs = [
      { kind: "local", name: "main" },
      { kind: "remote", remote: "origin", branch: "release/2.0" },
      { kind: "revision", revision: "abc1234" },
    ] as const;
    for (const ref of refs) expect(parseCompareRef(compareRefKey(ref))).toEqual(ref);
  });

  it("refuses anything it did not write", () => {
    for (const key of ["", "main", "local:", "remote:origin", "remote:/main", "nonsense:main"]) {
      expect(parseCompareRef(key)).toBeNull();
    }
  });
});

describe("targets as strings", () => {
  it("round-trips a target", () => {
    expect(parseTargetKey(targetKey(UNCOMMITTED))).toEqual(UNCOMMITTED);
    expect(parseTargetKey(targetKey({ kind: "commit", sha: "abc" }))).toEqual({ kind: "commit", sha: "abc" });
    expect(parseTargetKey(targetKey({ kind: "commits" }))).toEqual({ kind: "commits" });
  });

  it("refuses anything it did not write", () => {
    for (const key of ["", "commit:", "commits:", "commits:nonsense:main", "worktree"]) {
      expect(parseTargetKey(key)).toBeNull();
    }
  });
});

describe("defaultBase", () => {
  it("prefers the upstream the work is going to land on", () => {
    const upstream = { name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: false };
    expect(defaultBase(overview({ upstream }))).toEqual({ kind: "remote", remote: "origin", branch: "main" });
  });

  it("ignores an upstream whose remote-tracking ref is gone", () => {
    const gone = { name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: true };
    // The local main is the next best answer, and a better one than a ref
    // that no longer exists.
    expect(defaultBase(overview({ upstream: gone }))).toEqual({ kind: "local", name: "main" });
  });

  it("falls back to the remote-tracking main over a local one", () => {
    const remote = { name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: false };
    expect(defaultBase(overview({ upstream: remote, local: [branch("feature", true)], remote: [] }))).toEqual({
      kind: "remote",
      remote: "origin",
      branch: "main",
    });
  });

  it("answers null when there is no repository or nothing to compare against", () => {
    expect(defaultBase(null)).toBeNull();
    expect(defaultBase(overview({ unavailableReason: "no worktree" }))).toBeNull();
    expect(defaultBase(overview({ local: [branch("feature", true)], remote: [], remotes: [] }))).toBeNull();
  });
});

describe("baseCandidates", () => {
  it("offers every branch but the one that is checked out", () => {
    expect(baseCandidates(overview()).map(compareRefKey)).toEqual(["local:main", "remote:origin/main"]);
    expect(baseCandidates(null)).toEqual([]);
  });
});

describe("targetLabel", () => {
  it("names the working tree, a range and a commit", () => {
    expect(targetLabel(UNCOMMITTED, null, [])).toBe("Uncommitted changes");
    expect(targetLabel({ kind: "commits" }, { kind: "local", name: "main" }, [])).toBe("All commits vs main");
    const commits = [{ sha: "abc1234", shortSha: "abc1234", author: "a", committedAt: 1, subject: "A subject" }];
    expect(targetLabel({ kind: "commit", sha: "abc1234" }, null, commits)).toBe("A subject");
    // A commit the range no longer holds falls back to the sha it was named by.
    expect(targetLabel({ kind: "commit", sha: "deadbeefdeadbeef" }, null, commits)).toBe("deadbee");
  });
});

describe("channelsFor", () => {
  it("gives the working tree two readers and every other target one", () => {
    expect(channelsFor(UNCOMMITTED)).toEqual(["index", "worktree"]);
    expect(channelsFor({ kind: "commit", sha: "abc" })).toEqual(["target"]);
    expect(channelsFor({ kind: "commits" })).toEqual(["target"]);
  });
});
