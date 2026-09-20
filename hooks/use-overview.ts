import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { Overview } from "../contracts";
import type { rpcContract } from "../server";
import { CHANGED_CHANNEL } from "../shared/constants";
import { freshOverview, overviewCacheKey, rememberOverview } from "../shared/overview-cache";
import { errorMessage } from "../lib/errors";

interface UseOverviewOptions {
  threadId: string;
  environmentId: string | null;
  /** Nothing is fetched until the popup was opened once. */
  enabled: boolean;
}

export interface OverviewState {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  /** Read the repository now, whatever is already in hand. */
  refetch: () => Promise<void>;
  /**
   * Read it only if what is in hand has gone stale. What the popup calls when
   * it opens: reopening it twice in a row used to mean two full reads of six
   * git processes, for an answer that had not had time to change.
   */
  refreshIfStale: () => Promise<void>;
  /** Adopt the overview returned by a mutation without another round trip. */
  applyOverview: (overview: Overview) => void;
}

function isChangedPayload(value: unknown): value is { environmentId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { environmentId?: unknown }).environmentId === "string"
  );
}

export function useOverview({ threadId, environmentId, enabled }: UseOverviewOptions): OverviewState {
  const rpc = useRpc<typeof rpcContract>();
  const key = overviewCacheKey(threadId, environmentId);
  // Seeded from the cache so the first paint has the repository in it when
  // another surface has just read it.
  const [overview, setOverview] = useState<Overview | null>(() => freshOverview(key));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A slow response must never overwrite a newer one.
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const keyRef = useRef(key);
  keyRef.current = key;

  const read = useCallback(async () => {
    const mine = ++generation.current;
    const at = keyRef.current;
    setLoading(true);
    try {
      const next = await rpc.call("overview", { threadId });
      rememberOverview(at, next);
      if (mine !== generation.current) return;
      setOverview(next);
      setError(null);
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(errorMessage(cause));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [rpc, threadId]);

  const refetch = useCallback(() => read(), [read]);

  const refreshIfStale = useCallback(async () => {
    const cached = freshOverview(keyRef.current);
    if (cached !== null) {
      // Paint what is in hand; a read already in flight for this environment
      // will land behind it.
      setOverview(cached);
      return;
    }
    await read();
  }, [read]);

  const applyOverview = useCallback(
    (next: Overview) => {
      rememberOverview(keyRef.current, next);
      generation.current += 1;
      setOverview(next);
      setError(null);
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    if (enabled) void refreshIfStale();
  }, [enabled, refreshIfStale]);

  useRealtime(CHANGED_CHANNEL, (payload) => {
    if (!enabledRef.current) return;
    if (isChangedPayload(payload) && environmentId !== null && payload.environmentId !== environmentId) return;
    // A signal means the repository moved, so the freshness window does not
    // apply to it: this read always happens.
    void refetch();
  });

  // Signals are never replayed: reconcile after a reconnect.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current !== "connected" && connection === "connected" && enabledRef.current) {
      void refetch();
    }
    previousConnection.current = connection;
  }, [connection, refetch]);

  return { overview, loading, error, refetch, refreshIfStale, applyOverview };
}
