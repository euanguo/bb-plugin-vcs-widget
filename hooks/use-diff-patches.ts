// The patch side of the continuous stream: one entry per file, fetched in
// batches and only for what is on screen. A patch is asked for once and kept
// until the working tree changes, so scrolling back up does not re-read it.
//
// Two things guard against a stale answer: the identity the request was made
// under (a branch switch or a side change makes every in-flight answer
// irrelevant) and a freshness counter the panel bumps whenever `changes`
// arrives. Both are compared before an answer is written, so a slow read
// cannot overwrite a newer one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffBatchResult } from "../contracts";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { errorMessage } from "../lib/errors";
import { chunkDiffPaths } from "../shared/diff-tiering";

/** One file's patch as the stream holds it. */
export interface DiffPatchState {
  status: "idle" | "loading" | "loaded" | "error";
  patch?: string;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}

const IDLE: DiffPatchState = { status: "idle" };

/** Scroll is settled before a read starts, so a fast flick does not fetch every row it passes. */
const REQUEST_DEBOUNCE_MS = 80;

export interface UseDiffPatchesResult {
  /** Tell the hook which paths are visible and which are merely nearby. */
  requestPaths: (paths: { visible: string[]; overscan: string[] }) => void;
  /** What the stream renders for one path. */
  getPatchState: (path: string) => DiffPatchState;
  /** Fetch one path now, bypassing the debounce (the "Load diff" button). */
  loadPath: (path: string) => void;
  /** Forget one path's error so a retry can run. */
  retry: (path: string) => void;
  /** Drop entries for paths that are no longer in the list. */
  prunePaths: (paths: readonly string[]) => void;
  /** Bump when `changes` arrives, so cached patches for changed files are re-read. */
  invalidate: () => void;
}

export function useDiffPatches(
  threadId: string,
  side: string,
  enabled: boolean,
): UseDiffPatchesResult {
  const rpc = useRpc<typeof rpcContract>();
  const [patches, setPatches] = useState<Map<string, DiffPatchState>>(new Map());
  const [freshness, setFreshness] = useState(0);

  const identity = `${threadId}:${side}:${freshness}`;
  const identityRef = useRef(identity);
  const pendingRef = useRef<{ visible: string[]; overscan: string[] }>({ visible: [], overscan: [] });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());
  const controllersRef = useRef<Set<AbortController>>(new Set());
  // The debounce and the load/retry callbacks read the latest patches without
  // being re-created on every state change.
  const patchesRef = useRef(patches);
  useEffect(() => {
    patchesRef.current = patches;
  }, [patches]);

  // A new side or a new working-tree state makes every stored patch stale.
  useEffect(() => {
    identityRef.current = identity;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    inFlightRef.current.clear();
    setPatches(new Map());
  }, [identity]);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      for (const controller of controllers) controller.abort();
    };
  }, []);

  const fetchPaths = useCallback(
    async (paths: string[], requestedUnder: string) => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      for (const path of paths) inFlightRef.current.add(path);
      setPatches((previous) => {
        const next = new Map(previous);
        for (const path of paths) next.set(path, { status: "loading" });
        return next;
      });
      try {
        const result: DiffBatchResult = await rpc.call("diffFiles", {
          threadId,
          paths,
          side: side as "index" | "worktree",
        });
        // A branch switch or a newer working tree landed while this was in
        // flight: the answer describes a repository state that is gone.
        if (controller.signal.aborted || identityRef.current !== requestedUnder) return;
        setPatches((previous) => {
          const next = new Map(previous);
          if (!result.ok) {
            const message = result.error.message;
            for (const path of paths) next.set(path, { status: "error", error: message });
            return next;
          }
          const byPath = new Map(result.files.map((file) => [file.path, file]));
          for (const path of paths) {
            const file = byPath.get(path);
            next.set(
              path,
              file === undefined
                ? { status: "error", error: "No diff was available for this file." }
                : { status: "loaded", patch: file.patch, truncated: file.truncated, binary: file.binary },
            );
          }
          return next;
        });
      } catch (caught) {
        if (controller.signal.aborted || identityRef.current !== requestedUnder) return;
        const message = errorMessage(caught) ?? "Failed to load file diff";
        setPatches((previous) => {
          const next = new Map(previous);
          for (const path of paths) next.set(path, { status: "error", error: message });
          return next;
        });
      } finally {
        controllersRef.current.delete(controller);
        for (const path of paths) inFlightRef.current.delete(path);
      }
    },
    [rpc, threadId, side],
  );

  const dispatchPending = useCallback(() => {
    timerRef.current = null;
    if (!enabled) return;
    const requestedUnder = identityRef.current;
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const path of [...pendingRef.current.visible, ...pendingRef.current.overscan]) {
      if (seen.has(path)) continue;
      seen.add(path);
      ordered.push(path);
    }
    const toFetch = ordered.filter((path) => {
      if (inFlightRef.current.has(path)) return false;
      const state = patchesRef.current.get(path);
      // A loaded patch is kept; an error waits for an explicit retry.
      return state === undefined || state.status === "idle";
    });
    if (toFetch.length === 0) return;
    for (const page of chunkDiffPaths(toFetch)) void fetchPaths(page, requestedUnder);
  }, [enabled, fetchPaths]);

  const requestPaths = useCallback(
    (paths: { visible: string[]; overscan: string[] }) => {
      pendingRef.current = paths;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(dispatchPending, REQUEST_DEBOUNCE_MS);
    },
    [dispatchPending],
  );

  const loadPath = useCallback(
    (path: string) => {
      if (inFlightRef.current.has(path)) return;
      const state = patchesRef.current.get(path);
      if (state?.status === "loaded") return;
      void fetchPaths([path], identityRef.current);
    },
    [fetchPaths],
  );

  const retry = useCallback(
    (path: string) => {
      setPatches((previous) => {
        const next = new Map(previous);
        next.delete(path);
        return next;
      });
      void fetchPaths([path], identityRef.current);
    },
    [fetchPaths],
  );

  const prunePaths = useCallback((paths: readonly string[]) => {
    const keep = new Set(paths);
    setPatches((previous) => {
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

  const getPatchState = useCallback((path: string) => patches.get(path) ?? IDLE, [patches]);

  return useMemo(
    () => ({ requestPaths, getPatchState, loadPath, retry, prunePaths, invalidate }),
    [requestPaths, getPatchState, loadPath, retry, prunePaths, invalidate],
  );
}
