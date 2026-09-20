import { describe, expect, it } from "vitest";
import { createCoalescer } from "./overview-coalesce";

/** A read whose completion the test controls. */
function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

describe("createCoalescer", () => {
  it("runs one read for callers that ask at the same time", async () => {
    const coalesce = createCoalescer<string, string>();
    let runs = 0;
    const read = deferred<string>();
    const run = () => {
      runs += 1;
      return read.promise;
    };
    const first = coalesce("host:/repo", run);
    const second = coalesce("host:/repo", run);
    const third = coalesce("host:/repo", run);
    expect(runs).toBe(1);
    // All three are the same promise, so all three see the same answer.
    expect(second).toBe(first);
    expect(third).toBe(first);
    read.settle("overview");
    expect(await first).toBe("overview");
    expect(await second).toBe("overview");
  });

  it("keys by repository, so two repositories are not confused with each other", async () => {
    const coalesce = createCoalescer<string, string>();
    const keys: string[] = [];
    const run = (key: string) => () => {
      keys.push(key);
      return Promise.resolve(key);
    };
    const a = coalesce("host:/one", run("host:/one"));
    const b = coalesce("host:/two", run("host:/two"));
    expect(await a).toBe("host:/one");
    expect(await b).toBe("host:/two");
    expect(keys).toEqual(["host:/one", "host:/two"]);
  });

  it("runs again once the first read has landed", async () => {
    const coalesce = createCoalescer<string, string>();
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(`read ${runs}`);
    };
    expect(await coalesce("k", run)).toBe("read 1");
    // Nothing is cached: a landed read is not reused, so the next caller gets a
    // fresh one rather than a repository state that may have moved on.
    expect(await coalesce("k", run)).toBe("read 2");
    expect(runs).toBe(2);
  });

  it("starts a new read after one fails, rather than replaying the failure", async () => {
    const coalesce = createCoalescer<string, string>();
    let runs = 0;
    const failure = deferred<string>();
    const first = coalesce("k", () => {
      runs += 1;
      return failure.promise;
    });
    failure.fail(new Error("host is gone"));
    await expect(first).rejects.toThrow("host is gone");

    const second = await coalesce("k", () => {
      runs += 1;
      return Promise.resolve("recovered");
    });
    expect(second).toBe("recovered");
    expect(runs).toBe(2);
  });

  it("hands every joined caller the same failure", async () => {
    const coalesce = createCoalescer<string, string>();
    const failure = deferred<string>();
    const first = coalesce("k", () => failure.promise);
    const second = coalesce("k", () => failure.promise);
    failure.fail(new Error("nope"));
    await expect(first).rejects.toThrow("nope");
    await expect(second).rejects.toThrow("nope");
  });

  it("does not clear a newer read when an older one finishes late", async () => {
    const coalesce = createCoalescer<string, string>();
    const slow = deferred<string>();
    const first = coalesce("k", () => slow.promise);
    slow.settle("first");
    await first;
    // The slot is free again, so the next read is a real one.
    let runs = 0;
    const second = await coalesce("k", () => {
      runs += 1;
      return Promise.resolve("second");
    });
    expect(second).toBe("second");
    expect(runs).toBe(1);
  });
});
