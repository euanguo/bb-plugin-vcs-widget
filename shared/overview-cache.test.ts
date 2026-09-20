import { afterEach, describe, expect, it } from "vitest";
import type { Overview } from "../contracts";
import { OVERVIEW_FRESH_MS } from "./constants";
import { clearOverviewCache, freshOverview, overviewCacheKey, rememberOverview } from "./overview-cache";

const read = { repoName: "repo" } as Overview;

afterEach(() => {
  clearOverviewCache();
});

describe("overview cache", () => {
  it("hands back a read that is still inside the freshness window", () => {
    rememberOverview("env1", read, 1_000);
    expect(freshOverview("env1", 1_000)).toBe(read);
    expect(freshOverview("env1", 1_000 + OVERVIEW_FRESH_MS - 1)).toBe(read);
  });

  it("stops handing it back once the window has passed", () => {
    rememberOverview("env1", read, 1_000);
    // At the boundary the read is no longer good enough: a lock or an external
    // checkout has to be able to show up.
    expect(freshOverview("env1", 1_000 + OVERVIEW_FRESH_MS)).toBeNull();
    expect(freshOverview("env1", 1_000 + OVERVIEW_FRESH_MS + 1)).toBeNull();
  });

  it("knows nothing about an environment it has not read", () => {
    expect(freshOverview("env2", 1_000)).toBeNull();
  });

  it("keeps the environments apart", () => {
    const other = { repoName: "other" } as Overview;
    rememberOverview("env1", read, 1_000);
    rememberOverview("env2", other, 1_000);
    expect(freshOverview("env1", 1_000)).toBe(read);
    expect(freshOverview("env2", 1_000)).toBe(other);
  });

  it("replaces a read with the newer one of the same environment", () => {
    const newer = { repoName: "repo", gitVersion: "2.56.0" } as Overview;
    rememberOverview("env1", read, 1_000);
    rememberOverview("env1", newer, 2_000);
    expect(freshOverview("env1", 2_000)).toBe(newer);
  });

  it("forgets a read once the window has passed, rather than growing forever", () => {
    rememberOverview("env1", read, 1_000);
    // Reading again is what replaces it; asking for a stale one does not delete
    // it, so a read that is about to be repeated is still there for a caller
    // that arrives in the meantime.
    expect(freshOverview("env1", 1_000 + OVERVIEW_FRESH_MS)).toBeNull();
    expect(freshOverview("env1", 1_000)).toBe(read);
  });

  it("files a read under the environment, or the thread when there is none", () => {
    expect(overviewCacheKey("t1", "env1")).toBe("env1");
    // A hidden or archived thread is off bb's sidebar list, so its environment
    // can only come from the read; until then the thread names the entry.
    expect(overviewCacheKey("t1", null)).toBe("t1");
  });

  it("clears everything on request, which is what a test does between cases", () => {
    rememberOverview("env1", read, 1_000);
    clearOverviewCache();
    expect(freshOverview("env1", 1_000)).toBeNull();
  });
});
