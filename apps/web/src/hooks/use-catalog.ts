import { useEffect, useState } from "react";
import { cluster, errorMessage } from "@/services/api-client";
import * as watchMux from "@/services/watch-mux";
import { denialFromError, denialFromWire, type Denial } from "@/lib/denial";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { CatalogSchema, type Catalog } from "@/gen/kmate/v1/catalog_pb";
import { STREAM_RETRY_MS } from "@/constants/stream";

/** Live Service Catalog for a cluster (multiplexed socket; Connect stream as fallback). */
export const useCatalog = (clusterId: string) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  // A denial belongs to the cluster that refused; switching clusters clears it
  // during render rather than in the effect, so no frame shows the old one.
  const [denialClusterId, setDenialClusterId] = useState(clusterId);
  if (denialClusterId !== clusterId) {
    setDenialClusterId(clusterId);
    if (clusterId) setDenial(null);
  }
  useEffect(() => {
    if (!clusterId) return;
    const ac = new AbortController();
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    const runMux = () => {
      unsubscribe = watchMux.subscribeKind(clusterId, "catalog", (ev) => {
        if (stopped) return;
        if (ev.type === "CATALOG" && ev.catalog) {
          try { setCatalog(fromJson(CatalogSchema, ev.catalog as JsonValue, { ignoreUnknownFields: true })); setError(null); } catch (e) { setError(errorMessage(e)); }
        } else if (ev.type === "ERROR") {
          const d = denialFromWire(ev.error);
          setError(ev.error?.message ?? "catalog error");
          setDenial(d);
          if (!d && watchMux.shouldFallback(clusterId)) { unsubscribe?.(); unsubscribe = null; void run(); }
        } else if (ev.type === "CLOSED" && ev.error) { setError(ev.error.message); setDenial(denialFromWire(ev.error)); }
      });
    };
    const run = async () => {
      while (!stopped) {
        try {
          for await (const c of cluster.watchCatalog({ clusterId }, { signal: ac.signal })) {
            setCatalog(c);
            setError(null);
            setDenial(null);
          }
        } catch (e) {
          if (ac.signal.aborted) return;
          const d = denialFromError(e);
          setError(errorMessage(e));
          setDenial(d);
          if (d) return;
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, STREAM_RETRY_MS));
      }
    };
    if (watchMux.shouldFallback(clusterId)) void run(); else runMux();

    return () => {
      stopped = true;
      unsubscribe?.();
      ac.abort();
    };
  }, [clusterId]);

  return { catalog, error, denial };
};
