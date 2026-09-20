// The last overview of each environment, and when it was read.
//
// Module scope on purpose: the composer's banner, the popup and the panels are
// separate component trees, and the point is that the second one to ask pays
// nothing. Nothing outlives the page, and nothing is served past
// `OVERVIEW_FRESH_MS` — a read that is older than that is re-read, so a lock or
// an external checkout still shows up within a couple of seconds.
//
// Pure and free of the SDK so it can be tested on its own, and so the test that
// mounts the app can clear it without importing anything that needs the plugin
// runtime.
import type { Overview } from "../contracts";
import { OVERVIEW_FRESH_MS } from "./constants";

interface Read {
  overview: Overview;
  at: number;
}

const reads = new Map<string, Read>();

/** The key an environment's read is filed under: the environment, or the thread. */
export function overviewCacheKey(threadId: string, environmentId: string | null): string {
  return environmentId ?? threadId;
}

export function rememberOverview(key: string, overview: Overview, at: number = Date.now()): void {
  reads.set(key, { overview, at });
}

/** The overview for this key if it was read recently enough to paint. */
export function freshOverview(key: string, now: number = Date.now()): Overview | null {
  const read = reads.get(key);
  if (read === undefined) return null;
  return now - read.at < OVERVIEW_FRESH_MS ? read.overview : null;
}

/** Test hook: the store is module scope, so it outlives a test's unmount. */
export function clearOverviewCache(): void {
  reads.clear();
}
