// The complete old/new text of a changed file, fetched only when a card can
// actually use it. bb's own diff panel does the same thing for the same
// reason: without both sides the renderer cannot offer "expand unchanged
// lines", and fetching them for every file up front would move megabytes for
// diffs nobody opened.
//
// The plugin already has this data: `diffFile` returns `contents` alongside
// the patch, bounded by the host's own side limit. So this asks for that
// single-file read rather than introducing another contract.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { DiffSide } from "../shared/constants";

/** Both sides as the host diff renderer wants them. */
export interface DiffFullContents {
  old: { path: string; content: string };
  new: { path: string; content: string };
}

export type DiffContentsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; contents: DiffFullContents }
  | { status: "unavailable" };

const IDLE: DiffContentsState = { status: "idle" };

/** Requests in flight at once. A stream can have many rows on screen. */
const MAX_CONCURRENT = 3;

export interface UseDiffContentsResult {
  getContents: (path: string) => DiffContentsState;
  requestContents: (path: string, oldPath: string | null) => void;
  prune: (paths: readonly string[]) => void;
  invalidate: () => void;
}

export function useDiffContents(
  threadId: string,
  side: DiffSide,
  enabled: boolean,
): UseDiffContentsResult {
  const rpc = useRpc<typeof rpcContract>();
  const [states, setStates] = useState<Map<string, DiffContentsState>>(new Map());
  const [freshness, setFreshness] = useState(0);
  const identity = `${threadId}:${side}:${freshness}`;
  const identityRef = useRef(identity);
  const statesRef = useRef(states);
  const inFlightRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<{ path: string; oldPath: string | null }[]>([]);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  useEffect(() => {
    identityRef.current = identity;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    inFlightRef.current.clear();
    queueRef.current = [];
    setStates(new Map());
  }, [identity]);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers) controller.abort();
    };
  }, []);

  const drain = useCallback(() => {
    if (!enabled) return;
    while (inFlightRef.current.size < MAX_CONCURRENT && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (next === undefined) return;
      if (inFlightRef.current.has(next.path)) continue;
      const requestedUnder = identityRef.current;
      inFlightRef.current.add(next.path);
      const controller = new AbortController();
      controllersRef.current.add(controller);
      setStates((previous) => new Map(previous).set(next.path, { status: "loading" }));
      void rpc
        .call("diffFile", {
          threadId,
          path: next.path,
          oldPath: next.oldPath,
          side,
        })
        .then(
          (result) => {
            if (controller.signal.aborted || identityRef.current !== requestedUnder) return;
            setStates((previous) => {
              const updated = new Map(previous);
              // `contents` is null for a binary, a truncated patch, or a side
              // too large to send; that is the renderer's "unavailable".
              updated.set(
                next.path,
                result.ok && result.contents !== null
                  ? { status: "ready", contents: result.contents }
                  : { status: "unavailable" },
              );
              return updated;
            });
          },
          () => {
            if (controller.signal.aborted || identityRef.current !== requestedUnder) return;
            setStates((previous) => new Map(previous).set(next.path, { status: "unavailable" }));
          },
        )
        .finally(() => {
          controllersRef.current.delete(controller);
          inFlightRef.current.delete(next.path);
          drain();
        });
    }
  }, [enabled, rpc, side, threadId]);

  const requestContents = useCallback(
    (path: string, oldPath: string | null) => {
      if (!enabled) return;
      if (inFlightRef.current.has(path)) return;
      const state = statesRef.current.get(path);
      // Ready stays ready; unavailable waits for an explicit retry (a new
      // freshness) so one oversized file is not re-read on every scroll.
      if (state !== undefined && state.status !== "idle") return;
      queueRef.current.push({ path, oldPath });
      drain();
    },
    [drain, enabled],
  );

  const prune = useCallback((paths: readonly string[]) => {
    const keep = new Set(paths);
    queueRef.current = queueRef.current.filter((item) => keep.has(item.path));
    setStates((previous) => {
      let changed = false;
      const next = new Map(previous);
      for (const path of previous.keys()) {
        if (!keep.has(path)) {
          next.delete(path);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);

  const invalidate = useCallback(() => setFreshness((value) => value + 1), []);

  const getContents = useCallback((path: string) => states.get(path) ?? IDLE, [states]);

  return useMemo(
    () => ({ getContents, requestContents, prune, invalidate }),
    [getContents, requestContents, prune, invalidate],
  );
}