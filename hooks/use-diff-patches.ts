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

  // The view these patches describe. Changing it means a different repository
  // or a different side of it, so nothing stored here is meaningful any more.
  const identity = `${threadId}:${side}`;
  const identityRef = useRef(identity);
  const pendingRef = useRef<{ visible: string[]; overscan: string[] }>({ visible: [], overscan: [] });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());
  const controllersRef = useRef<Set<AbortController>>(new Set());
  // Paths whose stored patch may describe a working tree that has since
  // changed. They are re-read in place: the patch already on screen stays
  // until the new one arrives, because blanking every card back to a loading
  // state is what made staging one file look like the whole stream reloaded.
  const staleRef = useRef<Set<string>>(new Set());
  // The debounce and the load/retry callbacks read the latest patches without
  // being re-created on every state change.
  const patchesRef = useRef(patches);
  useEffect(() => {
    patchesRef.current = patches;
  }, [patches]);

  // A new thread or a new side makes every stored patch meaningless.
  useEffect(() => {
    identityRef.current = identity;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    inFlightRef.current.clear();
    staleRef.current.clear();
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
        let changed = false;
        const next = new Map(previous);
        for (const path of paths) {
          // A re-read keeps what is already on screen. Only a first read has
          // nothing to show and needs the loading state.
          if (previous.get(path)?.status === "loaded") continue;
          next.set(path, { status: "loading" });
          changed = true;
        }
        return changed ? next : previous;
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
          let changed = false;
          const next = new Map(previous);
          if (!result.ok) {
            const message = result.error.message;
            for (const path of paths) {
              // A re-read that failed leaves the patch already on screen.
              if (previous.get(path)?.status === "loaded") continue;
              next.set(path, { status: "error", error: message });
              changed = true;
            }
            return changed ? next : previous;
          }
          const byPath = new Map(result.files.map((file) => [file.path, file]));
          for (const path of paths) {
            const file = byPath.get(path);
            const current = previous.get(path);
            if (file === undefined) {
              if (current?.status === "loaded") continue;
              next.set(path, { status: "error", error: "No diff was available for this file." });
              changed = true;
              continue;
            }
            // The same patch keeps the object it already had, so a re-read
            // that finds nothing new does not re-render the row.
            if (
              current?.status === "loaded" &&
              current.patch === file.patch &&
              current.truncated === file.truncated &&
              current.binary === file.binary
            ) {
              continue;
            }
            next.set(path, { status: "loaded", patch: file.patch, truncated: file.truncated, binary: file.binary });
            changed = true;
          }
          return changed ? next : previous;
        });
      } catch (caught) {
        if (controller.signal.aborted || identityRef.current !== requestedUnder) return;
        const message = errorMessage(caught) ?? "Failed to load file diff";
        setPatches((previous) => {
          let changed = false;
          const next = new Map(previous);
          for (const path of paths) {
            if (previous.get(path)?.status === "loaded") continue;
            next.set(path, { status: "error", error: message });
            changed = true;
          }
          return changed ? next : previous;
        });
      } finally {
        controllersRef.current.delete(controller);
        for (const path of paths) inFlightRef.current.delete(path);
        // The answer landed under this identity, so these paths are current.
        // A changed identity cleared the set already.
        if (identityRef.current === requestedUnder) {
          for (const path of paths) staleRef.current.delete(path);
        }
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
      // A stale patch is re-read in place; a loaded one that is not stale is
      // kept, and an error waits for an explicit retry.
      if (staleRef.current.has(path)) return true;
      const state = patchesRef.current.get(path);
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
      staleRef.current.delete(path);
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
    for (const path of [...staleRef.current]) {
      if (!keep.has(path)) staleRef.current.delete(path);
    }
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

  /**
   * The working tree changed. Everything already read may describe it as it
   * was, but nothing is dropped: each stale path is re-read in the background
   * while its current patch stays on screen.
   */
  const invalidate = useCallback(() => {
    for (const [path, state] of patchesRef.current) {
      if (state.status === "loaded") staleRef.current.add(path);
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(dispatchPending, REQUEST_DEBOUNCE_MS);
  }, [dispatchPending]);

  const getPatchState = useCallback((path: string) => patches.get(path) ?? IDLE, [patches]);

  return useMemo(
    () => ({ requestPaths, getPatchState, loadPath, retry, prunePaths, invalidate }),
    [requestPaths, getPatchState, loadPath, retry, prunePaths, invalidate],
  );
}
