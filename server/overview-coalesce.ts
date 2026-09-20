// One repository read at a time, per repository.
//
// Reading a repository is six git processes and a status walk, and nothing
// stops three surfaces asking for it at once — the composer's banner reads
// without being asked, the popup reads when it opens, and a panel reads when it
// mounts. Against one repository those three used to run three identical reads.
// This folds them into one.
//
// Deliberately only in-flight: a read that has landed is not reused, so nothing
// here can serve a repository state that has since changed. The client-side
// freshness window is what makes a *second* open cheap; this is what makes a
// simultaneous one free.
export type Coalescer<K, V> = (key: K, run: () => Promise<V>) => Promise<V>;

export function createCoalescer<K, V>(): Coalescer<K, V> {
  const inflight = new Map<K, Promise<V>>();
  return (key, run) => {
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = run();
    // Registered before the read is awaited, so a caller that arrives while it
    // is running joins it rather than starting a second one. Cleared on either
    // outcome: a failed read must not poison the next attempt.
    inflight.set(key, promise);
    const release = () => {
      if (inflight.get(key) === promise) inflight.delete(key);
    };
    promise.then(release, release);
    return promise;
  };
}
