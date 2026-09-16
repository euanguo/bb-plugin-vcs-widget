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

/** Whether two reads describe the same text, so a re-read can be skipped. */
function sameContents(a: DiffFullContents, b: DiffFullContents): boolean {
  return (
    a.old.path === b.old.path &&
    a.old.content === b.old.content &&
    a.new.path === b.new.path &&
    a.new.content === b.new.content
  );
}

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
  // The view these contents describe. Changing it means a different repository
  // or a different side of it, so nothing stored here is meaningful any more.
  const identity = `${threadId}:${side}`;
  const identityRef = useRef(identity);
  const statesRef = useRef(states);
  const inFlightRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<{ path: string; oldPath: string | null }[]>([]);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  // The old path each entry was read with, so a re-read asks the same question.
  const oldPathsRef = useRef<Map<string, string | null>>(new Map());
  // Contents that may describe an older working tree. They are re-read in
  // place, so the context controls on an open card do not disappear and come
  // back every time the working tree changes.
  const staleRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  useEffect(() => {
    identityRef.current = identity;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    inFlightRef.current.clear();
    queueRef.current = [];
    oldPathsRef.current.clear();
    staleRef.current.clear();
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
      oldPathsRef.current.set(next.path, next.oldPath);
      const controller = new AbortController();
      controllersRef.current.add(controller);
      setStates((previous) => {
        // A re-read keeps what is already on screen; only a first read has
        // nothing to show and needs the loading state.
        if (previous.get(next.path)?.status === "ready") return previous;
        return new Map(previous).set(next.path, { status: "loading" });
      });
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
              const current = previous.get(next.path);
              const ready =
                result.ok && result.contents !== null
                  ? ({ status: "ready", contents: result.contents } as const)
                  : ({ status: "unavailable" } as const);
              // Unchanged text keeps the object it already had, so a re-read
              // that finds nothing new does not re-render the card.
              if (
                ready.status === "ready" &&
                current?.status === "ready" &&
                sameContents(current.contents, ready.contents)
              ) {
                return previous;
              }
              // A re-read that came back empty leaves the text already shown.
              if (ready.status === "unavailable" && current?.status === "ready") return previous;
              const updated = new Map(previous);
              // `contents` is null for a binary, a truncated patch, or a side
              // too large to send; that is the renderer's "unavailable".
              updated.set(next.path, ready);
              return updated;
            });
          },
          () => {
            if (controller.signal.aborted || identityRef.current !== requestedUnder) return;
            setStates((previous) =>
              previous.get(next.path)?.status === "ready"
                ? previous
                : new Map(previous).set(next.path, { status: "unavailable" }),
            );
          },
        )
        .finally(() => {
          controllersRef.current.delete(controller);
          inFlightRef.current.delete(next.path);
          if (identityRef.current === requestedUnder) staleRef.current.delete(next.path);
          drain();
        });
    }
  }, [enabled, rpc, side, threadId]);

  const requestContents = useCallback(
    (path: string, oldPath: string | null) => {
      if (!enabled) return;
      if (inFlightRef.current.has(path)) return;
      const state = statesRef.current.get(path);
      // Ready stays ready unless a newer working tree made it stale;
      // unavailable waits for an explicit retry, so one oversized file is not
      // re-read on every scroll.
      if (state !== undefined && state.status !== "idle" && !staleRef.current.has(path)) return;
      queueRef.current.push({ path, oldPath });
      drain();
    },
    [drain, enabled],
  );

  const prune = useCallback((paths: readonly string[]) => {
    const keep = new Set(paths);
    queueRef.current = queueRef.current.filter((item) => keep.has(item.path));
    for (const path of [...staleRef.current]) {
      if (!keep.has(path)) staleRef.current.delete(path);
    }
    for (const path of [...oldPathsRef.current.keys()]) {
      if (!keep.has(path)) oldPathsRef.current.delete(path);
    }
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

  /**
   * The working tree changed. Everything already read may describe it as it
   * was, but nothing is dropped: each stale path is asked for again while the
   * text it already holds stays on screen.
   */
  const invalidate = useCallback(() => {
    for (const [path, state] of statesRef.current) {
      if (state.status !== "ready") continue;
      if (inFlightRef.current.has(path)) continue;
      if (queueRef.current.some((item) => item.path === path)) continue;
      staleRef.current.add(path);
      queueRef.current.push({ path, oldPath: oldPathsRef.current.get(path) ?? null });
    }
    drain();
  }, [drain]);

  const getContents = useCallback((path: string) => states.get(path) ?? IDLE, [states]);

  return useMemo(
    () => ({ getContents, requestContents, prune, invalidate }),
    [getContents, requestContents, prune, invalidate],
  );
}
