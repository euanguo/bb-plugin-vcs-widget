// The rows for a diff target that is not the working tree.
//
// One read answers both halves of the pane: the files to list, and the commits
// a range spans so the picker can offer them. Reading them together is what
// stops the picker from offering a commit the list cannot show.
//
// The working tree does not come through here. `useChanges` already answers
// for it, with the index and the worktree as two sides rather than one list,
// and routing it through this hook would mean re-reading it for nothing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Commit, DiffTarget, TargetFiles } from "../contracts";
import type { rpcContract } from "../server";
import { errorMessage } from "../lib/errors";

export interface DiffTargetRead {
  files: Extract<TargetFiles, { ok: true }>["files"];
  commits: Commit[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY: Extract<TargetFiles, { ok: true }>["files"] = [];
/** One shared empty list: a caller compares the answer by identity, and a fresh
 * `[]` on every render would look like a new answer every time. */
const EMPTY_COMMITS: Commit[] = [];

/**
 * `target` is null for the working tree, which this hook does not answer for.
 * `freshness` is bumped by the caller whenever the repository may have moved,
 * exactly as the patch readers are bumped: a commit that was just made, or a
 * branch that was just switched, makes the list that is on screen wrong.
 */
export function useDiffTarget(threadId: string, target: DiffTarget | null, freshness: unknown): DiffTargetRead {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Extract<TargetFiles, { ok: true }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The key the answer belongs to. A new target or a new repository state
  // makes every stored answer stale, so it is compared before writing.
  const key = target === null ? null : threadId + ":" + JSON.stringify(target);
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
    setState(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (target === null) {
      setState(null);
      setLoading(false);
      setError(null);
      return;
    }
    let live = true;
    const requestedUnder = key;
    setLoading(true);
    void rpc
      .call("diffTarget", { threadId, target })
      .then(
        (result) => {
          if (!live || keyRef.current !== requestedUnder) return;
          if (result.ok) {
            setState(result);
            setError(null);
            return;
          }
          setError(result.error.message);
        },
        (cause: unknown) => {
          if (!live || keyRef.current !== requestedUnder) return;
          setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (live && keyRef.current === requestedUnder) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [rpc, threadId, target, key, freshness, attempt]);

  const refetch = useCallback(() => setAttempt((value) => value + 1), []);

  return useMemo(
    () => ({
      files: state?.files ?? EMPTY,
      commits: state?.commits ?? EMPTY_COMMITS,
      truncated: state?.truncated ?? false,
      loading,
      error,
      refetch,
    }),
    [state, loading, error, refetch],
  );
}

