// The commit panel's view of the working tree and the index, refetched on
// every repository change and after a reconnect.
//
// A tick is optimistic. Staging is one round trip, and a checkbox that only
// moves once the server answers reads as a dropped click; worse, every other
// row is disabled while that round trip runs, so the whole list flickers. So
// the panel records the intent locally, shows it at once, and drops it when
// the server's own view of the tree arrives. The record is a per-path
// override, never a rewritten status letter: faking `index`/`worktree` would
// make `diffSidesFor` claim a side the file does not have.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChangeEntry, ChangesResult } from "../contracts";
import type { rpcContract } from "../server";
import { errorMessage } from "../lib/errors";
import { useRepositoryChanges } from "./use-repository-changes";

export interface ChangesState {
  changes: ChangesResult | null;
  loading: boolean;
  /** A transport failure; a git failure is inside `changes`. */
  error: string | null;
  refetch: () => void;
  /**
   * Show these paths as staged (or unstaged) before the server confirms it.
   * Returns a rollback for the failure path.
   */
  applyStaged: (paths: readonly string[], staged: boolean) => () => void;
}

/** A staged/unstaged intent that has not been confirmed by a `changes` read. */
type StagedOverride = Map<string, boolean>;

export function useChanges(threadId: string): ChangesState {
  const rpc = useRpc<typeof rpcContract>();
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<StagedOverride>(() => new Map());
  const generation = useRef(0);

  const refetch = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    rpc.call("changes", { threadId }).then(
      (next) => {
        if (mine !== generation.current) return;
        setChanges(next);
        // The server's tree is the truth now: every local intent that this
        // read could have observed is either confirmed or contradicted.
        setOverrides(new Map());
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (mine !== generation.current) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
  }, [rpc, threadId]);

  const applyStaged = useCallback((paths: readonly string[], staged: boolean) => {
    const previous = new Map<string, boolean | undefined>();
    setOverrides((current) => {
      const next = new Map(current);
      for (const path of paths) {
        previous.set(path, current.get(path));
        next.set(path, staged);
      }
      return next;
    });
    return () => {
      setOverrides((current) => {
        const next = new Map(current);
        for (const [path, was] of previous) {
          if (was === undefined) next.delete(path);
          else next.set(path, was);
        }
        return next;
      });
    };
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRepositoryChanges(threadId, refetch);

  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current !== "connected" && connection === "connected") refetch();
    previous.current = connection;
  }, [connection, refetch]);

  const resolved = useMemo(
    () => applyOverrides(changes, overrides),
    [changes, overrides],
  );

  return { changes: resolved, loading, error, refetch, applyStaged };
}

/**
 * The server's list with the local intents folded in. Only the two status
 * letters a tick actually changes are rewritten: an unstaged file becomes
 * `index: "M"`, and staging an untracked file turns it into a tracked add.
 * Everything else about the row (its path, its old path, its kind) is left
 * exactly as the server described it.
 */
/**
 * The server's list with the local intents folded in. Only the two status
 * letters a tick actually changes are rewritten: an unstaged file becomes
 * `index: "M"` with a clean working tree, and staging an untracked file
 * turns it into a tracked add. Everything else about the row (its path, its
 * old path, its kind) is left exactly as the server described it.
 *
 * Exported for its own tests: the two letter transitions are the whole of
 * what an optimistic tick means, and getting one wrong shows a file as
 * half-staged when it is not.
 */
export function applyOverrides(changes: ChangesResult | null, overrides: StagedOverride): ChangesResult | null {
  if (changes === null || !changes.ok || overrides.size === 0) return changes;
  let changed = false;
  const files = changes.files.map((entry) => {
    const staged = overrides.get(entry.path);
    if (staged === undefined) return entry;
    const next = staged ? stagedEntry(entry) : unstagedEntry(entry);
    if (next !== entry) changed = true;
    return next;
  });
  return changed ? { ...changes, files } : changes;
}

function stagedEntry(entry: ChangeEntry): ChangeEntry {
  if (entry.kind === "untracked") {
    // Staging a new file makes it an add in the index with nothing left in
    // the working tree to compare against.
    return { ...entry, kind: "tracked", index: "A", worktree: "." };
  }
  if (entry.kind === "conflicted" || entry.index !== ".") return entry;
  // `git add` copies the working tree into the index, so afterwards the two
  // agree and the working-tree side is clean. A file that was only in the
  // working tree gets its status letter carried into the index.
  return { ...entry, index: entry.worktree === "." ? "M" : entry.worktree, worktree: "." };
}

function unstagedEntry(entry: ChangeEntry): ChangeEntry {
  if (entry.kind === "untracked" || entry.kind === "conflicted") return entry;
  if (entry.index === ".") return entry;
  // Unstaging leaves the change in the working tree. A file that had no
  // working-tree edit of its own now has one (the edit that was staged).
  return { ...entry, index: ".", worktree: entry.worktree === "." ? "M" : entry.worktree };
}
