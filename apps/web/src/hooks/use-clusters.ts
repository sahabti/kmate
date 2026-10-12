import { useEffect, useMemo, useState } from "react";
import { hub, errorMessage } from "@/services/api-client";
import * as watchMux from "@/services/watch-mux";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ClusterEventSchema, type Cluster } from "@/gen/kmate/v1/hub_pb";
import { STREAM_RETRY_MS } from "@/constants/stream";

/** Live list of clusters registered on the hub (multiplexed socket; Connect stream as fallback). */
export const useClusters = () => {
  const [clusters, setClusters] = useState<Map<string, Cluster>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    const apply = (type: string, c: Cluster) => setClusters((prev) => {
      const next = new Map(prev);
      if (type === "DELETED") next.delete(c.id); else next.set(c.id, c);

      return next;
    });
    const runMux = () => {
      unsubscribe = watchMux.subscribeKind(watchMux.HUB_SCOPE, "clusters", (ev) => {
        if (stopped) return;
        if (ev.type === "CLUSTER" && ev.event) {
          try {
            const e = fromJson(ClusterEventSchema, ev.event as JsonValue, { ignoreUnknownFields: true });
            if (e.cluster) apply(e.type, e.cluster);
            setLoaded(true);
            setError(null);
          } catch (err) { setError(errorMessage(err)); }
        } else if (ev.type === "ERROR") {
          setError(ev.error?.message ?? "clusters error");
          setLoaded(true);
          if (watchMux.shouldFallback(watchMux.HUB_SCOPE)) { unsubscribe?.(); unsubscribe = null; void run(); }
        } else if (ev.type === "CLOSED" && ev.error) { setError(ev.error.message); setLoaded(true); }
      });
    };
    const run = async () => {
      while (!stopped) {
        try {
          const res = await hub.listClusters({}, { signal: ac.signal });
          setClusters(new Map(res.clusters.map((c) => [c.id, c])));
          setLoaded(true);
          setError(null);
          for await (const ev of hub.watchClusters({}, { signal: ac.signal })) {
            if (!ev.cluster) continue;
            setClusters((prev) => {
              const next = new Map(prev);
              if (ev.type === "DELETED") next.delete(ev.cluster!.id);
              else next.set(ev.cluster!.id, ev.cluster!);

              return next;
            });
          }
        } catch (e) {
          if (ac.signal.aborted) return;
          setError(errorMessage(e));
          setLoaded(true);
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, STREAM_RETRY_MS));
      }
    };
    if (watchMux.shouldFallback(watchMux.HUB_SCOPE)) void run(); else runMux();

    return () => {
      stopped = true;
      unsubscribe?.();
      ac.abort();
    };
  }, []);
  const list = useMemo(() => Array.from(clusters.values()).sort((a, b) => a.name.localeCompare(b.name)), [clusters]);

  return { clusters: list, byId: clusters, loaded, error };
};
