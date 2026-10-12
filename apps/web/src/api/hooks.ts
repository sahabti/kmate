import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cluster, hub, errorMessage } from "./client";
import * as watchMux from "./watchMux";
import { useWatchStore } from "@/store/watch";
import { denialFromError, denialFromWire, type Denial } from "@/lib/denial";
import { decodeObject, gvrKey, type GVRKey, type KObj } from "@/lib/k8s";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { EventType } from "@/gen/kmate/v1/agent_pb";
import { CatalogSchema, type Catalog } from "@/gen/kmate/v1/catalog_pb";
import { ClusterEventSchema, type Cluster, type ClusterGrant } from "@/gen/kmate/v1/hub_pb";

const RETRY_MS = 2000;

/**
 * Polling interval that stops once the request is refused. Re-asking a question
 * the hub or the API server already answered with "no" only adds console noise.
 */
function pollUnlessDenied(ms: number) {
  // `any` keeps TanStack Query's data-type inference intact at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (q: any) => (denialFromError(q?.state?.error) ? false : ms);
}


/**
 * Live watch of a resource. Shares one stream per (cluster, gvr, namespace)
 * across components; returns the sorted list of objects.
 */
export function useWatch(clusterId: string, gvr: GVRKey, namespace: string, opts?: { columnsOnly?: boolean; labelSelector?: string; fieldSelector?: string; enabled?: boolean }) {
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
        await new Promise((r) => setTimeout(r, RETRY_MS));
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
}

/** Live Service Catalog for a cluster (multiplexed socket; Connect stream as fallback). */
export function useCatalog(clusterId: string) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  useEffect(() => {
    if (!clusterId) return;
    setDenial(null);
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
        await new Promise((r) => setTimeout(r, RETRY_MS));
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
}

/** Live list of clusters registered on the hub (multiplexed socket; Connect stream as fallback). */
export function useClusters() {
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
        await new Promise((r) => setTimeout(r, RETRY_MS));
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
}

export function useCluster(clusterId: string) {
  return useQuery({
    queryKey: ["cluster", clusterId],
    queryFn: async () => (await hub.getCluster({ id: clusterId })).cluster ?? null,
    refetchInterval: pollUnlessDenied(10_000),
    enabled: !!clusterId,
  });
}

/** Capabilities advertised by the cluster's agent ("read", "write", "exec", ...). */
export function useCapabilities(clusterId: string) {
  const q = useCluster(clusterId);
  const caps = q.data?.capabilities ?? [];
  const known = !!q.data;
  return {
    caps,
    known,
    canWrite: caps.includes("write"),
    canExec: caps.includes("exec"),
    online: q.data ? q.data.status === 2 /* ONLINE */ : false,
  };
}

/**
 * Pods scheduled on a node. The agent serves lists from its informer cache and
 * only honours metadata field selectors there, so filter on spec.nodeName here.
 */
export function usePodsOnNode(clusterId: string, node: string, enabled = true) {
  return useQuery({
    queryKey: ["podsOnNode", clusterId, node],
    queryFn: async () => {
      const res = await cluster.list({
        clusterId,
        gvr: { group: "", version: "v1", resource: "pods" },
        // Server-side field selector: the agent cache resolves spec.nodeName,
        // so large clusters don't ship every pod just to filter one node.
        options: { namespace: "", columnsOnly: true, fieldSelector: `spec.nodeName=${node}` },
      });
      return res.items.map((o) => decodeObject(o.json)).filter((p) => p.spec?.nodeName === node);
    },
    enabled: enabled && !!clusterId && !!node,
    refetchInterval: pollUnlessDenied(15_000),
  });
}

/** Pods selected by a Service (for port-forward target resolution). */
export function usePodsForSelector(clusterId: string, namespace: string, selector: Record<string, string> | undefined, enabled = true) {
  const labelSelector = Object.entries(selector ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return useQuery({
    queryKey: ["podsForSelector", clusterId, namespace, labelSelector],
    queryFn: async () => {
      const res = await cluster.list({ clusterId, gvr: { group: "", version: "v1", resource: "pods" }, options: { namespace, labelSelector, columnsOnly: true } });
      return res.items.map((o) => decodeObject(o.json));
    },
    enabled: enabled && !!clusterId && !!labelSelector,
  });
}

export function useHelmRelease(clusterId: string, namespace: string, name: string, revision = 0, enabled = true) {
  return useQuery({
    queryKey: ["helmRelease", clusterId, namespace, name, revision],
    queryFn: async () => cluster.getHelmRelease({ clusterId, helm: { namespace, name, revision } }),
    enabled: enabled && !!clusterId && !!name,
    staleTime: 30_000,
  });
}

export function useAuditEvents(clusterId: string, limit = 200) {
  return useQuery({
    queryKey: ["audit", clusterId, limit],
    queryFn: async () => (await hub.listAuditEvents({ clusterId, limit })).events,
    enabled: !!clusterId,
    refetchInterval: pollUnlessDenied(15_000),
  });
}

export function useDiscover(clusterId: string) {
  return useQuery({
    queryKey: ["discover", clusterId],
    queryFn: async () => (await cluster.discover({ clusterId })).resources,
    staleTime: 5 * 60_000,
    enabled: !!clusterId,
  });
}

/** Fetches the full object (with a small polling refresh). */
export function useObject(clusterId: string, gvr: GVRKey | null, namespace: string, name: string) {
  return useQuery({
    queryKey: ["object", clusterId, gvr ? gvrKey(gvr) : "", namespace, name],
    queryFn: async () => {
      const res = await cluster.get({ clusterId, ref: { gvr: gvr!, namespace, name } });
      return res.object ? decodeObject(res.object.json) : null;
    },
    enabled: !!clusterId && !!gvr && !!name,
    refetchInterval: pollUnlessDenied(15_000),
  });
}

export function useEventsFor(clusterId: string, namespace: string, name: string, enabled = true) {
  return useQuery({
    queryKey: ["events", clusterId, namespace, name],
    queryFn: async () => {
      const res = await cluster.list({
        clusterId,
        gvr: { group: "", version: "v1", resource: "events" },
        options: {
          namespace,
          fieldSelector: namespace
            ? `involvedObject.name=${name},involvedObject.namespace=${namespace}`
            : `involvedObject.name=${name}`,
        },
      });
      return res.items
        .map((o) => decodeObject(o.json))
        .sort((a, b) => String(b.lastTimestamp ?? b.eventTime ?? "").localeCompare(String(a.lastTimestamp ?? a.eventTime ?? "")));
    },
    enabled: enabled && !!clusterId && !!name,
    refetchInterval: pollUnlessDenied(10_000),
  });
}

/* ---------------- access review ---------------- */

/** One "can I do X" question, mirroring authorization.k8s.io ResourceAttributes. */
export interface AccessQuestion {
  group?: string;
  version?: string;
  resource: string;
  subresource?: string;
  namespace?: string;
  name?: string;
  verb: string;
}

export interface AccessAnswer {
  allowed: boolean;
  denied: boolean;
  reason: string;
  /** True when the agent cannot impersonate, so the answer is about the agent, not you. */
  shared: boolean;
}

export function accessKey(q: AccessQuestion): string {
  return [q.group ?? "", q.version ?? "", q.resource, q.subresource ?? "", q.namespace ?? "", q.name ?? "", q.verb].join("|");
}

/**
 * Asks the cluster what the signed-in user may actually do.
 *
 * The agent answers with a SelfSubjectAccessReview while impersonating, which is
 * the same question `kubectl auth can-i` asks, so buttons reflect real Kubernetes
 * permissions rather than only what the agent was installed to allow.
 */
export function useAccessReview(clusterId: string, questions: AccessQuestion[], enabled = true) {
  const keys = questions.map(accessKey).join("\n");
  const q = useQuery({
    queryKey: ["accessReview", clusterId, keys],
    queryFn: async () => {
      const res = await cluster.accessReview({
        clusterId,
        review: {
          items: questions.map((x) => ({
            group: x.group ?? "", version: x.version ?? "", resource: x.resource,
            subresource: x.subresource ?? "", namespace: x.namespace ?? "", name: x.name ?? "", verb: x.verb,
          })),
        },
      });
      const out = new Map<string, AccessAnswer>();
      res.results.forEach((r, i) => {
        const question = questions[i];
        if (!question) return;
        out.set(accessKey(question), {
          allowed: r.allowed,
          denied: r.denied,
          reason: r.reason,
          shared: r.reason.startsWith("shared identity"),
        });
      });
      return out;
    },
    enabled: enabled && !!clusterId && questions.length > 0,
    staleTime: 30_000,
    retry: false,
  });

  const answers = q.data;
  return useMemo(
    () => ({
      /** Undefined while unknown, so callers can avoid disabling a button prematurely. */
      can(question: AccessQuestion): AccessAnswer | undefined {
        return answers?.get(accessKey(question));
      },
      loaded: !!answers,
      error: q.error ? errorMessage(q.error) : null,
    }),
    [answers, q.error],
  );
}

/* ---------------- users, grants and your own access ---------------- */

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => (await hub.listUsers({})).users,
    enabled,
    retry: false,
  });
}

/** Grants for a user; an empty userId means your own. */
export function useGrants(userId = "", enabled = true) {
  return useQuery({
    queryKey: ["grants", userId],
    queryFn: async () => (await hub.listGrants({ userId })).grants,
    enabled,
    retry: false,
  });
}

/** Invalidate every user/grant query after an administrative change. */
export function useRefreshUsers() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["users"] });
    void qc.invalidateQueries({ queryKey: ["grants"] });
  };
}

/**
 * Namespaces the user may select on a cluster.
 *
 * A namespace-limited user cannot list the cluster-scoped `namespaces` resource,
 * so falling back to their own grant keeps the picker useful instead of empty.
 * `restricted` means "all namespaces" is not an option for this user.
 */
export function useAllowedNamespaces(clusterId: string) {
  const watch = useWatch(clusterId, { group: "", version: "v1", resource: "namespaces" }, "", { columnsOnly: true });
  const grants = useGrants("", !!clusterId);
  const granted = useMemo(() => {
    const g = (grants.data ?? []).find((x: ClusterGrant) => x.clusterId === clusterId);
    return g?.namespaces ?? [];
  }, [grants.data, clusterId]);

  const watched = useMemo(
    () => watch.items.map((n) => n.metadata?.name ?? "").filter(Boolean).sort(),
    [watch.items],
  );

  const restricted = granted.length > 0;
  const namespaces = useMemo(() => {
    if (restricted) {
      // Prefer the live list intersected with the grant, so names stay accurate.
      const live = new Set(watched);
      const inter = granted.filter((n) => live.has(n));
      return (inter.length ? inter : [...granted]).sort();
    }
    return watched;
  }, [restricted, granted, watched]);

  return { namespaces, restricted, denial: watch.denial };
}

/** Utility for stable AbortControllers in imperative stream consumers. */
export function useAbort() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return ref;
}


