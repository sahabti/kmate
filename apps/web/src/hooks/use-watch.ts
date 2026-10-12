import { useEffect, useMemo } from "react";
import { cluster, errorMessage } from "@/services/api-client";
import * as watchMux from "@/services/watch-mux";
import { useWatchStore } from "@/stores/watch";
import { denialFromError, denialFromWire } from "@/lib/denial";
import { decodeObject, gvrKey, type GVRKey, type KObj } from "@/lib/k8s";
import { EventType } from "@/gen/kmate/v1/agent_pb";
import { STREAM_RETRY_MS } from "@/constants/stream";

interface UseWatchOptions {
  columnsOnly?: boolean;
  labelSelector?: string;
  fieldSelector?: string;
  enabled?: boolean;
}

/**
 * Live watch of a resource. Shares one stream per (cluster, gvr, namespace)
 * across components; returns the sorted list of objects.
 */
export const useWatch = (clusterId: string, gvr: GVRKey, namespace: string, opts?: UseWatchOptions) => {
  const enabled = opts?.enabled ?? true;
  const key = `${clusterId}|${gvrKey(gvr)}|${namespace}|${opts?.labelSelector ?? ""}|${opts?.fieldSelector ?? ""}|${opts?.columnsOnly ? "c" : "f"}`;
  const store = useWatchStore;

  useEffect(() => {
    if (!enabled || !clusterId) return;
    store.getState().ensure(key);
    const existing = store.getState().entries[key];
    // Only the first subscriber opens the stream.
    if (existing && existing.refs > 1) {
      return () => store.getState().release(key);
    }
    const options = { namespace, columnsOnly: !!opts?.columnsOnly, labelSelector: opts?.labelSelector ?? "", fieldSelector: opts?.fieldSelector ?? "" };
    const ac = new AbortController();
    let stopped = false;
    let unsubscribe: (() => void) | null = null;

    // Preferred path: one multiplexed WebSocket per cluster (see watchMux.ts).
    const runMux = () => {
      let batch: KObj[] = [];
      store.getState().reset(key);
      unsubscribe = watchMux.subscribe(clusterId, gvr, options, (ev) => {
        if (stopped) return;
        switch (ev.type) {
          case "reset":
            batch = [];
            store.getState().reset(key);

            return;
          case "SYNC":
            if (ev.synced) {
              store.getState().replace(key, batch);
              batch = [];
            } else if (ev.object) {
              if (store.getState().entries[key]?.synced) store.getState().upsert(key, ev.object);
              else batch.push(ev.object);
            }

            return;
          case "ADDED":
          case "MODIFIED":
            if (ev.object) store.getState().upsert(key, ev.object);

            return;
          case "DELETED":
            if (ev.object) store.getState().remove(key, ev.object.metadata?.uid ?? `${ev.object.metadata?.namespace}/${ev.object.metadata?.name}`);

            return;
          case "ERROR": {
            const denial = denialFromWire(ev.error);
            store.getState().setError(key, ev.error?.message ?? "watch error", denial);
            // A denial is a final answer; only transport trouble falls back.
            if (!denial && watchMux.shouldFallback(clusterId)) {
              unsubscribe?.();
              unsubscribe = null;
              void runConnect();
            }

            return;
          }
          case "CLOSED":
            // The stream ended; a retry follows, so the rows are now stale rather than gone.
            store.getState().reset(key);
            if (ev.error) store.getState().setError(key, ev.error.message, denialFromWire(ev.error));

            return;
        }
      });
    };

    // Fallback path: a Connect server-stream per watch (one HTTP connection each).
    const runConnect = async () => {
      while (!stopped) {
        store.getState().reset(key);
        try {
          const stream = cluster.watch(
            { clusterId, gvr: { group: gvr.group, version: gvr.version, resource: gvr.resource }, options },
            { signal: ac.signal },
          );
          let batch: KObj[] = [];
          for await (const ev of stream) {
            if (ev.type === EventType.SYNC && ev.synced) {
              store.getState().replace(key, batch);
              batch = [];
              continue;
            }
            if (ev.type === EventType.ERROR) {
              store.getState().setError(key, ev.error?.message ?? "watch error");
              continue;
            }
            if (!ev.object) continue;
            const obj = decodeObject(ev.object.json);
            if (ev.type === EventType.DELETED) {
              store.getState().remove(key, obj.metadata?.uid ?? ev.object.uid);
            } else if (!store.getState().entries[key]?.synced && ev.type === EventType.SYNC) {
              batch.push(obj);
            } else {
              store.getState().upsert(key, obj);
            }
          }
          if (batch.length) store.getState().replace(key, batch);
        } catch (e) {
          if (ac.signal.aborted) return;
          const denial = denialFromError(e);
          store.getState().setError(key, errorMessage(e), denial);
          if (denial) return; // refused: stop asking
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, STREAM_RETRY_MS));
      }
    };

    if (watchMux.shouldFallback(clusterId)) void runConnect();
    else runMux();

    return () => {
      stopped = true;
      ac.abort();
      unsubscribe?.();
      store.getState().release(key);
    };
    // `key` already encodes gvr, namespace and opts; those are fresh objects every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const entry = useWatchStore((s) => s.entries[key]);
  const items = useMemo(() => {
    if (!entry) return [] as KObj[];

    return Array.from(entry.objects.values()).sort((a, b) => {
      const an = `${a.metadata?.namespace ?? ""}/${a.metadata?.name ?? ""}`;
      const bn = `${b.metadata?.namespace ?? ""}/${b.metadata?.name ?? ""}`;

      return an.localeCompare(bn);
    });
  }, [entry]);

  return {
    items,
    synced: entry?.synced ?? false,
    stale: entry?.stale ?? false,
    syncedAt: entry?.syncedAt ?? null,
    error: entry?.error ?? null,
    denial: entry?.denial ?? null,
  };
};
